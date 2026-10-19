// 记忆引擎 v2 · 离线层 —— 文档索引独立库（方案 §3.2 / D1 已拍：出主库）
//
// 为什么独立库（B3/B5 的正解，三条硬理由，勿重开）：
//   1. 主库 `memories` **无 path 列、无外部唯一索引** ⇒ 幂等键无处可放；
//      且 `forPrompt` 的 LIMIT 名额会被 `updated_at=now` 的索引条整批占掉；
//   2. `memory.db` 是 DELETE 模式 + `busy_timeout=0` ⇒ 生成器写主库 ＝ 与 `memory_write` 抢锁；
//   3. 索引条描述**本机 docs 的 mtime**，两机 mtime 不同 ⇒ 跨机双写会互相覆盖。
// 独立库同时继承 §3.1 的好处：不进任何同步仓、可重建、无锁竞争。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOC_INDEX_SCHEMA_VERSION } from './config.mjs';

/** 表结构 —— 逐列照方案 §3.2（验收要贴 PRAGMA table_info 逐列比对，勿自行增删列）。 */
const DDL = `
CREATE TABLE IF NOT EXISTS doc_index (
  path        TEXT    PRIMARY KEY,
  mtime       INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  text_hash   TEXT    NOT NULL,
  summary     TEXT    NOT NULL,
  owner_user  TEXT    NOT NULL DEFAULT 'LiJianXiao',
  visibility  TEXT    NOT NULL DEFAULT 'private_owner',
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

/** meta 键名（卡要求：schemaVersion / hostId / lastRunAt；后两项为运行状态，照 S1 的 lastSyncStats 先例）。 */
export const META_KEYS = {
  schemaVersion: 'schemaVersion',
  hostId: 'hostId',
  lastRunAt: 'lastRunAt',
  lastRunStats: 'lastRunStats',
};

/** 列序（验收用：与 PRAGMA table_info 逐列比对） */
export const COLUMNS = [
  { name: 'path', type: 'TEXT', notnull: 0, dflt: null, pk: 1 },
  { name: 'mtime', type: 'INTEGER', notnull: 1, dflt: null, pk: 0 },
  { name: 'size', type: 'INTEGER', notnull: 1, dflt: null, pk: 0 },
  { name: 'text_hash', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
  { name: 'summary', type: 'TEXT', notnull: 1, dflt: null, pk: 0 },
  { name: 'owner_user', type: 'TEXT', notnull: 1, dflt: "'LiJianXiao'", pk: 0 },
  { name: 'visibility', type: 'TEXT', notnull: 1, dflt: "'private_owner'", pk: 0 },
  { name: 'updated_at', type: 'INTEGER', notnull: 1, dflt: null, pk: 0 },
];

/** 并发保护参数（方案 §3.2 / §5.2）：busy_timeout + 重试 3 次、总退避上限 60 s。 */
export const RETRY = {
  retries: 3,
  // 单次等锁上限。独立库的写者只有本模块自己（罕见的手工操作才会占锁）⇒ 2s 足够；
  // 取 5s 会让"4 次尝试"的墙钟被等锁拖到 ~87s（2026-09-21 实测），与 §5.2「总退避上限 60s」的口径读起来不像同一件事。
  busyTimeoutMs: 2000,
  // 指数退避：1s / 4s / 16s（累计 21s）
  delaysMs: [1000, 4000, 16000],
  // 总预算（含等锁）：重试前判据 —— 已耗时 + 下一次退避 > 预算就直接放弃
  totalBudgetMs: 60000,
};

function tableExists(db, name) {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

export function ensureSchema(db) {
  const created = [];
  if (!tableExists(db, 'doc_index')) created.push('doc_index');
  if (!tableExists(db, 'meta')) created.push('meta');
  db.exec(DDL);
  return {
    created,
    tables: { doc_index: tableExists(db, 'doc_index'), meta: tableExists(db, 'meta') },
  };
}

/**
 * 打开（必要时创建）文档索引库。
 * @param {string} dbPath
 * @param {{create?: boolean, hostId?: string}} [opts]
 */
export function openDocIndexStore(dbPath, opts = {}) {
  const create = opts.create !== false;
  if (create) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (create === false && !fs.existsSync(dbPath)) {
    throw new Error(`文档索引库不存在: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${Number(opts.busyTimeoutMs) || RETRY.busyTimeoutMs};`);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    /* 只读介质上 WAL 可能不可用；本机不属此情况 */
  }
  const schema = ensureSchema(db);
  if (getMeta(db, META_KEYS.schemaVersion) == null) {
    setMeta(db, META_KEYS.schemaVersion, DOC_INDEX_SCHEMA_VERSION);
  }
  if (opts.hostId && getMeta(db, META_KEYS.hostId) == null) {
    setMeta(db, META_KEYS.hostId, String(opts.hostId));
  }
  return { db, dbPath, schema };
}

export function getMeta(db, k) {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return r ? r.v : null;
}

export function setMeta(db, k, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run(String(k), String(v));
}

export function getMetaAll(db) {
  const out = {};
  for (const r of db.prepare('SELECT k, v FROM meta ORDER BY k').all()) out[r.k] = r.v;
  return out;
}

// ---------------------------------------------------------------- 并发保护

/** 是否为"库被锁"类错误（可重试）；其它错误一律立即上抛（不掩盖真 bug）。 */
export function isBusyError(e) {
  const msg = String((e && e.message) || e || '').toLowerCase();
  return (
    msg.includes('database is locked') ||
    msg.includes('database table is locked') ||
    msg.includes('sqlite_busy') ||
    msg.includes('busy')
  );
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带重试地执行写操作（方案 §5.2：重试 3 次 / 退避上限 60 s）。
 * 超限不抛错给调用方判死——返回 {ok:false, error}，由上层记 failed（卡要求"不报错给主人"）。
 * @template T
 * @param {() => T} fn
 * @param {{retries?:number, delaysMs?:number[], sleep?:(ms:number)=>Promise<void>, onRetry?:(i:number, e:Error)=>void}} [opts]
 * @returns {Promise<{ok:boolean, value?:T, error?:string, attempts:number, busyWaits:number}>}
 */
export async function withBusyRetry(fn, opts = {}) {
  const retries = opts.retries ?? RETRY.retries;
  const delays = opts.delaysMs ?? RETRY.delaysMs;
  const sleep = opts.sleep ?? defaultSleep;
  const started = Date.now();
  let attempts = 0;
  for (let i = 0; ; i += 1) {
    attempts += 1;
    try {
      return { ok: true, value: fn(), attempts, busyWaits: i };
    } catch (e) {
      if (!isBusyError(e) || i >= retries) {
        return { ok: false, error: String((e && e.message) || e), attempts, busyWaits: i };
      }
      const delay = delays[Math.min(i, delays.length - 1)] ?? 1000;
      if (Date.now() - started + delay > (opts.totalBudgetMs ?? RETRY.totalBudgetMs)) {
        return { ok: false, error: `退避预算耗尽（${opts.totalBudgetMs ?? RETRY.totalBudgetMs}ms）：${String((e && e.message) || e)}`, attempts, busyWaits: i + 1 };
      }
      if (opts.onRetry) opts.onRetry(i + 1, e);
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------- 读写

/**
 * 批量 UPSERT（单事务）。幂等键 = `path` 主键：重复执行不产生孤条。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{path:string, mtime:number, size:number, textHash:string, summary:string,
 *   ownerUser?:string, visibility?:string, updatedAt:number}>} rows
 * @returns {{inserted:number, updated:number, unchanged:number}}
 */
export function upsertDocs(db, rows) {
  const out = { inserted: 0, updated: 0, unchanged: 0 };
  if (!rows.length) return out;
  const existing = new Map();
  const selStmt = db.prepare('SELECT text_hash FROM doc_index WHERE path = ?');
  for (const r of rows) {
    const cur = selStmt.get(r.path);
    existing.set(r.path, cur ? cur.text_hash : null);
  }
  const stmt = db.prepare(`
    INSERT INTO doc_index (path, mtime, size, text_hash, summary, owner_user, visibility, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      mtime      = excluded.mtime,
      size       = excluded.size,
      text_hash  = excluded.text_hash,
      summary    = excluded.summary,
      owner_user = excluded.owner_user,
      visibility = excluded.visibility,
      updated_at = excluded.updated_at
  `);
  const now = Date.now();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const prev = existing.get(r.path);
      if (prev === r.textHash) {
        // 摘要内容未变 ⇒ 不重写该条（验收项「text_hash 未变的条目未重建」）
        out.unchanged += 1;
        continue;
      }
      if (prev == null) out.inserted += 1;
      else out.updated += 1;
      stmt.run(
        String(r.path),
        Math.trunc(Number(r.mtime) || 0),
        Math.trunc(Number(r.size) || 0),
        String(r.textHash),
        String(r.summary),
        String(r.ownerUser || 'LiJianXiao'),
        String(r.visibility || 'private_owner'),
        Math.trunc(Number(r.updatedAt) || now),
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
  return out;
}

/** 取指定 path 的已有 text_hash（跳过判据）。 */
export function getHashesForPaths(db, paths) {
  const out = new Map();
  if (!paths.length) return out;
  const stmt = db.prepare('SELECT text_hash FROM doc_index WHERE path = ?');
  for (const p of paths) {
    const r = stmt.get(String(p));
    if (r) out.set(String(p), r.text_hash);
  }
  return out;
}

export function getRow(db, p) {
  const r = db.prepare('SELECT * FROM doc_index WHERE path = ?').get(String(p));
  return r ?? null;
}

/**
 * 该篇在库里**是否有条**（主条 `path` **或** 任一分条 `path#§N`）。
 * ⚠️ 必须两条都查：长文档按 §3.2 切成 2~5 条时**只有分条、没有主条**
 * （实测踩过：只查主条会让长文档每轮都判 `missing-in-db` 反复重建，"第二轮全部跳过"永远不成立）。
 */
export function hasDocRows(db, p) {
  const r = db
    .prepare("SELECT 1 AS n FROM doc_index WHERE path = ? OR path LIKE ? ESCAPE '\\' LIMIT 1")
    .get(String(p), `${escapeLike(p)}#§%`);
  return Boolean(r);
}

/** 全量列出（抽检/比对用；按 path 排序保证可复现）。 */
export function listRows(db, { pathPrefix = null } = {}) {
  if (pathPrefix) {
    return db
      .prepare("SELECT * FROM doc_index WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY path")
      .all(pathPrefix, `${escapeLike(pathPrefix)}#§%`);
  }
  return db.prepare('SELECT * FROM doc_index ORDER BY path').all();
}

export function countRows(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM doc_index').get().n;
}

/** LIKE 元字符转义（path 里可能出现 % _ \，不转义会误匹配）。 */
export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * 删除某篇文档的全部索引条（含 `path#§N` 长文档分条）——回滚口径：
 * `DELETE FROM doc_index WHERE path=?`（方案 §5.4）+ 分条一并清。
 */
export function deleteDoc(db, p) {
  const r = db
    .prepare("DELETE FROM doc_index WHERE path = ? OR path LIKE ? ESCAPE '\\'")
    .run(String(p), `${escapeLike(p)}#§%`);
  return Number(r.changes || 0);
}

/** 删除本次未再生成的分条（治"文档变短后残留孤条"）。 */
export function deleteStaleRows(db, p, keepKeys) {
  const keep = new Set(keepKeys.map(String));
  const rows = db
    .prepare("SELECT path FROM doc_index WHERE path = ? OR path LIKE ? ESCAPE '\\'")
    .all(String(p), `${escapeLike(p)}#§%`);
  const stale = rows.map((r) => r.path).filter((v) => !keep.has(v));
  if (!stale.length) return 0;
  const stmt = db.prepare('DELETE FROM doc_index WHERE path = ?');
  db.exec('BEGIN');
  try {
    for (const s of stale) stmt.run(s);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  }
  return stale.length;
}

/** 库文件级快照（改动前备份；方案 §7「回滚点」）。 */
export function snapshotDb(db, destFile) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  db.prepare('VACUUM INTO ?').run(destFile);
  return destFile;
}
