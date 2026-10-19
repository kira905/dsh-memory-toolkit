// 记忆引擎 v2 · 离线层 —— 兜底：全表 text_hash 段轮转校验（方案 §3.1 兜底 / §6.2 ②）
//
// 为什么必须有（A7 实测）：41 处外部 `UPDATE memories SET text=?` 中，
// apply-pinned-refine.mjs:110 改 text **不动 updated_at** ⇒ 这类勘误永远进不了增量窗口。
// 兜底外置、不与增量主路径共用候选集；按 id 段轮转，累计若干轮覆盖全表。
import { textHash } from './hashes.mjs';
import { META_KEYS, getMetaFor, setMetaFor, getHashes, upsertVectors } from './vectors-store.mjs';
// 【S3c 挂钩（2026-09-21）】轮转发现的"正文变了"差异**必须落 `memories_dirty` 台账**：
//   本函数发现差异后会**立刻重编码并更新 `vectors.text_hash`** ⇒ 差异信号当场消失。
//   若此刻只用于重编码而不留痕，被外部改过 text 的条（A7 的 41 处写口）就再也没人知道要提炼它们。
//   台账是**只加不改**的旁路；`recordDirty` 幂等（同一条重复扫到只 hits+1，不复活已消费项）。
import { recordDirty } from './dirty-ledger.mjs';

/**
 * @param {object} p
 * @param {object} p.source
 * @param {object} p.store
 * @param {object} p.embedder
 * @param {number} p.segments  全表分几段（默认 20）
 * @param {number} p.rounds    本次跑几段（默认 1；--all 传 segments = 一轮完整覆盖）
 * @param {string} [p.sourceName='memory'] 向量来源名
 *   ⚠️ 轮转语义按来源不同：memory = **id 段**；pitfall = `segment()` 内部按 `lastSeen` 排序后切片
 *      （`idRange()` 给的是排序下标区间 ⇒ 同一段轮转代码对两个来源都成立，不必分支）。
 */
export async function runHashSweep({
  source,
  store,
  embedder,
  modelId,
  dim,
  sourceName = 'memory',
  segments = 20,
  rounds = 1,
  dryRun = false,
  log = () => {},
  now = () => Date.now(),
}) {
  const db = store.db;
  const src = String(sourceName || 'memory');
  // ⚠️ `memories_dirty` 台账的语义是「哪条**记忆**的正文被外部改过、待提炼」——
  //    坑源跑兜底时**不得**把 16 位 hex 的坑 id 记进去（会污染提炼侧输入）。故只对 memory 源落台账。
  const useDirtyLedger = src === 'memory';
  const startedAt = now();
  const range = source.idRange();
  const stats = {
    source: src,
    mode: 'hash-sweep',
    segments,
    rounds,
    range,
    cursorStart: Number(getMetaFor(db, META_KEYS.hashSweepCursor, src) || 0) % Math.max(1, segments),
    cursorEnd: 0,
    scanned: 0,
    mismatched: 0,
    missing: 0,
    fixed: 0,
    dirtyRecorded: 0,
    segmentReports: [],
    completedFullSweep: false,
    elapsedMs: 0,
    failures: [],
  };
  if (range.lo == null) {
    stats.cursorEnd = stats.cursorStart;
    stats.finishedAt = now();
    stats.elapsedMs = stats.finishedAt - startedAt;
    log(`[sweep] ${src} 源为空，跳过`);
    return stats;
  }

  const width = Math.max(1, Math.ceil((range.hi - range.lo + 1) / Math.max(1, segments)));
  let cursor = stats.cursorStart;

  try {
    for (let i = 0; i < rounds; i += 1) {
      const lo = range.lo + cursor * width;
      const hi = Math.min(range.hi, lo + width - 1);
      const rows = source.segment(lo, hi);
      const hashes = getHashes(db, src, rows.map((r) => r.id));
      const need = [];
      // 【S3c】差异明细（只收 "mismatch"：正文哈希与向量库不符 = 被外部改过 text）
      const dirtyItems = [];
      let missing = 0;
      let mismatched = 0;
      for (const r of rows) {
        const h = textHash(r.text);
        const prev = hashes.get(String(r.id));
        if (prev === undefined) {
          missing += 1;
          need.push({ row: r, hash: h });
        } else if (prev !== h) {
          mismatched += 1;
          need.push({ row: r, hash: h });
          dirtyItems.push({ refId: r.id, kind: 'mismatch', oldHash: prev, newHash: h });
        }
      }
      // 先落台账、再重编码（顺序不能反：重编码会把 old_hash 覆盖掉，差异就再也说不清了）
      if (!dryRun && useDirtyLedger && dirtyItems.length) {
        try {
          recordDirty(db, dirtyItems, { now: now() });
          stats.dirtyRecorded = (stats.dirtyRecorded ?? 0) + dirtyItems.length;
        } catch (e) {
          // 台账写失败**不得**影响主路径（它只是提炼侧的补充输入源）
          stats.failures.push({ stage: 'dirty-ledger', message: String(e && e.message ? e.message : e) });
        }
      }
      if (need.length) {
        const vecs = await embedder.encodeBatch(need.map((n) => n.row.text));
        if (!dryRun) {
          upsertVectors(
            db,
            need.map((n, k) => ({
              source: src,
              refId: n.row.id,
              model: modelId,
              dim: vecs[k].length,
              vec: vecs[k],
              textHash: n.hash,
              updatedAt: n.row.updated_at,
            })),
          );
        }
      }
      stats.scanned += rows.length;
      stats.missing += missing;
      stats.mismatched += mismatched;
      stats.fixed += need.length;
      stats.segmentReports.push({
        segment: cursor,
        lo,
        hi,
        rows: rows.length,
        missing,
        mismatched,
        fixed: need.length,
      });
      log(
        `[sweep] 段 ${cursor}（id ${lo}-${hi}）：${rows.length} 条，缺失 ${missing}，哈希不符 ${mismatched} ⇒ 重编码 ${need.length}`,
      );
      cursor = (cursor + 1) % Math.max(1, segments);
      if (cursor === 0) stats.completedFullSweep = true;
    }
  } catch (e) {
    stats.failures.push({ stage: 'sweep', message: String(e && e.message ? e.message : e) });
    stats.error = stats.failures[0].message;
  }

  stats.cursorEnd = cursor;
  if (!dryRun) {
    setMetaFor(db, META_KEYS.hashSweepCursor, src, String(cursor));
    if (stats.completedFullSweep) {
      stats.lastFullHashSweepAt = now();
      setMetaFor(db, META_KEYS.lastFullHashSweepAt, src, String(stats.lastFullHashSweepAt));
    }
  }
  stats.finishedAt = now();
  stats.elapsedMs = stats.finishedAt - startedAt;
  return stats;
}
