// 增量同步：按 updated_at 水位，把新增或改过的条目编码进独立向量库。
//
// 这条路只读源库、只写向量库；一批一批往前推，某一批炸了就停在那儿 ——
// 之前跑完的批次进度已经落盘，下一轮从断点接着编即可。
// 换模型 / 换维度 / 显式全量都会转成"先清掉该来源、再整份重建"。
// 那种「改正文却不改时间戳」的盲区不归这里管，另有兜底轮转那条路。

import { textHash } from './hashes.mjs';
import * as vectors from './vectors-store.mjs';

const errText = (e) => (e && e.message ? e.message : String(e));

// 重建判据：模型变了、维度变了、或者调用方明确要全量。
function decideMode({ knownModel, knownDim, modelId, dim, full }) {
  const causes = [];
  if (knownModel && knownModel !== modelId) causes.push(`模型变更 ${knownModel} → ${modelId}`);
  if (knownDim && Number(knownDim) !== Number(dim)) causes.push(`维度变更 ${knownDim} → ${dim}`);
  if (full) causes.push('显式 --full');
  return { causes, rebuild: causes.length > 0 };
}

// 一批里真正要编码的那些：哈希与库里存的一致就跳过（幂等全靠这一步）。
function splitBatch(rows, stored) {
  const pending = [];
  let skipped = 0;
  for (const row of rows) {
    const digest = textHash(row.text);
    if (stored.get(String(row.id)) === digest) {
      skipped += 1;
      continue;
    }
    pending.push({ row, digest });
  }
  return { pending, skipped };
}

/**
 * @param {object} p
 * @param {object} p.source  记忆源 / 坑源（只读）
 * @param {object} p.store   向量库（{ db }）
 * @param {object} p.embedder 编码器（encodeBatch）
 * @param {string} p.modelId
 * @param {number} p.dim
 * @param {string} [p.sourceName='memory'] 来源名（同时决定 vectors.source 与 meta 命名空间）
 */
export async function runIncrementalSync({ source, store, embedder, modelId, dim, sourceName = 'memory', batchSize = 50, full = false, dryRun = false, log = () => {}, now = () => Date.now(), untilEmpty = true }) {
  const conn = store.db;
  const origin = String(sourceName || 'memory');
  const openedAt = now();
  // 水位/模型/维度一律按来源读写：两个来源共用一只库，键位串味会表现成"某来源静默漏编码"。
  const knownModel = vectors.getMetaFor(conn, vectors.META_KEYS.modelId, origin);
  const knownDim = vectors.getMetaFor(conn, vectors.META_KEYS.dim, origin);
  const hostKnown = vectors.getMeta(conn, vectors.META_KEYS.hostId);
  const { causes, rebuild } = decideMode({ knownModel, knownDim, modelId, dim, full });

  let level = 0;
  let purged = 0;
  if (rebuild) {
    if (!dryRun) {
      purged = vectors.deleteSource(conn, origin);
      vectors.setMetaFor(conn, vectors.META_KEYS.modelId, origin, modelId);
      vectors.setMetaFor(conn, vectors.META_KEYS.dim, origin, String(dim));
      vectors.setMetaFor(conn, vectors.META_KEYS.lastIncrementalSyncAt, origin, '0');
    }
    log(`[sync] 全量重建：${causes.join(' / ')}（清空 ${purged} 条向量）`);
  } else {
    level = Number(vectors.getMetaFor(conn, vectors.META_KEYS.lastIncrementalSyncAt, origin) || 0);
  }

  const stats = {
    source: origin, mode: rebuild ? 'rebuild' : 'incremental', reasons: causes,
    watermarkStart: level, watermarkEnd: level,
    scanned: 0, encoded: 0, skippedSameHash: 0, upserted: 0, batches: 0,
    failures: [], cleared: purged,
    vectorsBefore: vectors.countVectors(conn, origin), vectorsAfter: 0,
    elapsedMs: 0, startedAt: openedAt, finishedAt: 0,
  };

  let afterId = 0;
  let high = level;

  // 每批成功后把四类键一起前移（主机的键只在库里没有时补一次）。
  const advanceLevel = (value) => {
    vectors.setMetaFor(conn, vectors.META_KEYS.modelId, origin, modelId);
    vectors.setMetaFor(conn, vectors.META_KEYS.dim, origin, String(dim));
    if (!hostKnown) vectors.setMeta(conn, vectors.META_KEYS.hostId, String(store.hostId || ''));
    vectors.setMetaFor(conn, vectors.META_KEYS.lastIncrementalSyncAt, origin, String(value));
  };

  try {
    let page = source.incrementalPage(level, afterId, batchSize);
    while (page.length) {
      stats.batches += 1;
      const tailId = page[page.length - 1].id;
      stats.scanned += page.length;
      for (const row of page) if (row.updated_at > high) high = row.updated_at;

      const { pending, skipped } = splitBatch(page, vectors.getHashes(conn, origin, page.map((row) => row.id)));
      stats.skippedSameHash += skipped;

      if (pending.length) {
        const encoded = await embedder.encodeBatch(pending.map((item) => item.row.text));
        if (encoded.length !== pending.length) {
          throw new Error(`编码器返回数量不符：期望 ${pending.length}，实际 ${encoded.length}`);
        }
        if (!dryRun) {
          vectors.upsertVectors(conn, pending.map((item, at) => ({
            source: origin,
            refId: item.row.id,
            model: modelId,
            dim: encoded[at].length,
            vec: encoded[at],
            textHash: item.digest,
            updatedAt: item.row.updated_at,
          })));
        }
        stats.encoded += pending.length;
        stats.upserted += pending.length;
      }

      // 进度前移取「本批扫到的最大 updated_at」：边界条下轮会再扫一遍，靠同哈希幂等兜住。
      if (!dryRun) advanceLevel(high);
      log(`[sync] 批 ${stats.batches}：扫 ${page.length} 条（新编码 ${pending.length} / 同哈希跳过 ${page.length - pending.length}）水位=${high}`);
      if (!untilEmpty) break;
      afterId = tailId;
      page = source.incrementalPage(level, afterId, batchSize);
    }
    stats.watermarkEnd = high;
  } catch (e) {
    stats.failures.push({ stage: 'sync', message: errText(e), atBatch: stats.batches });
    // 已成功批次的进度早就落盘了，这里只是把读数对齐
    stats.watermarkEnd = high;
    stats.error = stats.failures[0].message;
  }

  stats.vectorsAfter = vectors.countVectors(conn, origin);
  const finishedAt = now();
  stats.finishedAt = finishedAt;
  stats.elapsedMs = finishedAt - stats.startedAt;
  if (!dryRun) {
    const brief = {
      source: origin, mode: stats.mode, scanned: stats.scanned,
      encoded: stats.encoded, skippedSameHash: stats.skippedSameHash,
      watermarkEnd: stats.watermarkEnd, elapsedMs: stats.elapsedMs,
      failures: stats.failures.length, at: new Date(finishedAt).toISOString(),
    };
    vectors.setMetaFor(conn, vectors.META_KEYS.lastSyncStats, origin, JSON.stringify(brief));
  }
  return stats;
}
