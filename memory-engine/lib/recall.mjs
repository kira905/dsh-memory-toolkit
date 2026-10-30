// 离线层召回（方案 §3.3）
//
// 主线：向量余弦 top-20 打底 + FTS5 只补英文/数字 + 词表第二路（默认关）+ RRF(k=60) 融合
// + 已 pinned 的剔除。触发判定不设「至少 10 字」这种阈值 —— 「退下吧」「整夜干活」这类短暗号
// 恰恰最需要召回，只把空串、纯符号、单字挡在外面。
//
// 三条「别让召回把整轮注入拖死」的口径（本版新增，行为只在失败路径上变化）：
//   ① 查询先截断到 `QUERY_CHAR_LIMIT` 个字符 —— 超长输入不该拿去编码，也不该撑爆 FTS 表达式；
//   ② 编码带时间预算：超时 / 抛错 / 空向量 ⇒ **降级成固定 Top-K 兜底**（最近改动的若干条），
//      绝不返回空、绝不把异常往上抛；
//   ③ 每一轮都能留痕：给 `recallLog` 就写一行 JSON（旁路、失败不影响结果），不给就什么都不做。
import { loadMatrix } from './vectors-store.mjs';
import { getLexiconIndex, rankByLexicon, resolveLexiconSwitch } from './lexicon-recall.mjs';
import { recordRecall } from './recall-log.mjs';

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

/* ────────────────── 查询整形 / 编码预算 / 降级兜底 ────────────────── */

/** 查询字符上限（按码点算，不是 UTF-16 码元 —— 免得把 emoji 劈成半个代理对）。 */
export const QUERY_CHAR_LIMIT = 256;
/** 编码等待预算：本地 ONNX 正常几十毫秒，1.5s 只用来兜住卡死；超了就走降级。 */
export const ENCODE_TIMEOUT_MS = 1500;
/** 降级兜底的固定条数。 */
export const FALLBACK_TOP_K = 8;

/**
 * 截断查询：留前 `limit` 个字符，并如实报「原来多长、有没有被截」。
 * @param {unknown} rawQuery
 * @param {number} [limit]
 * @returns {{text:string, chars:number, truncated:boolean, limit:number}}
 */
export function truncateQuery(rawQuery, limit = QUERY_CHAR_LIMIT) {
  const whole = String(rawQuery ?? '');
  const budget = Math.max(1, Math.trunc(Number(limit) || QUERY_CHAR_LIMIT));
  if (whole.length <= budget) return { text: whole, chars: whole.length, truncated: false, limit: budget };
  const points = Array.from(whole);
  if (points.length <= budget) return { text: whole, chars: whole.length, truncated: false, limit: budget };
  return { text: points.slice(0, budget).join(''), chars: whole.length, truncated: true, limit: budget };
}

/**
 * 带时间预算的编码。**永不抛错**：失败只回 `{ vector: null, error: { name, ms } }`。
 * 隐私口径：`error` 里只留错误名与耗时，不存 query 原文、不存 error.message（可能带路径或片段）。
 * @param {{encode:Function}} embedder
 * @param {string} text
 * @param {{timeoutMs?:number}} [options]
 */
export async function encodeQuery(embedder, text, options = {}) {
  const startedAt = performance.now();
  const budget = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
  const fail = (err) => ({ vector: null, error: { name: String((err && err.name) || 'Error'), ms: performance.now() - startedAt } });
  // 同步抛也接住；超时后底层 promise 仍可能失败 ⇒ 先挂一个处理者，别变成 unhandled rejection
  const pending = Promise.resolve().then(() => embedder.encode(text));
  pending.catch(() => {});
  let timer = null;
  try {
    let vector = null;
    if (budget > 0) {
      vector = await Promise.race([
        pending,
        new Promise((_, reject) => {
          // ⚠️ 这个定时器**不许 unref**：调用方正在 await 它，把它从事件循环里摘掉等于"预算永不生效"
          // （脚本里没有别的 handle 时进程会直接判定 unsettled top-level await 退出）。
          // 正常路径由 finally 里的 clearTimeout 收走，不会多留一个 handle。
          timer = setTimeout(() => {
            const timeout = new Error('encode-timeout');
            timeout.name = 'TimeoutError';
            reject(timeout);
          }, budget);
        }),
      ]);
    } else {
      vector = await pending;
    }
    if (!vector || typeof vector.length !== 'number' || vector.length === 0) {
      const empty = new Error('encode-empty-vector');
      empty.name = 'EmptyVectorError';
      throw empty;
    }
    return { vector, error: null, elapsedMs: performance.now() - startedAt };
  } catch (err) {
    return { ...fail(err), elapsedMs: performance.now() - startedAt };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 降级兜底清单：挑「最近改动」的若干条，保证非空、顺序确定。
 * 三档依次兜：数据源直给的 `recent()` → 元数据按 `updated_at` 降序 → 向量表里 id 最大的几条。
 * @param {{source?:object, index?:object|null, pinned?:Set<string>, take?:number}} [options]
 * @returns {string[]} refId 字符串（已去重、已剔 pinned、已截到 take）
 */
export function fallbackCandidateIds(options = {}) {
  const source = options.source || null;
  const index = options.index || null;
  const pinned = options.pinned || new Set();
  const take = Math.max(1, Math.trunc(Number(options.take) || FALLBACK_TOP_K));
  const kept = [];
  const taken = new Set();

  const admit = (candidate) => {
    if (candidate === null || candidate === undefined) return;
    const id = String(candidate);
    if (!id || id === 'null' || id === 'undefined' || taken.has(id) || pinned.has(id)) return;
    taken.add(id);
    kept.push(id);
  };
  const fill = (rows) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (kept.length >= take) return;
      admit(row && typeof row === 'object' ? row.id : row);
    }
  };

  try {
    if (source && typeof source.recent === 'function') fill(source.recent(take + pinned.size));
  } catch {
    // 第一档不给就换下一档
  }
  if (kept.length < take) {
    try {
      const rows = source && typeof source.allTags === 'function' ? source.allTags() : null;
      if (Array.isArray(rows)) {
        fill(rows.slice().sort((left, right) => (
          Number(right.updated_at ?? 0) - Number(left.updated_at ?? 0) || Number(right.id ?? 0) - Number(left.id ?? 0)
        )));
      }
    } catch {
      // 元数据也拿不到就算了，走第三档
    }
  }
  if (kept.length < take && index && Array.isArray(index.refIds)) {
    fill(index.refIds.slice().reverse().map((refId) => ({ id: refId })));
  }
  return kept.slice(0, take);
}

// 降级命中的形状：来源标 fallback；分数只为排序/展示（1/(k+rank)），不与融合分混用。
function fallbackHit(refId, at, sourceName, rrfK) {
  return {
    refId,
    id: sourceName === 'memory' ? refIdToNum(refId) : null,
    source: sourceName,
    score: 1 / (rrfK + at + 1),
    sources: ['fallback'],
    vectorRank: null,
    ftsRank: null,
    lexiconRank: null,
    fallbackRank: at + 1,
  };
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

// 单源召回结果 → 对外命中形状（字段只增不改：`lexiconRank` 是新增位）
function hitOf(entry, sourceName) {
  return {
    refId: entry.id,
    id: sourceName === 'memory' ? refIdToNum(entry.id) : null,
    source: sourceName,
    score: entry.score,
    sources: entry.sources,
    vectorRank: entry.ranks.vector ?? null,
    ftsRank: entry.ranks.fts ?? null,
    lexiconRank: entry.ranks.lexicon ?? null,
  };
}

// 召回主入口。三类失败各自就地降级，**永不因为编码失败把整轮注入拖死**：
// 编码失败 ⇒ 固定 Top-K 兜底；FTS 表达式非法/表缺失 ⇒ 该路为空；词表缺失/建索引失败 ⇒ 该路为空。
export async function recall({
  query, store, source, embedder,
  index = null, sourceName = 'memory',
  vectorTopK = 20, ftsTopK = 20, rrfK = 60, resultTopK = 8,
  queryCharLimit = QUERY_CHAR_LIMIT, encodeTimeoutMs = ENCODE_TIMEOUT_MS, fallbackTopK = FALLBACK_TOP_K,
  lexiconEnabled = null, lexiconTopK = null, lexiconFloor = null, lexiconIndex = null,
  recallLog = null,
  log = () => {},
}) {
  const startedAt = performance.now();
  const shaped = truncateQuery(query, queryCharLimit);
  const admit = shouldTrigger(shaped.text);
  if (!admit.trigger) {
    return { triggered: false, reason: admit.reason, query: String(query ?? ''), hits: [], timings: { totalMs: 0 } };
  }

  const vectorsDb = store.db;
  const pinned = new Set((source ? source.pinnedIds() : []).map(String));

  // ① 编码（带预算；失败/超时/空向量都只是"记下来"，不抛）
  const encoded = await encodeQuery(embedder, shaped.text, { timeoutMs: encodeTimeoutMs });
  const encodeMs = encoded.elapsedMs;

  // ② 向量索引（降级路也要：兜底清单的最后一档从这里取）
  const vectorStart = performance.now();
  const builtIndex = index || buildVectorIndex(vectorsDb, { source: sourceName });

  if (encoded.error) {
    const ids = fallbackCandidateIds({ source, index: builtIndex, pinned, take: fallbackTopK });
    const hits = ids.map((refId, at) => fallbackHit(refId, at, sourceName, rrfK));
    log(`[recall] 编码降级（${encoded.error.name} / ${Math.round(encoded.error.ms)}ms）：本轮改用固定 Top-${hits.length} 兜底`);
    const degradedResult = {
      triggered: true,
      reason: admit.reason,
      query: String(query ?? ''),
      hits,
      degraded: { mode: 'fixed-topk', reason: encoded.error.name, topK: Math.trunc(Number(fallbackTopK) || FALLBACK_TOP_K) },
      encodeError: encoded.error,
      timings: {
        encodeMs, vectorMs: performance.now() - vectorStart, ftsMs: 0, lexiconMs: 0, fuseMs: 0,
        totalMs: performance.now() - startedAt,
      },
      stats: {
        sourceName,
        indexSize: builtIndex.count,
        pinnedExcluded: pinned.size,
        queryChars: shaped.chars,
        queryCharsUsed: shaped.text.length,
        queryTruncated: shaped.truncated,
        queryCharLimit: shaped.limit,
        encodeDegraded: true,
        fallbackHits: hits.length,
        fallbackTopK: Math.trunc(Number(fallbackTopK) || FALLBACK_TOP_K),
        vectorCandidates: 0,
        vectorHits: 0,
        ftsTokens: [],
        ftsMatchExpr: null,
        ftsMatched: 0,
        ftsHits: 0,
        ftsSkipped: true,
        lexiconEnabled: false,
        lexiconStatus: 'skipped-degraded',
        lexiconHits: 0,
        lexiconBuildMs: null,
        lexiconSwitchSource: null,
        fused: 0,
      },
    };
    recordRecall(recallLog, degradedResult);
    return degradedResult;
  }

  const vectorCandidates = cosineTopK(builtIndex, encoded.vector, vectorTopK + pinned.size + 5);
  const vecHits = excludePinned(vectorCandidates, pinned, vectorTopK, 'refId');
  const vectorMs = performance.now() - vectorStart;

  // ③ 词表第二路（默认关；开关 = 配置 / 环境变量 / 显式入参，见 lexicon-recall.mjs）
  const lexiconStart = performance.now();
  const lexiconSwitch = resolveLexiconSwitch({ enabled: lexiconEnabled, topK: lexiconTopK, floor: lexiconFloor });
  const lexHits = [];
  let lexiconStatus = 'off';
  let lexiconBuildMs = null;
  if (lexiconSwitch.enabled) {
    try {
      const builtLexicon = lexiconIndex || getLexiconIndex(source);
      if (!builtLexicon) {
        lexiconStatus = 'warming'; // 后台正在建：这一轮先只走向量路（下一轮自然带上）
      } else {
        lexiconBuildMs = Number.isFinite(builtLexicon.buildMs) ? builtLexicon.buildMs : null;
        for (const hit of rankByLexicon(shaped.text, builtLexicon, { topK: lexiconSwitch.topK, floor: lexiconSwitch.floor })) {
          if (lexHits.length >= lexiconSwitch.topK) break;
          if (pinned.has(String(hit.id))) continue;
          lexHits.push(hit);
        }
        lexiconStatus = 'ok';
      }
    } catch (err) {
      lexiconStatus = 'degraded';
      log(`[recall] 词表通道降级：${String((err && err.name) || err)}`);
    }
  }
  const lexiconMs = performance.now() - lexiconStart;

  // ④ FTS 补位路（默认仍开；表达式非法/表缺失 ⇒ 空路）
  const ftsStart = performance.now();
  const ftsTokens = extractFtsTokens(shaped.text);
  const ftsQuery = buildFtsMatch(ftsTokens);
  const fts = ftsPass({ source, matchExpr: ftsQuery, pinned, take: ftsTopK, log, degradePrefix: '[recall] FTS 补位降级：' });
  const ftsMs = performance.now() - ftsStart;

  // ⑤ RRF 融合：按开关拼 2~3 路（关词表时 rankLists 与改动前完全一致）
  const fuseStart = performance.now();
  const rankLists = [
    { source: 'vector', ids: vecHits.map((hit) => String(hit.refId)) },
    { source: 'fts', ids: fts.hits.map((hit) => String(hit.id)) },
  ];
  if (lexiconSwitch.enabled) rankLists.push({ source: 'lexicon', ids: lexHits.map((hit) => String(hit.id)) });
  const merged = rrfFuse(rankLists, rrfK);
  const hits = merged.slice(0, Number(resultTopK) || 8).map((entry) => hitOf(entry, sourceName));
  const fuseMs = performance.now() - fuseStart;

  const result = {
    triggered: true,
    reason: admit.reason,
    query: String(query ?? ''),
    hits,
    encodeError: null,
    timings: { encodeMs, vectorMs, ftsMs, lexiconMs, fuseMs, totalMs: performance.now() - startedAt },
    stats: {
      sourceName,
      indexSize: builtIndex.count,
      pinnedExcluded: pinned.size,
      queryChars: shaped.chars,
      queryCharsUsed: shaped.text.length,
      queryTruncated: shaped.truncated,
      queryCharLimit: shaped.limit,
      encodeDegraded: false,
      fallbackHits: 0,
      fallbackTopK: Math.trunc(Number(fallbackTopK) || FALLBACK_TOP_K),
      vectorCandidates: vectorCandidates.length,
      vectorHits: vecHits.length,
      ftsTokens,
      ftsMatchExpr: ftsQuery,
      ftsMatched: fts.matched,
      ftsHits: fts.hits.length,
      ftsSkipped: false,
      lexiconEnabled: lexiconSwitch.enabled,
      lexiconStatus,
      lexiconHits: lexHits.length,
      lexiconBuildMs,
      lexiconSwitchSource: lexiconSwitch.source,
      fused: merged.length,
    },
  };
  recordRecall(recallLog, result);
  return result;
}

// 融合键：`<来源名>:<refId>`（不加来源前缀的话，两源同 id 会互相吃掉）
function fuseKey(name, refId) {
  return `${name}:${String(refId)}`;
}

// 多来源召回结果 → 对外命中形状（字段只增不改：`lexiconRank` / `fallbackRank` 是新增位）
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
    lexiconRank: label ? entry.ranks[`lexicon:${label}`] ?? null : null,
    fallbackRank: entry.ranks.fallback ?? null,
  };
}

// 多来源召回：query 只编码一次，逐来源做「向量 top-K + 词表 + FTS 补位」，跨来源再 RRF 融合。
// 每个命中带 source 归属；某来源没库/没向量/报错 ⇒ 记一行跳过，不影响别的来源。
// 编码失败与单来源同口径：整轮降级成「每源固定 Top-K」，绝不返回空、绝不抛错。
export async function recallMulti({
  query, store, entries, embedder,
  perSourceTopK = 5, rrfK = 60, resultTopK = 8,
  queryCharLimit = QUERY_CHAR_LIMIT, encodeTimeoutMs = ENCODE_TIMEOUT_MS,
  lexiconEnabled = null, lexiconTopK = null, lexiconFloor = null,
  recallLog = null,
  log = () => {},
}) {
  const startedAt = performance.now();
  const shaped = truncateQuery(query, queryCharLimit);
  const admit = shouldTrigger(shaped.text);
  if (!admit.trigger) {
    return {
      triggered: false, reason: admit.reason, query: String(query ?? ''), hits: [],
      perSource: {}, timings: { totalMs: 0 },
    };
  }

  const vectorsDb = store.db;
  const encoded = await encodeQuery(embedder, shaped.text, { timeoutMs: encodeTimeoutMs });
  const encodeMs = encoded.elapsedMs;
  const degraded = Boolean(encoded.error);

  const lexiconSwitch = resolveLexiconSwitch({ enabled: lexiconEnabled, topK: lexiconTopK, floor: lexiconFloor });
  const ftsTokens = extractFtsTokens(shaped.text);
  const ftsQuery = buildFtsMatch(ftsTokens);
  const rankLists = [];
  const origin = new Map();
  const perSource = {};
  const fallbackKeys = [];

  const vectorStart = performance.now();
  for (const entry of entries || []) {
    const name = String(entry.name);
    const src = entry.source || null;
    const rec = {
      indexSize: 0, pinnedExcluded: 0, vectorHits: 0, ftsHits: 0,
      lexiconHits: 0, lexiconStatus: 'off', fallbackHits: 0, error: null,
    };
    try {
      const builtIndex = entry.index || buildVectorIndex(vectorsDb, { source: name });
      rec.indexSize = builtIndex.count;
      const pinned = new Set((src ? src.pinnedIds() : []).map(String));
      rec.pinnedExcluded = pinned.size;

      if (degraded) {
        const ids = fallbackCandidateIds({ source: src, index: builtIndex, pinned, take: perSourceTopK });
        rec.fallbackHits = ids.length;
        for (const refId of ids) {
          const key = fuseKey(name, refId);
          fallbackKeys.push(key);
          origin.set(key, { name, refId });
        }
      } else {
        const candidates = cosineTopK(builtIndex, encoded.vector, perSourceTopK + pinned.size + 5);
        const vecHits = excludePinned(candidates, pinned, perSourceTopK, 'refId');
        rec.vectorHits = vecHits.length;
        rankLists.push({ source: `vector:${name}`, ids: vecHits.map((hit) => fuseKey(name, hit.refId)) });
        for (const hit of vecHits) origin.set(fuseKey(name, hit.refId), { name, refId: String(hit.refId) });

        if (lexiconSwitch.enabled) {
          try {
            const builtLexicon = getLexiconIndex(src);
            if (!builtLexicon) {
              rec.lexiconStatus = 'warming';
            } else {
              const lexHits = rankByLexicon(shaped.text, builtLexicon, { topK: lexiconSwitch.topK, floor: lexiconSwitch.floor })
                .filter((hit) => !pinned.has(String(hit.id)))
                .slice(0, perSourceTopK);
              rec.lexiconHits = lexHits.length;
              rec.lexiconStatus = 'ok';
              rankLists.push({ source: `lexicon:${name}`, ids: lexHits.map((hit) => fuseKey(name, hit.id)) });
              for (const hit of lexHits) origin.set(fuseKey(name, hit.id), { name, refId: String(hit.id) });
            }
          } catch {
            rec.lexiconStatus = 'degraded';
          }
        }

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
      }
    } catch (err) {
      rec.error = String(err && err.message ? err.message : err);
      log(`[recallMulti] 来源 ${name} 跳过：${rec.error}`);
    }
    perSource[name] = rec;
  }
  if (degraded) rankLists.push({ source: 'fallback', ids: fallbackKeys });
  const vectorMs = performance.now() - vectorStart;

  if (degraded) {
    log(`[recallMulti] 编码降级（${encoded.error.name} / ${Math.round(encoded.error.ms)}ms）：${fallbackKeys.length} 条固定兜底`);
  }

  const fuseStart = performance.now();
  const merged = rrfFuse(rankLists, rrfK);
  const hits = merged.slice(0, Number(resultTopK) || 8).map((entry) => {
    const info = origin.get(entry.id) || { name: null, refId: entry.id };
    return multiHitOf(entry, info);
  });
  const fuseMs = performance.now() - fuseStart;

  const result = {
    triggered: true,
    reason: admit.reason,
    query: String(query ?? ''),
    hits,
    degraded: degraded
      ? { mode: 'fixed-topk', reason: encoded.error.name, topK: perSourceTopK, scope: 'per-source' }
      : null,
    encodeError: encoded.error,
    perSource,
    timings: { encodeMs, vectorMs, fuseMs, totalMs: performance.now() - startedAt },
    stats: {
      sources: (entries || []).map((entry) => String(entry.name)),
      queryChars: shaped.chars,
      queryCharsUsed: shaped.text.length,
      queryTruncated: shaped.truncated,
      queryCharLimit: shaped.limit,
      encodeDegraded: degraded,
      fallbackHits: fallbackKeys.length,
      lexiconEnabled: lexiconSwitch.enabled,
      lexiconStatus: degraded ? 'skipped-degraded' : (lexiconSwitch.enabled ? 'on' : 'off'),
      lexiconSwitchSource: lexiconSwitch.source,
      ftsTokens,
      ftsMatchExpr: ftsQuery,
      ftsSkipped: degraded,
      rankLists: rankLists.length,
      fused: merged.length,
    },
  };
  recordRecall(recallLog, result);
  return result;
}
