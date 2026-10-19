// 记忆引擎 v2 · 离线层 —— 召回（方案 §3.3）
//
// 向量为主（余弦 top-20）+ FTS5 仅补标签/英文/数字 + RRF(k=60) 融合 + 排除 pinned
// 触发：非空即触发（不用 ≥10 字阈值——短暗号「退下吧」「整夜干活」恰恰最需要记忆）；
//       纯符号 / 单字跳过。
import { loadMatrix } from './vectors-store.mjs';

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
 * refId → 数字 id。
 * ⚠️ 语义定稿（方案 C1 + 2026-10-10 落地）：**数字 `id` 只是 memory 源的兼容字段**
 *   （`memories.id` 是整数主键）；其它来源（坑库 16 位 hex、未来 policy）的 `ref_id` 是**不透明键**
 *   ⇒ 一律给 `null`，绝不写 `NaN`（也避免 hex 全数字时与记忆 id 撞号）。
 */
export function refIdToNum(refId) {
  const s = String(refId);
  // 前导零视为不透明键（记忆 id 是自增整数，不会带前导零）
  if (!/^(0|[1-9]\d*)$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * refId 平局裁决比较器（方案 C1）：
 * 两侧都是纯数字串 ⇒ **按数值**比（与旧行为逐字节一致，memory 源不受影响）；
 * 任一不是数字（如坑库 hex）⇒ 按**字符串字典序**比（稳定、可复现，不再出现 `NaN - NaN` 的乱序）。
 */
export function cmpRefId(a, b) {
  const sa = String(a);
  const sb = String(b);
  const na = /^-?\d+$/.test(sa);
  const nb = /^-?\d+$/.test(sb);
  if (na && nb) return Number(sa) - Number(sb);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
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
  return [...acc.values()].sort((a, b) => b.score - a.score || cmpRefId(a.id, b.id));
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
  sourceName = 'memory',
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
  const idx = index || buildVectorIndex(db, { source: sourceName });
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
    // 数字 id 只对 memory 源有意义（见 refIdToNum 注释）；其它来源恒为 null
    id: sourceName === 'memory' ? refIdToNum(h.id) : null,
    source: sourceName,
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
      sourceName,
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

/**
 * **多来源召回**（方案 §3 A.2 第 5 行新增入口）：query 只编码一次，逐来源各做「向量 top-K + FTS 补位」，
 * 跨来源用 RRF 融合；每个命中带 `source` 归属，融合键 = `<source名>:<refId>`（**否则两源同 id 会互相吃掉**）。
 *
 * 逐来源 fail-open：某来源无库/无向量/报错 ⇒ 记一行、跳过该来源，**不影响其他来源**。
 * @param {object} p
 * @param {Array<{name:string, source?:object, index?:object}>} p.entries 来源列表（name 即 `vectors.source`）
 */
export async function recallMulti({
  query,
  store,
  entries,
  embedder,
  perSourceTopK = 5,
  rrfK = 60,
  resultTopK = 8,
  log = () => {},
}) {
  const t0 = performance.now();
  const gate = shouldTrigger(query);
  if (!gate.trigger) {
    return {
      triggered: false,
      reason: gate.reason,
      query: String(query ?? ''),
      hits: [],
      perSource: {},
      timings: { totalMs: 0 },
    };
  }

  const db = store.db;
  const tEnc = performance.now();
  const qvec = await embedder.encode(query);
  const encodeMs = performance.now() - tEnc;

  const tokens = extractFtsTokens(query);
  const matchExpr = buildFtsMatch(tokens);
  const rankLists = [];
  const meta = new Map();
  const perSource = {};
  const keyOf = (name, refId) => `${name}:${String(refId)}`;

  const tVec = performance.now();
  for (const e of entries || []) {
    const name = String(e.name);
    const src = e.source || null;
    const rec = { indexSize: 0, pinnedExcluded: 0, vectorHits: 0, ftsHits: 0, error: null };
    try {
      const idx = e.index || buildVectorIndex(db, { source: name });
      rec.indexSize = idx.count;
      const pinned = new Set((src ? src.pinnedIds() : []).map(String));
      rec.pinnedExcluded = pinned.size;
      const rawVec = cosineTopK(idx, qvec, perSourceTopK + pinned.size + 5);
      const vecHits = rawVec.filter((h) => !pinned.has(String(h.refId))).slice(0, perSourceTopK);
      rec.vectorHits = vecHits.length;
      rankLists.push({ source: `vector:${name}`, ids: vecHits.map((h) => keyOf(name, h.refId)) });
      for (const h of vecHits) meta.set(keyOf(name, h.refId), { name, refId: String(h.refId) });

      if (matchExpr && src) {
        const r = src.ftsSearch(matchExpr, perSourceTopK + pinned.size + 5);
        if (Array.isArray(r)) {
          const ftsHits = r.filter((h) => !pinned.has(String(h.id))).slice(0, perSourceTopK);
          rec.ftsHits = ftsHits.length;
          rankLists.push({ source: `fts:${name}`, ids: ftsHits.map((h) => keyOf(name, h.id)) });
          for (const h of ftsHits) meta.set(keyOf(name, h.id), { name, refId: String(h.id) });
        } else if (r && r.error) {
          log(`[recallMulti] ${name} FTS 补位降级：${r.error}`);
        }
      }
    } catch (err) {
      rec.error = String(err && err.message ? err.message : err);
      log(`[recallMulti] 来源 ${name} 跳过：${rec.error}`);
    }
    perSource[name] = rec;
  }
  const vectorMs = performance.now() - tVec;

  const tFuse = performance.now();
  const fused = rrfFuse(rankLists, rrfK);
  const hits = fused.slice(0, Number(resultTopK) || 8).map((h) => {
    const m = meta.get(h.id) || { name: null, refId: h.id };
    return {
      key: h.id,
      source: m.name,
      refId: m.refId,
      id: m.name === 'memory' ? refIdToNum(m.refId) : null,
      score: h.score,
      sources: h.sources,
      vectorRank: m.name ? h.ranks[`vector:${m.name}`] ?? null : null,
      ftsRank: m.name ? h.ranks[`fts:${m.name}`] ?? null : null,
    };
  });
  const fuseMs = performance.now() - tFuse;

  return {
    triggered: true,
    reason: gate.reason,
    query: String(query ?? ''),
    hits,
    perSource,
    timings: { encodeMs, vectorMs, fuseMs, totalMs: performance.now() - t0 },
    stats: {
      sources: (entries || []).map((e) => String(e.name)),
      ftsTokens: tokens,
      ftsMatchExpr: matchExpr,
      rankLists: rankLists.length,
      fused: fused.length,
    },
  };
}
