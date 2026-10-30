// 离线层召回（方案 §3.3）
//
// 主线：向量余弦 top-20 打底 + FTS5 只补英文/数字 + RRF(k=60) 融合 + 已 pinned 的剔除。
// 触发判定不设「至少 10 字」这种阈值 —— 「退下吧」「整夜干活」这类短暗号恰恰最需要召回，
// 只把空串、纯符号、单字挡在外面。
import { loadMatrix } from './vectors-store.mjs';

const TRIGGER_RULES = [
  { reason: 'empty', match: (raw) => raw.length === 0 },
  { reason: 'symbols-only', match: (raw) => countSemantic(raw) === 0 },
  { reason: 'single-char', match: (raw) => countSemantic(raw) < 2 },
];

// 数一数字母与数字的个数（中文汉字按字母算，标点不算）
function countSemantic(text) {
  const hits = text.match(/[\p{L}\p{N}]/gu);
  return hits ? hits.length : 0;
}

// 触发判定：按上面的规则表逐条试，都不命中就算可召回
export function shouldTrigger(rawQuery) {
  const raw = String(rawQuery ?? '').trim();
  const blocked = TRIGGER_RULES.find((rule) => rule.match(raw));
  return blocked ? { trigger: false, reason: blocked.reason } : { trigger: true, reason: 'non-empty' };
}

// 抽 FTS 补位 token：只认英文/数字（中文连续串在 unicode61 下几近不可用）。
// 单字符噪声太大直接丢；同一条只留一次，凑满 max 就收手。
export function extractFtsTokens(rawQuery, max = 8) {
  const text = String(rawQuery ?? '');
  const pattern = /[A-Za-z0-9][A-Za-z0-9_.-]*/g;
  const listed = [];
  const seen = new Set();
  let scan = pattern.exec(text);
  while (scan) {
    const token = scan[0];
    if (token.length >= 2 && !seen.has(token)) {
      seen.add(token);
      listed.push(token);
      if (listed.length >= max) break;
    }
    scan = pattern.exec(text);
  }
  return listed;
}

// 拼 FTS5 的 MATCH 表达式：每个 token 裹双引号防语法注入，token 之间 OR
export function buildFtsMatch(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const quoted = [];
  for (const token of tokens) quoted.push(`"${String(token).replace(/"/g, '')}"`);
  return quoted.join(' OR ');
}

// 每行范数（余弦召回用；建一次索引反复召回）
function rowNorms(data, count, dim) {
  const norms = new Float32Array(count);
  for (let row = 0; row < count; row += 1) {
    const from = row * dim;
    const slice = data.subarray(from, from + dim);
    let squareSum = 0;
    for (let i = 0; i < dim; i += 1) squareSum += slice[i] * slice[i];
    norms[row] = Math.sqrt(squareSum) || 1;
  }
  return norms;
}

// 载入向量矩阵 + 每行范数
export function buildVectorIndex(db, { source = 'memory', model = null } = {}) {
  const matrix = loadMatrix(db, source, model);
  return { ...matrix, norms: rowNorms(matrix.data, matrix.count, matrix.dim), builtAt: Date.now() };
}

// 余弦 top-K（纯内存暴力扫；候选上万也是毫秒级）
export function cosineTopK(index, qvec, topK) {
  const { data, dim, count, norms } = index;
  if (!dim || !count) return [];

  let qNorm = 0;
  for (let i = 0; i < dim; i += 1) qNorm += qvec[i] * qvec[i];
  qNorm = Math.sqrt(qNorm) || 1;

  const scores = new Float32Array(count);
  for (let row = 0; row < count; row += 1) {
    const from = row * dim;
    let dot = 0;
    for (let i = 0; i < dim; i += 1) dot += data[from + i] * qvec[i];
    scores[row] = dot / (qNorm * norms[row]);
  }

  const order = new Array(count);
  for (let i = 0; i < count; i += 1) order[i] = i;
  order.sort((left, right) => scores[right] - scores[left] || left - right);

  const take = Math.min(Number(topK) || 0, count);
  const picked = [];
  for (let i = 0; i < take; i += 1) {
    const at = order[i];
    picked.push({ index: at, refId: index.refIds[at], id: index.refIdsNum[at], score: scores[at] });
  }
  return picked;
}

// 规范十进制：允许 0，不允许前导零 / 正负号 / 小数点
function isCanonicalDecimal(text) {
  return /^(0|[1-9]\d*)$/.test(text);
}

// refId → 数字 id。
// 只有 memory 源的 id 是整数主键；坑库的 16 位 hex 之类是不透明键 ⇒ 恒给 null，
// 绝不写 NaN（也顺带躲开「hex 恰好全是数字」跟记忆 id 撞号）。
export function refIdToNum(refId) {
  const text = String(refId);
  if (!isCanonicalDecimal(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

// refId 平局裁决：两边都是整数串就按数值比；只要一边不是，就按字符串字典序比
// （稳定可复现，不会出现 NaN 相减导致的乱序）。
export function cmpRefId(a, b) {
  const left = String(a);
  const right = String(b);
  if (/^-?\d+$/.test(left) && /^-?\d+$/.test(right)) return Number(left) - Number(right);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// RRF 融合：score(d) = Σ_r 1/(k + rank_r(d))；rankLists 每路已按优劣降序，rank 从 1 起
export function rrfFuse(rankLists, k = 60) {
  const board = new Map();
  for (const list of rankLists) {
    if (!list || !list.ids) continue;
    for (let pos = 0; pos < list.ids.length; pos += 1) {
      const key = String(list.ids[pos]);
      const rank = pos + 1;
      let entry = board.get(key);
      if (!entry) {
        entry = { id: key, score: 0, sources: [], ranks: {} };
        board.set(key, entry);
      }
      entry.score += 1 / (k + rank);
      if (!entry.sources.includes(list.source)) entry.sources.push(list.source);
      entry.ranks[list.source] = rank;
    }
  }
  return [...board.values()].sort((left, right) => right.score - left.score || cmpRefId(left.id, right.id));
}

// 剔掉 pinned 再按上限截断（向量路看 refId，FTS 路看 id）
function excludePinned(rows, pinned, take, idField) {
  const kept = [];
  for (const row of rows) {
    if (!pinned.has(String(row[idField]))) kept.push(row);
  }
  return kept.slice(0, take);
}

// FTS 补位路：没有 MATCH 表达式或没有来源就整路缺席（不拿零分占位）
function ftsPass({ source, matchExpr, pinned, take, log, degradePrefix }) {
  if (!matchExpr || !source) return { hits: [], matched: 0 };
  const raw = source.ftsSearch(matchExpr, take + pinned.size + 5);
  if (Array.isArray(raw)) return { hits: excludePinned(raw, pinned, take, 'id'), matched: raw.length };
  if (raw && raw.error) log(`${degradePrefix}${raw.error}`);
  return { hits: [], matched: 0 };
}

// 单源召回结果 → 对外命中形状
function hitOf(entry, sourceName) {
  return {
    refId: entry.id,
    id: sourceName === 'memory' ? refIdToNum(entry.id) : null,
    source: sourceName,
    score: entry.score,
    sources: entry.sources,
    vectorRank: entry.ranks.vector ?? null,
    ftsRank: entry.ranks.fts ?? null,
  };
}

// 召回主入口。内部对 FTS 异常降级成空路，整体由调用方兜错（fail-open）。
export async function recall({
  query, store, source, embedder,
  index = null, sourceName = 'memory',
  vectorTopK = 20, ftsTopK = 20, rrfK = 60, resultTopK = 8,
  log = () => {},
}) {
  const startedAt = performance.now();
  const admit = shouldTrigger(query);
  if (!admit.trigger) {
    return { triggered: false, reason: admit.reason, query: String(query ?? ''), hits: [], timings: { totalMs: 0 } };
  }

  const vectorsDb = store.db;
  const pinned = new Set((source ? source.pinnedIds() : []).map(String));

  const encodeStart = performance.now();
  const queryVector = await embedder.encode(query);
  const encodeMs = performance.now() - encodeStart;

  const vectorStart = performance.now();
  const builtIndex = index || buildVectorIndex(vectorsDb, { source: sourceName });
  const vectorCandidates = cosineTopK(builtIndex, queryVector, vectorTopK + pinned.size + 5);
  const vecHits = excludePinned(vectorCandidates, pinned, vectorTopK, 'refId');
  const vectorMs = performance.now() - vectorStart;

  const ftsStart = performance.now();
  const ftsTokens = extractFtsTokens(query);
  const ftsQuery = buildFtsMatch(ftsTokens);
  const fts = ftsPass({ source, matchExpr: ftsQuery, pinned, take: ftsTopK, log, degradePrefix: '[recall] FTS 补位降级：' });
  const ftsMs = performance.now() - ftsStart;

  const fuseStart = performance.now();
  const merged = rrfFuse(
    [
      { source: 'vector', ids: vecHits.map((hit) => String(hit.refId)) },
      { source: 'fts', ids: fts.hits.map((hit) => String(hit.id)) },
    ],
    rrfK,
  );
  const hits = merged.slice(0, Number(resultTopK) || 8).map((entry) => hitOf(entry, sourceName));
  const fuseMs = performance.now() - fuseStart;

  return {
    triggered: true,
    reason: admit.reason,
    query: String(query ?? ''),
    hits,
    timings: { encodeMs, vectorMs, ftsMs, fuseMs, totalMs: performance.now() - startedAt },
    stats: {
      sourceName,
      indexSize: builtIndex.count,
      pinnedExcluded: pinned.size,
      vectorCandidates: vectorCandidates.length,
      vectorHits: vecHits.length,
      ftsTokens,
      ftsMatchExpr: ftsQuery,
      ftsMatched: fts.matched,
      ftsHits: fts.hits.length,
      fused: merged.length,
    },
  };
}

// 融合键：`<来源名>:<refId>`（不加来源前缀的话，两源同 id 会互相吃掉）
function fuseKey(name, refId) {
  return `${name}:${String(refId)}`;
}

// 多来源召回结果 → 对外命中形状
function multiHitOf(entry, info) {
  const label = info.name;
  return {
    key: entry.id,
    source: label,
    refId: info.refId,
    id: label === 'memory' ? refIdToNum(info.refId) : null,
    score: entry.score,
    sources: entry.sources,
    vectorRank: label ? entry.ranks[`vector:${label}`] ?? null : null,
    ftsRank: label ? entry.ranks[`fts:${label}`] ?? null : null,
  };
}

// 多来源召回：query 只编码一次，逐来源做「向量 top-K + FTS 补位」，跨来源再 RRF 融合。
// 每个命中带 source 归属；某来源没库/没向量/报错 ⇒ 记一行跳过，不影响别的来源。
export async function recallMulti({
  query, store, entries, embedder,
  perSourceTopK = 5, rrfK = 60, resultTopK = 8,
  log = () => {},
}) {
  const startedAt = performance.now();
  const admit = shouldTrigger(query);
  if (!admit.trigger) {
    return {
      triggered: false, reason: admit.reason, query: String(query ?? ''), hits: [],
      perSource: {}, timings: { totalMs: 0 },
    };
  }

  const vectorsDb = store.db;
  const encodeStart = performance.now();
  const queryVector = await embedder.encode(query);
  const encodeMs = performance.now() - encodeStart;

  const ftsTokens = extractFtsTokens(query);
  const ftsQuery = buildFtsMatch(ftsTokens);
  const rankLists = [];
  const origin = new Map();
  const perSource = {};

  const vectorStart = performance.now();
  for (const entry of entries || []) {
    const name = String(entry.name);
    const src = entry.source || null;
    const rec = { indexSize: 0, pinnedExcluded: 0, vectorHits: 0, ftsHits: 0, error: null };
    try {
      const builtIndex = entry.index || buildVectorIndex(vectorsDb, { source: name });
      rec.indexSize = builtIndex.count;
      const pinned = new Set((src ? src.pinnedIds() : []).map(String));
      rec.pinnedExcluded = pinned.size;

      const candidates = cosineTopK(builtIndex, queryVector, perSourceTopK + pinned.size + 5);
      const vecHits = excludePinned(candidates, pinned, perSourceTopK, 'refId');
      rec.vectorHits = vecHits.length;
      rankLists.push({ source: `vector:${name}`, ids: vecHits.map((hit) => fuseKey(name, hit.refId)) });
      for (const hit of vecHits) origin.set(fuseKey(name, hit.refId), { name, refId: String(hit.refId) });

      if (ftsQuery && src) {
        const raw = src.ftsSearch(ftsQuery, perSourceTopK + pinned.size + 5);
        if (Array.isArray(raw)) {
          const ftsHits = excludePinned(raw, pinned, perSourceTopK, 'id');
          rec.ftsHits = ftsHits.length;
          rankLists.push({ source: `fts:${name}`, ids: ftsHits.map((hit) => fuseKey(name, hit.id)) });
          for (const hit of ftsHits) origin.set(fuseKey(name, hit.id), { name, refId: String(hit.id) });
        } else if (raw && raw.error) {
          log(`[recallMulti] ${name} FTS 补位降级：${raw.error}`);
        }
      }
    } catch (err) {
      rec.error = String(err && err.message ? err.message : err);
      log(`[recallMulti] 来源 ${name} 跳过：${rec.error}`);
    }
    perSource[name] = rec;
  }
  const vectorMs = performance.now() - vectorStart;

  const fuseStart = performance.now();
  const merged = rrfFuse(rankLists, rrfK);
  const hits = merged.slice(0, Number(resultTopK) || 8).map((entry) => {
    const info = origin.get(entry.id) || { name: null, refId: entry.id };
    return multiHitOf(entry, info);
  });
  const fuseMs = performance.now() - fuseStart;

  return {
    triggered: true,
    reason: admit.reason,
    query: String(query ?? ''),
    hits,
    perSource,
    timings: { encodeMs, vectorMs, fuseMs, totalMs: performance.now() - startedAt },
    stats: {
      sources: (entries || []).map((entry) => String(entry.name)),
      ftsTokens,
      ftsMatchExpr: ftsQuery,
      rankLists: rankLists.length,
      fused: merged.length,
    },
  };
}
