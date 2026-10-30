// 记忆库的只读数据源。
//
// 契约：对 memory.db 只开只读连接；语句在**打开阶段**一次性备好 —— 表结构不对应当是
// open 当场就炸，而不是拖到某次查询才现形。只读连接在 DELETE journal 下既不挡写者、
// 也不被写者挡。
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const BUSY_TIMEOUT_MS = 5000;

/** 全部预编译语句（键名即内部代号，SQL 文本集中在这里便于比对 schema）。 */
const STATEMENT_SQL = {
  count: 'SELECT COUNT(*) AS n FROM memories',
  maxUpdated: 'SELECT MAX(updated_at) AS m FROM memories',
  idRange: 'SELECT MIN(id) AS lo, MAX(id) AS hi, COUNT(*) AS n FROM memories',
  pinned: 'SELECT id FROM memories WHERE pinned = 1 ORDER BY id',
  page: `SELECT id, text, tags, pinned, updated_at FROM memories
         WHERE updated_at >= ? AND id > ? ORDER BY id LIMIT ?`,
  segment: `SELECT id, text, tags, pinned, updated_at FROM memories
            WHERE id >= ? AND id <= ? ORDER BY id`,
  byId: 'SELECT id, text, tags, pinned, created_at, updated_at FROM memories WHERE id = ?',
  allTexts: 'SELECT id, text FROM memories ORDER BY id',
  allTags: 'SELECT id, tags, updated_at FROM memories',
};

/** FTS5 补位：中文连续串几乎不可用，只补标签/英文/数字。 */
const FTS_SQL = `SELECT m.id AS id, m.pinned AS pinned, bm25(memories_fts) AS score
                 FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
                 WHERE memories_fts MATCH ? AND m.pinned = 0
                 ORDER BY score LIMIT ?`;

function asVecRow(r) {
  return {
    id: Number(r.id),
    text: r.text,
    tags: r.tags,
    pinned: Number(r.pinned),
    updated_at: Number(r.updated_at),
  };
}

const nullableNumber = (v) => (v == null ? null : Number(v));

export function openMemorySource(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`记忆库不存在: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);

  const q = {};
  for (const [key, sql] of Object.entries(STATEMENT_SQL)) q[key] = db.prepare(sql);

  let closed = false;
  // FTS 表可能不存在 / 表达式可能非法 ⇒ 语句**懒备**，失败要走「补位路径空」而不是让 open 失败
  let ftsStmt = null;

  return {
    dbPath,
    readOnly: true,

    count: () => Number(q.count.get().n),

    maxUpdatedAt: () => {
      const v = q.maxUpdated.get().m;
      return v == null ? 0 : Number(v);
    },

    idRange: () => {
      const r = q.idRange.get();
      return { lo: nullableNumber(r.lo), hi: nullableNumber(r.hi), n: Number(r.n) };
    },

    /** 召回排除集合（pinned 条目由宿主插件注入，引擎侧不重复给）。 */
    pinnedIds: () => q.pinned.all().map((r) => Number(r.id)),

    /** 增量页：updated_at >= sinceTs 且 id > afterId，按 id 升序。 */
    incrementalPage: (sinceTs, afterId, limit) =>
      q.page.all(Number(sinceTs), Number(afterId), Number(limit)).map(asVecRow),

    /** id 闭区间段（兜底轮转用）。 */
    segment: (lo, hi) => q.segment.all(Number(lo), Number(hi)).map(asVecRow),

    getById: (id) => {
      const r = q.byId.get(Number(id));
      return r ? { ...r, id: Number(r.id) } : null;
    },

    /** 全表 id + 正文（兜底校验用，体量在内存可承受范围内）。 */
    allTexts: () => q.allTexts.all().map((r) => ({ id: Number(r.id), text: r.text })),

    allTags: () => q.allTags.all().map((r) => ({ id: Number(r.id), tags: r.tags })),

    ftsSearch(matchExpr, limit) {
      try {
        if (!ftsStmt) ftsStmt = db.prepare(FTS_SQL);
        return ftsStmt
          .all(String(matchExpr), Number(limit))
          .map((r) => ({ id: Number(r.id), score: Number(r.score) }));
      } catch (e) {
        // 表达式非法 / 表缺失：补位路径返回空，不做零分占位
        return { error: String(e && e.message ? e.message : e) };
      }
    },

    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        /* 关闭失败不算错：调用方常在 finally 里重复关 */
      }
    },

    get closed() {
      return closed;
    },
  };
}
