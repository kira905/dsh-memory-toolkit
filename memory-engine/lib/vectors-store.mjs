// 记忆引擎 v2 · 离线层 —— 独立向量库（方案 §3.1）
//
// 为什么独立库（D3 已拍）：memory.db 是 DELETE 模式 + busy_timeout=0，
// 任何第三个写者都可能让主人的 memory_write 失败。向量是可重建的派生物。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from './config.mjs';

const DDL = `
CREATE TABLE IF NOT EXISTS vectors (
  source     TEXT    NOT NULL,
  ref_id     TEXT    NOT NULL,
  model      TEXT    NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB    NOT NULL,
  text_hash  TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, ref_id)
);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vectors_source_model ON vectors (source, model);
`;

/** meta 键名（方案 §3.1 要求的前 6 项；后两项为兜底轮转的必需运行状态） */
export const META_KEYS = {
  schemaVersion: 'schemaVersion',
  hostId: 'hostId',
  modelId: 'modelId',
  dim: 'dim',
  lastIncrementalSyncAt: 'lastIncrementalSyncAt',
  lastFullHashSweepAt: 'lastFullHashSweepAt',
  hashSweepCursor: 'hashSweepCursor',
  lastSyncStats: 'lastSyncStats',
};

/**
 * 按「来源」命名空间的 meta 键前缀（记忆 v2 §3 A.4 / 2026-10-10 落地）。
 *
 * 为什么必须分命名空间：坑库（`source='pitfall'`）与记忆（`source='memory'`）**共用一个 vectors.db**，
 * 两者的水位/游标/模型键若同名会互相覆盖 ⇒ 表现为「记忆增量漏编码且不报错」（方案 §1.3-③.1 / §A.6 首要风险）。
 * ⇒ 这四个键（+ 两个运行状态键）一律写成 `<key>:<source>`。
 */
export const SOURCE_SCOPED_META_KEYS = [
  'modelId',
  'dim',
  'lastIncrementalSyncAt',
  'hashSweepCursor',
  'lastFullHashSweepAt',
  'lastSyncStats',
];

/** `<baseKey>:<source>`（来源命名空间的 meta 键名） */
export function metaKeyFor(baseKey, source) {
  return `${baseKey}:${source}`;
}

/**
 * 读 meta（按来源）：先读命名空间键；读不到且来源是 memory ⇒ **兼容读**无后缀旧键
 * （老库尚未迁移的那一次；语义等价，不改变任何默认行为）。
 */
export function getMetaFor(db, baseKey, source) {
  const v = getMeta(db, metaKeyFor(baseKey, source));
  if (v != null) return v;
  if (String(source) === 'memory') return getMeta(db, baseKey);
  return null;
}

/**
 * 写 meta（按来源）+ **冗余写**（方案 §A.4 的 C4 选项①）：
 * memory 侧同时把无后缀旧键写成同值 ⇒ 回滚到旧代码时读到的水位仍然正确，
 * 不会走「首次全量」分支把整库 DELETE 重建（626 条 ≈ 102 s 的一次数据面事件）。
 */
export function setMetaFor(db, baseKey, source, value) {
  setMeta(db, metaKeyFor(baseKey, source), value);
  if (String(source) === 'memory') setMeta(db, baseKey, value);
}

/**
 * 一次性命名空间迁移（**幂等**）：把无后缀旧键的现值播种到 `<key>:memory`。
 * 只在「旧键在 且 新键缺」时写 ⇒ 跑多少次都只迁移一次；旧键**保留不动**（= 冗余写）。
 * @returns {string[]} 本次实际迁移的键名
 */
export function migrateMetaNamespace(db) {
  const migrated = [];
  for (const k of SOURCE_SCOPED_META_KEYS) {
    const old = getMeta(db, k);
    if (old == null) continue;
    if (getMeta(db, metaKeyFor(k, 'memory')) != null) continue;
    setMeta(db, metaKeyFor(k, 'memory'), old);
    migrated.push(k);
  }
  return migrated;
}

function tableExists(db, name) {
  const r = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(r);
}

export function ensureSchema(db) {
  const created = [];
  if (!tableExists(db, 'vectors')) created.push('vectors');
  if (!tableExists(db, 'meta')) created.push('meta');
  db.exec(DDL);
  return { created, tables: { vectors: tableExists(db, 'vectors'), meta: tableExists(db, 'meta') } };
}

/**
 * 打开（必要时创建）向量库。
 * @param {string} dbPath
 * @param {{create?: boolean}} [opts]
 */
export function openVectorsStore(dbPath, opts = {}) {
  const create = opts.create !== false;
  if (create) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (create === false && !fs.existsSync(dbPath)) {
    throw new Error(`向量库不存在: ${dbPath}`);
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    /* 只读介质上 WAL 可能不可用，退回默认模式（本机不属此情况） */
  }
  const schema = ensureSchema(db);
  // 【2026-10-10 · 补坑库联动A】meta 命名空间一次性迁移（幂等；旧键保留 = 冗余写，可回滚）
  const migrated = migrateMetaNamespace(db);
  const sv = getMeta(db, META_KEYS.schemaVersion);
  if (sv == null) {
    setMeta(db, META_KEYS.schemaVersion, SCHEMA_VERSION);
  } else if (migrated.length && sv !== SCHEMA_VERSION) {
    // 迁移实际发生 ⇒ 升版本号（表结构未变，只是键位扩了命名空间）
    setMeta(db, META_KEYS.schemaVersion, SCHEMA_VERSION);
  }
  return { db, dbPath, schema, migrated };
}

export function getMeta(db, k) {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return r ? r.v : null;
}

export function setMeta(db, k, v) {
  db.prepare(
    'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  ).run(String(k), String(v));
}

export function getMetaAll(db) {
  const out = {};
  for (const r of db.prepare('SELECT k, v FROM meta ORDER BY k').all()) out[r.k] = r.v;
  return out;
}

export function vecToBlob(vec) {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function blobToVec(blob) {
  // 注意：sqlite 返回的 Buffer 可能是池化分配（byteOffset 不对齐 4 字节）⇒ 必须切片后重建
  const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(ab);
}

/** 批量 upsert（单事务） */
export function upsertVectors(db, items) {
  if (!items.length) return 0;
  const stmt = db.prepare(`
    INSERT INTO vectors (source, ref_id, model, dim, vec, text_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, ref_id) DO UPDATE SET
      model = excluded.model,
      dim = excluded.dim,
      vec = excluded.vec,
      text_hash = excluded.text_hash,
      updated_at = excluded.updated_at
  `);
  db.exec('BEGIN');
  try {
    for (const it of items) {
      stmt.run(
        it.source,
        String(it.refId),
        it.model,
        it.dim,
        vecToBlob(it.vec),
        it.textHash,
        it.updatedAt,
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
  return items.length;
}

/** 取指定 ref_id 的已有哈希（增量同步的跳过判据） */
export function getHashes(db, source, refIds) {
  const out = new Map();
  if (!refIds.length) return out;
  const stmt = db.prepare('SELECT text_hash FROM vectors WHERE source = ? AND ref_id = ?');
  for (const id of refIds) {
    const r = stmt.get(source, String(id));
    if (r) out.set(String(id), r.text_hash);
  }
  return out;
}

export function countVectors(db, source) {
  const r = source
    ? db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE source = ?').get(source)
    : db.prepare('SELECT COUNT(*) AS n FROM vectors').get();
  return r.n;
}

export function countByModel(db, source, model) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM vectors WHERE source = ? AND model = ?')
    .get(source, model).n;
}

export function deleteSource(db, source) {
  const r = db.prepare('DELETE FROM vectors WHERE source = ?').run(source);
  return Number(r.changes || 0);
}

/**
 * 载入整个矩阵（召回用；万级候选纯内存暴力检索，方案 §3.3）。
 * @returns {{refIds: string[], refIdsNum: number[], dim: number, data: Float32Array, count: number, textHashes: string[], models: string[]}}
 */
export function loadMatrix(db, source, model = null) {
  const rows = model
    ? db
        .prepare(
          'SELECT ref_id, model, dim, vec, text_hash FROM vectors WHERE source = ? AND model = ? ORDER BY CAST(ref_id AS INTEGER)',
        )
        .all(source, model)
    : db
        .prepare(
          'SELECT ref_id, model, dim, vec, text_hash FROM vectors WHERE source = ? ORDER BY CAST(ref_id AS INTEGER)',
        )
        .all(source);
  if (!rows.length) {
    return {
      refIds: [],
      refIdsNum: [],
      dim: 0,
      data: new Float32Array(0),
      count: 0,
      textHashes: [],
      models: [],
    };
  }
  const dim = rows[0].dim;
  const data = new Float32Array(rows.length * dim);
  rows.forEach((r, i) => {
    if (r.dim !== dim) {
      throw new Error(
        `向量库维度不一致：ref_id=${r.ref_id} dim=${r.dim}，首个为 ${dim}（应全量重建）`,
      );
    }
    const v = blobToVec(r.vec);
    if (v.length !== dim) {
      throw new Error(`向量 blob 长度异常：ref_id=${r.ref_id} len=${v.length} 期望 ${dim}`);
    }
    data.set(v, i * dim);
  });
  const models = [...new Set(rows.map((r) => r.model))];
  return {
    refIds: rows.map((r) => String(r.ref_id)),
    refIdsNum: rows.map((r) => Number(r.ref_id)),
    dim,
    data,
    count: rows.length,
    textHashes: rows.map((r) => r.text_hash),
    models,
  };
}
