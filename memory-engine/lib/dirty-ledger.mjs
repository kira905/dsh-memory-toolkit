// `memories_dirty` 台账：兜底轮转扫出来的「正文被外部改过」清单。
//
// 为什么必须落盘：轮转一旦发现差异，就会顺手把向量和 text_hash 刷成新的，差异信号当场消失；
// 那一刻要是没人看见，这条改动就再也不会出现在任何增量窗口里。所以差异一出现就先记账，
// 提炼侧日后按台账把漏掉的输入补回来。
//
// 放哪儿：和向量库同一只库（它本来就是向量层的派生物，库被清理/重建时一起走，不会变成孤儿）。
// 一行 = 一个 ref_id；consumed_at 只表示"提炼侧取过了"，行不删（要留痕），靠定期 prune 收掉。

import { DatabaseSync } from 'node:sqlite';

const TABLE = 'memories_dirty';
const COLUMNS = 'ref_id, kind, old_hash, new_hash, first_at, last_at, hits, consumed_at';

/** 建表语句（幂等；与向量表同库，只加表、不动既有表）。 */
export const DIRTY_DDL = `
CREATE TABLE IF NOT EXISTS memories_dirty (
  ref_id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL,
  old_hash TEXT,
  new_hash TEXT,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS memories_dirty_open ON memories_dirty (consumed_at, last_at);
`;

export const DIRTY_SCHEMA = 1; // 表结构版本；列一旦增减就地加一

export function ensureDirtySchema(db) {
  db.exec(DIRTY_DDL);
  return true;
}

// 表在不在：不在就当"还没轮转过"，一律返回空结果，不抛错（老库也要能读）。
function tablePresent(db) {
  const hit = db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE);
  return Boolean(hit);
}

// 三条热语句备一次就够：本模块的写入方都是短命脚本，连接不会活太久。
function prepareWrites(db) {
  return {
    peek: db.prepare(`SELECT ref_id, new_hash, consumed_at FROM ${TABLE} WHERE ref_id = ?`),
    spawn: db.prepare(
      `INSERT INTO ${TABLE} (ref_id, kind, old_hash, new_hash, first_at, last_at, hits, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`,
    ),
    bump: db.prepare(
      `UPDATE ${TABLE} SET kind = ?, old_hash = ?, new_hash = ?, last_at = ?, hits = hits + 1, consumed_at = ?
       WHERE ref_id = ?`,
    ),
  };
}

// 库里的一行 → 对外形状（驼峰；数值列统一转 number）
function toEntry(row) {
  const consumed = row.consumed_at;
  return {
    refId: String(row.ref_id),
    kind: row.kind,
    oldHash: row.old_hash,
    newHash: row.new_hash,
    firstAt: Number(row.first_at),
    lastAt: Number(row.last_at),
    hits: Number(row.hits),
    consumedAt: consumed == null ? null : Number(consumed),
  };
}

/**
 * 记一批差异（幂等 upsert）。
 *
 * 重复记账的口径只有两条，写死在这里：
 *   · 同一个 ref_id 再被扫到 ⇒ hits 加一、last_at 刷新、new_hash 跟着更新；
 *   · 只有当 new_hash 相对库里存的那份**又变了**，才把 consumed_at 清掉让它重新待消费。
 *     反过来，同一条差异被反复扫到**不许**复活 —— 否则每轮轮转都会把它重新消费一遍。
 *
 * @param {object} db 向量库连接（可写）
 * @param {Array<{refId:string|number, kind?:string, oldHash?:string|null, newHash?:string|null}>} items
 * @param {{now?:number}} [opts]
 * @returns {{recorded:number, reopened:number}}
 */
export function recordDirty(db, items, opts = {}) {
  const batch = items || [];
  if (!batch.length) return { recorded: 0, reopened: 0 };
  ensureDirtySchema(db);
  const at = Number(opts.now ?? Date.now());
  const writes = prepareWrites(db);
  let recorded = 0;
  let reopened = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of batch) {
      const refId = String(item.refId);
      if (!refId) continue;
      const kind = String(item.kind ?? 'mismatch');
      const oldHash = item.oldHash ?? null;
      const newHash = item.newHash ?? null;
      const before = writes.peek.get(refId);
      if (!before) {
        writes.spawn.run(refId, kind, oldHash, newHash, at, at);
        recorded += 1;
        continue;
      }
      const rewritten = newHash != null && before.new_hash != null && before.new_hash !== newHash;
      writes.bump.run(kind, oldHash, newHash, at, rewritten ? null : before.consumed_at, refId);
      if (rewritten && before.consumed_at != null) reopened += 1;
      recorded += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚本身失败也不能盖掉原始错误
    }
    throw e;
  }
  return { recorded, reopened };
}

/**
 * 读台账：默认只给未消费的；要全量就显式传 includeConsumed（或 openOnly:false）。
 * @param {object} db
 * @param {{includeConsumed?:boolean, openOnly?:boolean, limit?:number}} [opts]
 */
export function listDirty(db, opts = {}) {
  if (!tablePresent(db)) return [];
  const wantAll = opts.includeConsumed === true;
  const onlyOpen = opts.openOnly !== false && !wantAll;
  const cap = Number(opts.limit ?? 0);
  const filter = onlyOpen ? 'WHERE consumed_at IS NULL' : '';
  const page = cap > 0 ? `LIMIT ${cap}` : '';
  const sql = `SELECT ${COLUMNS} FROM ${TABLE} ${filter} ORDER BY last_at DESC ${page}`;
  return db.prepare(sql).all().map(toEntry);
}

/** 标记已消费（提炼侧把这批 id 并进输入之后调）。只动还没消费过的行，天然幂等。 */
export function markConsumed(db, refIds, opts = {}) {
  const ids = refIds || [];
  if (!ids.length || !tablePresent(db)) return 0;
  const at = Number(opts.now ?? Date.now());
  const stmt = db.prepare(`UPDATE ${TABLE} SET consumed_at = ? WHERE ref_id = ? AND consumed_at IS NULL`);
  let touched = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of ids) touched += Number(stmt.run(at, String(id)).changes || 0);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 同上：保留原始错误
    }
    throw e;
  }
  return touched;
}

/** 台账概览（状态面板 / 日报用）。表不在 ⇒ table:false 的空壳，不抛错。 */
export function dirtyStats(db) {
  if (!tablePresent(db)) return { table: false, total: 0, open: 0, consumed: 0, lastAt: null };
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN consumed_at IS NULL THEN 1 ELSE 0 END) AS open_count,
              SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed_count,
              MAX(last_at) AS last_at
       FROM ${TABLE}`,
    )
    .get();
  return {
    table: true,
    total: Number(agg.total ?? 0),
    open: Number(agg.open_count ?? 0),
    consumed: Number(agg.consumed_count ?? 0),
    lastAt: agg.last_at == null ? null : Number(agg.last_at),
  };
}

/** 定期收尾：只清"已消费且够老"的行，没消费过的永远留着。 */
export function pruneDirty(db, opts = {}) {
  if (!tablePresent(db)) return 0;
  const keepDays = Number(opts.keepDays ?? 90);
  const cutoff = Number(opts.now ?? Date.now()) - keepDays * 86_400_000;
  const res = db.prepare(`DELETE FROM ${TABLE} WHERE consumed_at IS NOT NULL AND consumed_at < ?`).run(cutoff);
  return Number(res.changes || 0);
}

/** 便捷入口：按库路径开一只写连接，跑完 fn 就关（台账写入方都是短命脚本）。 */
export function withDirtyDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    ensureDirtySchema(db);
    return fn(db);
  } finally {
    try {
      db.close();
    } catch {
      // 关不掉不算错：调用方多半已经在 finally 里兜着
    }
  }
}
