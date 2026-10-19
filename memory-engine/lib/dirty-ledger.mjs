// 记忆引擎 v2 · S3c —— `memories_dirty` 台账（兜底 hash 轮转的**产物**）
//
// 为什么要有它（方案 §3.5 输入行「v3 补漏（关 I5）」）：
//   A7 实测 5 个脚本 41 处 `UPDATE memories SET text=?`，其中 `apply-pinned-refine.mjs:110`
//   改 text **不动 `updated_at`** ⇒ 这类被勘误的记忆**永远不在 24h 增量窗口内**。
//   方案给的修法 = 把「§3.1 全表 `text_hash` 段轮转」的**产物**（差异清单）作为提炼 job 的补充输入源。
//
// 关键设计：差异清单必须**持久化**，不能只在内存里过一遍 ——
//   轮转（`lib/sweep.mjs`）发现差异后会**立刻重编码并更新 `vectors.text_hash`**，
//   差异信号当场消失；若当时没人消费，这条改动就永久消失在增量窗口之外（正是要治的病）。
//   ⇒ 检测到差异的**那一刻**就落台账；提炼 job 事后按台账补齐输入。
//
// 落点：`vectors.db`（独立向量库，`sync:false` 不进任何仓，可重建）。
//   放这里而不是新开 state 文件：它**本来就是**向量层的派生产物（与 `vectors.text_hash` 同源），
//   且向量库随 `~/.dsh/memory-vectors/` 一起被清理/重建，台账不会成为孤儿。
//
// 语义：一条 = 一个 `ref_id`（memory.id）。
//   · `kind='mismatch'`：正文哈希与向量库记录不符 ⇒ **正文被改过**（本台账的唯一入账类型）
//   · `consumed_at`：提炼 job 消费过（= 已并入某次提炼输入）
//     ⚠️ **不删行**：删了就没法回答"这条改动是谁消费的"；保留 + 定期 prune。
import { DatabaseSync } from 'node:sqlite';

/** 台账 DDL（幂等；与 `vectors-store.mjs` 同库，加表不前向破坏既有表）。 */
export const DIRTY_DDL = `
CREATE TABLE IF NOT EXISTS memories_dirty (
  ref_id      TEXT    NOT NULL PRIMARY KEY,
  kind        TEXT    NOT NULL,
  old_hash    TEXT,
  new_hash    TEXT,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 1,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS memories_dirty_open ON memories_dirty (consumed_at, last_at);
`;

export const DIRTY_SCHEMA = 1;

export function ensureDirtySchema(db) {
  db.exec(DIRTY_DDL);
  return true;
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

/**
 * 记一批差异（**幂等 upsert**）。
 *
 * 重复记账的口径（写死，别再各写各的）：
 *   · 同一 `ref_id` 再次被检测到 → `hits+1` / `last_at` 刷新 / `new_hash` 刷新；
 *   · **`new_hash` 与库里不同 = 正文又变了** ⇒ 把 `consumed_at` 清空（重新变成待消费），
 *     否则"消费过"的标记会把第二次改动永久吞掉（这正是台账最容易写错的一处）。
 *
 * @param {object} db 向量库连接（写）
 * @param {Array<{refId:string|number, kind?:string, oldHash?:string|null, newHash?:string|null}>} items
 * @param {{now?:number}} [opts]
 * @returns {{recorded:number, reopened:number}}
 */
export function recordDirty(db, items, opts = {}) {
  if (!items || !items.length) return { recorded: 0, reopened: 0 };
  ensureDirtySchema(db);
  const now = Number(opts.now ?? Date.now());
  const sel = db.prepare('SELECT ref_id, new_hash, consumed_at FROM memories_dirty WHERE ref_id = ?');
  const ins = db.prepare(`INSERT INTO memories_dirty (ref_id, kind, old_hash, new_hash, first_at, last_at, hits, consumed_at)
                          VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`);
  const upd = db.prepare(`UPDATE memories_dirty SET kind = ?, old_hash = ?, new_hash = ?, last_at = ?, hits = hits + 1,
                          consumed_at = ? WHERE ref_id = ?`);
  let recorded = 0;
  let reopened = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const it of items) {
      const refId = String(it.refId);
      if (!refId) continue;
      const kind = String(it.kind ?? 'mismatch');
      const oldHash = it.oldHash ?? null;
      const newHash = it.newHash ?? null;
      const prev = sel.get(refId);
      if (!prev) {
        ins.run(refId, kind, oldHash, newHash, now, now);
        recorded += 1;
        continue;
      }
      const changedAgain = newHash != null && prev.new_hash != null && prev.new_hash !== newHash;
      if (changedAgain && prev.consumed_at != null) reopened += 1;
      // ⚠️ 只有"正文又变了"才清 consumed_at；**同一条重复被扫到不得清**（否则每轮轮转都会重新消费一遍）
      upd.run(kind, oldHash, newHash, now, changedAgain ? null : prev.consumed_at, refId);
      recorded += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return { recorded, reopened };
}

/**
 * 读台账。
 * @param {object} db
 * @param {{includeConsumed?:boolean, openOnly?:boolean, limit?:number}} [opts]
 */
export function listDirty(db, opts = {}) {
  if (!hasTable(db, 'memories_dirty')) return [];
  const openOnly = opts.openOnly !== false && opts.includeConsumed !== true;
  const lim = Number(opts.limit ?? 0);
  const sql = `SELECT ref_id, kind, old_hash, new_hash, first_at, last_at, hits, consumed_at
               FROM memories_dirty ${openOnly ? 'WHERE consumed_at IS NULL' : ''}
               ORDER BY last_at DESC${lim > 0 ? ` LIMIT ${lim}` : ''}`;
  return db.prepare(sql).all().map((r) => ({
    refId: String(r.ref_id), kind: r.kind, oldHash: r.old_hash, newHash: r.new_hash,
    firstAt: Number(r.first_at), lastAt: Number(r.last_at), hits: Number(r.hits),
    consumedAt: r.consumed_at == null ? null : Number(r.consumed_at),
  }));
}

/** 标记已消费（提炼 job 把这批 id 并入输入后调用）。 */
export function markConsumed(db, refIds, opts = {}) {
  if (!refIds || !refIds.length) return 0;
  if (!hasTable(db, 'memories_dirty')) return 0;
  const now = Number(opts.now ?? Date.now());
  const stmt = db.prepare('UPDATE memories_dirty SET consumed_at = ? WHERE ref_id = ? AND consumed_at IS NULL');
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const id of refIds) n += Number(stmt.run(now, String(id)).changes || 0);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
  return n;
}

/** 台账概览（state / CLI / 日报用）。 */
export function dirtyStats(db) {
  if (!hasTable(db, 'memories_dirty')) return { table: false, total: 0, open: 0, consumed: 0, lastAt: null };
  const r = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN consumed_at IS NULL THEN 1 ELSE 0 END) open_count,
      SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) consumed_count,
      MAX(last_at) last_at FROM memories_dirty`).get();
  return {
    table: true,
    total: Number(r.total ?? 0),
    open: Number(r.open_count ?? 0),
    consumed: Number(r.consumed_count ?? 0),
    lastAt: r.last_at == null ? null : Number(r.last_at),
  };
}

/** 定期清理：清掉**已消费**且早于 `keepDays` 的行（未消费的永不清理）。 */
export function pruneDirty(db, opts = {}) {
  if (!hasTable(db, 'memories_dirty')) return 0;
  const now = Number(opts.now ?? Date.now());
  const keepDays = Number(opts.keepDays ?? 90);
  const cutoff = now - keepDays * 86_400_000;
  const r = db.prepare('DELETE FROM memories_dirty WHERE consumed_at IS NOT NULL AND consumed_at < ?').run(cutoff);
  return Number(r.changes || 0);
}

/** 便捷：直接按库路径开一个写连接执行 fn（台账写入方都是短命脚本）。 */
export function withDirtyDb(dbPath, fn) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    ensureDirtySchema(db);
    return fn(db);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
