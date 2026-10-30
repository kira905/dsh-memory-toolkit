// ── 记忆引擎 · 夜间提炼内核 ─────────────────────────────────────────────────
//
// 一句话职责：把"最近被动过的记忆"按语义归拢成若干主题组，交给便宜档模型提炼成
// 能长期复用的一条结论，再以带 `distilled` 前缀的新记忆写回主库（可整批撤销）。
//
// 五条不可让渡的口径（改动前先读这一段）：
//   ① 输入面 = 时间窗口内 `updated_at` 有变动的条 ∪ 变更台账里尚未消费的条 ∪ 调用方点名的条；
//      凡是 `distilled` 打头的条**永不**入输入 —— 否则每晚会拿"昨天的摘要"再摘要一遍。
//   ② 归组只靠语义向量；标签顶多当域提示。标签组合近乎唯一，拿它聚类是不成立的。
//   ③ 去重是**内容级**的：键取"源正文哈希集合的哈希"，不取 id 集合 ——
//      跨机合并会整段重排号，id 一变去重就漏（详见 `srcKeyOf` 旁的说明）。
//      判定顺序永远是"先查库、再决定要不要花钱"。
//   ④ 成本上限按"每日"计：超了当场收手、这一组不重试、日报段里留一行痕迹。
//   ⑤ 写回要落 `owner_user` / `visibility`；归属读不出来的条一律不送外部模型（宁可漏送）。
//
// 只读约束：本模块对生产库只开只读连接。真正写库的只有显式 apply 分支，
// 且由调用方保证库路径指向副本。状态文件一律原子写（临时件 + rename）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { textHash } from './hashes.mjs';
import { recordDirty, listDirty, markConsumed, dirtyStats, ensureDirtySchema } from './dirty-ledger.mjs';
import { readCredential, extractJson, vacuumInto } from './domain-tags.mjs';

// ── 常量表 ─────────────────────────────────────────────────────────────────

export const STATE_SCHEMA = 1;

// 成本闸的两道上限。每日口径，超限即停、不重试；改档属于产品决策，不是调参。
const DAILY_CALL_CAP = 20;
const DAILY_TOKEN_CAP = 150000;

export const COST_LIMITS = Object.freeze({
  callsPerDay: DAILY_CALL_CAP,
  tokensPerDay: DAILY_TOKEN_CAP,
});

// 提炼模型档：走 DeepSeek 官方端点。端点与模型名都是对外行为的一部分，
// 换别家等于新增一条外发面，必须先拍板；也不需要更强推理档（分类/提炼用不上，且贵数倍）。
const LLM_FIELDS = [
  ['provider', 'deepseek'],
  ['baseUrl', 'https://api.deepseek.com'],
  ['model', 'deepseek-flash'],
  ['credentialKey', 'DEEPSEEK_API_KEY'],
  ['maxTokens', 2048],
  // 非思考模式下秒级返回，余量给足即可；超时即算失败，不重试
  ['timeoutMs', 60000],
];

export const DEFAULT_LLM = Object.freeze(Object.fromEntries(LLM_FIELDS));

/** 标签前缀 —— 回滚筛选与"排除自我指涉"都靠它。 */
export const DISTILL_PREFIX = 'distilled';

export const DEFAULT_WINDOW_HOURS = 24;
export const DEFAULT_HISTORY_MAX = 20;
export const PROCESSED_MAX = 2000;

// 聚类与送模型的裁剪参数：逐项都能从调用方注入，单测与调参不必改代码。
const CLUSTER_FIELDS = [
  ['simThreshold', 0.60],      // 余弦相似度下限（贪心归组）；中文小模型同题实测多在 0.7 以上
  ['maxItemsPerCluster', 12],  // 单组最多几条，防一次调用把上下文塞爆
  ['maxCharsPerItem', 400],    // 每条正文送模型前的截断长度
  ['minClusterChars', 120],    // 整组正文合计低于此值 ⇒ 不值得调模型
  ['minClusterSize', 2],       // 单条成组不提炼（理由见下）
  ['maxClustersPerRun', 20],   // 单轮最多处理几组，与每日调用上限同量级，双保险
];

export const CLUSTER_DEFAULTS = Object.freeze(Object.fromEntries(CLUSTER_FIELDS));

// 为什么 `minClusterSize` 默认是 2 而不是 1：
//   · 从定义上看，这个作业叫"先归类、再提炼"。一条自己一组根本没有"跨条综合"，
//     把单条改写成一句结论只是换个说法，信息量没有增加。
//   · 从后果上看，产物仍然写回主库，会按 `updated_at` 挤进召回段的"最近若干条"候选池 ——
//     每写一条就顶掉一条真实记忆的位置。实测把单条组也提炼时，产物里有八成是这种"改写件"，
//     真实内容能进候选池的条数直接腰斩；限成 2 之后只剩真正的组。
//   · 需要旧行为时，调用方显式传 `minClusterSize: 1` 即可 —— 不写死在代码里。

// ── 小工具 ─────────────────────────────────────────────────────────────────

const hexOf = (input) => crypto.createHash('sha256').update(String(input ?? ''), 'utf8').digest('hex');

export function shortKey(key, n = 24) {
  const width = Number(n);
  return String(key ?? '').slice(0, width);
}

/** 本机时区的日期串（YYYYMMDD）。 */
export function localDay(ts = Date.now()) {
  const at = new Date(Number(ts));
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}${month}${day}`;
}

/** 本机时区的日期串（YYYY-MM-DD），与 `localDay` 同一份，只是加连字符。 */
export function localDateIso(ts = Date.now()) {
  const digits = localDay(ts);
  return [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6)].join('-');
}

/**
 * **去重键 = 源正文哈希集合的哈希**（内容级）。
 *
 * 刻意不用 id 集合，哪怕最初的方案写的是"源 id 集合哈希"：
 *   跨机合并以"内容哈希"为主键，会给同样的内容灌一批新的高位 id。
 *   id 集合一变，键就变，于是重新调一次模型、再写出一条内容重复的提炼条。
 *   验收口径要求"跨机换了号之后重跑仍不重复"，只有取正文哈希才过得去。
 *   （源 id 清单依旧写进标签供人追溯，只是**不参与**去重判定。）
 *
 * @param {Array<{id:number, text:string}>} rows
 * @returns {string} `d` + 16 位十六进制
 */
export function srcKeyOf(rows) {
  const digest = rows.map((entry) => textHash(entry.text)).sort().join('|');
  return `d${hexOf(digest).slice(0, 16)}`;
}

export function distilledTagOf({ srcKey, srcIds, now }) {
  const ids = [...srcIds].map(String).sort().join(',');
  const stamp = localDay(now);
  return [DISTILL_PREFIX, `src=${shortKey(srcKey)}`, `srcids=${ids}`, `date=${stamp}`].join(' ');
}

/** 从标签串里抠出 `src=` 的值（去重时用）。 */
export function srcKeyInTags(tags) {
  const found = /(?:^|\s)src=([0-9a-f]+)(?:\s|$)/.exec(String(tags ?? ''));
  return found ? found[1] : null;
}

export function isDistilledTags(tags) {
  const head = String(tags ?? '').slice(0, DISTILL_PREFIX.length);
  return head === DISTILL_PREFIX;
}

// ── 连接与句柄的小包装 ─────────────────────────────────────────────────────

const BUSY_TIMEOUT_SQL = 'PRAGMA busy_timeout = 5000;';
const OWNER_COLUMNS = Object.freeze(['owner_user', 'visibility']);

function closeQuiet(handle) {
  try { handle.close(); } catch { /* 关不掉不影响已算出的结果 */ }
}

/** 打开记忆库（只读；只读连接不会挡住写者）。 */
export function openMemoryDb(dbPath) {
  const handle = new DatabaseSync(dbPath, { readOnly: true });
  handle.exec(BUSY_TIMEOUT_SQL);
  return handle;
}

/** 读表结构：返回列名数组。 */
function tableColumns(handle, table) {
  const rows = handle.prepare(`PRAGMA table_info(${table});`).all();
  return rows.map((entry) => entry.name);
}

/** 库是否带归属列（决定"能不能判归属"以及写库时的列清单）。 */
function hasOwnerColumns(handle) {
  const names = tableColumns(handle, 'memories');
  return OWNER_COLUMNS.every((column) => names.includes(column));
}

function withDirtyDb(vectorsDbPath, body) {
  const handle = new DatabaseSync(vectorsDbPath);
  try {
    handle.exec(BUSY_TIMEOUT_SQL);
    return body(handle);
  } finally { closeQuiet(handle); }
}

// ── 输入挑选（只读） ────────────────────────────────────────────────────────

/** 把"台账 id / 点名 id"去重、剔掉非数字，保持首次出现顺序不变。 */
function numericIdSet(list) {
  return [...new Set(list.map((value) => Number(value)).filter((value) => Number.isFinite(value)))];
}

/**
 * 归属闸：决定这条记录能不能送外部模型。返回 `{bucket, why}`，
 * `bucket` ∈ `ok` / `family` / `unknown`。判定顺序即优先级，逐条 fail-closed。
 */
function ownerGate({ ownerColumn, ownerUser, visibility, localOwner }) {
  if (!ownerColumn) return { bucket: 'unknown', why: '库无 owner_user 列，归属不可判定' };
  if (visibility === 'family') return { bucket: 'family', why: 'visibility=family' };
  if (!localOwner) return { bucket: 'unknown', why: '本机 owner 未解析出来 ⇒ 不猜' };
  if (ownerUser == null) return { bucket: 'unknown', why: 'owner_user 为空' };
  if (ownerUser !== localOwner) return { bucket: 'unknown', why: 'owner_user != 本机 owner' };
  return { bucket: 'ok', why: null };
}

/** 组装一条"可以送模型"的输入记录（正文截断与 hash 都在这里一次性算好）。 */
function toAcceptedItem(row, { id, source, maxCharsPerItem, ownerUser, visibility, localOwner }) {
  const text = String(row.text ?? '');
  return {
    id,
    text,
    tags: String(row.tags ?? ''),
    pinned: Number(row.pinned ?? 0),
    updatedAt: Number(row.updated_at),
    textHash: textHash(text),
    ownerUser: ownerUser ?? localOwner,
    visibility: visibility ?? 'private_owner',
    textForModel: text.slice(0, maxCharsPerItem),
    textTruncated: text.length > maxCharsPerItem,
    source,
  };
}

/**
 * 挑输入（**只读**）。三路并集先按 id 去重、再统一过筛：
 *   ① 增量窗口 `updated_at >= now - windowHours`
 *   ② 变更台账未消费项（补"改了正文却没动 updated_at"的盲区）
 *   ③ 调用方点名的 id（补跑 / 单测用）
 * 过筛两道：`distilled` 打头的一律排除；再按归属闸逐条判定并**分别记账**。
 */
export function selectInputs({ dbPath, now = Date.now(), windowHours = DEFAULT_WINDOW_HOURS, dirtyIds = [], extraIds = [], localOwner = null, maxCharsPerItem = CLUSTER_DEFAULTS.maxCharsPerItem, limit = 0 }) {
  const handle = openMemoryDb(dbPath);
  try {
    const ownerColumn = hasOwnerColumns(handle);
    const projection = ['id', 'text', 'tags', 'pinned', 'updated_at'];
    if (ownerColumn) projection.push('owner_user', 'visibility');
    const byId = handle.prepare(`SELECT ${projection.join(', ')} FROM memories WHERE id = ?;`);

    const since = Number(now) - Number(windowHours) * 3_600_000;
    const windowIds = handle
      .prepare(`SELECT id FROM memories WHERE updated_at >= ? ORDER BY id;`)
      .all(since)
      .map((entry) => Number(entry.id));

    const dirtyList = numericIdSet(dirtyIds);
    const extraList = numericIdSet(extraIds);
    const dirtySet = new Set(dirtyList);
    const extraSet = new Set(extraList);
    const windowSet = new Set(windowIds);
    const sourceOf = (id) => {
      if (dirtySet.has(id)) return 'dirty-ledger';
      if (extraSet.has(id) && !windowSet.has(id)) return 'extra';
      return 'window';
    };

    const candidateIds = [...new Set([...windowIds, ...dirtyList, ...extraList])].sort((left, right) => left - right);
    const accepted = [];
    const family = [];
    const unknownOwner = [];
    let distilledExcluded = 0;

    for (const id of candidateIds) {
      const row = byId.get(id);
      if (!row) continue; // 台账里有、库里已经没有（合并/回滚删掉了）⇒ 静默跳过
      if (isDistilledTags(row.tags)) { distilledExcluded += 1; continue; }

      const ownerUser = ownerColumn ? (row.owner_user ?? null) : null;
      const visibility = ownerColumn ? (row.visibility ?? null) : null;
      const verdict = ownerGate({ ownerColumn, ownerUser, visibility, localOwner });
      if (verdict.bucket === 'family') {
        family.push({ id, ownerUser, visibility, why: verdict.why });
        continue;
      }
      if (verdict.bucket === 'unknown') {
        unknownOwner.push({ id, ownerUser, why: verdict.why });
        continue;
      }
      accepted.push(toAcceptedItem(row, { id, source: sourceOf(id), maxCharsPerItem, ownerUser, visibility, localOwner }));
    }

    const capped = Number(limit) > 0 ? accepted.slice(0, Number(limit)) : accepted;
    return {
      accepted: capped,
      family,
      unknownOwner,
      distilledExcluded,
      windowRows: windowIds.length,
      dirtyRows: dirtyList.length,
      ownerColumn,
      stats: {
        windowRows: windowIds.length,
        dirtyRows: dirtyList.length,
        extraRows: extraList.length,
        candidates: candidateIds.length,
        accepted: capped.length,
        skippedFamily: family.length,
        skippedUnknownOwner: unknownOwner.length,
        distilledExcluded,
      },
    };
  } finally { closeQuiet(handle); }
}

// ── 全表比对：找出"正文动过但向量没跟上"的条 ────────────────────────────────

/** 把向量库里 `source='memory'` 的 (ref_id ⇒ text_hash) 读成一张表（只读）。 */
function vectorHashIndex(vectorsDbPath) {
  const index = new Map();
  if (!vectorsDbPath || !fs.existsSync(vectorsDbPath)) return index;
  const handle = new DatabaseSync(vectorsDbPath, { readOnly: true });
  let rows = [];
  try {
    rows = handle.prepare("SELECT ref_id, text_hash FROM vectors WHERE source = 'memory';").all();
  } finally { closeQuiet(handle); }
  for (const row of rows) index.set(String(row.ref_id), row.text_hash);
  return index;
}

/**
 * 全表逐条比对 `text_hash`（**只读记忆库**，纯哈希计算，不编码、不联网）：
 * 正文与向量库记录不一致 ⇒ 说明有人绕过更新入口直接改了 text。
 * 这是"兜底轮转"的同一判据，只是这里一次覆盖全表。`record` 为真时把差异落进台账。
 */
export function detectDirty({ dbPath, vectorsDbPath, record = false, now = Date.now(), includeMissing = false }) {
  const scan = { mismatched: [], missing: [], details: [] };
  const handle = openMemoryDb(dbPath);
  try {
    const rows = handle.prepare('SELECT id, text, tags, updated_at FROM memories ORDER BY id;').all();
    const known = vectorHashIndex(vectorsDbPath);
    for (const row of rows) {
      if (isDistilledTags(row.tags)) continue;
      const id = Number(row.id);
      const recorded = known.get(String(id));
      const actual = textHash(row.text);
      if (recorded === undefined) { scan.missing.push(id); continue; }
      if (recorded === actual) continue;
      scan.mismatched.push(id);
      scan.details.push({ refId: id, kind: 'mismatch', oldHash: recorded, newHash: actual });
    }
    if (record && scan.details.length) {
      withDirtyDb(vectorsDbPath, (ledger) => recordDirty(ledger, scan.details, { now }));
    }
    return {
      items: rows.length,
      mismatched: scan.mismatched,
      missing: includeMissing ? scan.missing : [],
      recorded: Boolean(record && scan.details.length),
      details: scan.details,
    };
  } finally { closeQuiet(handle); }
}

const EMPTY_LEDGER_STATS = Object.freeze({ table: false, total: 0, open: 0, consumed: 0, lastAt: null });

/** 读变更台账里**未消费**的 id（向量库不存在 ⇒ 空结果，不抛）。 */
export function readDirtyIds(vectorsDbPath) {
  if (!vectorsDbPath || !fs.existsSync(vectorsDbPath)) {
    return { ids: [], stats: { ...EMPTY_LEDGER_STATS } };
  }
  const handle = new DatabaseSync(vectorsDbPath, { readOnly: true });
  try {
    const rows = listDirty(handle, { openOnly: true });
    return { ids: rows.map((entry) => Number(entry.refId)), rows, stats: dirtyStats(handle) };
  } finally { closeQuiet(handle); }
}

// ── 语义聚类（只看向量，不看标签） ─────────────────────────────────────────

function cosineSim(lhs, rhs) {
  let dot = 0;
  let normL = 0;
  let normR = 0;
  for (let i = 0; i < lhs.length; i += 1) {
    dot += lhs[i] * rhs[i];
    normL += lhs[i] * lhs[i];
    normR += rhs[i] * rhs[i];
  }
  const denom = Math.sqrt(normL * normR);
  return denom === 0 ? 0 : dot / denom;
}

/** 批量取向量：`Map<id, Float32Array>`（缺的就不放进去，调用方当"还没有向量"处理）。 */
function loadRowVectors(vectorsDbPath, ids) {
  const vectors = new Map();
  if (!vectorsDbPath || !fs.existsSync(vectorsDbPath) || !ids.length) return vectors;
  const handle = new DatabaseSync(vectorsDbPath, { readOnly: true });
  try {
    const stmt = handle.prepare("SELECT vec, dim FROM vectors WHERE source = 'memory' AND ref_id = ?;");
    for (const id of ids) {
      const hit = stmt.get(String(id));
      if (!hit) continue;
      const raw = hit.vec;
      const slice = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      vectors.set(Number(id), new Float32Array(slice));
    }
  } finally { closeQuiet(handle); }
  return vectors;
}

/** 质心 = 组内向量逐分量平均（新数组，不就地改入参）。 */
function centroidOf(list) {
  const dim = list[0].length;
  const center = new Float32Array(dim);
  for (const vec of list) {
    for (let i = 0; i < dim; i += 1) center[i] += vec[i];
  }
  for (let i = 0; i < dim; i += 1) center[i] /= list.length;
  return center;
}

/** 在既有组里挑"质心最像且没过阈值"的那一个；挑不出来返回 null。 */
function nearestGroup(groups, vec, threshold, maxItems) {
  let winner = null;
  let bestScore = -1;
  for (const group of groups) {
    if (group.members.length >= maxItems) continue;
    if (!group.centroid) continue;
    const score = cosineSim(vec, group.centroid);
    if (score > bestScore) { bestScore = score; winner = group; }
  }
  return bestScore >= threshold ? winner : null;
}

function newGroup(row, vec) {
  return {
    members: [row],
    vectors: vec ? [vec] : [],
    centroid: vec,
    chars: row.textForModel.length,
    simToAssign: vec ? null : 'no-vector',
  };
}

function absorbInto(group, row, vec) {
  group.members.push(row);
  group.vectors.push(vec);
  group.centroid = centroidOf(group.vectors);
  group.chars += row.textForModel.length;
}

/**
 * 单遍贪心聚类（O(n·组数)）：
 *   · 有向量的条 ⇒ 归到"质心最像且相似度过阈值"的组；组满了就另起一组；
 *   · **没有向量的条**（刚写进来还没编码）⇒ 自成一组。不按标签猜，也不硬塞。
 */
export function clusterRows(rows, opts = {}) {
  const vectorsDbPath = opts.vectorsDbPath ?? null;
  const threshold = Number(opts.simThreshold ?? CLUSTER_DEFAULTS.simThreshold);
  const maxItems = Number(opts.maxItemsPerCluster ?? CLUSTER_DEFAULTS.maxItemsPerCluster);
  const lookup = loadRowVectors(vectorsDbPath, rows.map((row) => row.id));
  const groups = [];
  let withoutVector = 0;

  for (const row of rows) {
    const vec = lookup.get(row.id) ?? null;
    if (!vec) {
      withoutVector += 1;
      groups.push(newGroup(row, null));
      continue;
    }
    const target = nearestGroup(groups, vec, threshold, maxItems);
    if (target) absorbInto(target, row, vec);
    else groups.push(newGroup(row, vec));
  }

  const clusters = groups.map((group) => {
    const { vectors, ...keep } = group;
    return { ...keep, key: srcKeyOf(group.members), ids: group.members.map((member) => member.id) };
  });
  return {
    clusters,
    stats: {
      rows: rows.length,
      clusters: clusters.length,
      withVector: lookup.size,
      noVector: withoutVector,
      singletonClusters: clusters.filter((cluster) => cluster.members.length === 1).length,
      simThreshold: threshold,
    },
  };
}

// ── 提示词与模型调用 ───────────────────────────────────────────────────────

const SYSTEM_RULES = [
  '你是一个长期记忆的「提炼器」。给你若干组同主题的中文记忆条目（组编号 + 条目编号 + 正文），',
  '把**每一组**提炼成 1 条**长期有效的结论**（将来会作为一条独立记忆保存下来）。',
  '规则：',
  '1. 只写这些条目**共同支撑**的结论；不得引入条目里没有的事实，不得脑补，不得评价作者。',
  '2. 结论要能长期复用：写清「是什么 / 在什么条件下适用 / 关键做法或阈值」；',
  '   禁止「今天/昨天/本次」这类相对时间，必须提日期时写绝对日期。',
  '3. 若这组只是流水账、提炼不出长期结论 ⇒ conclusion 置为空字符串（宁缺勿滥）。',
  '4. conclusion 用中文写成一整段（不要分点、不要 markdown、不要"综上所述"），不超过 200 字。',
  '5. 输出**严格 JSON**：{"items":[{"key":"<组编号>","conclusion":"..."}]}；',
  '   每组一条、key 逐字照抄输入的组编号、不要漏组、不要输出代码围栏或任何解释文字。',
];

export function buildSystemPrompt() {
  return SYSTEM_RULES.join('\n');
}

export function buildUserPrompt(clusters) {
  const blocks = clusters.map((cluster) => {
    const body = cluster.members
      .map((member) => `[${member.id}] ${member.textForModel.replace(/\s+/g, ' ').trim()}`)
      .join('\n');
    return `【组 ${shortKey(cluster.key)}】\n${body}`;
  });
  return `共 ${clusters.length} 组，请逐组提炼并按要求输出 JSON：\n\n${blocks.join('\n\n')}`;
}

/** 保守估算一次批量调用的 token；调用前先用它过成本闸。 */
export function estimateTokens(clusters) {
  const fixed = buildSystemPrompt().length + 200;
  const body = clusters.reduce((sum, cluster) => sum + cluster.chars + 32, 0);
  return Math.ceil((body + fixed) / 1.4) + 400;
}

/** 组装请求体。`thinking` 必须显式关掉：该模型默认开思考，白烧 token 且 content 可能为空。 */
function distillerPayload({ model, clusters, temperature, maxTokens }) {
  return {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(clusters) },
    ],
    thinking: { type: 'disabled' },
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
}

/** 模型输出可能是 `{items:[...]}` 也可能直接是数组，两种都认。 */
function itemsOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed?.items) ? parsed.items : null;
}

/** 调一次提炼模型（`fetchImpl` 可注入 ⇒ 单测不真发网络）。**单次尝试，不重试。** */
export async function callDistiller({ clusters, apiKey, baseUrl = DEFAULT_LLM.baseUrl, model = DEFAULT_LLM.model, fetchImpl = fetch, timeoutMs = DEFAULT_LLM.timeoutMs, maxTokens = DEFAULT_LLM.maxTokens, temperature = 0.2 }) {
  const payload = distillerPayload({ model, clusters, temperature, maxTokens });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs));
  const beganAt = Date.now();
  const spent = () => Date.now() - beganAt;
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    const ms = spent();
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}: ${raw.slice(0, 300)}`, ms };

    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (parseError) {
      return { ok: false, error: `响应不是 JSON：${parseError.message}`, raw: raw.slice(0, 300), ms };
    }
    const content = envelope?.choices?.[0]?.message?.content ?? '';
    const usage = envelope?.usage ?? {};
    const parsed = extractJson(content);
    if (!parsed) return { ok: false, error: '模型输出里找不到可解析的 JSON', raw: String(content).slice(0, 300), usage, ms };
    const items = itemsOf(parsed);
    if (!items) return { ok: false, error: 'JSON 结构不含 items 数组', raw: String(content).slice(0, 300), usage, ms };
    return { ok: true, items, usage, content, ms };
  } catch (failure) {
    return { ok: false, error: `请求失败：${failure && failure.message ? failure.message : failure}`, ms: spent() };
  } finally {
    clearTimeout(timer);
  }
}

// ── 去重源（先查库，再决定要不要调模型） ────────────────────────────────────

/** 库里已有的提炼条：`src=` 键集 + 正文哈希集。**durable** 去重源（状态文件丢了也挡得住）。 */
export function existingDistilled(dbPath) {
  const handle = openMemoryDb(dbPath);
  try {
    const rows = handle.prepare("SELECT id, text, tags FROM memories WHERE tags LIKE 'distilled%';").all();
    const keys = new Set();
    const textHashes = new Set();
    for (const row of rows) {
      const key = srcKeyInTags(row.tags);
      if (key) keys.add(key);
      textHashes.add(textHash(row.text));
    }
    return {
      count: rows.length,
      keys,
      textHashes,
      rows: rows.map((row) => ({ id: Number(row.id), tags: row.tags })),
    };
  } finally { closeQuiet(handle); }
}

// ── 状态文件与成本闸 ────────────────────────────────────────────────────────

function blankCost(nowIso) {
  return { date: localDateIso(Date.parse(nowIso) || Date.now()), calls: 0, promptTokens: 0, completionTokens: 0 };
}

export function defaultState(dbPath, nowIso) {
  return {
    schemaVersion: STATE_SCHEMA,
    dbPath,
    updatedAt: nowIso,
    cost: blankCost(nowIso),
    processed: {},
    skipped: {},
    lastRun: null,
    lastDailyLine: null,
    history: [],
    stats: { runs: 0, written: 0, calls: 0, stopped: 0 },
  };
}

export function readState(stateFile, dbPath, nowIso) {
  const fresh = () => defaultState(dbPath, nowIso);
  try {
    if (!fs.existsSync(stateFile)) return fresh();
    const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const base = fresh();
    const merged = {
      ...base,
      ...stored,
      cost: { ...base.cost, ...(stored.cost ?? {}) },
      stats: { ...base.stats, ...(stored.stats ?? {}) },
      processed: stored.processed ?? {},
      skipped: stored.skipped ?? {},
      history: Array.isArray(stored.history) ? stored.history : [],
    };
    // 成本闸是"每日"口径 ⇒ 跨日就把当日计数清零
    if (merged.cost.date !== base.cost.date) return { ...merged, cost: { ...base.cost } };
    return merged;
  } catch {
    return fresh();
  }
}

export function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const staged = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(staged, `${JSON.stringify(pruneState(state), null, 2)}\n`, 'utf8');
  let moved = true;
  try { fs.renameSync(staged, stateFile); } catch { moved = false; }
  if (!moved) {
    fs.copyFileSync(staged, stateFile);
    try { fs.unlinkSync(staged); } catch { /* 临时件删不掉也没有影响 */ }
  }
  return stateFile;
}

/** `processed` 只留最近若干条 —— 去重的权威源是库里的 `src=` 标签，这里只是快查缓存。 */
export function pruneState(state) {
  const entries = Object.entries(state.processed ?? {});
  if (entries.length <= PROCESSED_MAX) return state;
  const ordered = entries.sort((left, right) => String(left[1]?.at ?? '').localeCompare(String(right[1]?.at ?? '')));
  return { ...state, processed: Object.fromEntries(ordered.slice(ordered.length - PROCESSED_MAX)) };
}

/** 成本闸：逐条列上限，第一条被触发的就返回它的原因（超限即停，不重试）。 */
export function costGate(state, estimatedTokens, limits = COST_LIMITS) {
  const spent = Number(state.cost.promptTokens ?? 0) + Number(state.cost.completionTokens ?? 0);
  const usedCalls = Number(state.cost.calls ?? 0);
  const verdicts = [
    { hit: usedCalls >= limits.callsPerDay, reason: `当日调用数已达上限 ${limits.callsPerDay} 次` },
    { hit: spent >= limits.tokensPerDay, reason: `当日 token 已达上限 ${limits.tokensPerDay}` },
    { hit: spent + estimatedTokens > limits.tokensPerDay, reason: `本组估算 ${estimatedTokens} token 会超过当日上限（已用 ${spent}/${limits.tokensPerDay}）` },
  ];
  const blocked = verdicts.find((verdict) => verdict.hit);
  return blocked ? { ok: false, reason: blocked.reason } : { ok: true };
}

// ── 写库 ───────────────────────────────────────────────────────────────────

/** 开一次显式事务跑一段同步逻辑；失败先回滚再把原错误抛出来（错误信息一个字都不许改）。 */
function runTransaction(handle, body) {
  try {
    handle.exec('BEGIN IMMEDIATE');
  } catch (error) {
    return { ok: false, error };
  }
  try {
    const value = body();
    handle.exec('COMMIT');
    return { ok: true, value };
  } catch (error) {
    try { handle.exec('ROLLBACK'); } catch { /* 回滚失败也要把原始错误抛出去 */ }
    return { ok: false, error };
  }
}

/**
 * 带退避重试的写事务（只在"库被占用"这类错误上重试）。
 * 三次机会，退避 1s / 4s / 16s，累计等待不超过 60s。
 */
export async function withBusyRetry(db, fn, deps = {}) {
  const pause = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const backoff = [1000, 4000, 16000];
  const ceiling = 60000;
  const startedAt = Date.now();
  let slept = 0;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const outcome = runTransaction(db, fn);
    if (outcome.ok) return { ok: true, value: outcome.value, attempts: attempt, waitedMs: slept };
    lastError = outcome.error;
    const contended = /busy|locked/i.test(String(outcome.error?.message ?? outcome.error));
    if (!contended || attempt === 3) break;
    const nap = backoff[attempt - 1];
    const projected = Math.max(slept + nap, Date.now() - startedAt + nap);
    if (projected > ceiling) break;
    await pause(nap);
    slept += nap;
  }
  return { ok: false, attempts: 3, error: String(lastError?.message ?? lastError), waitedMs: slept };
}

function insertStatement(handle, withOwner) {
  const columns = 'text, tags, pinned, created_at, updated_at';
  return withOwner
    ? handle.prepare(`INSERT INTO memories (${columns}, owner_user, visibility) VALUES (?,?,0,?,?,?,?);`)
    : handle.prepare(`INSERT INTO memories (${columns}) VALUES (?,?,0,?,?);`);
}

/**
 * 写入提炼条（**幂等**：库里已有同 `src=` 键就跳过，不重复写）。
 * @returns {{written:number, skippedExisting:number, ids:number[], details:Array, ok:boolean, error:string|null}}
 */
export async function applyDistilled(dbPath, results, opts = {}) {
  const stamp = Number(opts.now ?? Date.now());
  const fallbackOwner = opts.ownerUser ?? null;
  const fallbackVisibility = opts.visibility ?? 'private_owner';
  const deps = opts.deps ?? {};

  const handle = new DatabaseSync(dbPath);
  const details = [];
  const ids = [];
  let written = 0;
  let skippedExisting = 0;
  try {
    handle.exec(BUSY_TIMEOUT_SQL);
    const withOwner = hasOwnerColumns(handle);
    const already = new Set(
      handle.prepare("SELECT tags FROM memories WHERE tags LIKE 'distilled%';").all()
        .map((row) => srcKeyInTags(row.tags))
        .filter(Boolean),
    );
    const insert = insertStatement(handle, withOwner);

    const outcome = await withBusyRetry(handle, () => {
      for (const entry of results) {
        const key = shortKey(entry.srcKey);
        if (already.has(key)) {
          skippedExisting += 1;
          details.push({ srcKey: key, action: 'already-in-db' });
          continue;
        }
        const tags = distilledTagOf({ srcKey: key, srcIds: entry.srcIds ?? [], now: stamp });
        const info = withOwner
          ? insert.run(entry.conclusion, tags, stamp, stamp, entry.ownerUser ?? fallbackOwner, entry.visibility ?? fallbackVisibility)
          : insert.run(entry.conclusion, tags, stamp, stamp);
        const newId = Number(info.lastInsertRowid ?? 0);
        ids.push(newId);
        written += 1;
        details.push({ srcKey: key, action: 'written', id: newId, tags, chars: String(entry.conclusion).length });
      }
      return { written, skippedExisting };
    }, deps);

    return {
      written: outcome.value?.written ?? 0,
      skippedExisting: outcome.value?.skippedExisting ?? 0,
      ids,
      details,
      ok: outcome.ok,
      error: outcome.error ?? null,
    };
  } finally { closeQuiet(handle); }
}

// ── 日报那一行 ─────────────────────────────────────────────────────────────

export const DAILY_SECTION_TITLE = '## 🧪 记忆提炼（memory-distill）';

/**
 * 拼日报行：条数 / 首行样本 / 当日调用数与 token。
 * 单轮组数上限属于**截断**而不是停机，所以要写清"本轮到哪、一共几组"。
 */
export function renderDailyLine({ mode, run, cost, limits = COST_LIMITS, stopping = null }) {
  const spent = Number(cost.promptTokens ?? 0) + Number(cost.completionTokens ?? 0);
  const sample = run?.firstSample ? `「${String(run.firstSample).slice(0, 60)}」` : '（无）';
  const parts = [
    ['模式', mode],
    ['输入', `${run?.inputs ?? 0} 条/${run?.clustersPlanned ?? 0} 组`],
    ['提炼条数', run?.written ?? 0],
    ['跳过(去重)', run?.skippedDuplicate ?? 0],
    ['跳过(非本机owner/家人)', (run?.skippedOwner ?? 0) + (run?.skippedFamily ?? 0)],
    ['当日调用', `${cost.calls ?? 0}/${limits.callsPerDay}`],
    ['当日 token', `${spent}/${limits.tokensPerDay}`],
  ].map(([label, value]) => `${label} ${value}`);
  parts.push(`首行样本：${sample}`);
  if (run?.capped?.capped) parts.push(`本轮处理 ${run.capped.processed}/${run.capped.plannedCalls} 组（单轮上限 ${run.capped.cap}）`);
  if (stopping) parts.push(`停机原因：${stopping}`);
  return parts.join(' · ');
}

/** 日报段落结束位置：从标题下一行起，遇到下一个二级标题（且不是空行紧跟）为止。 */
function sectionEnd(lines, titleAt) {
  let cursor = titleAt + 1;
  while (cursor < lines.length && !(lines[cursor].startsWith('## ') && cursor > titleAt + 1)) cursor += 1;
  return cursor;
}

/** 段级替换（同一天的日报只保留一条提炼行；日报不存在时不新建）。 */
export function updateDailySection({ file, line, dryRun = false }) {
  if (!fs.existsSync(file)) return { ok: false, reason: '日报不存在（不新建）', file };
  const original = fs.readFileSync(file, 'utf8').split('\n');
  const titleAt = original.findIndex((entry) => entry.trim() === DAILY_SECTION_TITLE);
  const block = [DAILY_SECTION_TITLE, '', `> ${line}`, ''];
  const next = titleAt >= 0
    ? [...original.slice(0, titleAt), ...block, ...original.slice(sectionEnd(original, titleAt))]
    : [...original, ...block];
  if (!dryRun) fs.writeFileSync(file, next.join('\n'), 'utf8');
  return { ok: true, replaced: titleAt >= 0, file };
}

export function dailyReportPath({ docsDir = path.join(process.cwd(), 'docs'), host = null, now = Date.now() } = {}) {
  const machine = host || process.env.COMPUTERNAME || 'unknown-host';
  return path.join(docsDir, '管家报告', `${localDateIso(now)}-${machine}.md`);
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

/** 一次运行的入参归一（缺省值即产品默认值，调用方可逐项覆盖）。 */
function readRunOptions(p) {
  const {
    memoryDb: memoryDbPath, vectorsDb: vectorsDbPath, stateFile: stateFilePath,
    now = Date.now(), windowHours = DEFAULT_WINDOW_HOURS, apply = false, limits = COST_LIMITS,
    model = DEFAULT_LLM.model, baseUrl = DEFAULT_LLM.baseUrl, apiKey = null,
    fetchImpl = fetch, timeoutMs = DEFAULT_LLM.timeoutMs, localOwner = null,
    limit = 0, extraIds = [], dirtyProbe = true,
    simThreshold = CLUSTER_DEFAULTS.simThreshold,
    maxItemsPerCluster = CLUSTER_DEFAULTS.maxItemsPerCluster,
    maxCharsPerItem = CLUSTER_DEFAULTS.maxCharsPerItem,
    minClusterChars = CLUSTER_DEFAULTS.minClusterChars,
    minClusterSize = CLUSTER_DEFAULTS.minClusterSize,
    maxClustersPerRun = CLUSTER_DEFAULTS.maxClustersPerRun,
    snapshotFile = null, log = () => {}, deps = {},
  } = p;
  return {
    memoryDbPath, vectorsDbPath, stateFilePath, now, windowHours, apply, limits, model, baseUrl,
    apiKey, fetchImpl, timeoutMs, localOwner, limit, extraIds, dirtyProbe, simThreshold,
    maxItemsPerCluster, maxCharsPerItem, minClusterChars, minClusterSize, maxClustersPerRun,
    snapshotFile, log, deps,
  };
}

/** 台账补盲：全表比对 + 未消费台账，两者并起来就是本轮的补充输入源。 */
function probeDirtyInputs({ memoryDbPath, vectorsDbPath, shouldRecord, now }) {
  const scan = detectDirty({ dbPath: memoryDbPath, vectorsDbPath, record: shouldRecord, now });
  const ledger = readDirtyIds(vectorsDbPath);
  return {
    ids: [...new Set([...ledger.ids, ...scan.mismatched])],
    summary: {
      mismatched: scan.mismatched.length,
      missingVectors: scan.missing.length,
      ledgerOpen: ledger.stats.open,
      ledgerTable: ledger.stats.table,
    },
  };
}

/** 失败记录的"哪一天"：优先看显式 day，其次从时间戳前 10 位截。 */
function failureDay(failure) {
  return failure.day ?? String(failure.at ?? '').slice(0, 10);
}

/** 给一个组下结论：跳过还是值得调模型。判定顺序即优先级，命中即返回。 */
function classifyCluster(cluster, plan) {
  const key = shortKey(cluster.key);
  const base = { key, ids: cluster.ids };
  if (cluster.members.length < plan.minClusterSize) {
    return { ...base, action: 'skip-singleton', chars: cluster.chars, reason: `组内 ${cluster.members.length} 条 < minClusterSize ${plan.minClusterSize}` };
  }
  if (cluster.chars < plan.minClusterChars) return { ...base, action: 'skip-too-short', chars: cluster.chars };
  const handled = plan.processed[key];
  if (handled) return { ...base, action: 'skip-processed', at: handled.at };
  if (plan.knownKeys.has(key)) return { ...base, action: 'skip-in-db' };
  // 同一天已经试过且失败/没结论 ⇒ 今天不再试（"不重试"要跨轮也成立），换一天才给第二次机会。
  // 依据：上游限流时如果同一天反复重跑，会对同一组反复烧额度。
  const failure = plan.failures[key];
  if (failure && failureDay(failure) === plan.today) {
    return { ...base, action: 'skip-failed-today', reason: failure.reason };
  }
  return { key, ids: cluster.ids, action: 'call', chars: cluster.chars, members: cluster.members };
}

/** 从模型返回的一组结论里挑出与本组对应那一条（对不上就退化为第一条）。 */
function pickClusterItem(items, key) {
  const hit = items.find((entry) => shortKey(entry?.key) === key);
  return hit ?? items[0];
}

/**
 * 处理一个组：过成本闸 → 调模型 → 记账 → 写库 → 更新状态。
 * 返回 `{verdict}`：`stop`（成本闸拦下，调用方必须停机）/ `failed` / `empty` / `written`。
 */
async function distillOneCluster(job, env) {
  const estimate = estimateTokens([{ chars: job.chars }]);
  const gate = costGate(env.state, estimate, env.limits);
  if (!gate.ok) return { verdict: 'stop', reason: gate.reason };

  const answer = await callDistiller({
    clusters: [job], apiKey: env.apiKey, baseUrl: env.baseUrl, model: env.model,
    fetchImpl: env.fetchImpl, timeoutMs: env.timeoutMs, maxTokens: DEFAULT_LLM.maxTokens,
  });
  // 调用即记账 —— 失败也记，因为额度是真的花掉了
  env.state.cost.calls = Number(env.state.cost.calls ?? 0) + 1;
  env.run.calls += 1;
  const usage = answer.usage ?? {};
  const promptTokens = Number(usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? 0);
  env.state.cost.promptTokens = Number(env.state.cost.promptTokens ?? 0) + promptTokens;
  env.state.cost.completionTokens = Number(env.state.cost.completionTokens ?? 0) + completionTokens;

  const conclusion = String(pickClusterItem(answer.items ?? [], job.key)?.conclusion ?? '').trim();
  env.result.calls.push({
    key: job.key, ids: job.ids, ok: answer.ok, ms: answer.ms ?? null,
    tokens: promptTokens + completionTokens,
    conclusionChars: conclusion.length, error: answer.ok ? null : answer.error,
  });

  if (!answer.ok) {
    env.run.modelFailures += 1;
    env.state.skipped[job.key] = { at: env.nowIso, day: env.today, reason: `model-error: ${String(answer.error).slice(0, 160)}` };
    return { verdict: 'failed' }; // 不重试：同一天再跑也走 skip-failed-today
  }
  if (!conclusion) {
    env.state.skipped[job.key] = { at: env.nowIso, day: env.today, reason: '模型判定无可提炼的长期结论' };
    return { verdict: 'empty' };
  }

  const outcome = await applyDistilled(
    env.memoryDbPath,
    [{ srcKey: job.key, srcIds: job.ids, conclusion, ownerUser: job.members[0]?.ownerUser, visibility: 'private_owner' }],
    { now: env.now, ownerUser: env.localOwner, deps: env.deps },
  );
  env.result.written += outcome.written;
  if (outcome.written) {
    env.result.writtenIds.push(...outcome.ids);
    env.run.written += outcome.written;
    if (!env.run.firstSample) env.run.firstSample = conclusion;
    env.state.processed[job.key] = { at: env.nowIso, ids: job.ids, outHash: textHash(conclusion), written: outcome.written, rowIds: outcome.ids };
  } else {
    env.result.warnings.push(`写库被跳过（库里已有同源键）：${job.key}`);
    env.state.processed[job.key] = { at: env.nowIso, ids: job.ids, outHash: textHash(conclusion), written: 0 };
  }
  return { verdict: 'written' };
}

/** 把一批 id 标成台账"已消费"（幂等；幂等性由台账层保证）。 */
function markLedgerConsumed(vectorsDbPath, ids, now) {
  withDirtyDb(vectorsDbPath, (ledger) => {
    ensureDirtySchema(ledger);
    markConsumed(ledger, ids, { now });
  });
}

/**
 * 跑一轮提炼。
 *
 * dry-run 什么都不写：不调模型、不写库、不写状态文件、不写台账；只是把"本来会怎么走"算给你看。
 *
 * @param {object} p
 * @param {string} p.memoryDb   记忆库路径（**测试一律指副本**）
 * @param {string} p.vectorsDb  向量库路径（聚类与台账都在这里）
 * @param {string} p.stateFile  状态文件（缺省落在库的上两级）
 * @param {boolean} p.apply     false = dry-run（默认）
 */
export async function runDistill(p = {}) {
  const opts = readRunOptions(p);
  const mode = opts.apply ? 'apply' : 'dry-run';
  const nowIso = new Date(Number(opts.now)).toISOString();
  const result = {
    ok: true,
    mode,
    at: nowIso,
    memoryDb: opts.memoryDbPath,
    vectorsDb: opts.vectorsDbPath,
    stateFile: opts.stateFilePath,
    model: opts.model,
    baseUrl: opts.baseUrl,
    windowHours: opts.windowHours,
    limits: opts.limits,
    localOwner: opts.localOwner,
    inputs: null,
    clusters: [],
    planned: [],
    calls: [],
    written: 0,
    writtenIds: [],
    cost: null,
    stopping: null,
    dailyLine: null,
    warnings: [],
    dirty: null,
    snapshot: null,
    state: null,
    exitCode: 0,
  };

  if (!opts.memoryDbPath || !fs.existsSync(opts.memoryDbPath)) {
    result.ok = false;
    result.exitCode = 3;
    result.stopping = `记忆库不存在：${opts.memoryDbPath}`;
    return result;
  }

  // ① 台账补盲（dry-run 只算不写）
  let dirtyIds = [];
  if (opts.dirtyProbe) {
    const probe = probeDirtyInputs({
      memoryDbPath: opts.memoryDbPath, vectorsDbPath: opts.vectorsDbPath,
      shouldRecord: opts.apply, now: opts.now,
    });
    dirtyIds = probe.ids;
    result.dirty = probe.summary;
    if (probe.summary.mismatched) {
      opts.log(`[distill] 全表 hash 比对：${probe.summary.mismatched} 条正文与向量库不符（台账补充输入）`);
    }
  }

  // ② 挑输入（含归属闸）
  const selection = selectInputs({
    dbPath: opts.memoryDbPath, now: opts.now, windowHours: opts.windowHours,
    dirtyIds, extraIds: opts.extraIds, localOwner: opts.localOwner,
    maxCharsPerItem: opts.maxCharsPerItem, limit: opts.limit,
  });
  result.inputs = selection.stats;
  result.dirtyInputIds = dirtyIds;
  if (selection.family.length) result.warnings.push(`D2：${selection.family.length} 条 visibility=family 已排除（不进第三方）`);
  if (selection.unknownOwner.length) result.warnings.push(`D2：${selection.unknownOwner.length} 条归属不可判定已排除（不进第三方）`);
  if (!selection.ownerColumn) result.warnings.push('库无 owner_user 列 ⇒ 归属不可判定，本轮 0 调用（红线：不猜）');
  opts.log(`[distill] 输入：窗口 ${selection.stats.windowRows} + 台账 ${selection.stats.dirtyRows} ⇒ 候选 ${selection.stats.candidates}，`
    + `接受 ${selection.stats.accepted}（排除 family ${selection.stats.skippedFamily} / 非本机 owner ${selection.stats.skippedUnknownOwner} / distilled ${selection.stats.distilledExcluded}）`);

  // ③ 聚类 + 去重规划
  const clustered = clusterRows(selection.accepted, {
    vectorsDbPath: opts.vectorsDbPath, simThreshold: opts.simThreshold, maxItemsPerCluster: opts.maxItemsPerCluster,
  });
  result.clusterStats = clustered.stats;
  const known = existingDistilled(opts.memoryDbPath);
  const state = readState(
    opts.stateFilePath ?? path.join(path.dirname(opts.memoryDbPath), '..', 'butler-distill-state.json'),
    opts.memoryDbPath,
    nowIso,
  );
  const today = localDateIso(opts.now);
  const plan = {
    minClusterSize: Number(opts.minClusterSize),
    minClusterChars: opts.minClusterChars,
    processed: state.processed ?? {},
    knownKeys: known.keys,
    failures: state.skipped ?? {},
    today,
  };
  const ordered = [...clustered.clusters].sort((left, right) => right.members.length - left.members.length || left.ids[0] - right.ids[0]);
  const planned = ordered.map((cluster) => classifyCluster(cluster, plan));
  result.planned = planned.map((entry) => ({
    key: entry.key, ids: entry.ids, action: entry.action, chars: entry.chars, reason: entry.reason ?? null,
  }));

  const callable = planned.filter((entry) => entry.action === 'call');
  const perRunCap = Math.max(0, Number(opts.maxClustersPerRun));
  const todo = callable.slice(0, perRunCap);
  result.capped = {
    plannedCalls: callable.length,
    processed: todo.length,
    capped: callable.length > todo.length,
    cap: Number(opts.maxClustersPerRun),
  };
  result.clusters = todo.length;

  const skippedByPlan = planned.filter((entry) => entry.action !== 'call').length;

  if (!opts.apply) {
    result.cost = { ...state.cost };
    result.run = {
      inputs: selection.stats.accepted,
      clustersPlanned: callable.length,
      written: 0,
      skippedDuplicate: skippedByPlan,
      skippedOwner: selection.stats.skippedUnknownOwner,
      skippedFamily: selection.stats.skippedFamily,
      firstSample: null,
      capped: result.capped,
    };
    result.dailyLine = renderDailyLine({ mode, run: result.run, cost: state.cost, limits: opts.limits, stopping: 'dry-run 不调用模型' });
    opts.log('[distill] dry-run：不调模型、不写库、不写 state');
    return result;
  }

  // ④ 逐组调用（成本闸逐次判；超限即停、不重试）
  const apiKey = opts.apiKey || readCredential(DEFAULT_LLM.credentialKey);
  if (!apiKey) {
    result.ok = false;
    result.exitCode = 1;
    result.stopping = `读不到凭证 ${DEFAULT_LLM.credentialKey}（.credentials.yaml）`;
    return result;
  }

  // 写库前快照（调用方给了才做；`VACUUM INTO` 只读源库）
  if (opts.snapshotFile) {
    try {
      vacuumInto(opts.memoryDbPath, opts.snapshotFile);
      result.snapshot = opts.snapshotFile;
      opts.log(`[distill] 写前快照：${opts.snapshotFile}`);
    } catch (failure) {
      result.warnings.push(`快照失败（不阻断写库）：${failure?.message ?? failure}`);
    }
  }

  const run = {
    inputs: selection.stats.accepted,
    clustersPlanned: callable.length,
    written: 0,
    skippedDuplicate: skippedByPlan,
    skippedOwner: selection.stats.skippedUnknownOwner,
    skippedFamily: selection.stats.skippedFamily,
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    firstSample: null,
    modelFailures: 0,
    capped: result.capped,
  };
  const env = {
    state, run, result, limits: opts.limits, apiKey,
    baseUrl: opts.baseUrl, model: opts.model, fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs, memoryDbPath: opts.memoryDbPath,
    now: opts.now, nowIso, today, localOwner: opts.localOwner, deps: opts.deps,
  };
  for (const job of todo) {
    const step = await distillOneCluster(job, env);
    if (step.verdict !== 'stop') continue;
    result.stopping = step.reason;
    opts.log(`[distill] 成本闸停：${step.reason}`);
    break;
  }

  // ⑤ 台账标记已消费 —— 只标真正进了输入的那些；被归属闸排除的保持 open，留着可见
  const acceptedIds = new Set(selection.accepted.map((entry) => entry.id));
  const consumedIds = dirtyIds.filter((id) => acceptedIds.has(Number(id)));
  if (consumedIds.length) {
    try {
      markLedgerConsumed(opts.vectorsDbPath, consumedIds, opts.now);
    } catch (failure) {
      result.warnings.push(`台账标记失败（不阻断）：${failure?.message ?? failure}`);
    }
  }
  result.dirtyConsumed = consumedIds;

  // ⑥ 状态落盘（原子写）
  result.cost = { ...state.cost };
  result.run = run;
  const dailyLine = renderDailyLine({ mode, run, cost: state.cost, limits: opts.limits, stopping: result.stopping });
  state.lastRun = {
    at: nowIso, mode, inputs: selection.stats, clusters: result.planned,
    calls: result.calls, written: result.written, writtenIds: result.writtenIds,
    stopping: result.stopping, model: opts.model,
  };
  state.lastDailyLine = dailyLine;
  state.history = [
    ...(state.history ?? []),
    {
      at: nowIso,
      written: result.written,
      calls: run.calls,
      tokens: Number(state.cost.promptTokens) + Number(state.cost.completionTokens),
      stopping: result.stopping,
    },
  ].slice(-DEFAULT_HISTORY_MAX);
  state.updatedAt = nowIso;
  state.stats = {
    ...state.stats,
    runs: Number(state.stats?.runs ?? 0) + 1,
    written: Number(state.stats?.written ?? 0) + result.written,
    calls: Number(state.stats?.calls ?? 0) + run.calls,
    stopped: Number(state.stats?.stopped ?? 0) + (result.stopping ? 1 : 0),
  };
  if (opts.stateFilePath) writeState(opts.stateFilePath, state);
  result.state = state;
  result.dailyLine = dailyLine;
  return result;
}

export { vacuumInto, dirtyStats };
