// 记忆引擎 v2 · 离线层 —— 记忆库只读数据源
//
// 铁律（方案 §3.1 / §7）：对 memory.db 只读，绝不写。只读连接在 DELETE journal 模式下
// 不阻塞写者，也不被写者阻塞（A6 实测：未提交写不阻塞读）。
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function openMemorySource(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`记忆库不存在: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');

  const S = {
    count: db.prepare('SELECT COUNT(*) AS n FROM memories'),
    maxUpdated: db.prepare('SELECT MAX(updated_at) AS m FROM memories'),
    idRange: db.prepare('SELECT MIN(id) AS lo, MAX(id) AS hi, COUNT(*) AS n FROM memories'),
    pinned: db.prepare('SELECT id FROM memories WHERE pinned = 1 ORDER BY id'),
    page: db.prepare(
      `SELECT id, text, tags, pinned, updated_at FROM memories
       WHERE updated_at >= ? AND id > ? ORDER BY id LIMIT ?`,
    ),
    segment: db.prepare(
      `SELECT id, text, tags, pinned, updated_at FROM memories
       WHERE id >= ? AND id <= ? ORDER BY id`,
    ),
    byId: db.prepare(
      'SELECT id, text, tags, pinned, created_at, updated_at FROM memories WHERE id = ?',
    ),
    allTexts: db.prepare('SELECT id, text FROM memories ORDER BY id'),
    tagsOf: db.prepare('SELECT id, tags, updated_at FROM memories'),
  };

  return {
    dbPath,
    readOnly: true,

    count() {
      return Number(S.count.get().n);
    },

    maxUpdatedAt() {
      const v = S.maxUpdated.get().m;
      return v == null ? 0 : Number(v);
    },

    idRange() {
      const r = S.idRange.get();
      return { lo: r.lo == null ? null : Number(r.lo), hi: r.hi == null ? null : Number(r.hi), n: Number(r.n) };
    },

    /** 召回用：pinned 集合（方案 §3.3：召回排除 pinned，交给 dsh-memory 注入） */
    pinnedIds() {
      return S.pinned.all().map((r) => Number(r.id));
    },

    /** 增量页：updated_at >= sinceTs 且 id > afterId，按 id 升序 */
    incrementalPage(sinceTs, afterId, limit) {
      return S.page.all(Number(sinceTs), Number(afterId), Number(limit)).map(mapRow);
    },

    /** id 段（兜底 hash 轮转用） */
    segment(lo, hi) {
      return S.segment.all(Number(lo), Number(hi)).map(mapRow);
    },

    getById(id) {
      const r = S.byId.get(Number(id));
      return r ? { ...r, id: Number(r.id) } : null;
    },

    /** 全表 id + 正文（兜底校验用；570 条量级纯内存可承受） */
    allTexts() {
      return S.allTexts.all().map((r) => ({ id: Number(r.id), text: r.text }));
    },

    allTags() {
      return S.tagsOf.all().map((r) => ({ id: Number(r.id), tags: r.tags }));
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
