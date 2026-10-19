/**
 * FORK-EDIT(2026-09-21): 向量库只读读取器 —— 从 S1 离线层 `memory-engine/lib/vectors-store.mjs`
 * 移植（只取召回路径需要的只读部分：blobToVec / loadMatrix）。
 *
 * 移植来源：本仓 `memory-engine/lib/vectors-store.mjs`（记忆引擎 v2 · S1 交付）
 * 口径（方案 §3.1 / §3.3）：**只读**打开向量库；向量是可重建的派生物，插件永不写它。
 * 为什么不直接 import 那个文件：插件部署后自持于 profiles\web\node_modules\dsh-memory\，
 * 不能依赖仓库外的工具目录（逃逸 import 会被 deploy.mjs gate1 拒绝）。
 * 语义与本文件来源逐字一致（仅去掉写路径函数）。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * 取 blob 里的 float32 向量。
 * 注意：sqlite 返回的 Buffer 可能是池化分配（byteOffset 不对齐 4 字节）⇒ 必须切片后重建。
 * @param {Buffer} blob
 * @returns {Float32Array}
 */
export function blobToVec(blob) {
  const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(ab);
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

/**
 * 只读打开向量库（召回侧）。文件不存在 → 抛错，由调用方 fail-open 兜住。
 * 铁律：readOnly 打开；不建表、不建目录、**绝不创建库文件**（创建是离线层 sync 的事）。
 * @param {string} dbPath
 */
export function openVectorsReader(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`向量库不存在: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');
  return {
    dbPath,
    db,
    meta(k) {
      try {
        const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
        return r ? r.v : null;
      } catch {
        return null;
      }
    },
    count(source) {
      const r = db.prepare('SELECT COUNT(*) AS n FROM vectors WHERE source = ?').get(source);
      return Number(r.n);
    },
    close() {
      try {
        db.close();
      } catch {
        /* 幂等 */
      }
    },
  };
}
