// 记忆引擎 v2 · 离线层 —— 增量同步（方案 §3.1 主路径）
//
// 主路径：memories.updated_at > meta.lastIncrementalSyncAt 增量扫描（只读 memory.db，不写）
// 批 50；失败保留进度、下轮续跑；换模型 / 维度变化 → 全量重建。
// ⚠ 兜底（外置，不与本路径共用候选集）见 sweep.mjs。
import { textHash } from './hashes.mjs';
import {
  META_KEYS,
  getMetaFor,
  setMetaFor,
  getMeta,
  setMeta,
  getHashes,
  upsertVectors,
  countVectors,
  deleteSource,
} from './vectors-store.mjs';

/**
 * @param {object} p
 * @param {object} p.source   memory-source / pitfall-source（只读）
 * @param {object} p.store    vectors-store { db }
 * @param {object} p.embedder 编码器（encode/encodeBatch）
 * @param {string} p.modelId
 * @param {number} p.dim
 * @param {string} [p.sourceName='memory'] 向量来源名（写入 `vectors.source` 与 meta 命名空间）
 */
export async function runIncrementalSync({
  source,
  store,
  embedder,
  modelId,
  dim,
  sourceName = 'memory',
  batchSize = 50,
  full = false,
  dryRun = false,
  log = () => {},
  now = () => Date.now(),
  untilEmpty = true,
}) {
  const db = store.db;
  const src = String(sourceName || 'memory');
  const startedAt = now();
  // ⚠️ 水位/模型/维度键一律**按来源**读写（共库不串味：方案 §A.6 首要风险 / §1.3-③.1）
  const metaModel = getMetaFor(db, META_KEYS.modelId, src);
  const metaDim = getMetaFor(db, META_KEYS.dim, src);
  const metaHost = getMeta(db, META_KEYS.hostId);

  const reasons = [];
  if (metaModel && metaModel !== modelId) reasons.push(`模型变更 ${metaModel} → ${modelId}`);
  if (metaDim && Number(metaDim) !== Number(dim)) reasons.push(`维度变更 ${metaDim} → ${dim}`);
  if (full) reasons.push('显式 --full');

  let rebuild = reasons.length > 0;
  let watermark = 0;
  let cleared = 0;

  if (rebuild) {
    if (!dryRun) {
      cleared = deleteSource(db, src);
      setMetaFor(db, META_KEYS.modelId, src, modelId);
      setMetaFor(db, META_KEYS.dim, src, String(dim));
      setMetaFor(db, META_KEYS.lastIncrementalSyncAt, src, '0');
    }
    log(`[sync] 全量重建：${reasons.join(' / ')}（清空 ${cleared} 条向量）`);
  } else {
    watermark = Number(getMetaFor(db, META_KEYS.lastIncrementalSyncAt, src) || 0);
  }

  const stats = {
    source: src,
    mode: rebuild ? 'rebuild' : 'incremental',
    reasons,
    watermarkStart: watermark,
    watermarkEnd: watermark,
    scanned: 0,
    encoded: 0,
    skippedSameHash: 0,
    upserted: 0,
    batches: 0,
    failures: [],
    cleared,
    vectorsBefore: countVectors(db, src),
    vectorsAfter: 0,
    elapsedMs: 0,
    startedAt,
    finishedAt: 0,
  };

  let afterId = 0;
  let maxSeenUpdatedAt = watermark;

  try {
    for (;;) {
      const page = source.incrementalPage(watermark, afterId, batchSize);
      if (!page.length) break;
      stats.batches += 1;
      afterId = page[page.length - 1].id;
      stats.scanned += page.length;
      for (const r of page) if (r.updated_at > maxSeenUpdatedAt) maxSeenUpdatedAt = r.updated_at;

      const hashes = getHashes(db, src, page.map((r) => r.id));
      const need = [];
      for (const r of page) {
        const h = textHash(r.text);
        if (hashes.get(String(r.id)) === h) {
          stats.skippedSameHash += 1;
          continue;
        }
        need.push({ row: r, hash: h });
      }

      if (need.length) {
        const vecs = await embedder.encodeBatch(need.map((n) => n.row.text));
        if (vecs.length !== need.length) {
          throw new Error(`编码器返回数量不符：期望 ${need.length}，实际 ${vecs.length}`);
        }
        if (!dryRun) {
          upsertVectors(
            db,
            need.map((n, i) => ({
              source: src,
              refId: n.row.id,
              model: modelId,
              dim: vecs[i].length,
              vec: vecs[i],
              textHash: n.hash,
              updatedAt: n.row.updated_at,
            })),
          );
        }
        stats.encoded += need.length;
        stats.upserted += need.length;
      }

      // 进度前移（失败保留进度可续跑）：用「本批已扫到的最大 updated_at」，重扫边界条幂等
      if (!dryRun) {
        setMetaFor(db, META_KEYS.modelId, src, modelId);
        setMetaFor(db, META_KEYS.dim, src, String(dim));
        if (!metaHost) setMeta(db, META_KEYS.hostId, String(store.hostId || ''));
        setMetaFor(db, META_KEYS.lastIncrementalSyncAt, src, String(maxSeenUpdatedAt));
      }
      log(
        `[sync] 批 ${stats.batches}：扫 ${page.length} 条（新编码 ${need.length} / 同哈希跳过 ${
          page.length - need.length
        }）水位=${maxSeenUpdatedAt}`,
      );
      if (!untilEmpty) break;
    }
    stats.watermarkEnd = maxSeenUpdatedAt;
  } catch (e) {
    stats.failures.push({ stage: 'sync', message: String(e && e.message ? e.message : e), atBatch: stats.batches });
    stats.watermarkEnd = maxSeenUpdatedAt; // 已成功批次的水位已落盘
    stats.error = stats.failures[0].message;
  }

  stats.vectorsAfter = countVectors(db, src);
  stats.finishedAt = now();
  stats.elapsedMs = stats.finishedAt - stats.startedAt;
  if (!dryRun) {
    setMetaFor(
      db,
      META_KEYS.lastSyncStats,
      src,
      JSON.stringify({
        source: src,
        mode: stats.mode,
        scanned: stats.scanned,
        encoded: stats.encoded,
        skippedSameHash: stats.skippedSameHash,
        watermarkEnd: stats.watermarkEnd,
        elapsedMs: stats.elapsedMs,
        failures: stats.failures.length,
        at: new Date(stats.finishedAt).toISOString(),
      }),
    );
  }
  return stats;
}
