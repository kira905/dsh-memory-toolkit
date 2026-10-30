// 兜底轮转：把全表按 id 段切开，一段一段核对「正文哈希」与「向量库里存的那份」是否还一致。
//
// 为什么非它不可：外部脚本改正文时未必顺手更新 updated_at（真实写口里就有一批这样的），
// 这类勘误永远落在增量窗口之外。所以兜底单列一条路，不与增量主路径共用候选集，
// 靠一圈一圈轮转最终覆盖整张表。

import { textHash } from './hashes.mjs';
import * as vectors from './vectors-store.mjs';
import { recordDirty } from './dirty-ledger.mjs';

// 台账的语义是「哪条记忆的正文被外部改过」，因此只对记忆源记账；
// 其它来源（例如坑源的十六位十六进制 id）一律不往台账塞，免得污染提炼侧输入。
const LEDGER_SOURCE = 'memory';

const noteOf = (stage, e) => ({ stage, message: e && e.message ? e.message : String(e) });

/**
 * @param {object} p
 * @param {object} p.source   数据源（idRange / segment）
 * @param {object} p.store    向量库（{ db }）
 * @param {object} p.embedder 编码器
 * @param {string} p.modelId
 * @param {number} p.dim
 * @param {string} [p.sourceName='memory'] 来源名（决定写哪一列、游标落哪个命名空间）
 * @param {number} [p.segments=20] 全表切几段
 * @param {number} [p.rounds=1] 本次走几段（传 segments 即一整圈）
 */
export async function runHashSweep({ source, store, embedder, modelId, dim, sourceName = 'memory', segments = 20, rounds = 1, dryRun = false, log = () => {}, now = () => Date.now() }) {
  const conn = store.db;
  const origin = String(sourceName || 'memory');
  const ledgerApplies = origin === LEDGER_SOURCE;
  const openedAt = now();
  const bounds = source.idRange();
  const slotCount = Math.max(1, segments);
  const stats = {
    source: origin, mode: 'hash-sweep', segments, rounds, range: bounds,
    cursorStart: Number(vectors.getMetaFor(conn, vectors.META_KEYS.hashSweepCursor, origin) || 0) % slotCount,
    cursorEnd: 0, scanned: 0, mismatched: 0, missing: 0, fixed: 0, dirtyRecorded: 0,
    segmentReports: [], completedFullSweep: false, elapsedMs: 0, failures: [],
  };
  const closeBook = () => {
    stats.finishedAt = now();
    stats.elapsedMs = stats.finishedAt - openedAt;
  };

  // 空表：游标原地不动，直接收工（一个 meta 都不写）
  if (bounds.lo == null) {
    stats.cursorEnd = stats.cursorStart;
    closeBook();
    log(`[sweep] ${origin} 源为空，跳过`);
    return stats;
  }

  const width = Math.max(1, Math.ceil((bounds.hi - bounds.lo + 1) / slotCount));
  let slot = stats.cursorStart;

  // 单段作业：先对哈希，再落台账，最后重编码 —— 顺序不能换。
  // 重编码会把旧的 text_hash 覆盖掉，差异就再也说不清了。
  const runSegment = async (lo, hi, index) => {
    const rows = source.segment(lo, hi);
    const known = vectors.getHashes(conn, origin, rows.map((row) => row.id));
    const redo = [];
    const drifted = [];
    let absent = 0;
    let stale = 0;
    for (const row of rows) {
      const digest = textHash(row.text);
      const stored = known.get(String(row.id));
      if (stored === digest) continue;
      if (stored === undefined) {
        absent += 1;
      } else {
        stale += 1;
        drifted.push({ refId: row.id, kind: 'mismatch', oldHash: stored, newHash: digest });
      }
      redo.push({ row, digest });
    }

    if (drifted.length && ledgerApplies && !dryRun) {
      try {
        recordDirty(conn, drifted, { now: now() });
        stats.dirtyRecorded += drifted.length;
      } catch (e) {
        // 台账只是提炼侧的补充输入源 ⇒ 它写失败绝不许拖垮主路径
        stats.failures.push(noteOf('dirty-ledger', e));
      }
    }

    if (redo.length) {
      const encoded = await embedder.encodeBatch(redo.map((item) => item.row.text));
      if (!dryRun) {
        vectors.upsertVectors(conn, redo.map((item, at) => ({
          source: origin,
          refId: item.row.id,
          model: modelId,
          dim: encoded[at].length,
          vec: encoded[at],
          textHash: item.digest,
          updatedAt: item.row.updated_at,
        })));
      }
    }

    stats.scanned += rows.length;
    stats.missing += absent;
    stats.mismatched += stale;
    stats.fixed += redo.length;
    stats.segmentReports.push({ segment: index, lo, hi, rows: rows.length, missing: absent, mismatched: stale, fixed: redo.length });
    log(`[sweep] 段 ${index}（id ${lo}-${hi}）：${rows.length} 条，缺失 ${absent}，哈希不符 ${stale} ⇒ 重编码 ${redo.length}`);
  };

  try {
    for (let step = 0; step < rounds; step += 1) {
      const from = bounds.lo + slot * width;
      const until = Math.min(bounds.hi, from + width - 1);
      await runSegment(from, until, slot);
      slot = (slot + 1) % slotCount;
      if (slot === 0) stats.completedFullSweep = true;
    }
  } catch (e) {
    stats.failures.push(noteOf('sweep', e));
    stats.error = stats.failures[0].message;
  }

  stats.cursorEnd = slot;
  if (!dryRun) {
    vectors.setMetaFor(conn, vectors.META_KEYS.hashSweepCursor, origin, String(slot));
    if (stats.completedFullSweep) {
      stats.lastFullHashSweepAt = now();
      const fullAt = vectors.META_KEYS.lastFullHashSweepAt;
      vectors.setMetaFor(conn, fullAt, origin, String(stats.lastFullHashSweepAt));
    }
  }
  closeBook();
  return stats;
}
