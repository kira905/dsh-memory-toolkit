// 文档索引独立库 —— 建表 / 键值元数据 / 并发保护 / 批量读写与清理
//
// 为什么单开一个库文件（三条理由，别重新讨论）：
//   1. 索引条要有天然的幂等键（一条文档一个主键），主记忆库没有这样的唯一列可用；
//   2. 索引条上记的规模数字跟着本机文件 mtime 走，两台机器各算各的 ⇒ 塞进同一个库会互相覆盖；
//   3. 独立库不进任何同步链路，删掉整份可重建，也就不会跟别的写入抢锁。
//
// 对外只承诺「打开 / 读 / 写 / 清理」四件事，SQL 细节不出这个文件。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOC_INDEX_SCHEMA_VERSION } from './config.mjs';

// ── 表形状（验收按 PRAGMA table_info 逐列核对，列序/类型/NOT NULL/默认值一个都不许漂） ──

const T_DOC = 'doc_index';
const T_META = 'meta';
const ALL_TABLES = [T_DOC, T_META];

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${T_DOC} (`,
  '  path TEXT PRIMARY KEY,',
  '  mtime INTEGER NOT NULL,',
  '  size INTEGER NOT NULL,',
  '  text_hash TEXT NOT NULL,',
  '  summary TEXT NOT NULL,',
  "  owner_user TEXT NOT NULL DEFAULT 'LiJianXiao',",
  "  visibility TEXT NOT NULL DEFAULT 'private_owner',",
  '  updated_at INTEGER NOT NULL',
  ');',
  `CREATE TABLE IF NOT EXISTS ${T_META} (`,
  '  k TEXT PRIMARY KEY,',
  '  v TEXT NOT NULL',
  ');',
].join('\n');

// 列定义写成元组表，再由元组生成对外对象 —— 与上面的 DDL 一一对应，改一处就得同步另一处
const COLUMN_SPEC = [
  ['path', 'TEXT', 0, null, 1],
  ['mtime', 'INTEGER', 1, null, 0],
  ['size', 'INTEGER', 1, null, 0],
  ['text_hash', 'TEXT', 1, null, 0],
  ['summary', 'TEXT', 1, null, 0],
  ['owner_user', 'TEXT', 1, "'LiJianXiao'", 0],
  ['visibility', 'TEXT', 1, "'private_owner'", 0],
  ['updated_at', 'INTEGER', 1, null, 0],
];

export const COLUMNS = COLUMN_SPEC.map(([name, type, notnull, dflt, pk]) => ({ name, type, notnull, dflt, pk }));

// 元数据键：schemaVersion 是结构版本；hostId / lastRunAt 是运行状态；lastRunStats 存最近一轮计数
export const META_KEYS = {
  schemaVersion: 'schemaVersion',
  hostId: 'hostId',
  lastRunAt: 'lastRunAt',
  lastRunStats: 'lastRunStats',
};

// 并发保护参数：每次等锁 2s × 最多 4 次尝试，退避 1s / 4s / 16s，总预算 60s
export const RETRY = {
  retries: 3,
  busyTimeoutMs: 2000,
  delaysMs: [1000, 4000, 16000],
  totalBudgetMs: 60000,
};

const DEFAULT_OWNER = 'LiJianXiao';
const DEFAULT_VISIBILITY = 'private_owner';

// 长 SQL 集中在这里，读代码时不用在一堆模板串里找
const UPSERT_SQL = [
  `INSERT INTO ${T_DOC} (path, mtime, size, text_hash, summary, owner_user, visibility, updated_at)`,
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  'ON CONFLICT(path) DO UPDATE SET',
  '  mtime = excluded.mtime, size = excluded.size, text_hash = excluded.text_hash,',
  '  summary = excluded.summary, owner_user = excluded.owner_user,',
  '  visibility = excluded.visibility, updated_at = excluded.updated_at',
].join('\n');

const SQL_HAS_ROW = `SELECT 1 AS hit FROM ${T_DOC} WHERE path = ? OR path LIKE ? ESCAPE '\\' LIMIT 1`;
const SQL_LIST_ALL = `SELECT * FROM ${T_DOC} ORDER BY path`;
const SQL_LIST_TREE = `SELECT * FROM ${T_DOC} WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY path`;
const SQL_COUNT = `SELECT COUNT(*) AS total FROM ${T_DOC}`;
const SQL_DELETE_TREE = `DELETE FROM ${T_DOC} WHERE path = ? OR path LIKE ? ESCAPE '\\'`;

// ── 内部小件 ────────────────────────────────────────────────────────────────

const asInt = (v) => Math.trunc(Number(v) || 0);

// LIKE 元字符转义（path 里可能有 % _ \，不转义会误匹配到别的篇）
export const escapeLike = (s) => String(s).replace(/[\\%_]/g, (m) => `\\${m}`);

// 子条键前缀：长文档切成 path#§1..N 那一批时用
const subKeyPattern = (p) => `${escapeLike(p)}#§%`;

const tableExists = (db, name) =>
  Boolean(db.prepare('SELECT 1 AS hit FROM sqlite_master WHERE type = ? AND name = ?').get('table', name));

// 事务壳：体里抛错就回滚；回滚本身再炸也只把原始错误往外抛
function inTransaction(db, body) {
  db.exec('BEGIN');
  try {
    const outcome = body();
    db.exec('COMMIT');
    return outcome;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 连接已经坏了才会走到这儿 —— 原始错误更有诊断价值
    }
    throw err;
  }
}

// ── 建库 / 打开 ─────────────────────────────────────────────────────────────

export function ensureSchema(db) {
  const created = ALL_TABLES.filter((name) => !tableExists(db, name));
  db.exec(DDL);
  const tables = {};
  for (const name of ALL_TABLES) tables[name] = tableExists(db, name);
  return { created, tables };
}

// 打开（必要时建）文档索引库：建目录 → 设等锁时长 → 开 WAL → 补 schema / hostId 两个元数据键
export function openDocIndexStore(dbPath, opts = {}) {
  const canCreate = opts.create !== false;
  if (canCreate) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  else if (!fs.existsSync(dbPath)) throw new Error(`文档索引库不存在: ${dbPath}`);

  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${Number(opts.busyTimeoutMs) || RETRY.busyTimeoutMs};`);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    // 只读介质上 WAL 可能开不起来，不影响主流程
  }

  const schema = ensureSchema(db);
  if (getMeta(db, META_KEYS.schemaVersion) == null) setMeta(db, META_KEYS.schemaVersion, DOC_INDEX_SCHEMA_VERSION);
  if (opts.hostId && getMeta(db, META_KEYS.hostId) == null) setMeta(db, META_KEYS.hostId, String(opts.hostId));
  return { db, dbPath, schema };
}

// ── 元数据键值 ──────────────────────────────────────────────────────────────

export const getMeta = (db, k) => db.prepare(`SELECT v FROM ${T_META} WHERE k = ?`).get(k)?.v ?? null;

export const setMeta = (db, k, v) =>
  db
    .prepare(`INSERT INTO ${T_META} (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
    .run(String(k), String(v));

export const getMetaAll = (db) => {
  const out = {};
  for (const row of db.prepare(`SELECT k, v FROM ${T_META} ORDER BY k`).all()) out[row.k] = row.v;
  return out;
};

// ── 并发保护 ────────────────────────────────────────────────────────────────

// 只有「库被占着」类错误值得等；其它错误立刻收手，免得把真 bug 掩盖成重试
export const isBusyError = (e) => /busy|locked/i.test(String((e && e.message) || e || ''));

const realSleep = (ms) => new Promise((done) => setTimeout(done, ms));

// 带退避地执行一次写操作。超限**不抛**：返回 {ok:false, error} 交上层记失败
// （调用方约定：库里出问题只记账，不把异常甩给用户）
export async function withBusyRetry(fn, opts = {}) {
  const maxRetries = opts.retries ?? RETRY.retries;
  const delays = opts.delaysMs ?? RETRY.delaysMs;
  const nap = opts.sleep ?? realSleep;
  const budget = opts.totalBudgetMs ?? RETRY.totalBudgetMs;
  const t0 = Date.now();
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return { ok: true, value: fn(), attempts: attempt, busyWaits: attempt - 1 };
    } catch (err) {
      const text = String((err && err.message) || err);
      const waited = attempt - 1;
      if (!isBusyError(err) || attempt > maxRetries) {
        return { ok: false, error: text, attempts: attempt, busyWaits: waited };
      }
      const pause = delays[Math.min(waited, delays.length - 1)] ?? 1000;
      if (Date.now() - t0 + pause > budget) {
        return { ok: false, error: `退避预算耗尽（${budget}ms）：${text}`, attempts: attempt, busyWaits: waited + 1 };
      }
      if (typeof opts.onRetry === 'function') opts.onRetry(attempt, err);
      await nap(pause);
    }
  }
}

// ── 读写 ────────────────────────────────────────────────────────────────────

// 批量 UPSERT（一个事务）。幂等键 = path：同一批重复执行不会长出第二条。
// 返回 {inserted, updated, unchanged}；unchanged 是「摘要哈希没变、整行没重写」的那些。
export function upsertDocs(db, rows) {
  const tally = { inserted: 0, updated: 0, unchanged: 0 };
  if (!rows?.length) return tally;

  const readHash = db.prepare(`SELECT text_hash FROM ${T_DOC} WHERE path = ?`);
  const pending = [];
  for (const row of rows) {
    const seen = readHash.get(row.path);
    const before = seen ? seen.text_hash : null;
    if (before === row.textHash) {
      // 摘要没变 ⇒ 整行不重写（mtime / updated_at 都不许动）
      tally.unchanged += 1;
      continue;
    }
    pending.push({ row, before });
  }
  if (!pending.length) return tally;

  const write = db.prepare(UPSERT_SQL);
  const stamp = Date.now();
  inTransaction(db, () => {
    for (const { row, before } of pending) {
      write.run(
        String(row.path),
        asInt(row.mtime),
        asInt(row.size),
        String(row.textHash),
        String(row.summary),
        String(row.ownerUser || DEFAULT_OWNER),
        String(row.visibility || DEFAULT_VISIBILITY),
        asInt(row.updatedAt) || stamp,
      );
      if (before == null) tally.inserted += 1;
      else tally.updated += 1;
    }
  });
  return tally;
}

// 一批 path 已有的 text_hash（调用方据此判「要不要重算」）
export function getHashesForPaths(db, paths) {
  const known = new Map();
  if (!paths?.length) return known;
  const stmt = db.prepare(`SELECT text_hash FROM ${T_DOC} WHERE path = ?`);
  for (const p of paths) {
    const key = String(p);
    const hit = stmt.get(key);
    if (hit) known.set(key, hit.text_hash);
  }
  return known;
}

export const getRow = (db, p) => db.prepare(`SELECT * FROM ${T_DOC} WHERE path = ?`).get(String(p)) ?? null;

// 这一篇在库里有没有条：主条 path **或**任一分条 path#§N 都算。
// 分条必须一起查 —— 长文档切成 2~5 条时只存在分条，只查主条会判成「库里没有」而每轮重建。
export function hasDocRows(db, p) {
  const hit = db.prepare(SQL_HAS_ROW).get(String(p), subKeyPattern(p));
  return Boolean(hit);
}

// 全量列出（按 path 排序，读数可复现）；给 pathPrefix 就只管这一篇及其分条
export function listRows(db, { pathPrefix = null } = {}) {
  if (!pathPrefix) return db.prepare(SQL_LIST_ALL).all();
  return db.prepare(SQL_LIST_TREE).all(String(pathPrefix), subKeyPattern(pathPrefix));
}

export const countRows = (db) => db.prepare(SQL_COUNT).get().total;

// 删掉某篇的全部条（主条 + path#§N 分条）—— 回滚口径就这一条
export function deleteDoc(db, p) {
  const res = db.prepare(SQL_DELETE_TREE).run(String(p), subKeyPattern(p));
  return Number(res.changes || 0);
}

// 删本次没再生成的分条（文档从长变短时的残留），保留 keepKeys 里点名的那些
export function deleteStaleRows(db, p, keepKeys) {
  const keep = new Set(keepKeys.map(String));
  const rows = db.prepare(`SELECT path FROM ${T_DOC} WHERE path = ? OR path LIKE ? ESCAPE '\\'`).all(
    String(p),
    subKeyPattern(p),
  );
  const stale = rows.map((r) => r.path).filter((v) => !keep.has(v));
  if (!stale.length) return 0;
  const drop = db.prepare(`DELETE FROM ${T_DOC} WHERE path = ?`);
  inTransaction(db, () => {
    for (const key of stale) drop.run(key);
  });
  return stale.length;
}

// 库文件级快照（改动前的回滚点）
export function snapshotDb(db, destFile) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  db.prepare('VACUUM INTO ?').run(destFile);
  return destFile;
}
