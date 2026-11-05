/**
 * forget-ledger.mjs —— `memory_forget` 的**删留痕**（归档 + 台账 + 八步铁律）
 *
 * 它解决的问题：删一条记忆原本是 "DELETE 一行"，删完查不出「删了什么、谁删的、什么时候删的」。
 * 本模块把 `memory_forget` 改成八步：**先归档正文 → 写台账 → 事务内复核 hash → 才 DELETE**。
 * 顺序不可换：没有正文备份的删除＝救不回来的删除。
 *
 * ── 落点为什么可配置（别改回写死）─────────────────────────────────────────────
 *   归档里放的是**记忆正文全文**（不截断），所以它绝不能落在任何"会被快照/备份工具整体收集"的
 *   目录里 —— 否则一次备份就等于把正文搬出了本机。因此归档根**只走显式配置**，取不到就
 *   fail-closed 拒绝删除（见 `resolveRemovedRoot` 的三级解析）。
 *
 * ── 谁的入口 ────────────────────────────────────────────────────────────────
 *   本文件是唯一实现处：调用方（宿主插件的 `memory_forget`）只调 `forgetWithLedger()`。
 *   本模块不注册工具、不改召回渲染，可单独 import 进自己的脚本做离线演练。
 *
 * ── 八步（`forgetWithLedger` 的函数体就是这条顺序）──────────────────────────────
 *   ① 配置 fail-closed ② 建归档目录 ③ BEGIN IMMEDIATE ④ 事务内 raw SELECT
 *   ⑤ 写归档 + 回读自检 ⑥ 写台账（写前判重）⑦ 事务内复核 hash ⑧ DELETE 并核 changes === 1 ⑨ COMMIT
 *
 * 🔴 硬约束（改这段不许破）：
 *   ① **不把正文或开头摘录写进台账**（隐私最小化）—— 台账只放指针 `beforeRef`；
 *      正文只落归档 `.json`（本地、不进任何备份白名单、不进 FTS）。
 *   ② **不复用通用的"撤回/retraction"追加器**：那类函数会先做 schema 校验再 `JSON.stringify`，
 *      扩展字段会被**静默砍掉且不报错**，而老读器看到的 `invalid` 仍是 0（判据假绿）
 *      ⇒ 这里自写 raw 单行 append。
 *   ③ 归档目录不可写 / 取不到 ⇒ **fail-closed**：报错、记忆仍在、连接不卡在事务里
 *      （紧接着 `memory_write` 能落库）。
 *   ④ 台账**只 append**：老行一个字节不碰（不重排、不改写）。
 *   ⑤ 任一失败先 `ROLLBACK` 再抛 —— 全进程共用一条 `DatabaseSync` 连接，
 *      抛错不 ROLLBACK 会把连接停在隐式开放事务里 ⇒ 之后所有 `memory_write` 报成功却不落盘。
 *
 * ── 两处容易踩的口径 ──────────────────────────────────────────────────────────
 *   a. `beforeRef` 记**相对归档根**（`<removedRoot>`）的 posix 路径（`<stamp>/<memId>-<hash12>.json`），
 *      不是"相对 home" —— 归档根可能跨盘，`path.relative()` 跨盘会直接返回绝对路径。
 *   b. 归档 `.json` 的 `text` **全文不截断**（写入长度的 `maxTextChars` 是入库限制、不是归档限制；
 *      长记忆一旦截断就是永久丢尾巴）。
 *
 * ── 台账一行的字段（都在 `forgetWithLedger` 第 ⑥ 步）──────────────────────────
 *   必有 6 字段：`at`（ISO）/ `by`（谁发起）/ `hash`（`sha256:<16hex>`）/ `owner` / `reasonCode` / `host`
 *   本模块扩展：`op` / `memId` / `beforeRef` / `beforeBytes` / `textLength` / `seq` / `store`
 *   ⇒ 老读器（只认 6 字段）照样能读；扩展字段只增不删。
 *   `host` 是**调用方注入**的（缺省取本机名），不写死任何一台机器的名字。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const FORGET_LEDGER_VERSION = "1.0.0";
export const ARCHIVE_SCHEMA_VERSION = 1;
export const HASH_PREFIX = "sha256:";
/** 模型自清必须显式写 `other`（不吃通用撤回的缺省 `self-request`，否则隐私审计分不清谁发起）。 */
export const FORGET_REASON_CODE = "other";
/** 建议连接参数（由调用方在构造连接时 PRAGMA 设置；数字在这里只作单一出处）。 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/** 有限次退避（`BEGIN IMMEDIATE` 撞上外部的长批事务时）。 */
export const RETRY_DELAYS_MS = Object.freeze([60, 150, 400]);
/** 归档根下的相对布局（`<root>/<UTC stamp>/<memId>-<hash12>.json`）。 */
export const ARCHIVE_SUBDIRS = Object.freeze(["_archive", "memory-removed"]);

// ── 内容哈希：与仓内 `memory-db-tools` 的 merge/hash 同口径 ──────────────────────
// 剥 BOM → 换行归一（CRLF / CR → LF）→ trim 首尾空白 → sha256 前 16 位（`sha256:<16 hex>`）。
// 多处副本必须同解，否则体检比 hash 会假红（本仓有夹具守着这一条）。
export function normalizeText(text) {
  let s = typeof text === "string" ? text : (text === null || text === undefined ? "" : String(text));
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n?/g, "\n");
  return s.trim();
}

export function contentHashOf(text) {
  const hex = crypto.createHash("sha256").update(normalizeText(text), "utf8").digest("hex");
  return HASH_PREFIX + hex.slice(0, 16);
}

/** `hash12` = 内容哈希的 16 位 hex 取前 12 位（归档文件名用）。 */
export function hash12Of(hash) {
  const s = String(hash ?? "").trim().toLowerCase();
  const hex = s.startsWith(HASH_PREFIX) ? s.slice(HASH_PREFIX.length) : s;
  return /^[0-9a-f]{12,}$/.test(hex) ? hex.slice(0, 12) : "000000000000";
}

/** 归档目录名：UTC `YYYYMMDD-HHmmss`（`at` 就是 UTC，别混本地时区）。 */
export function stampNow(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * 归档根解析（三级，**取不到即 fail-closed**，绝不静默退回一个"看着像"的目录）。
 *
 * 顺序：`options.configured`（配置里的 `removedRoot`）→ env `DSH_MEMORY_REMOVED_ROOT`
 *       → env `DSH_ROOT`（⇒ `<DSH_ROOT>/_archive/memory-removed`）
 * @returns {{root: string|null, source: string}}
 */
export function resolveRemovedRoot(options = {}) {
  const env = options.env ?? process.env;
  const configured = typeof options.configured === "string" ? options.configured.trim() : "";
  if (configured) return { root: path.resolve(configured), source: "config.removedRoot" };
  const fromEnv = typeof env.DSH_MEMORY_REMOVED_ROOT === "string" ? env.DSH_MEMORY_REMOVED_ROOT.trim() : "";
  if (fromEnv) return { root: path.resolve(fromEnv), source: "env.DSH_MEMORY_REMOVED_ROOT" };
  const dshRoot = typeof env.DSH_ROOT === "string" ? env.DSH_ROOT.trim() : "";
  if (dshRoot) return { root: path.join(path.resolve(dshRoot), ...ARCHIVE_SUBDIRS), source: "env.DSH_ROOT" };
  return { root: null, source: "unset" };
}

/** 台账绝对路径（`<home>/memory/retractions.jsonl`，与 CLI 同一份）。 */
export function ledgerPathOf(home) {
  return path.join(path.resolve(String(home)), "memory", "retractions.jsonl");
}

/**
 * 本连接打的是不是"另一个库"（`<home>/family-memory/` 下）—— 台账 `store` 字段靠它分库。
 * （只是为了给台账标清"这条属于哪个库"，不参与任何权限判断。）
 */
export function isFamilyDbPath(dbPath, home) {
  try {
    const dir = path.dirname(path.resolve(String(dbPath))).toLowerCase();
    const fam = path.join(path.resolve(String(home)), "family-memory").toLowerCase();
    return dir === fam;
  } catch {
    return false;
  }
}

/**
 * 读台账**原始行**（`JSON.parse`，不过任何 schema 校验器）。
 * 为什么要 raw：通用校验器会把扩展字段静默丢掉 ⇒ 判重与审计都读不到。
 * @returns {{exists:boolean, rows:object[], invalid:{line:number,error:string}[], lines:number, bytes:number}}
 */
export function readLedgerRaw(file) {
  const p = path.resolve(String(file));
  let buf;
  try {
    buf = fs.readFileSync(p);
  } catch (e) {
    // 不存在 = 正常（首删）；**存在但读不了**（目录 / 权限 / 占用）⇒ 交给调用方 fail-closed
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
      if (doc && typeof doc === "object" && !Array.isArray(doc)) rows.push(doc);
      else invalid.push({ line: i + 1, error: "不是对象" });
    } catch (e) {
      invalid.push({ line: i + 1, error: String(e && e.message ? e.message : e) });
    }
  }
  return { exists: true, rows, invalid, lines: lines.length, bytes: buf.length };
}

/**
 * **自写 raw 单行 append**（O_APPEND + 单行 + fsync）。
 * ⚠️ 只校验"必需 6 字段非空 + hash 形态"，**扩展字段原样透传** —— 这是不复用通用追加器的原因。
 */
export function appendLedgerRowRaw(file, row) {
  const p = path.resolve(String(file));
  const problems = [];
  for (const k of ["at", "by", "hash", "owner", "reasonCode", "host"]) {
    if (typeof row[k] !== "string" || row[k].trim().length === 0) problems.push(`缺 ${k}`);
  }
  if (typeof row.hash === "string" && !/^sha256:[0-9a-f]{16}$/.test(row.hash)) problems.push("hash 形态非法（要 sha256:<16 hex>）");
  if (problems.length > 0) return { ok: false, file: p, error: problems.join("；"), line: "" };
  const line = JSON.stringify(row);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(p, "a");
    try {
      fs.writeSync(fd, line + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, file: p, error: null, line, bytes: fs.statSync(p).size };
  } catch (e) {
    return { ok: false, file: p, error: String(e && e.message ? e.message : e), line };
  }
}

/** 归档自校验摘要：**除 `archiveSha256` 外**其余字段按 key 升序规范化 JSON 的 sha256（防手改）。 */
export function archiveDigestOf(body) {
  const entries = Object.entries(body || {})
    .filter(([k]) => k !== "archiveSha256")
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonical = JSON.stringify(Object.fromEntries(entries));
  return HASH_PREFIX + crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** 同步睡眠（退避用；node 无同步 sleep）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 极端环境下不可用 ⇒ 退化为零延迟重试 */
  }
}

function isBusyError(error) {
  const msg = String(error && error.message ? error.message : error);
  return /busy|SQLITE_BUSY|database is locked/i.test(msg);
}

function safeRollback(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* 事务已不在 ⇒ 正常 */
  }
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 旁挂失败日志（`<home>/memory-shadow/forget-failed-<YYYY-MM>.jsonl`，never throw）。 */
export function appendForgetFailedLog(home, record) {
  try {
    const base = home || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
    const dir = path.join(base, "memory-shadow");
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    fs.writeFileSync(path.join(dir, `forget-failed-${month}.jsonl`), JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 删一条记忆并留痕（归档 → 台账 → 复核 → DELETE → COMMIT）。
 *
 * @param {object} opts
 * @param {import("node:sqlite").DatabaseSync} opts.db - 共享连接
 * @param {string} opts.dbPath - 库文件绝对路径
 * @param {number} opts.id - 要删的记忆 id
 * @param {"owner"|"family"} [opts.storeKind] - 哪个库（台账 `store` 字段）
 * @param {string} opts.home - home 目录（台账与失败日志的落点）
 * @param {string|null} opts.removedRoot - 归档根（null ⇒ fail-closed）
 * @param {string} [opts.removedRootSource] - 根从哪来（写日志用）
 * @param {string} [opts.ledgerFile] - 缺省 `<home>/memory/retractions.jsonl`
 * @param {string} [opts.host] - 写入机器名（缺省取本机名；可注入以便夹具稳定）
 * @param {string|null} [opts.by] - 发起人（缺省 = 被删条 owner_user）
 * @param {object|null} [opts.hooks] - **夹具注入点**（生产传 null）：`{afterArchive?, afterLedger?}`
 * @param {Date} [opts.now] - 注入时钟（单测）
 * @returns {{forgotten:boolean, reason?:string, hash?:string, beforeRef?:string, beforeBytes?:number, textLength?:number, seq?:number|null, archiveFile?:string, ms?:number}}
 */
export function forgetWithLedger(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const { db, dbPath, id } = o;
  const storeKind = o.storeKind === "family" ? "family" : "owner";
  const home = String(o.home || "");
  const host = String(o.host || process.env.COMPUTERNAME || os.hostname());
  const hooks = o.hooks && typeof o.hooks === "object" ? o.hooks : null;
  const now = o.now instanceof Date ? o.now : new Date();
  const at = now.toISOString();
  const startedMs = Date.now();

  // ① 配置 fail-closed（在动任何东西之前）
  if (!db) throw fail("E_MEMORY_FORGET_NO_DB", "memory_forget: 记忆库连接不可用 —— 本次未删除");
  if (!o.removedRoot) {
    throw fail("E_MEMORY_REMOVED_ROOT_UNSET",
      "memory_forget: 归档根未配置（config.removedRoot / env DSH_MEMORY_REMOVED_ROOT / env DSH_ROOT 三者都取不到）"
      + " ⇒ **已拒绝删除**（宁可不删，也不删了没记）。请配置 `removedRoot`，或设环境变量 DSH_MEMORY_REMOVED_ROOT。");
  }
  const removedRoot = path.resolve(String(o.removedRoot));
  const ledgerFile = o.ledgerFile ? path.resolve(String(o.ledgerFile)) : ledgerPathOf(home);

  let stampDir = null;
  let archiveFile = null;
  let archiveBytes = 0;
  let beforeRef = null;
  let seq = null;
  let hash = null;
  let textLength = 0;
  let began = false;
  let result = "fail";

  try {
    // ② 首删目录不存在 ⇒ 先建（不建就 ENOENT，会被当成"归档不可写 ⇒ 拒删"）
    const stamp = stampNow(now);
    stampDir = path.join(removedRoot, stamp);
    try {
      fs.mkdirSync(stampDir, { recursive: true });
    } catch (e) {
      throw fail("E_MEMORY_ARCHIVE_WRITE_FAILED",
        `memory_forget: 归档目录不可写（${stampDir}）—— ${e && e.message ? e.message : e} ⇒ **已拒绝删除**（顺序铁律：没正文备份的删除＝救不回来的删除）`);
    }

    // ③ BEGIN IMMEDIATE（busy_timeout 已由连接参数兜住；这里再补有限次退避）
    let busyTries = 0;
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        began = true;
        break;
      } catch (e) {
        if (!isBusyError(e) || busyTries >= RETRY_DELAYS_MS.length) {
          throw fail("E_MEMORY_FORGET_BUSY", `memory_forget: 拿不到写锁（${e && e.message ? e.message : e}，已退避 ${busyTries} 次）⇒ 本次未删除`);
        }
        sleepSync(RETRY_DELAYS_MS[busyTries]);
        busyTries += 1;
      }
    }

    // ④ 事务内 raw SELECT（不用 store 的 `get()`：它只回 6 个公开字段，拿不到 owner_user）
    const raw = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
    if (!raw) {
      safeRollback(db);
      began = false;
      recordLog({ at, store: storeKind, memId: id, hash: null, beforeRef: null, beforeBytes: null, textLength: null, seq: null, ms: Date.now() - startedMs, result: "not-found" });
      return { forgotten: false, reason: "not-found", ms: Date.now() - startedMs };
    }
    const text = String(raw.text ?? "");
    hash = contentHashOf(text);
    textLength = [...text].length;
    const owner = String(raw.owner_user ?? "").trim() || "unknown";

    // ⑤ 写归档（writeFileSync 语义 + fsync）+ 回读自检
    const body = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      op: "forget",
      cause: "memory_forget",
      store: storeKind,
      dbPath: String(dbPath || ""),
      memId: Number(id),
      text,
      tags: String(raw.tags ?? ""),
      pinned: Number(raw.pinned ?? 0),
      created_at: Number(raw.created_at ?? 0),
      updated_at: Number(raw.updated_at ?? 0),
      owner_user: owner,
      visibility: String(raw.visibility ?? ""),
      source_ids: String(raw.source_ids ?? ""),
      hash,
      removedAt: at,
      removedBy: String(o.by || owner),
      host,
      textLength
    };
    body.archiveSha256 = archiveDigestOf(body);
    const payload = JSON.stringify(body, null, 2) + "\n";
    const base = `${Number(id)}-${hash12Of(hash)}`;
    let candidate = path.join(stampDir, `${base}.json`);
    for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(stampDir, `${base}-${n}.json`);
    try {
      const fd = fs.openSync(candidate, "w");
      try {
        fs.writeSync(fd, payload);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const back = fs.readFileSync(candidate, "utf8");
      if (back !== payload) throw new Error("写入后回读与内存不一致");
    } catch (e) {
      throw fail("E_MEMORY_ARCHIVE_WRITE_FAILED",
        `memory_forget: 归档写入失败（${candidate}）—— ${e && e.message ? e.message : e} ⇒ **已拒绝删除**（库未改一行）`);
    }
    archiveFile = candidate;
    archiveBytes = fs.statSync(candidate).size;
    beforeRef = path.relative(removedRoot, candidate).split(path.sep).join("/");

    if (hooks && typeof hooks.afterArchive === "function") hooks.afterArchive({ db, id, hash, archiveFile });

    // ⑥ 写台账（写前先判 `hash|owner` 是否已在 ⇒ 防"删失败后重试"写出同 key 两行）
    let ledger;
    try {
      ledger = readLedgerRaw(ledgerFile);
    } catch (e) {
      throw fail("E_MEMORY_LEDGER_WRITE_FAILED",
        `memory_forget: 台账不可读（${ledgerFile}）—— ${e && e.message ? e.message : e} ⇒ **已拒绝删除**（读不到台账就无法判重、也写不进 tombstone）；库未改一行`);
    }
    const already = ledger.rows.some((r) => String(r.hash ?? "").trim().toLowerCase() === hash && String(r.owner ?? "").trim() === owner);
    if (!already) {
      const row = {
        at,
        by: String(o.by || owner),
        hash,
        owner,
        reasonCode: FORGET_REASON_CODE,
        host,
        op: "forget",
        memId: Number(id),
        beforeRef,
        beforeBytes: archiveBytes,
        textLength,
        seq: ledger.lines + 1,
        store: storeKind
      };
      const w = appendLedgerRowRaw(ledgerFile, row);
      if (!w.ok) {
        throw fail("E_MEMORY_LEDGER_WRITE_FAILED",
          `memory_forget: 台账写入失败（${ledgerFile}）—— ${w.error} ⇒ **已拒绝删除**（拿不到 tombstone 的删除＝会还魂的删除）；库未改一行`);
      }
      seq = row.seq;
    }

    if (hooks && typeof hooks.afterLedger === "function") hooks.afterLedger({ db, id, hash });

    // ⑦ 事务内复核：重算 hash 与第 ④ 步比对（不等即 ROLLBACK —— "读→归档→删"窗口里正文被改过）
    const again = db.prepare("SELECT text, owner_user FROM memories WHERE id = ?").get(id);
    if (!again) {
      safeRollback(db);
      began = false;
      throw fail("E_MEMORY_FORGET_HASH_DRIFT", `memory_forget: #${id} 在事务内消失（并发删除）⇒ 已回滚；归档/台账留作证据`);
    }
    const hash2 = contentHashOf(String(again.text ?? ""));
    if (hash2 !== hash) {
      safeRollback(db);
      began = false;
      throw fail("E_MEMORY_FORGET_HASH_DRIFT",
        `memory_forget: #${id} 正文在读→归档窗口内被改（台账 hash ${hash} ≠ 当前 ${hash2}）⇒ 已回滚、记忆原样保留（否则会"归档旧文、删新文"且自洽查不出）`);
    }

    // ⑧ DELETE 并核 changes === 1
    const del = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    if (Number(del.changes) !== 1) {
      safeRollback(db);
      began = false;
      throw fail("E_MEMORY_FORGET_DELETE_MISMATCH", `memory_forget: DELETE 影响 ${del.changes} 行（期望 1）⇒ 已回滚`);
    }

    // ⑨ COMMIT
    db.exec("COMMIT");
    began = false;
    result = "ok";
    const ms = Date.now() - startedMs;
    recordLog({ at, store: storeKind, memId: id, hash, beforeRef, beforeBytes: archiveBytes, textLength, seq, ms, result });
    return { forgotten: true, hash, beforeRef, beforeBytes: archiveBytes, textLength, seq, archiveFile, ms };
  } catch (error) {
    if (began) safeRollback(db);
    appendForgetFailedLog(home, {
      at,
      op: "forget",
      store: storeKind,
      memId: Number(id) || null,
      hash,
      beforeRef,
      beforeBytes: archiveBytes || null,
      textLength: textLength || null,
      seq,
      ms: Date.now() - startedMs,
      result: "fail",
      code: String(error && error.code ? error.code : "E_MEMORY_FORGET"),
      error: String(error && error.message ? error.message : error)
    });
    throw error;
  }
}

/** 结构化日志一行（字段集固定；走 stderr，不污染工具返回值）。 */
function recordLog(fields) {
  try {
    console.warn(`[memory] ${JSON.stringify({ at: fields.at, op: "forget", ...fields })}`);
  } catch {
    /* 日志失败不影响主流程 */
  }
}

// ══ 关系（零代码那一半）─────────────────────────────────────────────────────────────
// 唯一权威 = tags 里的 `supersedes:<旧 id>`；`superseded-by:<新 id>` 只是可读冗余，**判定不读它**。
// 本模块只提供只读校验，**不写任何关系**、不建第二套关系表。
export const RELATION_TAG_RE = /^supersedes:([0-9]{4,9})$/i;
export const RELATION_REVERSE_TAG_RE = /^superseded-by:([0-9]{4,9})$/i;

/**
 * 扫全库的关系 tag，报"形态脏边"（拼接写法 / 指向不存在的 id / 只写一边）。
 * @param {import("node:sqlite").DatabaseSync} db
 * @returns {{ok:boolean, forward:{from:number,to:number}[], reverse:{from:number,to:number}[], badForm:{id:number,tag:string}[], danglingTo:number[], orphanReverse:number[]}}
 */
export function auditRelations(db) {
  const rows = db.prepare("SELECT id, tags FROM memories").all();
  const byId = new Map(rows.map((r) => [Number(r.id), String(r.tags ?? "")]));
  const forward = [];
  const reverse = [];
  const badForm = [];
  for (const r of rows) {
    const id = Number(r.id);
    const tags = String(r.tags ?? "").split(/\s+/).filter(Boolean);
    for (const tag of tags) {
      if (/^supersedes:/i.test(tag) && !RELATION_TAG_RE.test(tag)) badForm.push({ id, tag });
      else if (/^superseded-by:/i.test(tag) && !RELATION_REVERSE_TAG_RE.test(tag)) badForm.push({ id, tag });
      const m = tag.match(RELATION_TAG_RE);
      if (m) forward.push({ from: id, to: Number(m[1]) });
      const n = tag.match(RELATION_REVERSE_TAG_RE);
      if (n) reverse.push({ from: id, to: Number(n[1]) });
    }
  }
  const danglingTo = forward.filter((e) => !byId.has(e.to)).map((e) => e.to);
  // 反向冗余缺失：新条声明了 supersedes:旧，但旧条 tags 里没有 superseded-by:新 —— **不影响判定**，只少一条人读线索
  const orphanReverse = forward.filter((e) => !reverse.some((rv) => rv.from === e.to && rv.to === e.from)).map((e) => e.to);
  return { ok: badForm.length === 0 && danglingTo.length === 0, forward, reverse, badForm, danglingTo, orphanReverse };
}

export default {
  FORGET_LEDGER_VERSION,
  ARCHIVE_SCHEMA_VERSION,
  DEFAULT_BUSY_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  FORGET_REASON_CODE,
  ARCHIVE_SUBDIRS,
  contentHashOf,
  normalizeText,
  hash12Of,
  stampNow,
  resolveRemovedRoot,
  ledgerPathOf,
  isFamilyDbPath,
  readLedgerRaw,
  appendLedgerRowRaw,
  archiveDigestOf,
  appendForgetFailedLog,
  forgetWithLedger,
  auditRelations,
  RELATION_TAG_RE,
  RELATION_REVERSE_TAG_RE
};
