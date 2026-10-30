// 独立向量库（方案 §3.1）
//
// 为什么单独一个 SQLite 文件：主记忆库跑 DELETE 日志模式、busy_timeout 是 0，
// 再挂一个写者就可能把主人的 memory_write 撞成失败。向量本身可由正文重算，是纯派生物。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from './config.mjs';

// 建表改成「列定义表 → 拼 SQL」：以后加列只动这张表，不再改 SQL 正文
const VECTOR_COLUMN_SPEC = [
  ['source', 'TEXT NOT NULL'],
  ['ref_id', 'TEXT NOT NULL'],
  ['model', 'TEXT NOT NULL'],
  ['dim', 'INTEGER NOT NULL'],
  ['vec', 'BLOB NOT NULL'],
  ['text_hash', 'TEXT NOT NULL'],
  ['updated_at', 'INTEGER NOT NULL'],
];

const VECTOR_COLUMN_SQL = VECTOR_COLUMN_SPEC.map(([col, type]) => `  ${col} ${type},`).join('\n');

const DDL = [
  `CREATE TABLE IF NOT EXISTS vectors (\n${VECTOR_COLUMN_SQL}\n  PRIMARY KEY (source, ref_id)\n);`,
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);',
  'CREATE INDEX IF NOT EXISTS vectors_source_model ON vectors (source, model);',
].join('\n');

const SQL_META_READ = 'SELECT v FROM meta WHERE k = ?';
const SQL_META_UPSERT = `
  INSERT INTO meta (k, v) VALUES (?, ?)
  ON CONFLICT(k) DO UPDATE SET v = excluded.v
`;
const SQL_META_DUMP = 'SELECT k, v FROM meta ORDER BY k';
const SQL_TABLE_PROBE = 'SELECT name FROM sqlite_master WHERE type = ? AND name = ?';
const SQL_VECTOR_UPSERT = `
INSERT INTO vectors (source, ref_id, model, dim, vec, text_hash, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(source, ref_id) DO UPDATE SET
  model = excluded.model,
  dim = excluded.dim,
  vec = excluded.vec,
  text_hash = excluded.text_hash,
  updated_at = excluded.updated_at
`;
const SQL_HASH_READ = 'SELECT text_hash FROM vectors WHERE source = ? AND ref_id = ?';
const SQL_COUNT_ALL = 'SELECT COUNT(*) AS n FROM vectors';
const SQL_COUNT_BY_SOURCE = 'SELECT COUNT(*) AS n FROM vectors WHERE source = ?';
const SQL_COUNT_BY_MODEL = 'SELECT COUNT(*) AS n FROM vectors WHERE source = ? AND model = ?';
const SQL_SOURCE_DELETE = 'DELETE FROM vectors WHERE source = ?';
const SQL_MATRIX_BASE = 'SELECT ref_id, model, dim, vec, text_hash FROM vectors WHERE source = ?';
const SQL_MATRIX_ORDER = 'ORDER BY CAST(ref_id AS INTEGER)';

const META_KEY_NAMES = [
  'schemaVersion',
  'hostId',
  'modelId',
  'dim',
  'lastIncrementalSyncAt',
  'lastFullHashSweepAt',
  'hashSweepCursor',
  'lastSyncStats',
];

/** meta 键名（方案 §3.1 要的前 6 项；后 2 项是兜底轮转的运行状态） */
export const META_KEYS = META_KEY_NAMES.reduce((bag, name) => {
  bag[name] = name;
  return bag;
}, {});

/**
 * 需要按来源分命名空间的键（记忆 v2 §3 A.4）。
 * 坑库与记忆共用一个 vectors.db，同名键会互相覆盖 —— 症状是「记忆增量漏编码却不报错」。
 * 因此这些键一律存成 `<key>:<source>`。
 */
export const SOURCE_SCOPED_META_KEYS = [
  'modelId',
  'dim',
  'lastIncrementalSyncAt',
  'hashSweepCursor',
  'lastFullHashSweepAt',
  'lastSyncStats',
];

/** 内部：读一个键（没有就 null） */
function metaRead(db, key) {
  const row = db.prepare(SQL_META_READ).get(key);
  return row ? row.v : null;
}

/** 内部：写一个键（覆盖式） */
function metaWrite(db, key, value) {
  db.prepare(SQL_META_UPSERT).run(String(key), String(value));
}

/** `<baseKey>:<source>` 形式的键名 */
export function metaKeyFor(baseKey, source) {
  return `${baseKey}:${source}`;
}

/**
 * 按来源读 meta：先认命名空间键；落空且来源是 memory 时兼容读无后缀旧键
 * （老库还没迁移的那一次，语义与迁移后一致）。
 */
export function getMetaFor(db, baseKey, source) {
  const scoped = metaRead(db, metaKeyFor(baseKey, source));
  if (scoped != null) return scoped;
  return String(source) === 'memory' ? metaRead(db, baseKey) : null;
}

/**
 * 按来源写 meta，并**冗余**写一份无后缀旧键（方案 §A.4 的 C4 选项①）。
 * 目的：回滚到旧代码时水位仍然读得到，不会走「首次全量」把整库 DELETE 重建。
 */
export function setMetaFor(db, baseKey, source, value) {
  metaWrite(db, metaKeyFor(baseKey, source), value);
  if (String(source) === 'memory') metaWrite(db, baseKey, value);
}

/**
 * 一次性命名空间迁移（幂等）：把旧键现值播种到 `<key>:memory`。
 * 触发条件 = 旧键在、且新键缺；跑几次都只迁一次，旧键保留不算删。
 * @returns {string[]} 本次真正迁过的键名
 */
export function migrateMetaNamespace(db) {
  const touched = [];
  for (const base of SOURCE_SCOPED_META_KEYS) {
    const legacyValue = metaRead(db, base);
    if (legacyValue == null) continue;
    const scopedKey = metaKeyFor(base, 'memory');
    if (metaRead(db, scopedKey) != null) continue;
    metaWrite(db, scopedKey, legacyValue);
    touched.push(base);
  }
  return touched;
}

/** 内部：某张表在不在 */
function hasTable(db, name) {
  const probe = db.prepare(SQL_TABLE_PROBE).get('table', name);
  return probe !== undefined && probe !== null;
}

export function ensureSchema(db) {
  const missing = ['vectors', 'meta'].filter((name) => !hasTable(db, name));
  db.exec(DDL);
  return { created: missing, tables: { vectors: hasTable(db, 'vectors'), meta: hasTable(db, 'meta') } };
}

/**
 * 打开（必要时创建）向量库。
 * @param {string} dbPath
 * @param {{create?: boolean}} [opts]
 */
export function openVectorsStore(dbPath, opts = {}) {
  const mayCreate = opts.create !== false;
  if (mayCreate) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  else if (!fs.existsSync(dbPath)) throw new Error(`向量库不存在: ${dbPath}`);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    // 只读介质上 WAL 可能起不来：退回默认日志模式即可，不影响读写语义
  }

  const schema = ensureSchema(db);
  // 命名空间迁移放在 schemaVersion 之前：迁移发生过就顺手把版本号推上去（表结构没变，只是键位变宽）
  const migrated = migrateMetaNamespace(db);
  const storedVersion = metaRead(db, META_KEYS.schemaVersion);
  const shouldStamp = storedVersion == null || (migrated.length > 0 && storedVersion !== SCHEMA_VERSION);
  if (shouldStamp) metaWrite(db, META_KEYS.schemaVersion, SCHEMA_VERSION);

  return { db, dbPath, schema, migrated };
}

export const getMeta = (db, key) => metaRead(db, key);

export const setMeta = (db, key, value) => metaWrite(db, key, value);

export const getMetaAll = (db) => {
  const bag = {};
  for (const row of db.prepare(SQL_META_DUMP).all()) bag[row.k] = row.v;
  return bag;
};

export function vecToBlob(vec) {
  const floats = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function blobToVec(blob) {
  // sqlite 回来的 Buffer 可能是池化分配的（byteOffset 不保证 4 字节对齐）⇒ 先按窗口切一份再建视图
  const { buffer, byteOffset, byteLength } = blob;
  return new Float32Array(buffer.slice(byteOffset, byteOffset + byteLength));
}

/** 内部：开事务跑一小段 body（异常先回滚再原样抛出） */
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
      // 回滚自己失败也不掩盖原始错误
    }
    throw err;
  }
}

/** 批量 upsert（单事务） */
export function upsertVectors(db, items) {
  if (items.length === 0) return 0;
  const put = db.prepare(SQL_VECTOR_UPSERT);
  inTransaction(db, () => {
    for (const item of items) {
      put.run(
        item.source,
        String(item.refId),
        item.model,
        item.dim,
        vecToBlob(item.vec),
        item.textHash,
        item.updatedAt,
      );
    }
  });
  return items.length;
}

/** 取指定 ref_id 的已有哈希（增量同步据此跳过没变的条目） */
export function getHashes(db, source, refIds) {
  const found = new Map();
  if (refIds.length === 0) return found;
  const probe = db.prepare(SQL_HASH_READ);
  for (const refId of refIds) {
    const row = probe.get(source, String(refId));
    if (row) found.set(String(refId), row.text_hash);
  }
  return found;
}

export function countVectors(db, source) {
  const row = source ? db.prepare(SQL_COUNT_BY_SOURCE).get(source) : db.prepare(SQL_COUNT_ALL).get();
  return row.n;
}

export function countByModel(db, source, model) {
  return db.prepare(SQL_COUNT_BY_MODEL).get(source, model).n;
}

export function deleteSource(db, source) {
  const res = db.prepare(SQL_SOURCE_DELETE).run(source);
  return Number(res.changes || 0);
}

/** 空矩阵（形状与正常返回一致，调用方不用判空） */
function emptyMatrix() {
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

/**
 * 载入整个矩阵（召回用；万级候选直接内存暴力扫，方案 §3.3）。
 * @returns {{refIds: string[], refIdsNum: number[], dim: number, data: Float32Array, count: number,
 *            textHashes: string[], models: string[]}}
 */
export function loadMatrix(db, source, model = null) {
  const filterByModel = Boolean(model);
  const sql = `${filterByModel ? `${SQL_MATRIX_BASE} AND model = ?` : SQL_MATRIX_BASE} ${SQL_MATRIX_ORDER}`;
  const recs = filterByModel ? db.prepare(sql).all(source, model) : db.prepare(sql).all(source);
  if (recs.length === 0) return emptyMatrix();

  const dim = recs[0].dim;
  const count = recs.length;
  const data = new Float32Array(count * dim);
  const refIds = [];
  const refIdsNum = [];
  const textHashes = [];
  const models = [];
  const seenModel = new Set();

  for (let i = 0; i < count; i += 1) {
    const rec = recs[i];
    if (rec.dim !== dim) {
      throw new Error(
        `向量库维度不一致：ref_id=${rec.ref_id} dim=${rec.dim}，首个为 ${dim}（应全量重建）`,
      );
    }
    const vec = blobToVec(rec.vec);
    if (vec.length !== dim) {
      throw new Error(`向量 blob 长度异常：ref_id=${rec.ref_id} len=${vec.length} 期望 ${dim}`);
    }
    data.set(vec, i * dim);
    refIds.push(String(rec.ref_id));
    refIdsNum.push(Number(rec.ref_id));
    textHashes.push(rec.text_hash);
    if (!seenModel.has(rec.model)) {
      seenModel.add(rec.model);
      models.push(rec.model);
    }
  }

  return { refIds, refIdsNum, dim, data, count, textHashes, models };
}
