#!/usr/bin/env node
/**
 * memory-snapshot.mjs —— 记忆「改正文」留痕的**唯一写口**（记忆引擎第 4 期补 · 改留痕）
 *
 * 为什么要它：第 4 期只接了「删」——`memory_forget` 一条走归档 + 台账，删了能查回原文；
 * 而**改**（外部脚本 `UPDATE memories SET text=?`）旧正文就地蒸发、台账一个字不写。
 * 本件把「改」也做成可回溯：**先落旧行全文 + 记一行指针，才允许 UPDATE**。
 *
 * 口径真源：
 *   · 变更留痕方案 §3.2 台账行格式 / §3.3 落点 / §3.5 顺序铁律（内部设计档，不随仓分发）
 *   · 删侧实现 = 插件部署实体 `dsh-memory/lib/forget-ledger.mjs`（归档形状、内容哈希、digest、raw append 口径**全部照抄**）
 *     本件是它的**工具侧孪生**：op 从 `forget` 换成 `update`，落点、判重、fail-closed 一模一样。
 *
 * 🔴 硬约束（改这段不许破）：
 *   ① 台账**只放指针**（`beforeRef` 相对归档根），**绝不放正文/摘录** —— 落盘前有一道"正文泄漏自检"，
 *      台账行里出现归档正文的 ≥40 字前缀即中断（宁可不写，也不把记忆正文写进会整体出机的台账）。
 *   ② 归档落点**必须在 home 之外**且**不在快照/备份的收集目录里**：本件硬拒 `<home>` 下的任何路径
 *      （`<home>/memory/removed/` 这种一旦被快照器收进去，就会被周期性整体搬走）。
 *   ③ 顺序铁律（fail-closed）：**写归档（fsync + 回读）→ 写台账（写前判重 + 写后回读）→ 复核 hash → 才允许 UPDATE**。
 *      任一步失败 ⇒ **不执行 UPDATE**，库未改一行；已写的归档留作"半成品痕迹"（体检 `--orphans` 能看到）。
 *   ④ 台账**只 append**：老 26 行一个字节不碰（不重排、不改写）。
 *   ⑤ 幂等：同 `op+memId+hash` 已有行 ⇒ 不重复落（归档缺了就补一份同样的，不写第二行）。
 *
 * 用法（三条：被包、被调、被查）：
 *   # ① 一条命令 + 把 UPDATE 包给它（推荐；快照没过就**不会**执行你的命令）
 *   node memory-db-tools/memory-snapshot.mjs --id 42 --reason "把旧路径改成新路径" \
 *        --wrap-exec "node your-script.mjs --apply"
 *
 *   # ② 只快照、不执行（给外部脚本自己接）：rc 0 才准 UPDATE；rc≠0 一律当作「不许改」
 *   node ...memory-snapshot.mjs --id 42 --reason "..."        # rc 0 ⇒ 写你的 UPDATE
 *
 *   # ③ 改后体检（阴性对照靠它：跳过留痕直接改 ⇒ 必须报红）
 *   node ...memory-snapshot.mjs --verify --id 42
 *   node ...memory-snapshot.mjs --verify --all [--strict-coverage]
 *
 *   # 自检（自带夹具 + 阴性对照，跑在临时库上，不碰生产）
 *   node ...memory-snapshot.mjs --selftest
 *
 * 通用参数：`--db <库>`（缺省 `$DSH_HOME`/`~/.dsh` 的 memory/memory.db）
 *           `--home <dir>` · `--ledger <file>`（缺省 `<home>/memory/retractions.jsonl`，可用 env `DSH_MEMORY_LEDGER`）
 *           `--removed-root <dir>`（缺省 env `DSH_MEMORY_REMOVED_ROOT` → env `DSH_ROOT/_archive/memory-removed/plugin`
 *                                → 都取不到 ⇒ **fail-closed 拒动**；**拒收 home 下路径**）
 *           `--by <who>` · `--host <name>` · `--store owner|family` · `--dry-run` · `--json`
 *
 * 退出码：0 = 成功 / 已幂等 / 体检绿
 *         2 = 用法错 · 3 = fail-closed（任一步没过，**未执行 UPDATE**，库未改一行）
 *         4 = 体检红（改过但查不到留痕 / 指针坏）· 5 = 目标 id 不存在 · 6 = 快照成功但 `--wrap-exec` 的命令失败
 *         1 = 其它异常
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const SNAPSHOT_VERSION = "1.0.0";
export const ARCHIVE_SCHEMA_VERSION = 1;
export const HASH_PREFIX = "sha256:";
/** 台账 `reasonCode`：改留痕不是隐私撤回，统一记 `other`（与 forget 同值，老读器认）。 */
export const UPDATE_REASON_CODE = "other";
/** 归档根**没有缺省值**：必须由 `--removed-root` / `DSH_MEMORY_REMOVED_ROOT` / `DSH_ROOT` 明确给出
 *  （归档里是正文全文，落在会被整体备份的目录里 = 一次备份就把正文搬出本机；见 resolveRemovedRoot）。 */
/** 台账行允许出现的字段白名单 —— 出现别的字段就当作"有人想往台账塞正文"。 */
const LEDGER_ROW_FIELDS = new Set([
  "at", "by", "hash", "owner", "reasonCode", "host", "op", "memId", "beforeRef",
  "beforeBytes", "textLength", "seq", "store", "cause", "reason"
]);

// ── 内容哈希：真源 = `tools\b2-equiv\lib\merge-memory.mjs#contentHashOf`（与插件 forget-ledger 同式）────
function localContentHashOf(text) {
  let s = typeof text === "string" ? text : (text === null || text === undefined ? "" : String(text));
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n?/g, "\n").trim();
  return HASH_PREFIX + crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}
export let contentHashOf = localContentHashOf;
export let hashSource = "builtin(同式)";
{
  const cand = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "b2-equiv", "lib", "merge-memory.mjs");
  try {
    const mod = await import(pathToFileURL(cand).href);
    if (typeof mod.contentHashOf === "function") { contentHashOf = mod.contentHashOf; hashSource = "b2-equiv/lib/merge-memory.mjs"; }
  } catch { /* 兜底：同口径就地实现 */ }
}

export function hash12Of(hash) {
  const s = String(hash ?? "").trim().toLowerCase();
  const hex = s.startsWith(HASH_PREFIX) ? s.slice(HASH_PREFIX.length) : s;
  return /^[0-9a-f]{12,}$/.test(hex) ? hex.slice(0, 12) : "000000000000";
}

/** UTC `YYYYMMDD-HHmmss`（与 forget 归档目录同一形态；别混本地时区）。 */
export function stampNow(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** 归档自校验摘要：除 `archiveSha256` 外其余字段按 key 升序规范化 JSON 的 sha256（与插件同式）。 */
export function archiveDigestOf(body) {
  const entries = Object.entries(body || {})
    .filter(([k]) => k !== "archiveSha256")
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return HASH_PREFIX + crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(entries)), "utf8").digest("hex");
}

export function ledgerPathOf(home) {
  return path.join(path.resolve(String(home)), "memory", "retractions.jsonl");
}

export function isFamilyDbPath(dbPath, home) {
  try {
    return path.dirname(path.resolve(String(dbPath))).toLowerCase() === path.join(path.resolve(String(home)), "family-memory").toLowerCase();
  } catch { return false; }
}

/**
 * 归档根解析。**取到 home 下的路径一律拒**（红线：那儿进快照白名单，记忆正文会出机）。
 * @returns {{root:string, source:string}}
 * @throws {SnapshotError} E_SNAPSHOT_ROOT_INSIDE_HOME
 */
export function resolveRemovedRoot(options = {}) {
  const env = options.env ?? process.env;
  const home = path.resolve(String(options.home || env.DSH_HOME || path.join(os.homedir(), ".dsh")));
  const configured = typeof options.configured === "string" ? options.configured.trim() : "";
  let root;
  let source;
  if (configured) { root = path.resolve(configured); source = "--removed-root / config"; }
  else if (typeof env.DSH_MEMORY_REMOVED_ROOT === "string" && env.DSH_MEMORY_REMOVED_ROOT.trim()) {
    root = path.resolve(env.DSH_MEMORY_REMOVED_ROOT.trim()); source = "env.DSH_MEMORY_REMOVED_ROOT";
  } else if (typeof env.DSH_ROOT === "string" && env.DSH_ROOT.trim()) {
    root = path.join(path.resolve(env.DSH_ROOT.trim()), "_archive", "memory-removed", "plugin"); source = "env.DSH_ROOT";
  } else {
    // 🔴 不给缺省路径：归档里是**正文全文**，落在任何"会被快照/备份整体收集"的目录里 ⇒
    //    一次备份就把正文搬出本机。取不到就先要人明确指定（fail-closed）。
    throw new SnapshotError("E_SNAPSHOT_ROOT_UNSET",
      "归档根未配置 ⇒ 拒动。请给 `--removed-root <dir>`，或设环境变量 `DSH_MEMORY_REMOVED_ROOT` / `DSH_ROOT`。");
  }
  // 🔴 红线守卫：不许落 home 下（也不许落 home 的任何子路径）
  const rel = path.relative(home, root);
  const insideHome = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (insideHome) {
    throw new SnapshotError("E_SNAPSHOT_ROOT_INSIDE_HOME",
      `归档根落在 home 内（${root} ⊂ ${home}）⇒ **拒动**。记忆正文放 home 下 = 进快照/备份白名单 = 会被整体搬出机。`
      + ` 请用 --removed-root 指到 home 之外（或设 DSH_MEMORY_REMOVED_ROOT / DSH_ROOT）。`);
  }
  return { root, source };
}

export class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SnapshotError";
    this.code = code;
  }
}

/** 读台账**原始行**（raw JSON.parse，不过老读器 —— 审扩展字段必须原样） */
export function readLedgerRaw(file) {
  const p = path.resolve(String(file));
  let buf;
  try { buf = fs.readFileSync(p); } catch (e) {
    if (e && e.code === "ENOENT") return { exists: false, rows: [], invalid: [], lines: 0, bytes: 0 };
    throw e;
  }
  const text = buf.toString("utf8");
  const parts = text.split("\n");
  const lines = parts.length > 0 && parts[parts.length - 1] === "" ? parts.slice(0, -1) : parts;
  const rows = [];
  const invalid = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const doc = JSON.parse(line);
      if (doc && typeof doc === "object" && !Array.isArray(doc)) rows.push({ line: i + 1, doc });
      else invalid.push({ line: i + 1, error: "不是对象" });
    } catch (e) { invalid.push({ line: i + 1, error: String(e && e.message ? e.message : e) }); }
  }
  return { exists: true, rows, invalid, lines: lines.length, bytes: buf.length };
}

/** raw 单行 append（O_APPEND + fsync）；**只校验指针字段**，扩展字段透传。 */
export function appendLedgerRowRaw(file, row) {
  const p = path.resolve(String(file));
  const problems = [];
  for (const k of ["at", "by", "hash", "owner", "reasonCode", "host", "op", "memId", "beforeRef"]) {
    if (row[k] === undefined || row[k] === null || String(row[k]).trim() === "") problems.push(`缺 ${k}`);
  }
  if (typeof row.hash === "string" && !/^sha256:[0-9a-f]{16}$/.test(row.hash)) problems.push("hash 形态非法（要 sha256:<16 hex>）");
  for (const k of Object.keys(row)) if (!LEDGER_ROW_FIELDS.has(k)) problems.push(`多余字段 ${k}（台账只放指针，禁塞正文）`);
  if (problems.length > 0) return { ok: false, file: p, error: problems.join("；"), line: "" };
  const line = JSON.stringify(row);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(p, "a");
    try { fs.writeSync(fd, line + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { ok: true, file: p, error: null, line, bytes: fs.statSync(p).size };
  } catch (e) {
    return { ok: false, file: p, error: String(e && e.message ? e.message : e), line };
  }
}

/** 旁挂失败日志（照 forget 先例；never throw）—— 半成品必须留痕可查。 */
export function appendUpdateFailedLog(home, record) {
  try {
    const base = home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
    const dir = path.join(base, "memory-shadow");
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    fs.writeFileSync(path.join(dir, `update-failed-${month}.jsonl`), JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
    return true;
  } catch { return false; }
}

/**
 * 正文泄漏自检：台账行里不许出现归档正文。
 *
 * ⚠️ 2026-11-05 踩到的坑：拿 `JSON.stringify(row)` 去 `includes(正文)` **永远不命中** ——
 *    JSON 会把正文里的 `\` 转义成 `\\`（Windows 路径满篇反斜杠）⇒ 转义后的串与原文对不上。
 *    所以逐**字段值**比（不是比整行 JSON），并且比"归一化后"的形态。
 */
export function assertNoTextLeak(row, text) {
  const norm = (s) => String(s ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  const tn = norm(text);
  if (!tn) return;
  const FRAG = 24;                    // 连 24 字正文片段都不许出现在台账里
  for (const [k, v] of Object.entries(row)) {
    if (typeof v !== "string" || v.length === 0) continue;
    const vn = norm(v);
    if (tn.length >= 8 && vn.includes(tn)) {
      throw new SnapshotError("E_SNAPSHOT_TEXT_LEAK", `台账行字段 \`${k}\` 里出现了归档正文全文 ⇒ 拒写（台账只放指针，红线②）`);
    }
    for (let i = 0; i + FRAG <= tn.length; i += 8) {
      if (vn.includes(tn.slice(i, i + FRAG))) {
        throw new SnapshotError("E_SNAPSHOT_TEXT_LEAK", `台账行字段 \`${k}\` 里带了归档正文的 ${FRAG} 字片段 ⇒ 拒写（台账只放指针，红线②）`);
      }
    }
  }
}

/**
 * 改前留痕（**唯一写口**）：归档旧行 → 台账记一行 `op:"update"` → 复核 hash。
 *
 * 本函数**不动库**（不 UPDATE、不 BEGIN）；它只回答一件事：**"现在可以改了吗"** ——
 * 返回正常 = 可以；抛 `SnapshotError` = 一律当作「不许改」（库未改一行）。
 *
 * @param {object} opts
 * @param {import("node:sqlite").DatabaseSync} opts.db        - 调用方的连接（只用来 SELECT）
 * @param {string} opts.dbPath                               - 库文件绝对路径（写进归档备查）
 * @param {number} opts.id                                   - 目标记忆 id
 * @param {string} opts.reason                               - 为什么要改（人读；**别粘正文**）
 * @param {string} opts.home                                 - DSH home
 * @param {string} [opts.removedRoot]                        - 归档根（缺省按 resolveRemovedRoot 推）
 * @param {string} [opts.removedRootSource]
 * @param {string} [opts.ledgerFile]                         - 缺省 `<home>/memory/retractions.jsonl`
 * @param {"owner"|"family"} [opts.storeKind]
 * @param {string} [opts.by]                                 - 改的人（缺省 = 该条 owner_user）
 * @param {string} [opts.host]
 * @param {string} [opts.expectHash]                          - 可选：防"快照的不是你以为的那版"
 * @param {{afterArchive?:Function, afterLedger?:Function}|null} [opts.hooks] - 夹具注入点（生产 null）
 * @param {Date} [opts.now]                                   - 注入时钟
 * @returns {{ok:true, skipped:boolean, hash:string, beforeRef:string, archiveFile:string, beforeBytes:number, textLength:number, seq:number|null, store:string, ms:number}}
 */
export function snapshotBeforeUpdate(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const startedMs = Date.now();
  const now = o.now instanceof Date ? o.now : new Date();
  const at = now.toISOString();
  const home = path.resolve(String(o.home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh")));
  const host = String(o.host || process.env.COMPUTERNAME || os.hostname());
  const hooks = o.hooks && typeof o.hooks === "object" ? o.hooks : null;
  const db = o.db;
  const id = Number(o.id);
  if (!db) throw new SnapshotError("E_SNAPSHOT_NO_DB", "记忆库连接不可用 ⇒ 未留痕、未改库");
  if (!Number.isInteger(id) || id <= 0) throw new SnapshotError("E_SNAPSHOT_BAD_ID", `id 非法：${String(o.id)}`);

  const ledgerFile = o.ledgerFile ? path.resolve(String(o.ledgerFile))
    : (process.env.DSH_MEMORY_LEDGER ? path.resolve(process.env.DSH_MEMORY_LEDGER) : ledgerPathOf(home));
  const storeKind = o.storeKind === "family" ? "family" : (o.storeKind === "owner" ? "owner" : (isFamilyDbPath(o.dbPath, home) ? "family" : "owner"));
  const rootPick = (o.removedRoot ? { root: path.resolve(String(o.removedRoot)), source: String(o.removedRootSource || "参数") } : resolveRemovedRoot({ configured: "", env: process.env, home }));
  // 走 resolveRemovedRoot 的红线守卫（即便调用方直接传了 removedRoot，也必须过 home 检查）
  const guarded = resolveRemovedRoot({ configured: rootPick.root, env: process.env, home });
  const removedRoot = guarded.root;

  let stampDir = null;
  let archiveFile = null;
  let beforeRef = null;
  let archiveBytes = 0;
  let hash = null;
  let textLength = 0;
  let seq = null;
  let skipped = false;

  try {
    const raw = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    if (!raw) throw new SnapshotError("E_SNAPSHOT_NOT_FOUND", `#${id} 在库里不存在 ⇒ 未留痕、未改库（拒绝凭空插入）`);
    const text = String(raw.text ?? "");
    hash = contentHashOf(text);
    textLength = [...text].length;
    const owner = String(raw.owner_user ?? "").trim() || "unknown";
    if (o.expectHash && String(o.expectHash).trim().toLowerCase() !== hash) {
      throw new SnapshotError("E_SNAPSHOT_EXPECT_MISMATCH", `#${id} 当前 hash ${hash} ≠ 期望 ${o.expectHash} ⇒ 未留痕、未改库（防"快照的不是你以为的那版"）`);
    }

    // ── 幂等第一道：台账里已有同 op+memId+hash ⇒ 不重复落（归档缺了就补一份同样的）
    let ledger;
    try { ledger = readLedgerRaw(ledgerFile); } catch (e) {
      throw new SnapshotError("E_SNAPSHOT_LEDGER_READ", `台账不可读（${ledgerFile}）—— ${e && e.message ? e.message : e} ⇒ 未留痕、未改库`);
    }
    const existed = ledger.rows.find((r) => r.doc && r.doc.op === "update" && Number(r.doc.memId) === id
      && String(r.doc.hash ?? "").toLowerCase() === hash.toLowerCase());
    if (existed) {
      const ref = String(existed.doc.beforeRef ?? "");
      const file = ref ? path.join(removedRoot, ref) : null;
      if (file && fs.existsSync(file)) {
        return { ok: true, skipped: true, hash, beforeRef: ref, archiveFile: file, beforeBytes: fs.statSync(file).size, textLength, seq: existed.doc.seq ?? null, store: storeKind, ms: Date.now() - startedMs };
      }
      // 台账有行、归档丢了 ⇒ 补写同内容同名的归档（**不写第二行**）
      stampDir = path.dirname(file || path.join(removedRoot, stampNow(now), `${id}-${hash12Of(hash)}.json`));
      archiveFile = file || path.join(removedRoot, stampNow(now), `${id}-${hash12Of(hash)}.json`);
      skipped = true;
      void ref;
    }

    // ── ② 写归档（fsync + 回读比对）
    const body = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      op: "update",
      cause: "external_update",
      store: storeKind,
      dbPath: String(o.dbPath || ""),
      memId: id,
      text,
      tags: String(raw.tags ?? ""),
      pinned: Number(raw.pinned ?? 0),
      created_at: Number(raw.created_at ?? 0),
      updated_at: Number(raw.updated_at ?? 0),
      owner_user: owner,
      visibility: String(raw.visibility ?? ""),
      source_ids: String(raw.source_ids ?? ""),
      hash,
      at,
      by: String(o.by || owner),
      host,
      textLength,
      reason: String(o.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
    };
    body.archiveSha256 = archiveDigestOf(body);
    const payload = JSON.stringify(body, null, 2) + "\n";
    if (!stampDir) stampDir = path.join(removedRoot, stampNow(now));
    if (!archiveFile) {
      const base = `${id}-${hash12Of(hash)}`;
      let candidate = path.join(stampDir, `${base}.json`);
      for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(stampDir, `${base}-${n}.json`);
      archiveFile = candidate;
    }
    try {
      fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
      const fd = fs.openSync(archiveFile, "w");
      try { fs.writeSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const back = fs.readFileSync(archiveFile, "utf8");
      if (back !== payload) throw new Error("写入后回读与内存不一致");
    } catch (e) {
      throw new SnapshotError("E_SNAPSHOT_ARCHIVE_WRITE",
        `归档写入失败（${archiveFile}）—— ${e && e.message ? e.message : e} ⇒ **未改库**（顺序铁律：没旧文备份的改写＝救不回来的改写）`);
    }
    archiveBytes = fs.statSync(archiveFile).size;
    beforeRef = path.relative(removedRoot, archiveFile).split(path.sep).join("/");

    if (hooks && typeof hooks.afterArchive === "function") hooks.afterArchive({ db, id, hash, archiveFile });

    // ── ③ 写台账（写前判重已在上面做过；这里只处理"还没有行"的情形）
    if (!skipped) {
      const row = {
        at, by: String(o.by || owner), hash, owner, reasonCode: UPDATE_REASON_CODE, host,
        op: "update", memId: id, beforeRef, beforeBytes: archiveBytes, textLength,
        seq: ledger.lines + 1, store: storeKind, cause: "external_update",
        reason: String(o.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
      };
      assertNoTextLeak(row, text);                     // 🔴 红线：台账只放指针
      const w = appendLedgerRowRaw(ledgerFile, row);
      if (!w.ok) {
        throw new SnapshotError("E_SNAPSHOT_LEDGER_WRITE",
          `台账写入失败（${ledgerFile}）—— ${w.error} ⇒ **未改库**（拿不到留痕的改写＝改了也查不出）；`
          + `半成品归档留作证据：${archiveFile}`);
      }
      // 写后回读：末行必须就是这一行（防"写了一半"）
      const back = readLedgerRaw(ledgerFile);
      const last = back.rows[back.rows.length - 1];
      if (!last || Number(last.doc.memId) !== id || String(last.doc.hash) !== hash || last.doc.op !== "update") {
        throw new SnapshotError("E_SNAPSHOT_LEDGER_WRITE", `台账写后回读不符（末行不是本次那行）⇒ **未改库**；归档：${archiveFile}`);
      }
      seq = row.seq;
    }

    if (hooks && typeof hooks.afterLedger === "function") hooks.afterLedger({ db, id, hash });

    // ── ④ 复核 hash：归档→台账这段窗口里正文被别的会话改掉 ⇒ 停下来（否则会"归档旧文、放行改新文"）
    const again = db.prepare("SELECT text FROM memories WHERE id = ?").get(id);
    if (!again) throw new SnapshotError("E_SNAPSHOT_HASH_DRIFT", `#${id} 在留痕期间消失（并发删除）⇒ 未改库；归档/台账留作证据`);
    const hash2 = contentHashOf(String(again.text ?? ""));
    if (hash2 !== hash) {
      throw new SnapshotError("E_SNAPSHOT_HASH_DRIFT",
        `#${id} 正文在「读→归档→台账」窗口内被改（台账 hash ${hash} ≠ 当前 ${hash2}）⇒ 未改库（否则会"归档旧文、改掉新文"且自洽查不出）`);
    }

    return { ok: true, skipped, hash, beforeRef, archiveFile, beforeBytes: archiveBytes, textLength, seq, store: storeKind, ms: Date.now() - startedMs };
  } catch (error) {
    appendUpdateFailedLog(home, {
      at, op: "update", store: storeKind, memId: id, hash, beforeRef, beforeBytes: archiveBytes || null,
      textLength: textLength || null, seq, removedRoot, ledgerFile,
      result: "fail", code: String(error && error.code ? error.code : "E_SNAPSHOT"),
      error: String(error && error.message ? error.message : error)
    });
    throw error;
  }
}

/**
 * 改后体检：这行**改过**（`updated_at > created_at`）就必须查得到 `op:"update"` 留痕，
 * 且**最后一条留痕要晚于（或贴近）库里最后一次改动**。
 *
 * 两条判据：
 *   J1 `updated_at > created_at` 但**一条 update 留痕都没有** ⇒ 红（历史敞口 / 跳过快照）。
 *   J2 有留痕、但 `updated_at > 最后一条留痕的 at + 容差` ⇒ 红（**留了一次痕之后又偷偷改了一次**）。
 *      —— 这条就是"跳过快照直接 UPDATE"的照妖镜：先正规留痕一次做掩护，再裸改一次照样抓得到。
 *   容差缺省 300 s（一次改写通常"快照 → UPDATE"在毫秒级完成；refine 批量逐条 fsync 也远小于 5 分钟）。
 *
 * @param {{db:object, id:number, removedRoot:string, ledgerFile:string, strict?:boolean, toleranceMs?:number}} o
 *   `strict:false`（`--verify --all` 用）= J1 只算"历史缺口"不判红，只判指针坏与 J2。
 * @returns {{ok:boolean, id:number, changed:boolean, traceCount:number, lastTraceAt:string|null, updatedAt:string|null, problems:string[], traces:object[], currentHash:string|null}}
 */
export function verifyUpdateTrace({ db, id, removedRoot, ledgerFile, strict = true, toleranceMs = 300000 }) {
  const out = {
    ok: true, id: Number(id), changed: false, traceCount: 0, lastTraceAt: null,
    updatedAt: null, problems: [], traces: [], currentHash: null
  };
  const row = db.prepare("SELECT id, text, created_at, updated_at FROM memories WHERE id = ?").get(Number(id));
  if (!row) { out.ok = false; out.problems.push(`#${id} 库里不存在`); return out; }
  out.changed = Number(row.updated_at) > Number(row.created_at);
  out.updatedAt = new Date(Number(row.updated_at)).toISOString();
  out.currentHash = contentHashOf(String(row.text ?? ""));
  const raw = readLedgerRaw(ledgerFile);
  const traces = raw.rows.filter((r) => r.doc && r.doc.op === "update" && Number(r.doc.memId) === Number(id));
  out.traceCount = traces.length;
  let lastAtMs = null;
  for (const { line, doc } of traces) {
    const p = [];
    if (!Number.isInteger(doc.memId)) p.push("memId 不是整数");
    const atMs = typeof doc.at === "string" ? new Date(doc.at).getTime() : NaN;
    if (!Number.isFinite(atMs)) p.push(`at 不是合法时间：${String(doc.at)}`);
    else if (lastAtMs === null || atMs > lastAtMs) lastAtMs = atMs;
    if (typeof doc.beforeRef !== "string" || !doc.beforeRef) p.push("缺 beforeRef");
    else {
      const file = path.join(removedRoot, doc.beforeRef);
      if (!fs.existsSync(file)) p.push(`beforeRef 指的文件不存在：${file}`);
      else {
        const buf = fs.readFileSync(file);
        if (Number(doc.beforeBytes) !== buf.length) p.push(`beforeBytes ${doc.beforeBytes} ≠ 文件大小 ${buf.length}`);
        let arch = null;
        try { arch = JSON.parse(buf.toString("utf8")); } catch { p.push("归档不是合法 JSON"); }
        if (arch) {
          const h = contentHashOf(String(arch.text ?? ""));
          if (h !== String(doc.hash ?? "")) p.push(`归档 text 的 contentHashOf = ${h} ≠ 台账 hash ${doc.hash}`);
          if (Number(doc.textLength) !== [...String(arch.text ?? "")].length) p.push("textLength 与归档正文码点数不符");
          if (arch.archiveSha256 && archiveDigestOf(arch) !== arch.archiveSha256) p.push("归档自校验摘要不符（文件被手改过？）");
        }
      }
    }
    if (p.length) { out.ok = false; out.problems.push(`L${line} #${doc.memId}: ${p.join("；")}`); }
    out.traces.push({ line, at: doc.at ?? null, beforeRef: doc.beforeRef ?? null, hash: doc.hash ?? null, problems: p });
  }
  if (lastAtMs !== null) out.lastTraceAt = new Date(lastAtMs).toISOString();

  // J1：改过但一条留痕都没有
  if (out.changed && out.traceCount === 0) {
    const msg = `#${id} 库上**改过**（updated_at=${out.updatedAt}）但台账里查不到任何 op=update 留痕 ⇒ 旧正文已永久丢失`;
    if (strict) { out.ok = false; out.problems.push(msg); } else out.problems.push("[历史缺口·不判红] " + msg);
  }
  // J2：留痕之后又改了一次
  if (out.changed && lastAtMs !== null && Number(row.updated_at) > lastAtMs + toleranceMs) {
    out.ok = false;
    out.problems.push(`#${id} 最后一次留痕在 ${out.lastTraceAt}，但库里最后一次改动在 ${out.updatedAt}`
      + `（差 ${Math.round((Number(row.updated_at) - lastAtMs) / 1000)} s > 容差 ${Math.round(toleranceMs / 1000)} s）`
      + ` ⇒ 留痕之后又被改过一次、这次没留痕`);
  }
  return out;
}

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const argOf = (k, dflt = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };

function realOr(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }
function mainEntry() {
  const a1 = process.argv[1] ? realOr(process.argv[1]) : "";
  const a2 = realOr(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return a1.toLowerCase() === a2.toLowerCase();
}

function cli() {
  const HOME = path.resolve(argOf("--home", process.env.DSH_HOME || path.join(os.homedir(), ".dsh")));
  const DB = path.resolve(argOf("--db", path.join(HOME, "memory", "memory.db")));
  const LEDGER = path.resolve(argOf("--ledger", process.env.DSH_MEMORY_LEDGER || ledgerPathOf(HOME)));
  const JSON_ONLY = has("--json");

  // `--help` / `--selftest` 不需要归档根 ⇒ 先处理，别让"没配 removedRoot"把它们一起挡掉。
  if (has("--help") || argv.length === 0) {
    console.log(fs.readFileSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "utf8").split("*/")[0].replace(/^#!.*\n/, ""));
    return 0;
  }
  // ── selftest ──
  if (has("--selftest")) return selftestMain();

  let removed = null;
  try { removed = resolveRemovedRoot({ configured: argOf("--removed-root", ""), env: process.env, home: HOME }); }
  catch (e) { console.error(`✗ ${e.message}`); process.exit(3); }

  // ── verify ──
  if (has("--verify")) {
    const db = new DatabaseSync(DB, { readOnly: true });
    try {
      const ids = [];
      if (argOf("--id", null)) ids.push(Number(argOf("--id", null)));
      else if (has("--all")) {
        const rows = db.prepare("SELECT id FROM memories WHERE updated_at > created_at ORDER BY updated_at DESC").all();
        for (const r of rows) ids.push(Number(r.id));
        const traced = readLedgerRaw(LEDGER).rows.filter((r) => r.doc && r.doc.op === "update").map((r) => Number(r.doc.memId));
        for (const t of traced) if (!ids.includes(t)) ids.push(t);
      } else { console.error("用法：--verify --id <n> 或 --verify --all"); process.exit(2); }
      const strict = !has("--all");
      const results = ids.map((id) => verifyUpdateTrace({ db, id, removedRoot: removed.root, ledgerFile: LEDGER, strict }));
      const bad = results.filter((r) => !r.ok);
      if (JSON_ONLY) console.log(JSON.stringify({ ok: bad.length === 0, removedRoot: removed.root, ledger: LEDGER, results }, null, 2));
      else {
        console.log("改后体检 · " + new Date().toISOString());
        console.log("  库       " + DB);
        console.log("  台账     " + LEDGER);
        console.log("  归档根   " + removed.root + "   [" + removed.source + "]");
        console.log("");
        for (const r of results) {
          if (r.ok) console.log(`✅ #${r.id}  改过=${r.changed} · 留痕 ${r.traceCount} 条 · 当前 hash ${r.currentHash}`);
          else {
            console.log(`❌ #${r.id}  改过=${r.changed} · 留痕 ${r.traceCount} 条`);
            for (const p of r.problems) console.log(`     · ${p}`);
          }
        }
        if (has("--all")) {
          const changedIds = new Set();
          for (const r of db.prepare("SELECT id FROM memories WHERE updated_at > created_at").all()) changedIds.add(Number(r.id));
          const tracedIds = new Set(readLedgerRaw(LEDGER).rows.filter((r) => r.doc && r.doc.op === "update").map((r) => Number(r.doc.memId)));
          const covered = [...changedIds].filter((x) => tracedIds.has(x)).length;
          console.log("");
          console.log(`改留痕覆盖：改过 ${changedIds.size} 条 / 有 update 留痕 ${tracedIds.size} 条 / 两者交集 ${covered} 条`
            + ` ⇒ 覆盖 ${changedIds.size ? ((covered / changedIds.size) * 100).toFixed(1) : "0"}%`);
          console.log("  （历史行的改写早于本器具上线 ⇒ 覆盖率天然不到 100%，不是器具失效；--strict-coverage 才把缺口判红）");
          if (has("--strict-coverage") && covered < changedIds.size) {
            console.log(`❌ --strict-coverage：还有 ${changedIds.size - covered} 条改过但无留痕`);
            return 4;
          }
        }
        console.log("");
        console.log(bad.length === 0 ? "结论：全绿" : `结论：${bad.length} 条红（机器只报不修）`);
      }
      return bad.length === 0 ? 0 : 4;
    } finally { try { db.close(); } catch { /* ignore */ } }
  }

  // ── snapshot ──
  const idArg = argOf("--id", null);
  if (!idArg) { console.error("用法：--id <n> --reason \"...\" [--wrap-exec \"<命令>\"] ／ --verify --id <n> ／ --selftest"); process.exit(2); }
  const id = Number(idArg);
  const reason = String(argOf("--reason", "") || "").trim();
  if (!reason) { console.error("缺 --reason（为什么要改；**别粘正文**）"); process.exit(2); }

  if (!fs.existsSync(DB)) { console.error(`✗ 库不存在：${DB}`); process.exit(3); }
  const db = new DatabaseSync(DB, { readOnly: true });
  let res;
  try {
    if (has("--dry-run")) {
      const row = db.prepare("SELECT id, text, created_at, updated_at FROM memories WHERE id = ?").get(id);
      if (!row) { console.error(`✗ #${id} 不存在`); return 5; }
      const h = contentHashOf(String(row.text ?? ""));
      console.log("[dry-run] 会写：");
      console.log(`  归档  ${path.join(removed.root, stampNow(), `${id}-${hash12Of(h)}.json`)}`);
      console.log(`  台账  ${LEDGER}   op=update memId=${id} hash=${h} seq=${readLedgerRaw(LEDGER).lines + 1}`);
      console.log(`  reason ${reason}`);
      return 0;
    }
    res = snapshotBeforeUpdate({
      db, dbPath: DB, id, reason, home: HOME,
      removedRoot: removed.root, removedRootSource: removed.source, ledgerFile: LEDGER,
      by: argOf("--by", null), host: argOf("--host", null), storeKind: argOf("--store", null),
      expectHash: argOf("--expect-hash", null)
    });
  } catch (e) {
    const code = e && e.code ? e.code : "E_SNAPSHOT";
    if (JSON_ONLY) console.log(JSON.stringify({ ok: false, code, error: String(e && e.message ? e.message : e) }, null, 2));
    else console.error(`✗ ${code}：${e && e.message ? e.message : e}\n  ⇒ **未执行 UPDATE**（fail-closed）`);
    return code === "E_SNAPSHOT_NOT_FOUND" ? 5 : 3;
  } finally { try { db.close(); } catch { /* ignore */ } }

  if (!JSON_ONLY) {
    console.log(res.skipped
      ? `✓ 已留痕（幂等跳过）：#${id} hash ${res.hash} → ${res.beforeRef}`
      : `✓ 已留痕：#${id} hash ${res.hash} · ${res.textLength} 字 → ${res.beforeRef}（台账第 ${res.seq} 行）`);
    console.log(`  归档 ${res.archiveFile}（${res.beforeBytes} B）`);
    console.log(`  台账 ${LEDGER}（**只放指针，无正文**）`);
  } else {
    console.log(JSON.stringify({ ok: true, ...res, removedRoot: removed.root, ledger: LEDGER }, null, 2));
  }

  const wrapCmd = argOf("--wrap-exec", null);
  if (!wrapCmd) {
    if (!JSON_ONLY) console.log("  ⇒ 现在可以执行 UPDATE 了（rc 0 才算拿到许可）。");
    return 0;
  }
  if (!JSON_ONLY) console.log(`\n— 执行被包的命令 —\n  ${wrapCmd}`);
  const shell = argOf("--wrap-shell", process.platform === "win32" ? "pwsh" : "bash");
  const cwd = argOf("--wrap-cwd", process.cwd());
  const r = shell === "node"
    ? spawnSync(process.execPath, wrapCmd.split(/\s+/).filter(Boolean), { stdio: "inherit", cwd })
    : spawnSync(shell, shell === "cmd" ? ["/c", wrapCmd] : ["-NoProfile", "-Command", wrapCmd], { stdio: "inherit", cwd });
  if (r.error) { console.error(`✗ 被包命令无法启动：${r.error.message}`); return 6; }
  if (r.status !== 0) { console.error(`✗ 被包命令退出码 ${r.status}（快照已落，库可能未改）`); return 6; }
  // 改后自检：正文真变了才算改成功
  const db2 = new DatabaseSync(DB, { readOnly: true });
  try {
    const row = db2.prepare("SELECT text FROM memories WHERE id = ?").get(id);
    const h2 = row ? contentHashOf(String(row.text ?? "")) : null;
    if (!row) console.log("⚠ 改后 #" + id + " 已不在库里（被删？）");
    else if (h2 === res.hash) console.log("⚠ 改后正文 hash 未变 ⇒ 被包的命令没真改这条（或改成了同样的内容）");
    else console.log(`✓ 改后正文 hash ${res.hash} → ${h2}`);
  } finally { try { db2.close(); } catch { /* ignore */ } }
  return 0;
}

/** 自带夹具 + 阴性对照（临时库/临时归档，不碰生产）。 */
function selftestMain() {
  const tmp = path.join(os.tmpdir(), `mem-snapshot-selftest-${Date.now()}`);
  const home = path.join(tmp, "home");
  const removedRoot = path.join(tmp, "plugin");
  const ledger = path.join(home, "memory", "retractions.jsonl");
  const dbFile = path.join(home, "memory", "memory.db");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const cases = [];
  const say = (id, ok, detail) => cases.push({ id, ok, detail });

  const mk = () => {
    const d = new DatabaseSync(dbFile);
    d.exec("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, owner_user TEXT NOT NULL DEFAULT 'owner', visibility TEXT NOT NULL DEFAULT 'private_owner', source_ids TEXT NOT NULL DEFAULT '')");
    return d;
  };
  let db = mk();
  const t0 = Date.now();
  db.prepare("INSERT OR REPLACE INTO memories (id, text, tags, pinned, created_at, updated_at, owner_user) VALUES (?,?,?,?,?,?,?)").run(1, "夹具正文 A —— 旧路径 <old-dir>\\\\x", "x", 0, t0, t0, "owner");
  db.close();

  // ① 正常：快照 + 台账一行
  db = mk();
  let r1;
  try {
    r1 = snapshotBeforeUpdate({ db, dbPath: dbFile, id: 1, reason: "夹具：改路径", home, removedRoot, ledgerFile: ledger });
    say("① 正常快照 → 归档落盘", fs.existsSync(r1.archiveFile), r1.beforeRef);
    const raw = readLedgerRaw(ledger);
    const row = raw.rows.find((x) => x.doc.op === "update");
    say("① 台账 op=update 一行、字段齐", !!row
      && ["at", "by", "hash", "owner", "reasonCode", "host", "op", "memId", "beforeRef", "beforeBytes", "textLength", "seq", "store"].every((k) => row.doc[k] !== undefined),
      row ? `seq=${row.doc.seq} hash=${row.doc.hash}` : "无行");
    say("① 台账**不含正文**", !fs.readFileSync(ledger, "utf8").includes("夹具正文 A"), `台账 ${fs.statSync(ledger).size} B`);
    const arch = JSON.parse(fs.readFileSync(r1.archiveFile, "utf8"));
    say("① 归档字段齐 + 自校验摘要可复算", ["text", "tags", "pinned", "created_at", "updated_at", "owner_user", "visibility", "hash", "at", "by", "host", "textLength", "archiveSha256"].every((k) => arch[k] !== undefined)
      && archiveDigestOf(arch) === arch.archiveSha256, `textLength=${arch.textLength}`);
    // 幂等
    const r1b = snapshotBeforeUpdate({ db, dbPath: dbFile, id: 1, reason: "夹具：改路径", home, removedRoot, ledgerFile: ledger });
    say("④ 幂等：同 id 同 hash 再来一次 ⇒ 只落一份", r1b.skipped === true && readLedgerRaw(ledger).rows.filter((x) => x.doc.op === "update").length === 1,
      `skipped=${r1b.skipped} update行=${readLedgerRaw(ledger).rows.filter((x) => x.doc.op === "update").length}`);
  } catch (e) { say("① 正常快照", false, String(e && e.message ? e.message : e)); }
  db.close();

  // ② 归档目录不可写 ⇒ fail-closed
  const before2 = (() => { const d = new DatabaseSync(dbFile, { readOnly: true }); const n = d.prepare("SELECT COUNT(*) n FROM memories").get().n; const t = d.prepare("SELECT text FROM memories WHERE id=1").get().text; d.close(); return { n, text: t }; })();
  const fileAsRoot = path.join(tmp, "not-a-dir");
  fs.writeFileSync(fileAsRoot, "x", "utf8");
  db = mk();
  let e2 = null;
  try { snapshotBeforeUpdate({ db, dbPath: dbFile, id: 1, reason: "夹具：归档不可写", home, removedRoot: fileAsRoot, ledgerFile: ledger }); }
  catch (e) { e2 = e; }
  db.close();
  const after2 = (() => { const d = new DatabaseSync(dbFile, { readOnly: true }); const n = d.prepare("SELECT COUNT(*) n FROM memories").get().n; const t = d.prepare("SELECT text FROM memories WHERE id=1").get().text; d.close(); return { n, text: t }; })();
  say("② 归档不可写 ⇒ fail-closed（库未变）", !!e2 && e2.code === "E_SNAPSHOT_ARCHIVE_WRITE" && after2.n === before2.n && after2.text === before2.text,
    `${e2 ? e2.code : "没抛"} · 库 ${before2.n}/${after2.n} 条 · 正文相同=${after2.text === before2.text}`);

  // ③ 台账**追加**失败 ⇒ fail-closed，且半成品归档有痕迹
  //    注入姿势：台账文件先放一条合法老行，再置只读 ⇒ **读得到、追加写的开档必失败**
  //    （不用"路径做成目录"，那会让失败提前到"读台账"，就测不到"归档已写、台账没写"这个半成品态）
  const ledger3 = path.join(tmp, "ledger-readonly.jsonl");
  fs.writeFileSync(ledger3, JSON.stringify({ at: "2026-10-22T08:12:26.419Z", by: "owner", hash: "sha256:0000000000000001", owner: "owner", reasonCode: "duplicate", host: "SELFTEST" }) + "\n", "utf8");
  fs.chmodSync(ledger3, 0o444);
  const removedRoot3 = path.join(tmp, "plugin3");
  db = mk();
  let e3 = null;
  try { snapshotBeforeUpdate({ db, dbPath: dbFile, id: 1, reason: "夹具：台账不可写", home, removedRoot: removedRoot3, ledgerFile: ledger3 }); }
  catch (e) { e3 = e; }
  db.close();
  const walkJson = (dir) => {
    const out = [];
    const go = (d) => { if (!fs.existsSync(d)) return; for (const ent of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, ent.name); if (ent.isDirectory()) go(p); else if (p.endsWith(".json")) out.push(p); } };
    go(dir); return out;
  };
  const partial = walkJson(removedRoot3);
  const after3 = (() => { const d = new DatabaseSync(dbFile, { readOnly: true }); const t = d.prepare("SELECT text FROM memories WHERE id=1").get().text; d.close(); return t; })();
  const ledger3Lines = fs.readFileSync(ledger3, "utf8").split("\n").filter(Boolean).length;
  try { fs.chmodSync(ledger3, 0o666); } catch { /* ignore */ }
  say("③ 台账追加失败 ⇒ fail-closed（库未变）+ 半成品归档留痕", !!e3 && e3.code === "E_SNAPSHOT_LEDGER_WRITE" && after3 === before2.text && partial.length === 1 && ledger3Lines === 1,
    `${e3 ? e3.code : "没抛"} · 半成品归档 ${partial.length} 份 · 台账仍 ${ledger3Lines} 行 · 正文相同=${after3 === before2.text}`);
  const sideLog = path.join(home, "memory-shadow");
  const logs = fs.existsSync(sideLog) ? fs.readdirSync(sideLog).filter((f) => f.startsWith("update-failed")) : [];
  say("③ 失败旁挂日志有痕迹", logs.length >= 1, logs.join(",") || "无");

  // ③b 台账行泄漏正文 ⇒ 拒写
  let e3b = null;
  db = mk();
  const removedRoot3b = path.join(tmp, "plugin3b");
  try {
    snapshotBeforeUpdate({ db, dbPath: dbFile, id: 1, reason: "夹具正文 A —— 旧路径 <old-dir>\\\\x", home, removedRoot: removedRoot3b, ledgerFile: path.join(tmp, "ledger3b.jsonl") });
  } catch (e) { e3b = e; }
  db.close();
  say("③b --reason 粘了正文 ⇒ 拒写", !!e3b && e3b.code === "E_SNAPSHOT_TEXT_LEAK", e3b ? e3b.code : "没抛");

  // ⑥ 阴性对照：跳过快照直接 UPDATE ⇒ --verify 必须报红
  //    这里把"偷偷改"的时间设在最后一次留痕之后 10 分钟（> 容差 300 s）——  realistically 谁会秒级连改两次；
  //    容差内的改写 J2 抓不到，这是刻意留的（见 verifyUpdateTrace 注释：容差是为了容纳"快照→UPDATE"之间的间隙）。
  const t1 = Date.now() + 600000;
  db = mk();
  db.prepare("UPDATE memories SET text = ?, updated_at = ? WHERE id = ?").run("偷偷改掉的新正文", t1, 1);
  db.close();
  db = new DatabaseSync(dbFile, { readOnly: true });
  const vRed = verifyUpdateTrace({ db, id: 1, removedRoot, ledgerFile: ledger });
  db.close();
  say("⑥ 阴性对照：跳过留痕直接改 ⇒ 体检报红", vRed.ok === false
    && vRed.problems.some((p) => p.includes("查不到任何 op=update 留痕") || p.includes("留痕之后又被改过一次")),
    `ok=${vRed.ok} changed=${vRed.changed} traces=${vRed.traceCount} · ${vRed.problems.join(" / ").slice(0, 120)}`);

  // ⑥b 阳性对照：把这条的改也留痕 ⇒ 绿
  db = mk();
  db.prepare("UPDATE memories SET text = ?, updated_at = ? WHERE id = ?").run("夹具正文 A —— 旧路径 <old-dir>\\\\x", t0, 1);
  db.close();
  db = mk();
  let vGreen = null;
  try {
    const r6 = snapshotBeforeUpdate({ db, dbPath: dbFile, id: 1, reason: "夹具：恢复正常态", home, removedRoot, ledgerFile: ledger });
    const d2 = mk();
    d2.prepare("UPDATE memories SET text = ?, updated_at = ? WHERE id = ?").run("第二次改的新正文", Date.now(), 1);
    d2.close();
    vGreen = verifyUpdateTrace({ db, id: 1, removedRoot, ledgerFile: ledger });
    say("⑥b 阳性对照：有留痕 ⇒ 体检绿", vGreen.ok === true && vGreen.traceCount >= 1, `ok=${vGreen.ok} traces=${vGreen.traceCount} seq=${r6.seq}`);
  } catch (e) { say("⑥b 阳性对照", false, String(e && e.message ? e.message : e)); }
  db.close();

  // ⑤ hash 真源与审计器具口径一致（同一段文本两种算法同解）
  say("⑤ 内容哈希与 b2-equiv 同解", localContentHashOf("甲乙\n丙") === contentHashOf("甲乙\r\n丙 "), `${hashSource}`);

  const ok = cases.every((c) => c.ok);
  console.log(`memory-snapshot --selftest：${cases.filter((c) => c.ok).length}/${cases.length} ${ok ? "✅" : "❌"}`);
  for (const c of cases) console.log(`  ${c.ok ? "·" : "!"} ${c.id} — ${c.detail}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok ? 0 : 3;
}

if (mainEntry()) {
  try {
    process.exitCode = cli();
  } catch (e) {
    console.error(`✗ ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  }
}

export default {
  SNAPSHOT_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  UPDATE_REASON_CODE,
  contentHashOf,
  hash12Of,
  stampNow,
  archiveDigestOf,
  ledgerPathOf,
  isFamilyDbPath,
  resolveRemovedRoot,
  readLedgerRaw,
  appendLedgerRowRaw,
  appendUpdateFailedLog,
  assertNoTextLeak,
  snapshotBeforeUpdate,
  verifyUpdateTrace
};
