/**
 * FORK-EDIT(2026-09-21): 记忆库只读数据源（召回路径） —— 从 S1 离线层
 * `memory-engine/lib/memory-source.mjs` 移植（只取召回需要的读口）。
 *
 * 移植来源：本仓 `memory-engine/lib/memory-source.mjs`（记忆引擎 v2 · S1 交付）
 * 铁律（方案 §3.1 / §7）：对 memory.db **只读**，绝不写。只读连接在 DELETE journal 模式下
 * 不阻塞写者，也不被写者阻塞（A6 实测：未提交写不阻塞读）。
 * 与来源的差异：只保留 pinnedIds / ftsSearch / getById / rowsByIds / maxUpdatedAt，
 * 去掉增量同步与全表扫描（那些是离线层 sync/sweep 的活）。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function openMemoryReader(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`记忆库不存在: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');

  const S = {
    count: db.prepare('SELECT COUNT(*) AS n FROM memories'),
    maxUpdated: db.prepare('SELECT MAX(updated_at) AS m FROM memories'),
    pinned: db.prepare('SELECT id FROM memories WHERE pinned = 1 ORDER BY id'),
    byId: db.prepare(
      'SELECT id, text, tags, pinned, created_at, updated_at FROM memories WHERE id = ?',
    ),
  };

  return {
    dbPath,
    readOnly: true,
    db,

    count() {
      return Number(S.count.get().n);
    },

    maxUpdatedAt() {
      const v = S.maxUpdated.get().m;
      return v == null ? 0 : Number(v);
    },

    /** 召回用：pinned 集合（方案 §3.3：召回排除 pinned，交给 dsh-memory 注入） */
    pinnedIds() {
      return S.pinned.all().map((r) => Number(r.id));
    },

    getById(id) {
      const r = S.byId.get(Number(id));
      return r ? mapRow(r) : null;
    },

    /**
     * 批量取详情（指针渲染用；一条 SQL 取回，避免 N 次查询）。
     * @param {number[]} ids
     * @returns {Array<{id:number,text:string,tags:string,pinned:number,created_at:number,updated_at:number}>}
     */
    rowsByIds(ids) {
      const list = (ids || []).map(Number).filter((n) => Number.isFinite(n));
      if (!list.length) return [];
      const ph = list.map(() => '?').join(',');
      return db
        .prepare(
          `SELECT id, text, tags, pinned, created_at, updated_at FROM memories WHERE id IN (${ph})`,
        )
        .all(...list)
        .map((r) => ({ ...mapRow(r), created_at: Number(r.created_at) }));
    },

    /**
     * FTS5 补位检索（方案 §3.4 A4：中文连续串几近不可用，只补标签/英文/数字）。
     * @param {string} matchExpr 已构造好的 FTS5 MATCH 表达式
     */
    ftsSearch(matchExpr, limit) {
      try {
        return db
          .prepare(
            `SELECT m.id AS id, m.pinned AS pinned, bm25(memories_fts) AS score
             FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
             WHERE memories_fts MATCH ? AND m.pinned = 0
             ORDER BY score LIMIT ?`,
          )
          .all(String(matchExpr), Number(limit))
          .map((r) => ({ id: Number(r.id), score: Number(r.score) }));
      } catch (e) {
        // 表达式非法/表缺失 → 补位路径空（方案 §3.3：FTS 缺失时不参与，不做零分占位）
        return { error: String(e && e.message ? e.message : e) };
      }
    },

    close() {
      // 幂等：重复 close 不得抛错（调用方常在 finally 里再关一次）
      if (this._closed) return;
      this._closed = true;
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
    get closed() {
      return Boolean(this._closed);
    },
  };
}

function mapRow(r) {
  return {
    id: Number(r.id),
    text: r.text,
    tags: r.tags,
    pinned: Number(r.pinned),
    updated_at: Number(r.updated_at),
  };
}
