/**
 * FORK-EDIT(2026-09-21): 召回主逻辑 —— 从 S1 离线层 `memory-engine/lib/recall.mjs` 移植。
 *
 * 移植来源：本仓 `memory-engine/lib/recall.mjs`（记忆引擎 v2 · S1 交付）
 * 本文件与来源**逐字同语义**（方案 §3.3：向量为主 + FTS 仅补标签/英文/数字 + RRF(k=60)
 * + 排除 pinned + 非空即触发、纯符号/单字跳过）；**唯一改动**是 import 路径
 * （`./vectors-store.mjs` → `./vectors-read.mjs`，插件侧只读、不写向量库）。
 */
import { loadMatrix } from './vectors-read.mjs';

/** 触发判定（方案 §3.3 Z16 已吸收） */
export function shouldTrigger(rawQuery) {
  const q = String(rawQuery ?? '').trim();
  if (!q) return { trigger: false, reason: 'empty' };
  const semantic = q.match(/[\p{L}\p{N}]/gu) || [];
  if (semantic.length === 0) return { trigger: false, reason: 'symbols-only' };
  if (semantic.length < 2) return { trigger: false, reason: 'single-char' };
  return { trigger: true, reason: 'non-empty' };
}

/** 抽 FTS 补位 token：只取英文/数字（A4：中文连续串在 unicode61 下几近不可用） */
export function extractFtsTokens(rawQuery, max = 8) {
  const m = String(rawQuery ?? '').match(/[A-Za-z0-9][A-Za-z0-9_.-]*/g) || [];
  const out = [];
  for (const t of m) {
    if (t.length < 2) continue; // 单字母/单数字噪声大
    if (!out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** 构造 FTS5 MATCH 表达式：每个 token 加双引号（防语法注入），OR 连接 */
export function buildFtsMatch(tokens) {
  if (!tokens || !tokens.length) return null;
  return tokens.map((t) => `"${String(t).replace(/"/g, '')}"`).join(' OR ');
}

/** 载入向量矩阵 + 行范数（余弦召回用；一次构建，多次召回） */
export function buildVectorIndex(db, { source = 'memory', model = null } = {}) {
  const matrix = loadMatrix(db, source, model);
  const norms = new Float32Array(matrix.count);
  for (let r = 0; r < matrix.count; r += 1) {
    let n = 0;
    const off = r * matrix.dim;
    for (let i = 0; i < matrix.dim; i += 1) n += matrix.data[off + i] * matrix.data[off + i];
    norms[r] = Math.sqrt(n) || 1;
  }
  return { ...matrix, norms, builtAt: Date.now() };
}

/** 余弦 top-K（纯内存暴力；万级候选毫秒级，方案 §3.3） */
export function cosineTopK(index, qvec, topK) {
  const { data, dim, count, norms } = index;
  if (!dim || !count) return [];
  let qn = 0;
  for (let i = 0; i < dim; i += 1) qn += qvec[i] * qvec[i];
  qn = Math.sqrt(qn) || 1;
  const scores = new Float32Array(count);
  for (let r = 0; r < count; r += 1) {
    let s = 0;
    const off = r * dim;
    for (let i = 0; i < dim; i += 1) s += data[off + i] * qvec[i];
    scores[r] = s / (qn * norms[r]);
  }
  const order = Array.from({ length: count }, (_, i) => i);
  order.sort((a, b) => scores[b] - scores[a] || a - b);
  const k = Math.min(Number(topK) || 0, count);
  const out = [];
  for (let i = 0; i < k; i += 1) {
    const idx = order[i];
    out.push({ index: idx, refId: index.refIds[idx], id: index.refIdsNum[idx], score: scores[idx] });
  }
  return out;
}

/**
 * RRF 融合（k=60）：score(d) = Σ_r 1/(k + rank_r(d))
 * @param {Array<{source:string, ids:string[]}>} rankLists 各路排名（已按优劣降序，rank 从 1 起）
 */
export function rrfFuse(rankLists, k = 60) {
  const acc = new Map();
  for (const list of rankLists) {
    if (!list || !list.ids) continue;
    list.ids.forEach((id, i) => {
      const rank = i + 1;
      const cur = acc.get(String(id)) || { id: String(id), score: 0, sources: [], ranks: {} };
      cur.score += 1 / (k + rank);
      if (!cur.sources.includes(list.source)) cur.sources.push(list.source);
      cur.ranks[list.source] = rank;
      acc.set(String(id), cur);
    });
  }
  return [...acc.values()].sort(
    (a, b) => b.score - a.score || Number(a.id) - Number(b.id),
  );
}

/**
 * 召回主入口。
 * fail-open：任何异常都由调用方兜住（本函数内部对 FTS 异常降级为空路）。
 * @returns {Promise<object>}
 */
export async function recall({
  query,
  store,
  source,
  embedder,
  index = null,
  vectorTopK = 20,
  ftsTopK = 20,
  rrfK = 60,
  resultTopK = 8,
  log = () => {},
}) {
  const t0 = performance.now();
  const gate = shouldTrigger(query);
  if (!gate.trigger) {
    return { triggered: false, reason: gate.reason, query: String(query ?? ''), hits: [], timings: { totalMs: 0 } };
  }

  const db = store.db;
  const pinned = new Set((source ? source.pinnedIds() : []).map(String));

  // ① 查询编码
  const tEnc = performance.now();
  const qvec = await embedder.encode(query);
  const encodeMs = performance.now() - tEnc;

  // ② 向量路
  const tVec = performance.now();
  const idx = index || buildVectorIndex(db, { source: 'memory' });
  const rawVec = cosineTopK(idx, qvec, vectorTopK + pinned.size + 5);
  const vecHits = rawVec.filter((h) => !pinned.has(String(h.refId))).slice(0, vectorTopK);
  const vectorMs = performance.now() - tVec;

  // ③ FTS 补位路（仅英文/数字；缺失时不参与，不做零分占位）
  const tFts = performance.now();
  let ftsHits = [];
  let ftsMatched = 0;
  const tokens = extractFtsTokens(query);
  const matchExpr = buildFtsMatch(tokens);
  if (matchExpr && source) {
    const r = source.ftsSearch(matchExpr, ftsTopK + pinned.size + 5);
    if (Array.isArray(r)) {
      ftsMatched = r.length;
      ftsHits = r.filter((h) => !pinned.has(String(h.id))).slice(0, ftsTopK);
    } else if (r && r.error) {
      log(`[recall] FTS 补位降级：${r.error}`);
    }
  }
  const ftsMs = performance.now() - tFts;

  // ④ RRF 融合
  const tFuse = performance.now();
  const fused = rrfFuse(
    [
      { source: 'vector', ids: vecHits.map((h) => String(h.refId)) },
      { source: 'fts', ids: ftsHits.map((h) => String(h.id)) },
    ],
    rrfK,
  );
  const hits = fused.slice(0, Number(resultTopK) || 8).map((h) => ({
    refId: h.id,
    id: Number(h.id),
    score: h.score,
    sources: h.sources,
    vectorRank: h.ranks.vector ?? null,
    ftsRank: h.ranks.fts ?? null,
  }));
  const fuseMs = performance.now() - tFuse;

  const totalMs = performance.now() - t0;
  return {
    triggered: true,
    reason: gate.reason,
    query: String(query ?? ''),
    hits,
    timings: { encodeMs, vectorMs, ftsMs, fuseMs, totalMs },
    stats: {
      indexSize: idx.count,
      pinnedExcluded: pinned.size,
      vectorCandidates: rawVec.length,
      vectorHits: vecHits.length,
      ftsTokens: tokens,
      ftsMatchExpr: matchExpr,
      ftsMatched,
      ftsHits: ftsHits.length,
      fused: fused.length,
    },
  };
}
