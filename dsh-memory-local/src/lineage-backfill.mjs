#!/usr/bin/env node
/**
 * lineage-backfill.mjs —— 记忆「观察血缘」的**索引后回填**：把 `memories.source_ids` 填满
 *
 * 它是写侧预埋（`lineage-auto.mjs`）的另一半：
 *   · 写侧只记「这条记忆是在哪一轮写下的」⇒ 一行 pending 指针（`(sessionId, turnTs, userHeadSha16)`）；
 *   · 本件拿这行指针去**索引库**里认回原文块（按 `(session_id, ts)` 命中）⇒ 写进 `source_ids`。
 * 缺了写侧，血缘永远是空串；缺了本件，覆盖率永远停在 0。
 *
 * 一句话：**读 pending 日志 → 按 `(session_id, ts)` 找索引库的块 → 先留痕归档旧行 → 才允许
 * UPDATE → 写 `state.json`。**
 *
 * ── 用法 ────────────────────────────────────────────────────────────────────────
 *   # ① 覆盖率读数（只读 · 三数 + asOf + 分档 + 存活率）
 *   node lineage-backfill.mjs --report [--days 7]
 *
 *   # ② 存活率重算（只读 · 已挂 id 还在索引库里吗）
 *   node lineage-backfill.mjs --recheck [--days 7]
 *
 *   # ③ 真回填（**缺省 dry-run**，必须显式 --apply 才写库）
 *   node lineage-backfill.mjs
 *   node lineage-backfill.mjs --apply [--limit 50] [--id 2001367]
 *
 * 通用参数：`--home <dir>`（缺省 env `DSH_HOME` → `~/.dsh`）· `--memory-db <file>` · `--life-db <file>`
 *           `--chunk-table <name>`（缺省自动探测）· `--state <file>` · `--pending-dir <dir>` · `--log <file>`
 *           `--snapshot <file>`（唯一写口模块；缺省自动找，找不到 ⇒ apply 时拒写）
 *           `--index-log <file>`（可选：索引在跑时本轮跳过）· `--alert-log <file>`（可选：失败告警落点）
 *           `--keep-pending-months N`（缺省 6）· `--no-rotate` · `--prune-pending`（默认只改名不删）
 *           `--json`（stdout 只有 JSON）· `--ignore-switch` · `--ignore-index-lock`
 *
 * ── 退出码 ──────────────────────────────────────────────────────────────────────
 *   0 = 成功 / 无事可做 / dry-run 正常      2 = 用法错
 *   3 = **整轮拒动**（库打不开 / 被锁 / 开关关 / 索引在跑 / 写口找不到 ⇒ 一个字节没写）
 *   4 = **部分 blocked**（归档台账已落但 UPDATE 没成 / 快照拒动 ⇒ 其它条照常，见 `--report`）
 *   1 = 其它异常
 *
 * ── 🔴 硬约束（改这段不许破）────────────────────────────────────────────────────
 *   ① 写口唯一：改历史行**必须**走同一个"先留痕再改"的写口模块（`--snapshot`，缺省同名件），
 *      不新造第二个写口、不直接 `UPDATE` 了事。
 *   ② `UPDATE memories SET source_ids=? WHERE id=? AND source_ids=''` —— **不碰 `updated_at`**：
 *      召回池按 `updated_at DESC` 排序，刷它会把历史记忆顶进近期池。
 *      `AND source_ids=''` 是并发守卫：别人先写了 ⇒ `changes=0` ⇒ 计 blocked，绝不复写别人的值。
 *   ③ 写口抛 ⇒ **库未改一行**（fail-closed）；写口返回 `skipped:true` **≠ 已完成**
 *      ⇒ 仍须 UPDATE 且核 `changes===1`。
 *   ④ 幂等键 = `(memId, 目标 source_ids 值)`（**不是**快照的 `(op,memId,正文 hash)`）。
 *   ⑤ 0 块 / 头部哈希对不上 ⇒ 宁缺毋滥：不挂、不拿"最近 N 块"凑。
 *   ⑥ 不给存量批量造 id：本器只处理 pending 日志里点名的 memId。
 *   ⑦ pending 日志分片按月滚动：整月都已回填完的分片改名成 `*.jsonl.done`（不再被读），
 *      超期分片**只在显式 `--prune-pending` 时才删**（缺省保留，删是不可逆的）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const BACKFILL_VERSION = "2b-P2-1";
/** 缺省统计窗口（天）。 */
export const DEFAULT_DAYS = 7;
/** 一条记忆最多挂几条块。 */
export const MAX_SOURCES = 8;
/** assistant 取前几块。 */
export const ASSISTANT_PICK = 3;
/** 机器判据取前多少字（与写侧 `lineage-auto.mjs#headSha16Of` 同口径）。 */
export const HEAD_CHARS = 200;
/** `unmatched` 终态的存活期：attempts 到 7 天仍空 ⇒ 终态。 */
export const UNMATCHED_TTL_MS = 7 * 24 * 3600 * 1000;
/** 锁与退避。 */
export const LIFE_BUSY_TIMEOUT_MS = 15000;
export const MEMORY_BUSY_TIMEOUT_MS = 5000;
export const WRITE_BACKOFF_MS = [60, 150, 400];
/** pending 分片文件名（`pending-YYYY-MM.jsonl`；`.done` = 已归档、不再读）。 */
export const PENDING_FILE_RE = /^pending-(\d{4})-(\d{2})\.jsonl$/;
export const PENDING_DONE_RE = /^pending-(\d{4})-(\d{2})\.jsonl\.done$/;
export const PENDING_DONE_SUFFIX = ".done";
/** 已归档分片保留几个月（超期只标记 prunable，除非显式 `--prune-pending`）。 */
export const DEFAULT_KEEP_PENDING_MONTHS = 6;
/** 索引库候选表名（没有 `--chunk-table` 时按序探测）。 */
export const CHUNK_TABLE_CANDIDATES = Object.freeze(["chunks", "life_chunks", "memory_chunks"]);
/** 取块需要的列（探测到表后逐一核；缺列 ⇒ 报清哪张表缺哪列）。 */
export const CHUNK_TABLE_COLUMNS = Object.freeze(["id", "session_id", "ts", "role", "kind", "ord", "text"]);
/** 唯一写口模块的候选位置（相对本文件 / 相对包根）。 */
export const SNAPSHOT_MODULE_CANDIDATES = Object.freeze([
  "memory-db-tools/memory-snapshot.mjs",
  "../memory-db-tools/memory-snapshot.mjs",
  "memory-snapshot.mjs"
]);
export const SNAPSHOT_MODULE_ENV = "DSH_MEMORY_SNAPSHOT_MODULE";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 包根（本件在 `<pkg>/dsh-memory-local/lib|src/` 下 ⇒ 往上两级）。 */
const PKG_ROOT = path.resolve(HERE, "..", "..");

/**
 * 「已知非 `memory_write` 入口」标记（覆盖率的分母要剔除这些行）。
 * 只收**能现读、有代码出处**的两类；每类都给出判据 SQL 与出处，`--report` 会逐类报数。
 * ⚠️ 不是"猜"：这两条是外部写者直接 `INSERT INTO memories` 且 tags 带稳定标记的情形；
 *    其余入口**没有稳定标记**（识别不了 ⇒ 不纳入，如实登记在报告里）。
 */
export const NON_MW_MARKERS = Object.freeze([
  { id: "src:life", sql: "tags LIKE '%src:life%'", why: "外部导入器直写 INSERT（生活/其它来源导入）" },
  { id: "distilled", sql: "tags LIKE 'distilled%'", why: "提炼器直写 INSERT（摘要条）" }
]);

// ── 小工具 ─────────────────────────────────────────────────────────────────────
/** sha256 十六进制前 16 位（与 `lineage-auto.mjs#sha16` 同式）。 */
export function sha16(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 16);
}
/** 空白压缩（与写侧 `squeeze` 同式 —— 头部哈希必须两边一模一样，否则整批 unmatched）。 */
export function squeeze(text) {
  return String(text ?? "").replace(/\s+/g, "");
}
/** 真人消息「前 200 字（去空白）sha16」= 回填的机器判据。 */
export function headSha16Of(text) {
  return sha16(squeeze(text).slice(0, HEAD_CHARS));
}
/** ISO 时间 → 毫秒（解析失败 ⇒ null）。 */
function msOf(iso) {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) ? t : null;
}
/** 统一口径的会话 id（strip `session-` 前缀，与索引库的会话主键对齐）。 */
export function normalizeSessionId(raw) {
  return String(raw ?? "").trim().replace(/^session-/, "");
}
/** 原子写 JSON（tmp → fsync → rename），失败抛错（state 是权威源，不许半截）。 */
export function writeJsonAtomic(file, doc) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const payload = JSON.stringify(doc, null, 2) + "\n";
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // Windows：目标被别的进程瞬时打开时 rename 会 EPERM/EBUSY ⇒ 短重试（state 每轮都写，不能一次抖动就整轮失败）
  let lastErr = null;
  for (let i = 0; i < 4; i += 1) {
    try { fs.renameSync(tmp, file); lastErr = null; break; } catch (e) {
      lastErr = e;
      if (!/EPERM|EACCES|EBUSY/i.test(String(e && e.code))) break;
      const end = Date.now() + 30 * (i + 1);
      while (Date.now() < end) { /* 等锁释放 */ }
    }
  }
  if (lastErr) { try { fs.unlinkSync(tmp); } catch { /* 忽略 */ } throw lastErr; }
  return payload.length;
}
/** 读 JSON（缺/坏 ⇒ null）。 */
function readJson(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    return o && typeof o === "object" ? o : null;
  } catch { return null; }
}
/** 月份键（`YYYY-MM`）与月龄（当月 = 0，上月 = 1）。 */
function monthKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}
function monthAge(monthKey, now) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthKey ?? ""));
  if (!m) return null;
  const nowIdx = now.getFullYear() * 12 + now.getMonth();
  const thenIdx = Number(m[1]) * 12 + (Number(m[2]) - 1);
  return nowIdx - thenIdx;
}

// ── ① pending 日志 ─────────────────────────────────────────────────────────────
/**
 * 读 `pending-*.jsonl`：**逐行 JSON.parse，坏的跳过并计 `badLines`，不崩整轮**。
 * 同 `memId` 多行 ⇒ 取**最新**（幂等键 = memId）。
 * ⚠️ 只认 `pending-YYYY-MM.jsonl`；`.jsonl.done`（已归档）**不读** —— 这就是"已回填标记"。
 * @returns {{byId:Map<number,object>, badLines:Array<{file:string,line:number,error:string}>, files:string[], totalLines:number}}
 */
export function loadPending(dir) {
  const out = { byId: new Map(), badLines: [], files: [], totalLines: 0 };
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => PENDING_FILE_RE.test(n)).sort(); } catch { return out; }
  for (const name of names) {
    const file = path.join(dir, name);
    out.files.push(file);
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i].trim();
      if (!raw) continue;
      out.totalLines += 1;
      let doc = null;
      try { doc = JSON.parse(raw); } catch (e) {
        out.badLines.push({ file, line: i + 1, error: String(e && e.message ? e.message : e) });
        continue;
      }
      const memId = Number(doc && doc.memId);
      if (!Number.isInteger(memId) || memId <= 0) {
        out.badLines.push({ file, line: i + 1, error: `memId 非法：${JSON.stringify(doc && doc.memId)}` });
        continue;
      }
      const ts = Number(doc.turnTs);
      if (!Number.isFinite(ts) || ts <= 0) {
        out.badLines.push({ file, line: i + 1, error: `turnTs 非法：${JSON.stringify(doc.turnTs)}` });
        continue;
      }
      const rec = {
        memId, turnTs: ts,
        sessionId: normalizeSessionId(doc.sessionId),
        userHeadSha16: String(doc.userHeadSha16 ?? ""),
        textSha16: String(doc.textSha16 ?? ""),
        at: String(doc.at ?? ""), host: String(doc.host ?? ""), file, line: i + 1,
      };
      const prev = out.byId.get(memId);
      if (!prev || (msOf(rec.at) ?? 0) >= (msOf(prev.at) ?? 0)) out.byId.set(memId, rec);
    }
  }
  return out;
}

/**
 * 分片滚动：把「整月每一行都已回填完」的 `pending-YYYY-MM.jsonl` 改名成 `*.jsonl.done`。
 *
 * 为什么要有它：写侧只 append，回填器每次从头扫 ⇒ 一年后单次读取量线性增长（用户跑一年就卡）。
 * 判据（三条同时成立才归档）：
 *   ① 分片月份 **早于** 当月（当月的还要继续追加，不许动）；
 *   ② 每一行都能解析出合法 `memId`（**有坏行就整片不归档** —— 坏行无法判定，宁可多读一次）；
 *   ③ 每一行的 memId 在 `state.json` 里 `state === "done"`（**已回填**）。
 * 归档 = 改名（可逆，`mv back` 即可恢复）；超期分片只在 `prune:true` 时才删。
 *
 * @param {string} dir pending 目录
 * @param {{state?:object, keepMonths?:number, now?:Date, fs?:object, prune?:boolean}} [opts]
 * @returns {{scanned:number, rotated:{file:string,rows:number}[], kept:{file:string,why:string}[], prunable:string[], pruned:string[], errors:string[]}}
 */
export function rotatePending(dir, opts = {}) {
  const fsImpl = opts.fs ?? fs;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const keepMonths = Number.isFinite(Number(opts.keepMonths)) ? Number(opts.keepMonths) : DEFAULT_KEEP_PENDING_MONTHS;
  const prune = opts.prune === true;
  const entries = opts.state && typeof opts.state.entries === "object" && opts.state.entries !== null ? opts.state.entries : {};
  const done = (memId) => entries[String(memId)]?.state === "done";
  const out = { scanned: 0, rotated: [], kept: [], prunable: [], pruned: [], errors: [] };
  let names = [];
  try { names = fsImpl.readdirSync(dir).sort(); } catch { return out; }
  const currentMonth = monthKeyOf(now);
  for (const name of names) {
    const live = PENDING_FILE_RE.exec(name);
    const archived = PENDING_DONE_RE.exec(name);
    out.scanned += 1;
    if (archived) {
      const age = monthAge(`${archived[1]}-${archived[2]}`, now);
      if (age !== null && age > keepMonths) {
        const full = path.join(dir, name);
        if (prune) {
          try { fsImpl.unlinkSync(full); out.pruned.push(full); } catch (e) { out.errors.push(`${name}: ${String(e && e.message ? e.message : e)}`); }
        } else out.prunable.push(full);
      }
      continue;
    }
    if (!live) continue;
    const monthKey = `${live[1]}-${live[2]}`;
    const full = path.join(dir, name);
    if (monthKey >= currentMonth) { out.kept.push({ file: full, why: "current-month" }); continue; }
    let text = "";
    try { text = fsImpl.readFileSync(full, "utf8"); } catch (e) {
      out.errors.push(`${name}: ${String(e && e.message ? e.message : e)}`);
      continue;
    }
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    let rows = 0;
    let blocked = null;
    for (const raw of lines) {
      let doc = null;
      try { doc = JSON.parse(raw); } catch { blocked = "bad-line"; break; }
      const memId = Number(doc && doc.memId);
      if (!Number.isInteger(memId) || memId <= 0) { blocked = "bad-line"; break; }
      if (!done(memId)) { blocked = "not-backed"; break; }
      rows += 1;
    }
    if (blocked) { out.kept.push({ file: full, why: blocked }); continue; }
    const target = full + PENDING_DONE_SUFFIX;
    try {
      fsImpl.renameSync(full, target);
      out.rotated.push({ file: target, rows });
    } catch (e) {
      out.errors.push(`${name}: ${String(e && e.message ? e.message : e)}`);
    }
  }
  return out;
}

// ── ② 库连接（锁超时 + 退避）──────────────────────────────────────────────────
function openDb(file, { readOnly, busyTimeoutMs }) {
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  try { db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) || 5000}`); } catch { /* 只读连接有些 pragma 不生效，无害 */ }
  return db;
}
/** 三级退避重试（`[60,150,400]ms`）；仍失败 ⇒ 抛（调用方整轮退出 rc 3，不写库）。 */
export function withBackoff(fn, opts = {}) {
  const backoff = Array.isArray(opts.backoff) ? opts.backoff : WRITE_BACKOFF_MS;
  const sleep = opts.sleep || ((ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* busy wait 极短 */ } });
  let lastErr = null;
  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    try { return { ok: true, value: fn(attempt) }; } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(msg)) return { ok: false, error: e, retries: attempt };
      if (attempt < backoff.length) sleep(backoff[attempt]);
    }
  }
  return { ok: false, error: lastErr, retries: backoff.length };
}

/**
 * 索引库的「块表」探测（表名不写死）。
 * 候选：`--chunk-table` 显式给的 > {@link CHUNK_TABLE_CANDIDATES} 依次探。
 * 命中后逐一核 {@link CHUNK_TABLE_COLUMNS}；缺列 ⇒ 返回 `missingColumns`（调用方拒动并说清缺哪列）。
 * @returns {{table:string|null, missingColumns:string[], tried:string[]}}
 */
export function detectChunkTable(db, preferred = null) {
  const tried = [];
  const names = [];
  if (preferred) names.push(String(preferred).trim());
  for (const n of CHUNK_TABLE_CANDIDATES) if (!names.includes(n)) names.push(n);
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    tried.push(name);
    let hit = null;
    try { hit = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); } catch { hit = null; }
    if (!hit) continue;
    const cols = new Set();
    try {
      for (const row of db.prepare(`PRAGMA table_info(${name})`).all()) cols.add(String(row.name));
    } catch { /* 取不到列就按缺列处理 */ }
    const missingColumns = CHUNK_TABLE_COLUMNS.filter((c) => !cols.has(c));
    return { table: name, missingColumns, tried };
  }
  return { table: null, missingColumns: [], tried };
}

/**
 * 写口模块解析（**唯一写口**，不新造第二个）。
 * 顺序：`opts.snapshotModule` > env `DSH_MEMORY_SNAPSHOT_MODULE` > {@link SNAPSHOT_MODULE_CANDIDATES}
 * 相对 `HERE` 与 `PKG_ROOT` 各试。都找不到 ⇒ 返回 `{file:null}`（apply 时调用方拒动 rc 3）。
 * @returns {{file:string|null, tried:string[]}}
 */
export function resolveSnapshotModule(opts = {}) {
  const tried = [];
  const explicit = typeof opts.snapshotModule === "string" && opts.snapshotModule.trim() ? opts.snapshotModule.trim() : "";
  const fromEnv = String((opts.env ?? process.env)?.[SNAPSHOT_MODULE_ENV] ?? "").trim();
  const direct = [explicit, fromEnv].filter(Boolean);
  for (const p of direct) {
    const full = path.resolve(p);
    tried.push(full);
    if (fs.existsSync(full)) return { file: full, tried };
  }
  for (const rel of SNAPSHOT_MODULE_CANDIDATES) {
    for (const base of [HERE, PKG_ROOT]) {
      const full = path.resolve(base, rel);
      tried.push(full);
      if (fs.existsSync(full)) return { file: full, tried };
    }
  }
  return { file: null, tried };
}

// ── ③ 取块规则 ─────────────────────────────────────────────────────────────────
/**
 * 从同 `(session_id, ts)` 的块里挑要挂的 id。
 *
 * 规则（写死，防"62 块取哪 8 块"没定义）：
 *   · `user/text`：用 `userHeadSha16` 与**各块前 200 字哈希**比对，只认对得上的那一条消息的
 *     **首块 + 尾块**（长消息被切块时，首块开头就是这 200 字）；
 *   · `assistant/text`：按 `ord` 升序**前 3 块**（且 `ord` 在锚点之后）；
 *   · `reasoning` 一块不取；总数封顶 8；
 *   · **对不上 ⇒ 这一轮不挂**（宁缺毋滥）。
 * @returns {{ids:string[], reason:string, anchorOrd:number|null, detail:object}}
 */
export function pickSourceIds(chunks, headSha16) {
  const rows = (Array.isArray(chunks) ? chunks : []).map((c, i) => ({
    id: Number(c.id), role: String(c.role ?? ""), kind: String(c.kind ?? ""),
    ord: Number.isFinite(Number(c.ord)) ? Number(c.ord) : Number.MAX_SAFE_INTEGER - 1000 + i,
    text: String(c.text ?? ""),
  })).filter((c) => Number.isInteger(c.id) && c.id > 0);
  const userBlocks = rows.filter((c) => c.role === "user" && c.kind === "text").sort((a, b) => a.ord - b.ord);
  if (userBlocks.length === 0) return { ids: [], reason: "no-user-block", anchorOrd: null, detail: { blocks: rows.length } };
  const want = String(headSha16 ?? "");
  if (!want) return { ids: [], reason: "no-head-sha", anchorOrd: null, detail: { blocks: rows.length } };
  const matches = userBlocks.filter((c) => headSha16Of(c.text) === want);
  if (matches.length === 0) {
    return { ids: [], reason: "head-mismatch", anchorOrd: null, detail: { userBlocks: userBlocks.length } };
  }
  const anchor = matches[0];
  // 「同一条消息被切块」的部分：从锚点往后，连续的 user/text 块。
  // 遇到**另起一条同头消息**（同 headSha）就停 —— 那是另一条，不该挂进这一条。
  let last = anchor;
  for (let i = 1; i < userBlocks.length; i += 1) {
    const b = userBlocks[i];
    if (b.ord <= last.ord) continue;
    if (headSha16Of(b.text) === want && b.id !== anchor.id) break;
    last = b;
  }
  const out = [anchor.id, last.id];
  const assist = rows
    .filter((c) => c.role === "assistant" && c.kind === "text" && c.ord > anchor.ord)
    .sort((a, b) => a.ord - b.ord).slice(0, ASSISTANT_PICK);
  for (const a of assist) out.push(a.id);
  const ids = [...new Set(out.map(String))].slice(0, MAX_SOURCES);
  return {
    ids, reason: "ok", anchorOrd: anchor.ord,
    detail: { userFirst: anchor.id, userLast: last.id, assistant: assist.map((a) => a.id), multiBlock: last.id !== anchor.id },
  };
}

// ── ④ 开关与索引闸 ────────────────────────────────────────────────────────────
/** 总闸：env `DSH_MEMORY_LINEAGE=off` 优先 → `config.json#enabled`（缺省开）。 */
export function resolveSwitch(home, env = process.env) {
  const raw = String(env?.DSH_MEMORY_LINEAGE ?? "").trim();
  if (raw) return { enabled: !/^(0|false|off|no)$/i.test(raw), source: "env" };
  const cfg = readJson(path.join(home, "memory-lineage", "config.json"));
  if (cfg && typeof cfg.enabled === "boolean") return { enabled: cfg.enabled, source: "config" };
  return { enabled: true, source: "default" };
}
/**
 * 索引闸（**可选**）：若给了 `--index-log`，看最后一条不是 `done indexRc=` 的记录 ⇒ 视为索引在跑，
 * 本轮跳过（rc 0，不是失败）。没给日志路径 ⇒ 不做这个判断（`running:false`）。
 * @returns {{running:boolean, lastDoneAt:string|null, lastDoneMs:number|null, lastLine:string|null, ageMs:number|null}}
 */
export function indexLockState(indexLogFile) {
  if (!indexLogFile) return { running: false, lastDoneAt: null, lastDoneMs: null, lastLine: null, ageMs: null, skipped: "no-index-log" };
  let text = "";
  try { text = fs.readFileSync(indexLogFile, "utf8"); } catch {
    return { running: false, lastDoneAt: null, lastDoneMs: null, lastLine: null, ageMs: null };
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : null;
  let lastDoneAt = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^\[index-tick ([^\]]+)\] done indexRc=/.exec(lines[i]);
    if (m) { lastDoneAt = m[1]; break; }
  }
  const lastDoneMs = lastDoneAt ? (Date.parse(lastDoneAt.replace(" ", "T")) || null) : null;
  return {
    running: !(last && /done indexRc=/.test(last)),
    lastDoneAt, lastDoneMs,
    lastLine: last,
    ageMs: lastDoneMs ? Date.now() - lastDoneMs : null,
  };
}

// ── ⑤ state.json（权威源 = state.json）────────────────────────────────────────
export function emptyState() { return { v: 1, updatedAt: new Date(0).toISOString(), entries: {}, runs: [] }; }
export function loadState(file) {
  const doc = readJson(file);
  if (!doc || typeof doc !== "object" || typeof doc.entries !== "object" || doc.entries === null) return emptyState();
  if (!Array.isArray(doc.runs)) doc.runs = [];
  return doc;
}
export function saveState(file, doc) {
  doc.v = 1;
  doc.updatedAt = new Date().toISOString();
  if (doc.runs.length > 30) doc.runs = doc.runs.slice(-30);
  writeJsonAtomic(file, doc);
  return doc;
}

// ── ⑥ 回填主逻辑 ──────────────────────────────────────────────────────────────
/**
 * 处理一条 pending（**纯函数式地返回决策**，写库由调用方在同一函数内完成）。
 * @returns {{action:string, reason:string, target?:string, ...}}
 */
export function planOne({ rec, entry, chunks, currentSourceIds }) {
  const nowIso = new Date().toISOString();
  if (String(currentSourceIds ?? "").trim() !== "") {
    return { action: "skip", reason: "already-filled" };
  }
  const picked = pickSourceIds(chunks, rec.userHeadSha16);
  if (picked.ids.length === 0) {
    const first = entry?.first ?? nowIso;
    const ageMs = Date.now() - (msOf(first) ?? Date.now());
    const terminal = (Number(entry?.attempts) || 0) + 1 >= 1 && ageMs >= UNMATCHED_TTL_MS;
    return { action: "unmatched", reason: picked.reason, detail: picked.detail, terminal };
  }
  const target = JSON.stringify(picked.ids);
  const written = Array.isArray(entry?.writtenTargets) ? entry.writtenTargets : [];
  if (entry?.state === "done" && written.some((w) => String(w?.target ?? "") === target)) {
    return { action: "skip", reason: "already-done", target };
  }
  return { action: "write", reason: "ok", target, ids: picked.ids, detail: picked.detail };
}

/**
 * 真回填一轮。
 * @returns {{rc:number, summary:object, events:Array}}
 */
export async function runBackfill(opts) {
  const {
    home, memoryDbFile, lifeDbFile, pendingDir, stateFile, logFile, indexLogFile, alertLogFile,
    apply = false, limit = 0, onlyId = null, ignoreSwitch = false, ignoreIndexLock = false,
    chunkTable = null, snapshotModule = null, keepPendingMonths = DEFAULT_KEEP_PENDING_MONTHS,
    rotate = true, prunePending = false,
    json = false, say = () => {},
  } = opts;
  const t0 = Date.now();
  const events = [];
  const summary = {
    v: BACKFILL_VERSION, at: new Date().toISOString(), mode: apply ? "apply" : "dry-run",
    pending: 0, badLines: 0, candidates: 0, written: 0, skipped: 0, unmatched: 0, blocked: 0,
    badLineDetail: [], events: 0, ms: 0, rc: 0, note: null, rotation: null,
  };

  // ① 开关（写侧零动作、回填零写入）
  const sw = opts.sw || resolveSwitch(home);
  if (apply && !ignoreSwitch && !sw.enabled) {
    summary.note = `switch-off（source=${sw.source}）⇒ 一个字节没写`;
    summary.rc = 3;
    return { rc: 3, summary, events };
  }
  // ② 索引闸：正在索引 ⇒ 本轮跳过（rc 0，不是失败）
  const idx = opts.idx || indexLockState(indexLogFile);
  if (apply && !ignoreIndexLock && idx.running) {
    summary.note = `index-running ⇒ 本轮跳过（日志末行：${String(idx.lastLine ?? "").slice(0, 80)}）`;
    summary.rc = 0;
    return { rc: 0, summary, events };
  }

  // ③ pending
  const pending = loadPending(pendingDir);
  summary.pending = pending.byId.size;
  summary.badLines = pending.badLines.length;
  summary.badLineDetail = pending.badLines.slice(0, 20);
  const state = loadState(stateFile);
  let todo = [...pending.byId.values()].sort((a, b) => a.memId - b.memId);
  if (onlyId) todo = todo.filter((r) => r.memId === Number(onlyId));
  summary.candidates = todo.length;
  if (todo.length === 0) {
    summary.ms = Date.now() - t0;
    summary.rc = 0;
    summary.rotation = rotate && apply ? rotatePending(pendingDir, { state, keepMonths: keepPendingMonths, prune: prunePending }) : null;
    return { rc: 0, summary, events };
  }
  if (limit > 0) todo = todo.slice(0, limit);

  // ③b 写口（apply 时必须能找到；找不到 ⇒ 一个字节不写）
  let snapshot = { file: null, tried: [] };
  if (apply) {
    snapshot = opts.snapshot || resolveSnapshotModule({ snapshotModule });
    if (!snapshot.file) {
      summary.note = `唯一写口未找到（--snapshot / env ${SNAPSHOT_MODULE_ENV} / 候选路径都没命中）⇒ 整轮拒动：`
        + `${snapshot.tried.length ? snapshot.tried.join(" | ") : "（无可试路径）"}`;
      summary.rc = 3;
      return { rc: 3, summary, events };
    }
  }

  // ④ 库（只读索引库 / 读写记忆库）—— 打不开 ⇒ rc 3，一个字节不写
  let life;
  let mem;
  try {
    life = openDb(lifeDbFile, { readOnly: true, busyTimeoutMs: LIFE_BUSY_TIMEOUT_MS });
    mem = openDb(memoryDbFile, { readOnly: !apply, busyTimeoutMs: MEMORY_BUSY_TIMEOUT_MS });
  } catch (e) {
    summary.note = `库打不开 ⇒ 整轮拒动：${e && e.message ? e.message : e}`;
    summary.rc = 3;
    return { rc: 3, summary, events };
  }
  // ④b 块表探测（表名不写死）
  const detected = detectChunkTable(life, chunkTable);
  if (!detected.table || detected.missingColumns.length > 0) {
    try { mem.close(); } catch { /* 忽略 */ }
    try { life.close(); } catch { /* 忽略 */ }
    summary.note = detected.table
      ? `索引库的块表 \`${detected.table}\` 缺列：${detected.missingColumns.join(", ")} ⇒ 整轮拒动（不猜列名）`
      : `索引库里没找到块表（试过：${detected.tried.join(", ")}）⇒ 整轮拒动（可用 --chunk-table 指定）`;
    summary.chunkTable = detected.table;
    summary.rc = 3;
    return { rc: 3, summary, events };
  }
  summary.chunkTable = detected.table;

  const stmtChunks = life.prepare(`SELECT id, role, kind, ord, text FROM ${detected.table} WHERE session_id = ? AND ts = ? ORDER BY ord, id`);
  const stmtCur = mem.prepare("SELECT id, source_ids FROM memories WHERE id = ?");
  const updateSql = "UPDATE memories SET source_ids = ? WHERE id = ? AND source_ids = ''";

  try {
    for (const rec of todo) {
      const entry = state.entries[String(rec.memId)] || null;
      const nowIso = new Date().toISOString();
      const base = { memId: rec.memId, at: nowIso, sessionId: rec.sessionId, turnTs: rec.turnTs };
      // 已终态 unmatched 且未过期 ⇒ 跳过（不再刷 attempts）
      if (entry?.state === "unmatched" && (Date.now() - (msOf(entry.first) ?? Date.now())) >= UNMATCHED_TTL_MS) {
        events.push({ ...base, event: "skip", reason: "unmatched-terminal" });
        summary.skipped += 1;
        continue;
      }
      let chunks = [];
      try { chunks = stmtChunks.all(rec.sessionId, rec.turnTs); } catch (e) {
        events.push({ ...base, event: "blocked", reason: "life-query-failed", error: String(e && e.message ? e.message : e) });
        summary.blocked += 1;
        state.entries[String(rec.memId)] = {
          ...(entry || { first: nowIso }), last: nowIso, attempts: (Number(entry?.attempts) || 0) + 1,
          state: "blocked", reason: "life-query-failed", lastError: String(e && e.message ? e.message : e),
        };
        continue;
      }
      if (chunks.length === 0) {
        const attempts = (Number(entry?.attempts) || 0) + 1;
        const first = entry?.first ?? nowIso;
        const terminal = Date.now() - (msOf(first) ?? Date.now()) >= UNMATCHED_TTL_MS;
        state.entries[String(rec.memId)] = {
          first, last: nowIso, attempts, state: terminal ? "unmatched" : "pending",
          reason: "no-chunks", sessionId: rec.sessionId, turnTs: rec.turnTs,
        };
        events.push({ ...base, event: "unmatched", reason: "no-chunks", attempts, terminal });
        summary.unmatched += 1;
        continue;
      }
      let cur = null;
      try { cur = stmtCur.get(rec.memId); } catch (e) {
        events.push({ ...base, event: "blocked", reason: "memory-read-failed", error: String(e && e.message ? e.message : e) });
        summary.blocked += 1;
        continue;
      }
      if (!cur) {
        state.entries[String(rec.memId)] = {
          ...(entry || { first: nowIso }), last: nowIso, attempts: (Number(entry?.attempts) || 0) + 1,
          state: "blocked", reason: "memory-not-found",
        };
        events.push({ ...base, event: "blocked", reason: "memory-not-found" });
        summary.blocked += 1;
        continue;
      }
      const plan = planOne({ rec, entry, chunks, currentSourceIds: cur.source_ids });
      if (plan.action === "skip") {
        events.push({ ...base, event: "skip", reason: plan.reason, target: plan.target ?? null });
        summary.skipped += 1;
        continue;
      }
      if (plan.action === "unmatched") {
        const attempts = (Number(entry?.attempts) || 0) + 1;
        const first = entry?.first ?? nowIso;
        state.entries[String(rec.memId)] = {
          first, last: nowIso, attempts, state: plan.terminal ? "unmatched" : "pending",
          reason: plan.reason, detail: plan.detail, sessionId: rec.sessionId, turnTs: rec.turnTs,
        };
        events.push({ ...base, event: "unmatched", reason: plan.reason, attempts, detail: plan.detail });
        summary.unmatched += 1;
        continue;
      }
      // ── 写：先用唯一写口留痕（fail-closed），拿到放行才 UPDATE
      if (!apply) {
        events.push({ ...base, event: "would-write", target: plan.target, ids: plan.ids, detail: plan.detail });
        state.entries[String(rec.memId)] = {
          ...(entry || { first: nowIso }), last: nowIso,
          attempts: (Number(entry?.attempts) || 0) + 1, state: "pending",
          reason: "dry-run", sessionId: rec.sessionId, turnTs: rec.turnTs,
        };
        continue;
      }
      let snap = null;
      try {
        const mod = await import(new URL(`file:///${snapshot.file.replace(/\\/g, "/")}`).href);
        if (typeof mod.snapshotBeforeUpdate !== "function") {
          throw Object.assign(new Error(`写口模块没有导出 snapshotBeforeUpdate：${snapshot.file}`), { code: "E_SNAPSHOT_NO_EXPORT" });
        }
        snap = mod.snapshotBeforeUpdate({
          db: mem, dbPath: memoryDbFile, id: rec.memId,
          reason: `lineage backfill: source_ids ← ${plan.ids.join(",")}（轮级锚点）`,
          home, storeKind: "owner", by: "lineage-backfill",
        });
      } catch (e) {
        const code = String(e && e.code ? e.code : "E_SNAPSHOT");
        state.entries[String(rec.memId)] = {
          ...(entry || { first: nowIso }), last: nowIso, attempts: (Number(entry?.attempts) || 0) + 1,
          state: "blocked", reason: `snapshot:${code}`, lastError: String(e && e.message ? e.message : e),
          sessionId: rec.sessionId, turnTs: rec.turnTs,
        };
        events.push({ ...base, event: "blocked", reason: `snapshot:${code}`, error: String(e && e.message ? e.message : e), target: plan.target });
        summary.blocked += 1;
        continue;
      }
      // 写口放行了：**skipped:true 也照样 UPDATE**，并核 changes===1
      let changes = 0;
      let writeErr = null;
      const wr = withBackoff(() => {
        try {
          mem.exec("BEGIN IMMEDIATE");
          const r = mem.prepare(updateSql).run(plan.target, rec.memId);
          const n = Number(r && r.changes);
          mem.exec("COMMIT");
          return n;
        } catch (e) {
          try { mem.exec("ROLLBACK"); } catch { /* 忽略 */ }
          throw e;
        }
      });
      if (!wr.ok) writeErr = String(wr.error && wr.error.message ? wr.error.message : wr.error);
      else changes = Number(wr.value) || 0;
      if (writeErr || changes !== 1) {
        const reason = writeErr ? "update-failed" : `update-not-applied(changes=${changes})`;
        state.entries[String(rec.memId)] = {
          ...(entry || { first: nowIso }), last: nowIso, attempts: (Number(entry?.attempts) || 0) + 1,
          state: "blocked", reason, lastError: writeErr || null, target: plan.target,
          archive: snap?.beforeRef ?? null, ledgerSeq: snap?.seq ?? null,
          snapshotSkipped: snap?.skipped === true, sessionId: rec.sessionId, turnTs: rec.turnTs,
        };
        events.push({ ...base, event: "blocked", reason, error: writeErr, changes, target: plan.target, archive: snap?.beforeRef ?? null });
        summary.blocked += 1;
        continue;
      }
      const writtenTargets = Array.isArray(entry?.writtenTargets) ? entry.writtenTargets.slice(-3) : [];
      writtenTargets.push({ target: plan.target, at: nowIso });
      state.entries[String(rec.memId)] = {
        first: entry?.first ?? nowIso, last: nowIso, attempts: (Number(entry?.attempts) || 0) + 1,
        state: "done", reason: "ok", target: plan.target, ids: plan.ids,
        writtenAt: nowIso, archive: snap?.beforeRef ?? null, archiveFile: snap?.archiveFile ?? null,
        ledgerSeq: snap?.seq ?? null, snapshotSkipped: snap?.skipped === true,
        sessionId: rec.sessionId, turnTs: rec.turnTs, writtenTargets,
      };
      events.push({
        ...base, event: "written", target: plan.target, ids: plan.ids, changes,
        snapshotSkipped: snap?.skipped === true, archive: snap?.beforeRef ?? null, ledgerSeq: snap?.seq ?? null,
        detail: plan.detail,
      });
      summary.written += 1;
    }
  } finally {
    try { mem && mem.close(); } catch { /* 忽略 */ }
    try { life && life.close(); } catch { /* 忽略 */ }
  }

  summary.events = events.length;
  summary.ms = Date.now() - t0;
  // ⑤ state：apply 模式才落盘（dry-run 零写入）
  let stateSaved = false;
  if (apply) {
    state.runs.push({
      at: summary.at, mode: summary.mode, written: summary.written, skipped: summary.skipped,
      unmatched: summary.unmatched, blocked: summary.blocked, badLines: summary.badLines, ms: summary.ms,
    });
    try { saveState(stateFile, state); stateSaved = true; } catch (e) {
      // state 是权威源：落盘失败 ⇒ 本轮**如实报红**（不静默）；但已写的库值不回退
      // （幂等有第二道保险 = `source_ids` 已非空则跳过，所以下次重跑不会重复写）
      summary.note = [summary.note, `state.json 落盘失败：${e && e.message ? e.message : e}`].filter(Boolean).join("｜");
    }
  }
  // ⑤b pending 分片滚动（整月都回填完的分片改名归档；缺省只改名、不删）
  if (apply && rotate && stateSaved) {
    try {
      summary.rotation = rotatePending(pendingDir, { state, keepMonths: keepPendingMonths, prune: prunePending });
    } catch (e) {
      summary.rotation = { errors: [String(e && e.message ? e.message : e)] };
    }
  }
  // ⑥ 日志 + 告警
  const rc = summary.blocked > 0 ? 4 : (apply && !stateSaved ? 4 : 0);
  summary.rc = rc;
  summary.stateSaved = stateSaved;
  const line = { ts: summary.at, v: BACKFILL_VERSION, event: apply ? "run" : "dry", written: summary.written, skipped: summary.skipped, unmatched: summary.unmatched, blocked: summary.blocked, badLines: summary.badLines, pending: summary.pending, ms: summary.ms, stateSaved, rc };
  if (logFile && !opts.noLog) appendLogLine(logFile, line);
  if (apply && rc !== 0 && alertLogFile) {
    appendAlertLine(alertLogFile, `lineage-backfill rc=${rc} blocked=${summary.blocked}${stateSaved ? "" : " state-save-failed"}（明细：state.json / 日志）`);
  }
  return { rc, summary, events };
}

function appendLogLine(file, doc) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(doc) + "\n", "utf8"); } catch { /* 日志失败不改主流程 */ }
}
/** 失败告警：**一行**（只在给了 `--alert-log` 时才写）。 */
export function appendAlertLine(file, text) {
  try { fs.appendFileSync(file, `[${new Date().toISOString()}] lineage-backfill 失败：${text}\n`, "utf8"); return true; } catch { return false; }
}

// ── ⑦ 读数（--report / --recheck）─────────────────────────────────────────────
/** 批量取 id → 行（一次 prepare，供 report/recheck 的循环用）。 */
export function makeChunkLookup(life, table = "chunks") {
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(table)) ? String(table) : "chunks";
  const stmt = life.prepare(`SELECT id, session_id FROM ${name} WHERE id = ?`);
  return (id) => {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    try { return stmt.get(n) ?? null; } catch { return null; }
  };
}
export function parseSourceIds(raw) {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const doc = JSON.parse(raw);
    return Array.isArray(doc) ? doc.filter((x) => typeof x === "string" && x.length > 0) : [];
  } catch { return []; }
}

/**
 * 覆盖率读数（五条口径）。
 * 五数：总分母 / 结构性分母 / 分子 / 存活率 / 抽样（抽样 = 人工，本器只标"待人工"，绝不代编）。
 */
export async function runReport(opts) {
  const { home, memoryDbFile, lifeDbFile, pendingDir, days = DEFAULT_DAYS, json = false, chunkTable = null } = opts;
  const asOf = new Date();
  const since = asOf.getTime() - days * 86400000;
  const out = {
    v: BACKFILL_VERSION, kind: "report", asOf: asOf.toISOString(), days,
    since: new Date(since).toISOString(), ok: false, error: null, chunkTable: null,
    total: 0, structural: 0, numerator: 0, coverage: null,
    markers: [], markersUnion: 0, buckets: {}, missing: null, missingSinceP1: null,
    p1Since: null, live: null, notes: [],
  };
  let mem; let life;
  try {
    mem = openDb(memoryDbFile, { readOnly: true, busyTimeoutMs: MEMORY_BUSY_TIMEOUT_MS });
  } catch (e) {
    out.error = `记忆库打不开（${memoryDbFile}）：${e && e.message ? e.message : e}`;
    return { rc: 3, report: out };
  }
  try {
    life = openDb(lifeDbFile, { readOnly: true, busyTimeoutMs: LIFE_BUSY_TIMEOUT_MS });
    const detected = detectChunkTable(life, chunkTable);
    if (!detected.table || detected.missingColumns.length > 0) {
      throw new Error(detected.table
        ? `块表 \`${detected.table}\` 缺列：${detected.missingColumns.join(", ")}`
        : `没找到块表（试过：${detected.tried.join(", ")}）`);
    }
    out.chunkTable = detected.table;
  } catch (e) {
    try { mem.close(); } catch { /* 忽略 */ }
    out.error = `索引库不可用（${lifeDbFile}）：${e && e.message ? e.message : e} ⇒ 拒出数（不猜）`;
    return { rc: 3, report: out };
  }
  try {
    const q = (sql, ...a) => Number(mem.prepare(sql).get(...a)?.c ?? 0);
    out.total = q("SELECT count(*) c FROM memories WHERE created_at >= ?", since);
    for (const m of NON_MW_MARKERS) {
      out.markers.push({ id: m.id, why: m.why, sql: m.sql, count: q(`SELECT count(*) c FROM memories WHERE created_at >= ? AND (${m.sql})`, since) });
    }
    const unionSql = NON_MW_MARKERS.map((m) => `(${m.sql})`).join(" OR ");
    out.markersUnion = NON_MW_MARKERS.length ? q(`SELECT count(*) c FROM memories WHERE created_at >= ? AND (${unionSql})`, since) : 0;
    out.structural = Math.max(0, out.total - out.markersUnion);
    // 分子：窗口内 source_ids 非空 且 ≥1 个 id 能在索引库里查到
    const rows = mem.prepare("SELECT id, source_ids, created_at FROM memories WHERE created_at >= ? AND source_ids IS NOT NULL AND source_ids <> ''").all(since);
    const lookup = makeChunkLookup(life, out.chunkTable);
    let hit = 0; let deadOnly = 0; let idsTotal = 0; let idsAlive = 0; let rowsAllAlive = 0; const deadSamples = [];
    for (const r of rows) {
      const ids = parseSourceIds(r.source_ids);
      idsTotal += ids.length;
      let alive = 0;
      for (const id of ids) if (lookup(id)) alive += 1;
      idsAlive += alive;
      if (alive >= 1) hit += 1;
      else { deadOnly += 1; if (deadSamples.length < 5) deadSamples.push(Number(r.id)); }
      if (ids.length > 0 && alive === ids.length) rowsAllAlive += 1;
    }
    out.numerator = hit;
    out.coverage = out.structural > 0 ? Number((hit / out.structural).toFixed(4)) : null;
    out.live = {
      rows: rows.length, idsTotal, idsAlive,
      byId: idsTotal ? Number((idsAlive / idsTotal).toFixed(4)) : null,
      byRow: rows.length ? Number((rowsAllAlive / rows.length).toFixed(4)) : null,
      deadOnly, deadSamples,
    };
    // 分档（hit / pending / unmatched / blocked / stale）
    const pending = loadPending(pendingDir);
    const state = loadState(path.join(home, "memory-lineage", "state.json"));
    const inWindow = new Set(mem.prepare("SELECT id FROM memories WHERE created_at >= ?").all(since).map((r) => Number(r.id)));
    const p1 = [...pending.byId.values()].map((r) => msOf(r.at)).filter((x) => x !== null);
    const p1Since = p1.length ? new Date(Math.min(...p1)).toISOString() : null;
    out.p1Since = p1Since;
    const pendingInWindow = [...pending.byId.values()].filter((r) => inWindow.has(r.memId));
    const filled = new Set(rows.map((r) => Number(r.id)));
    const st = { pending: 0, unmatched: 0, blocked: 0 };
    for (const [id, e] of Object.entries(state.entries)) {
      if (!inWindow.has(Number(id))) continue;
      if (filled.has(Number(id))) continue;
      if (e.state === "blocked") st.blocked += 1;
      else if (e.state === "unmatched") st.unmatched += 1;
      else st.pending += 1;
    }
    out.buckets = {
      hit, pending: Math.max(0, pendingInWindow.length - hit - st.blocked - st.unmatched),
      unmatched: st.unmatched, blocked: st.blocked, deadOnly,
      silentPendingNoLog: Math.max(0, out.structural - (hit + pendingInWindow.length)),
    };
    out.missing = Math.max(0, out.structural - pendingInWindow.length);
    if (p1Since) {
      const sinceP1 = msOf(p1Since);
      const totalP1 = q("SELECT count(*) c FROM memories WHERE created_at >= ?", sinceP1);
      const markersP1 = q(`SELECT count(*) c FROM memories WHERE created_at >= ? AND (${unionSql})`, sinceP1);
      const pendingP1 = [...pending.byId.values()].filter((r) => (msOf(r.at) ?? 0) >= sinceP1).length;
      out.missingSinceP1 = { since: p1Since, total: totalP1, structural: Math.max(0, totalP1 - markersP1), pending: pendingP1, missing: Math.max(0, Math.max(0, totalP1 - markersP1) - pendingP1) };
    }
    out.notes.push("抽样准确率 = 人工 30 条，本器**不代劳**、不编数字");
    if (out.missing !== null && out.missingSinceP1) out.notes.push("`失踪数` 分两个数报：全窗（含上线前的历史行，必缺）与上线起算（才有意义）");
    out.ok = true;
    return { rc: 0, report: out };
  } catch (e) {
    out.error = `读数失败：${e && e.message ? e.message : e}`;
    return { rc: 3, report: out };
  } finally {
    try { mem.close(); } catch { /* 忽略 */ }
    try { life.close(); } catch { /* 忽略 */ }
  }
}

/** 存活率重算（**只读**）：已挂 id 还在索引库里吗 + 越界检查。 */
export async function runRecheck(opts) {
  const { home, memoryDbFile, lifeDbFile, pendingDir, days = 0, chunkTable = null } = opts;
  const asOf = new Date();
  const out = {
    v: BACKFILL_VERSION, kind: "recheck", asOf: asOf.toISOString(), days: days || null, chunkTable: null,
    ok: false, error: null, rows: 0, idsTotal: 0, idsAlive: 0, rowsAllAlive: 0, rowsAnyAlive: 0,
    byId: null, byRow: null, outOfSession: 0, overCap: 0, samples: [],
  };
  let mem; let life;
  try { mem = openDb(memoryDbFile, { readOnly: true, busyTimeoutMs: MEMORY_BUSY_TIMEOUT_MS }); } catch (e) {
    out.error = `记忆库打不开：${e && e.message ? e.message : e}`; return { rc: 3, recheck: out };
  }
  try {
    life = openDb(lifeDbFile, { readOnly: true, busyTimeoutMs: LIFE_BUSY_TIMEOUT_MS });
    const detected = detectChunkTable(life, chunkTable);
    if (!detected.table || detected.missingColumns.length > 0) {
      throw new Error(detected.table
        ? `块表 \`${detected.table}\` 缺列：${detected.missingColumns.join(", ")}`
        : `没找到块表（试过：${detected.tried.join(", ")}）`);
    }
    out.chunkTable = detected.table;
  } catch (e) {
    try { mem.close(); } catch { /* 忽略 */ }
    out.error = `索引库不可用：${e && e.message ? e.message : e} ⇒ 拒出数（不猜）`;
    return { rc: 3, recheck: out };
  }
  try {
    const since = days > 0 ? Date.now() - days * 86400000 : 0;
    const rows = mem.prepare(`SELECT id, source_ids, created_at FROM memories WHERE source_ids IS NOT NULL AND source_ids <> ''${since ? " AND created_at >= ?" : ""}`).all(...(since ? [since] : []));
    const pending = loadPending(pendingDir);
    const lookup = makeChunkLookup(life, out.chunkTable);
    out.rows = rows.length;
    for (const r of rows) {
      const ids = parseSourceIds(r.source_ids);
      if (ids.length > MAX_SOURCES) out.overCap += 1;
      let alive = 0;
      const pend = pending.byId.get(Number(r.id));
      for (const id of ids) {
        const row = lookup(id);
        if (row) {
          alive += 1;
          if (pend && String(row.session_id ?? "") !== pend.sessionId) out.outOfSession += 1;
        } else if (out.samples.length < 5) {
          out.samples.push({ memId: Number(r.id), deadId: String(id) });
        }
      }
      out.idsTotal += ids.length;
      out.idsAlive += alive;
      if (alive === ids.length && ids.length > 0) out.rowsAllAlive += 1;
      if (alive > 0) out.rowsAnyAlive += 1;
    }
    out.byId = out.idsTotal ? Number((out.idsAlive / out.idsTotal).toFixed(4)) : null;
    out.byRow = out.rows ? Number((out.rowsAllAlive / out.rows).toFixed(4)) : null;
    out.ok = true;
    return { rc: 0, recheck: out };
  } catch (e) {
    out.error = `重算失败：${e && e.message ? e.message : e}`;
    return { rc: 3, recheck: out };
  } finally {
    try { mem.close(); } catch { /* 忽略 */ }
    try { life.close(); } catch { /* 忽略 */ }
  }
}

// ── ⑧ CLI ─────────────────────────────────────────────────────────────────────
export const CLI_HELP = `lineage-backfill.mjs v${BACKFILL_VERSION} —— 索引后回填 memories.source_ids（观察级血缘）

  node lineage-backfill.mjs --report [--days 7]     覆盖率读数（只读 · 三数 + asOf + 分档 + 存活率）
  node lineage-backfill.mjs --recheck [--days 7]    存活率重算（只读）
  node lineage-backfill.mjs [--apply]               回填（缺省 dry-run；--apply 才写）
     [--limit N] [--id <memId>] [--json]
     [--home <dir>] [--memory-db <f>] [--life-db <f>] [--chunk-table <name>]
     [--state <f>] [--pending-dir <dir>] [--log <f>] [--no-log]
     [--snapshot <f>] [--index-log <f>] [--alert-log <f>]
     [--keep-pending-months N] [--no-rotate] [--prune-pending]
     [--ignore-switch] [--ignore-index-lock]
退出码：0 成功/无事可做 · 2 用法错 · 3 整轮拒动（一个字节没写）· 4 部分 blocked · 1 其它

写口（唯一）：默认自动找 memory-db-tools/memory-snapshot.mjs；找不到就拒写（rc 3），
             可用 --snapshot <file> 或 env ${SNAPSHOT_MODULE_ENV} 指定。
pending 分片：整月都已回填完的自动改名 *.jsonl.done（不再被读）；超期分片缺省只列不删。`;

function parseArgs(argv) {
  const o = {
    mode: "backfill", apply: false, days: DEFAULT_DAYS, daysSet: false, limit: 0, onlyId: null, json: false,
    home: null, memoryDb: null, lifeDb: null, state: null, pendingDir: null, log: null, noLog: false,
    chunkTable: null, snapshot: null, indexLog: null, alertLog: null,
    keepPendingMonths: DEFAULT_KEEP_PENDING_MONTHS, rotate: true, prunePending: false,
    ignoreSwitch: false, ignoreIndexLock: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--report") o.mode = "report";
    else if (a === "--recheck") o.mode = "recheck";
    else if (a === "--apply") o.apply = true;
    else if (a === "--dry-run") o.apply = false;
    else if (a === "--days") { o.days = Number(next()) || DEFAULT_DAYS; o.daysSet = true; }
    else if (a === "--limit") o.limit = Number(next()) || 0;
    else if (a === "--id") o.onlyId = Number(next()) || null;
    else if (a === "--json") o.json = true;
    else if (a === "--home") o.home = next();
    else if (a === "--memory-db") o.memoryDb = next();
    else if (a === "--life-db") o.lifeDb = next();
    else if (a === "--chunk-table") o.chunkTable = next();
    else if (a === "--state") o.state = next();
    else if (a === "--pending-dir") o.pendingDir = next();
    else if (a === "--log") o.log = next();
    else if (a === "--no-log") o.noLog = true;
    else if (a === "--snapshot") o.snapshot = next();
    else if (a === "--index-log") o.indexLog = next();
    else if (a === "--alert-log") o.alertLog = next();
    else if (a === "--keep-pending-months") o.keepPendingMonths = Number(next());
    else if (a === "--no-rotate") o.rotate = false;
    else if (a === "--prune-pending") o.prunePending = true;
    else if (a === "--ignore-switch") o.ignoreSwitch = true;
    else if (a === "--ignore-index-lock") o.ignoreIndexLock = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else { o.unknown = a; }
  }
  return o;
}
function resolvePaths(o) {
  const home = path.resolve(String(o.home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh")));
  return {
    home,
    memoryDbFile: path.resolve(String(o.memoryDb || path.join(home, "memory", "memory.db"))),
    lifeDbFile: path.resolve(String(o.lifeDb || path.join(home, "memory-life", "life.db"))),
    pendingDir: path.resolve(String(o.pendingDir || path.join(home, "memory-lineage"))),
    stateFile: path.resolve(String(o.state || path.join(home, "memory-lineage", "state.json"))),
    logFile: path.resolve(String(o.log || path.join(home, "memory-lineage", "backfill.log"))),
    indexLogFile: o.indexLog ? path.resolve(String(o.indexLog)) : (process.env.DSH_LINEAGE_INDEX_LOG ? path.resolve(String(process.env.DSH_LINEAGE_INDEX_LOG)) : null),
    alertLogFile: o.alertLog ? path.resolve(String(o.alertLog)) : null,
  };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(CLI_HELP + "\n"); return 0; }
  if (o.unknown) { process.stderr.write(`未知参数：${o.unknown}\n${CLI_HELP}\n`); return 2; }
  const p = resolvePaths(o);
  if (o.mode === "report") {
    const { rc, report } = await runReport({ ...p, days: o.days, chunkTable: o.chunkTable });
    if (o.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else process.stdout.write(renderReport(report) + "\n");
    return rc;
  }
  if (o.mode === "recheck") {
    // 存活率默认看**全部**已挂 id（`--days` 只在显式给了才收窄）
    const days = o.daysSet ? o.days : 0;
    const { rc, recheck } = await runRecheck({ ...p, days, chunkTable: o.chunkTable });
    if (o.json) process.stdout.write(JSON.stringify(recheck, null, 2) + "\n");
    else process.stdout.write(renderRecheck(recheck) + "\n");
    return rc;
  }
  const { rc, summary, events } = await runBackfill({
    ...p, apply: o.apply, limit: o.limit, onlyId: o.onlyId, json: o.json,
    chunkTable: o.chunkTable, snapshotModule: o.snapshot,
    keepPendingMonths: o.keepPendingMonths, rotate: o.rotate, prunePending: o.prunePending,
    ignoreSwitch: o.ignoreSwitch, ignoreIndexLock: o.ignoreIndexLock, noLog: o.noLog,
  });
  if (o.json) process.stdout.write(JSON.stringify({ ...summary, events }, null, 2) + "\n");
  else process.stdout.write(renderBackfill(summary, events) + "\n");
  return rc;
}

export function renderBackfill(summary, events) {
  const L = [];
  L.push(`=== 回填（${summary.mode}）· ${summary.at} ===`);
  if (summary.note) L.push(`⚠️ ${summary.note}`);
  if (summary.chunkTable) L.push(`块表 ${summary.chunkTable}`);
  L.push(`pending ${summary.pending} 条 · 坏行 ${summary.badLines} · 候选 ${summary.candidates}`);
  L.push(`写入 ${summary.written} · 跳过 ${summary.skipped} · 未命中 ${summary.unmatched} · blocked ${summary.blocked} · ${summary.ms} ms`);
  for (const e of events.slice(0, 40)) {
    L.push(`  · ${e.event} #${e.memId}${e.reason ? ` (${e.reason})` : ""}${e.target ? ` ← ${e.target}` : ""}${e.changes !== undefined ? ` changes=${e.changes}` : ""}`);
  }
  if (events.length > 40) L.push(`  … 其余 ${events.length - 40} 条见日志`);
  if (summary.rotation) {
    const r = summary.rotation;
    L.push(`pending 分片：已归档 ${r.rotated?.length ?? 0} · 保留 ${r.kept?.length ?? 0} · 超期可删 ${r.prunable?.length ?? 0} · 已删 ${r.pruned?.length ?? 0}`);
    for (const e of r.errors ?? []) L.push(`  ⚠️ ${e}`);
  }
  L.push(`rc=${summary.rc}`);
  return L.join("\n");
}

export function renderReport(r) {
  const L = [];
  L.push(`=== 覆盖率读数 · asOf ${r.asOf} · 窗口 ${r.days} 天（since ${r.since}）===`);
  if (!r.ok) { L.push(`❌ ${r.error}`); return L.join("\n"); }
  if (r.chunkTable) L.push(`块表 = ${r.chunkTable}`);
  L.push(`① 总分母            = ${r.total}（近 ${r.days} 天 created_at 新增）`);
  for (const m of r.markers) L.push(`   ├ 剔除 ${m.id.padEnd(10)} = ${m.count}（${m.why}）`);
  L.push(`   └ 剔除合计（去重）  = ${r.markersUnion}`);
  L.push(`② 结构性分母        = ${r.structural}`);
  L.push(`③ 分子              = ${r.numerator}（source_ids 非空 且 ≥1 个 id 在索引库里查得到）`);
  L.push(`   覆盖率            = ${r.coverage === null ? "分母为 0，拒出数" : `${(r.coverage * 100).toFixed(2)}%（${r.numerator}/${r.structural}）`}`);
  L.push(`④ 存活率（--recheck）= ${r.live && r.live.byId !== null ? `按 id ${(r.live.byId * 100).toFixed(2)}% · 按行(全活) ${(r.live.byRow * 100).toFixed(2)}%` : "暂无已挂 id"}`);
  L.push(`⑤ 抽样准确率        = 待人工 30 条（本器不代劳）`);
  L.push(`分档：hit ${r.buckets.hit} · pending ${r.buckets.pending} · unmatched ${r.buckets.unmatched} · blocked ${r.buckets.blocked} · 血缘全失效 ${r.buckets.deadOnly}`);
  L.push(`失踪数（结构性分母 − 有 pending 记录）= ${r.missing}`);
  if (r.missingSinceP1) L.push(`失踪数（上线起算 since ${r.missingSinceP1.since}）= ${r.missingSinceP1.missing}（分母 ${r.missingSinceP1.structural} / pending ${r.missingSinceP1.pending}）`);
  for (const n of r.notes) L.push(`注：${n}`);
  return L.join("\n");
}

export function renderRecheck(r) {
  const L = [];
  L.push(`=== 存活率重算（只读）· asOf ${r.asOf}${r.days ? ` · 窗口 ${r.days} 天` : ""} ===`);
  if (!r.ok) { L.push(`❌ ${r.error}`); return L.join("\n"); }
  if (r.chunkTable) L.push(`块表 = ${r.chunkTable}`);
  L.push(`有 source_ids 的记忆 = ${r.rows} 行 · 挂的 id 共 ${r.idsTotal} 个`);
  L.push(`按 id 存活 = ${r.byId === null ? "n/a" : `${(r.byId * 100).toFixed(2)}%（${r.idsAlive}/${r.idsTotal}）`}`);
  L.push(`按行（全部 id 都活）= ${r.byRow === null ? "n/a" : `${(r.byRow * 100).toFixed(2)}%（${r.rowsAllAlive}/${r.rows}）`} · 至少 1 个活 = ${r.rowsAnyAlive}`);
  L.push(`越界（id 的 session_id ≠ pending 的 sessionId）= ${r.outOfSession} · 超上限（>${MAX_SOURCES} 条）= ${r.overCap}`);
  if (r.samples.length) L.push(`失效样例：${r.samples.map((s) => `#${s.memId}→${s.deadId}`).join("、")}`);
  return L.join("\n");
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  main().then((rc) => { process.exitCode = rc; }).catch((e) => {
    process.stderr.write(`[lineage-backfill] 未捕获异常：${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 1;
  });
}

export default {
  BACKFILL_VERSION, DEFAULT_DAYS, MAX_SOURCES, HEAD_CHARS, NON_MW_MARKERS,
  CHUNK_TABLE_CANDIDATES, CHUNK_TABLE_COLUMNS, SNAPSHOT_MODULE_CANDIDATES, SNAPSHOT_MODULE_ENV,
  PENDING_FILE_RE, PENDING_DONE_RE, DEFAULT_KEEP_PENDING_MONTHS,
  sha16, squeeze, headSha16Of, normalizeSessionId, loadPending, rotatePending, pickSourceIds, planOne,
  detectChunkTable, resolveSnapshotModule, resolveSwitch, indexLockState, loadState, saveState,
  runBackfill, runReport, runRecheck,
  withBackoff, writeJsonAtomic, parseSourceIds, renderBackfill, renderReport, renderRecheck,
};
