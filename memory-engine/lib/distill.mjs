// 记忆引擎 v2 · S3c —— 夜间提炼内核（方案 §3.5 唯一权威条款的逐条落地）
//
// 一句话：把窗口内**新增/变更**的记忆按**语义向量**聚成组，交给便宜档模型提炼成**长期结论**，
//         写成带 `distilled` 标记的新记忆（可批量回滚）。
//
// 逐条口径（都能在 `docs\P2-记忆引擎升级-方案-20260916.md` §3.5 找到出处）：
//   · 输入 = 窗口内（默认 24h）`updated_at` 变更的记忆 **且** `tags NOT LIKE 'distilled%'`（Z8 防"摘要的摘要"）
//     + **补充输入源** = `memories_dirty` 台账（治 A7：改 text 不动 `updated_at` 的 41 处外部写口）
//   · 聚类 = **语义向量**（复用 `memory-vectors.db`）；tags 只作分域辅助（Z19：tags 组合近乎唯一，不可用于聚类）
//   · 去重 = **内容级**：`srcKey` = 源**正文哈希**集合的哈希（**不是 id 集合** —— id 会因跨机合并整段换号，
//     见本文件 `srcKeyOf` 的注释）+ 产出正文哈希；**先查库再决定是否调 LLM**（不依赖 lastProcessedMaxId）
//   · 成本闸 = 模型 `deepseek-flash`（本鱼链；2026-09-21 主人拍板）· ≤20 次/日 · ≤150K token/日 ·
//     **超限即停 + 日报一行** · **不重试**
//   · 输出 = 新增记忆，`tags` 以 `distilled` 开头 + 源 id 清单 + 日期；写 `owner_user` / `visibility`（默认 private_owner）
//   · **D2 从严**（§3.5 后的订正注 / 服务面隐私包 §11.3）：只把 `owner_user == 本机 owner`、
//     且 `visibility != 'family'` 的条送模型；**判不出归属的一律跳过 + 记账**（宁可漏，不可错送）
//   · 回滚 = `tags LIKE 'distilled%'` 批量列出/删除（见 `lib/distill-rollback.mjs`）
//   · state = `~/.dsh/butler-distill-state.json`（原子写 + schemaVersion），每次调用记 时间/模型/输入条数/token/结果
//
// 红线：本内核**只读生产 `memory.db`**（`readOnly` 连接）；写入一律走显式 `apply` 分支，
//       且测试/开发期一律指副本库（调用方负责）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { textHash } from './hashes.mjs';
import { recordDirty, listDirty, markConsumed, dirtyStats, ensureDirtySchema } from './dirty-ledger.mjs';
import { readCredential, extractJson, vacuumInto } from './domain-tags.mjs';

// ── 常量 ────────────────────────────────────────────────────────────────────

export const STATE_SCHEMA = 1;

/** 成本闸（方案 §3.5 现值；**D8 已拍照现值，不许改档**）。 */
export const COST_LIMITS = Object.freeze({ callsPerDay: 20, tokensPerDay: 150000 });

/**
 * 提炼模型档（**2026-09-21 主人拍板：记忆线一律走本鱼链**；真源 = 方案 §3.5 订正注 2 + §13 D8 订正）。
 * ⚠️ 不许改回智谱等"本鱼以外"的第三方（D2 延长效：新增外发面须先拍）；
 *    也不用 `deepseek-v4-pro`（贵 4.4 倍，分类/提炼任务不需要强推理）。
 * 价目与成本实算见 `docs\API资产与定价.md` §十。
 */
export const DEFAULT_LLM = Object.freeze({
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  credentialKey: 'DEEPSEEK_API_KEY',
  maxTokens: 2048,
  // deepseek-flash 非思考模式下秒级返回；给足余量即可，超时即失败，**不重试**
  timeoutMs: 60000,
});

/** 标签前缀（`tags LIKE 'distilled%'` 是回滚/排除自我指涉的唯一判据）。 */
export const DISTILL_PREFIX = 'distilled';

export const DEFAULT_WINDOW_HOURS = 24;
export const DEFAULT_HISTORY_MAX = 20;
export const PROCESSED_MAX = 2000;

/** 聚类与输入裁剪参数（本卡默认值；逐项可注入 ⇒ 单测/调参不必改代码）。 */
export const CLUSTER_DEFAULTS = Object.freeze({
  simThreshold: 0.60,     // 余弦相似度阈值（贪心聚类）；bge-small-zh 同题实测多在 0.7+
  maxItemsPerCluster: 12, // 单组最多几条（防一次调用塞爆上下文）
  maxCharsPerItem: 400,   // 每条正文送给模型的截断长度
  minClusterChars: 120,   // 整组正文合计短于此 ⇒ 不调模型（没什么可提炼的）
  minClusterSize: 2,      // **单条组不提炼**（为什么见下方注释）
  maxClustersPerRun: 20,  // 单轮最多处理几组（与「≤20 次/日」同量级，双保险）
});

/**
 * 为什么 `minClusterSize` 默认 **2**（不是 1）：
 *   ① **语义**：本 job 的定义是"聚类 → 提炼"；**一条自成一组不算聚类**，把单条记忆回炉成一句
 *      "结论"只是改写，没有跨条综合的信息增量；
 *   ② **可证伪硬验收**（方案 §8.2 / D7 选③）：产物仍进主库 ⇒ 会被 `memory:recall` 段按
 *      `updated_at` 排进"最近 N 条"候选池，**每写一条就挤掉一条真实记忆的池位**。
 *      实测（2026-09-21 本卡验收）：生产窗口 60 条 → 不设限时产出 **17** 条（4 个大组 + 13 个单条组），
 *      在放大预算下该段"真实条数"从 18 掉到 16（预算 20000）、从 45 掉到 29（40000）；
 *      设 `minClusterSize: 2` 后只写 **4** 条（真正的组），挤占面按比例缩小。
 *   ③ 想要旧行为（单条也提炼）显式传 `--min-cluster-size 1` 即可 —— **不写死**。
 */

// ── 小工具 ──────────────────────────────────────────────────────────────────

function sha256(s) {
  return crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex');
}

export function shortKey(key, n = 24) {
  return String(key ?? '').slice(0, n);
}

/** 本地日期串（YYYYMMDD，按本机时区）。 */
export function localDay(ts = Date.now()) {
  const d = new Date(Number(ts));
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** 本机日期串（YYYY-MM-DD，与 `localDay` 同源，只多连字符）。 */
export function localDateIso(ts = Date.now()) {
  const s = localDay(ts);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
}

/**
 * **去重键 = 源正文哈希集合的哈希**（内容级）。
 *
 * ⚠️ 刻意**不用 id 集合**（哪怕方案 §3.5 :243 的字面写法是"源 id 集合哈希"）：
 *   跨机合并（`merge-memory.mjs` 的内容哈希主键口径）会把同一条内容灌**新的高位 id**，
 *   id 集合一变 ⇒ srcKey 变 ⇒ 会重新调一次 LLM 并写出**内容重复**的提炼条。
 *   本卡验收明写「跨机改 id 后重跑仍不重复」⇒ 取正文哈希才是能过验收的那一版。
 *   （源 id 清单仍写进 `tags` 供人追溯，只是**不参与**去重判定。）
 *
 * @param {Array<{id:number, text:string}>} rows
 * @returns {string} `d<16位十六进制>`
 */
export function srcKeyOf(rows) {
  const hashes = rows.map((r) => textHash(r.text)).sort();
  return `d${sha256(hashes.join('|')).slice(0, 16)}`;
}

export function distilledTagOf({ srcKey, srcIds, now }) {
  const ids = [...srcIds].map((x) => String(x)).sort().join(',');
  return `${DISTILL_PREFIX} src=${shortKey(srcKey)} srcids=${ids} date=${localDay(now)}`;
}

/** 从 tags 解析 `src=` 值（去重用）。 */
export function srcKeyInTags(tags) {
  const m = String(tags ?? '').match(/(?:^|\s)src=([0-9a-f]+)(?:\s|$)/);
  return m ? m[1] : null;
}

export function isDistilledTags(tags) {
  return String(tags ?? '').startsWith(DISTILL_PREFIX);
}

// ── 库：只读输入 ────────────────────────────────────────────────────────────

/** 打开记忆库（只读；与 `memory-source.mjs` 同口径：只读连接不阻塞写者）。 */
export function openMemoryDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/**
 * 挑输入（**只读**）。
 *
 * 三路并集（按 id 去重，先并后筛）：
 *   ① 增量窗口：`updated_at >= now - windowHours`
 *   ② `memories_dirty` 台账未消费项（治"改 text 不动 updated_at"）
 *   ③ 调用方显式给的 `extraIds`（单测/补跑用）
 * 再统一套：`tags NOT LIKE 'distilled%'`（不自我指涉）+ **D2 从严归属筛**。
 *
 * @returns {{accepted:Array, family:Array, unknownOwner:Array, distilledExcluded:number,
 *            windowRows:number, dirtyRows:number, ownerColumn:boolean, stats:object}}
 */
export function selectInputs({ dbPath, now = Date.now(), windowHours = DEFAULT_WINDOW_HOURS, dirtyIds = [], extraIds = [], localOwner = null, maxCharsPerItem = CLUSTER_DEFAULTS.maxCharsPerItem, limit = 0 }) {
  const db = openMemoryDb(dbPath);
  try {
    const cols = db.prepare('PRAGMA table_info(memories)').all().map((r) => r.name);
    const hasOwner = cols.includes('owner_user') && cols.includes('visibility');
    const sel = `SELECT id, text, tags, pinned, updated_at${hasOwner ? ', owner_user, visibility' : ''} FROM memories WHERE id = ?`;
    const byId = db.prepare(sel);
    const since = Number(now) - Number(windowHours) * 3_600_000;

    const windowRows = db
      .prepare(`SELECT id${hasOwner ? ', owner_user, visibility' : ''} FROM memories WHERE updated_at >= ? ORDER BY id`)
      .all(since);
    const windowIds = windowRows.map((r) => Number(r.id));
    const dirtyIdSet = [...new Set(dirtyIds.map((x) => Number(x)).filter((x) => Number.isFinite(x)))];
    const extraIdSet = [...new Set(extraIds.map((x) => Number(x)).filter((x) => Number.isFinite(x)))];

    const allIds = [...new Set([...windowIds, ...dirtyIdSet, ...extraIdSet])].sort((a, b) => a - b);
    const accepted = [];
    const family = [];
    const unknownOwner = [];
    let distilledExcluded = 0;
    for (const id of allIds) {
      const r = byId.get(id);
      if (!r) continue; // 台账里有、库里已删（跨机合并/回滚）⇒ 静默跳过
      const tags = String(r.tags ?? '');
      if (isDistilledTags(tags)) { distilledExcluded += 1; continue; }
      const ownerUser = hasOwner ? (r.owner_user ?? null) : null;
      const visibility = hasOwner ? (r.visibility ?? null) : null;
      // D2 从严（**逐条 fail-closed**）：库无归属列 / 家人可见 / 非本机 owner / 归属读不出
      //   ⇒ 一律不进第三方模型，且**逐条记账**（宁可漏，不可错送）
      if (!hasOwner) { unknownOwner.push({ id, ownerUser: null, why: '库无 owner_user 列，归属不可判定' }); continue; }
      if (visibility === 'family') { family.push({ id, ownerUser, visibility, why: 'visibility=family' }); continue; }
      if (!localOwner) { unknownOwner.push({ id, ownerUser, why: '本机 owner 未解析出来 ⇒ 不猜' }); continue; }
      if (ownerUser == null) { unknownOwner.push({ id, ownerUser, why: 'owner_user 为空' }); continue; }
      if (ownerUser !== localOwner) { unknownOwner.push({ id, ownerUser, why: 'owner_user != 本机 owner' }); continue; }
      const text = String(r.text ?? '');
      accepted.push({
        id, text, tags,
        pinned: Number(r.pinned ?? 0),
        updatedAt: Number(r.updated_at),
        textHash: textHash(text),
        ownerUser: ownerUser ?? localOwner,
        visibility: visibility ?? 'private_owner',
        textForModel: text.slice(0, maxCharsPerItem),
        textTruncated: text.length > maxCharsPerItem,
        source: dirtyIdSet.includes(id) ? 'dirty-ledger' : (extraIdSet.includes(id) && !windowIds.includes(id) ? 'extra' : 'window'),
      });
    }
    const trimmed = limit > 0 ? accepted.slice(0, Number(limit)) : accepted;
    return {
      accepted: trimmed,
      family,
      unknownOwner,
      distilledExcluded,
      windowRows: windowIds.length,
      dirtyRows: dirtyIdSet.length,
      ownerColumn: hasOwner,
      stats: {
        windowRows: windowIds.length, dirtyRows: dirtyIdSet.length, extraRows: extraIdSet.length,
        candidates: allIds.length, accepted: trimmed.length,
        skippedFamily: family.length, skippedUnknownOwner: unknownOwner.length, distilledExcluded,
      },
    };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * 全表 `text_hash` 比对（**只读记忆库**）：找出"正文与向量库记录不符"的条 = 被外部改过 text 的条。
 * 这是 §3.1 兜底轮转的同一判据，只是这里一次覆盖全表（626 条纯 sha256 计算 ≈ 毫秒级，不编码、不联网）。
 *
 * @param {{dbPath:string, vectorsDbPath:string, record?:boolean, now?:number, maxCharsPerItem?:number}} p
 * @returns {{items:Array<{id:number,text:string,tags:string,updatedAt:number}>, mismatched:number[], missing:number[], recorded:boolean}}
 */
export function detectDirty({ dbPath, vectorsDbPath, record = false, now = Date.now(), includeMissing = false }) {
  const mem = openMemoryDb(dbPath);
  const mismatched = [];
  const missing = [];
  const details = [];
  try {
    const rows = mem.prepare('SELECT id, text, tags, updated_at FROM memories ORDER BY id').all();
    let hashes = new Map();
    if (vectorsDbPath && fs.existsSync(vectorsDbPath)) {
      const vec = new DatabaseSync(vectorsDbPath, { readOnly: true });
      try {
        for (const r of vec.prepare("SELECT ref_id, text_hash FROM vectors WHERE source = 'memory'").all()) {
          hashes.set(String(r.ref_id), r.text_hash);
        }
      } finally {
        try { vec.close(); } catch { /* ignore */ }
      }
    }
    for (const r of rows) {
      if (isDistilledTags(r.tags)) continue;
      const prev = hashes.get(String(r.id));
      const h = textHash(r.text);
      if (prev === undefined) { missing.push(Number(r.id)); continue; }
      if (prev !== h) {
        mismatched.push(Number(r.id));
        details.push({ refId: Number(r.id), kind: 'mismatch', oldHash: prev, newHash: h });
      }
    }
    if (record && details.length) {
      const vec = new DatabaseSync(vectorsDbPath);
      try {
        vec.exec('PRAGMA busy_timeout = 5000;');
        recordDirty(vec, details, { now });
      } finally {
        try { vec.close(); } catch { /* ignore */ }
      }
    }
    return { items: rows.length, mismatched, missing: includeMissing ? missing : [], recorded: Boolean(record && details.length), details };
  } finally {
    try { mem.close(); } catch { /* ignore */ }
  }
}

/** 读 `memories_dirty` 台账里**未消费**的 id（向量库不存在 ⇒ 空）。 */
export function readDirtyIds(vectorsDbPath) {
  if (!vectorsDbPath || !fs.existsSync(vectorsDbPath)) return { ids: [], stats: { table: false, total: 0, open: 0, consumed: 0, lastAt: null } };
  const db = new DatabaseSync(vectorsDbPath, { readOnly: true });
  try {
    const rows = listDirty(db, { openOnly: true });
    return { ids: rows.map((r) => Number(r.refId)), rows, stats: dirtyStats(db) };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ── 聚类（语义向量；不复用 tags） ───────────────────────────────────────────

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function loadVectors(vectorsDbPath, ids) {
  const out = new Map();
  if (!vectorsDbPath || !fs.existsSync(vectorsDbPath) || !ids.length) return out;
  const db = new DatabaseSync(vectorsDbPath, { readOnly: true });
  try {
    const stmt = db.prepare("SELECT vec, dim FROM vectors WHERE source = 'memory' AND ref_id = ?");
    for (const id of ids) {
      const r = stmt.get(String(id));
      if (!r) continue;
      const buf = r.vec;
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      out.set(Number(id), new Float32Array(ab));
    }
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return out;
}

/** 向量平均（就地返回新数组）。 */
function centroidOf(vecs) {
  const dim = vecs[0].length;
  const c = new Float32Array(dim);
  for (const v of vecs) for (let i = 0; i < dim; i += 1) c[i] += v[i];
  for (let i = 0; i < dim; i += 1) c[i] /= vecs.length;
  return c;
}

/**
 * 贪心语义聚类（单遍；O(n·k)）。
 * · 有向量的条 → 归入"质心最相似且 ≥ 阈值"的既有组（组满则另起一组）；
 * · **没有向量的条**（刚写入还没编码）→ **自成一组**（不猜、不按 tags 兜底）。
 *
 * @returns {{clusters:Array<{key:string, members:Array, chars:number, centroid:Float32Array|null}>, stats:object}}
 */
export function clusterRows(rows, opts = {}) {
  const vectorsDbPath = opts.vectorsDbPath ?? null;
  const sim = Number(opts.simThreshold ?? CLUSTER_DEFAULTS.simThreshold);
  const maxItems = Number(opts.maxItemsPerCluster ?? CLUSTER_DEFAULTS.maxItemsPerCluster);
  const vecs = loadVectors(vectorsDbPath, rows.map((r) => r.id));
  const clusters = [];
  let noVector = 0;
  for (const row of rows) {
    const v = vecs.get(row.id) ?? null;
    if (!v) noVector += 1;
    let best = null;
    let bestSim = -1;
    if (v) {
      for (const c of clusters) {
        if (c.members.length >= maxItems) continue;
        if (!c.centroid) continue;
        const s = cosine(v, c.centroid);
        if (s > bestSim) { bestSim = s; best = c; }
      }
    }
    if (best && bestSim >= sim) {
      best.members.push(row);
      best.vecs.push(v);
      best.centroid = centroidOf(best.vecs);
      best.chars += row.textForModel.length;
    } else {
      clusters.push({ members: [row], vecs: v ? [v] : [], centroid: v, chars: row.textForModel.length, simToAssign: v ? null : 'no-vector' });
    }
  }
  for (const c of clusters) {
    c.key = srcKeyOf(c.members);
    c.ids = c.members.map((m) => m.id);
    delete c.vecs;
  }
  return {
    clusters,
    stats: {
      rows: rows.length, clusters: clusters.length, withVector: vecs.size, noVector,
      singletonClusters: clusters.filter((c) => c.members.length === 1).length,
      simThreshold: sim,
    },
  };
}

// ── LLM ────────────────────────────────────────────────────────────────────

export function buildSystemPrompt() {
  return [
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
  ].join('\n');
}

export function buildUserPrompt(clusters) {
  const blocks = clusters.map((c) => {
    const lines = c.members.map((m) => `[${m.id}] ${m.textForModel.replace(/\s+/g, ' ').trim()}`);
    return `【组 ${shortKey(c.key)}】\n${lines.join('\n')}`;
  });
  return `共 ${clusters.length} 组，请逐组提炼并按要求输出 JSON：\n\n${blocks.join('\n\n')}`;
}

/** 估算一次批量调用的 token（保守；调用前预判成本闸）。 */
export function estimateTokens(clusters) {
  const chars = clusters.reduce((n, c) => n + c.chars + 32, 0) + buildSystemPrompt().length + 200;
  return Math.ceil(chars / 1.4) + 400;
}

/** 调一次提炼模型（`fetchImpl` 可注入 ⇒ 单测不真发网络）。**单次尝试，不重试。** */
export async function callDistiller({ clusters, apiKey, baseUrl = DEFAULT_LLM.baseUrl, model = DEFAULT_LLM.model, fetchImpl = fetch, timeoutMs = DEFAULT_LLM.timeoutMs, maxTokens = DEFAULT_LLM.maxTokens, temperature = 0.2 }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(clusters) },
    ],
    // deepseek-flash 默认开思考（effort=high ⇒ 白烧 token，且 content 可能为空）⇒ 显式关思考
    // 官方口径见 api-docs.deepseek.com/guides/thinking_mode：`{"thinking":{"type":"disabled"}}`
    thinking: { type: 'disabled' },
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(timeoutMs));
  const t0 = Date.now();
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}`, ms };
    let json;
    try { json = JSON.parse(text); } catch (e) { return { ok: false, error: `响应不是 JSON：${e.message}`, raw: text.slice(0, 300), ms }; }
    const content = json?.choices?.[0]?.message?.content ?? '';
    const usage = json?.usage ?? {};
    const parsed = extractJson(content);
    if (!parsed) return { ok: false, error: '模型输出里找不到可解析的 JSON', raw: String(content).slice(0, 300), usage, ms };
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : null);
    if (!list) return { ok: false, error: 'JSON 结构不含 items 数组', raw: String(content).slice(0, 300), usage, ms };
    return { ok: true, items: list, usage, content, ms };
  } catch (e) {
    return { ok: false, error: `请求失败：${e && e.message ? e.message : e}`, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// ── 去重（先查库，再决定是否调 LLM） ────────────────────────────────────────

/** 库里已有的提炼条（`src=` 键集 + 正文哈希集）——**durable** 去重源（state 丢了也能挡）。 */
export function existingDistilled(dbPath) {
  const db = openMemoryDb(dbPath);
  try {
    const rows = db.prepare("SELECT id, text, tags FROM memories WHERE tags LIKE 'distilled%'").all();
    const keys = new Set();
    const textHashes = new Set();
    for (const r of rows) {
      const k = srcKeyInTags(r.tags);
      if (k) keys.add(k);
      textHashes.add(textHash(r.text));
    }
    return { count: rows.length, keys, textHashes, rows: rows.map((r) => ({ id: Number(r.id), tags: r.tags })) };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// ── state 与成本闸 ──────────────────────────────────────────────────────────

export function defaultState(dbPath, nowIso) {
  return {
    schemaVersion: STATE_SCHEMA,
    dbPath,
    updatedAt: nowIso,
    cost: { date: localDateIso(Date.parse(nowIso) || Date.now()), calls: 0, promptTokens: 0, completionTokens: 0 },
    processed: {},
    skipped: {},
    lastRun: null,
    lastDailyLine: null,
    history: [],
    stats: { runs: 0, written: 0, calls: 0, stopped: 0 },
  };
}

export function readState(stateFile, dbPath, nowIso) {
  try {
    if (!fs.existsSync(stateFile)) return defaultState(dbPath, nowIso);
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const base = defaultState(dbPath, nowIso);
    const merged = {
      ...base, ...raw,
      cost: { ...base.cost, ...(raw.cost ?? {}) },
      stats: { ...base.stats, ...(raw.stats ?? {}) },
      processed: raw.processed ?? {}, skipped: raw.skipped ?? {},
      history: Array.isArray(raw.history) ? raw.history : [],
    };
    // 跨日 ⇒ 当日成本归零（成本闸是"每日"口径）
    if (merged.cost.date !== localDateIso(Date.parse(nowIso) || Date.now())) {
      merged.cost = { date: localDateIso(Date.parse(nowIso) || Date.now()), calls: 0, promptTokens: 0, completionTokens: 0 };
    }
    return merged;
  } catch {
    return defaultState(dbPath, nowIso);
  }
}

export function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(pruneState(state), null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, stateFile);
  } catch {
    fs.copyFileSync(tmp, stateFile);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  return stateFile;
}

/** 台账裁剪：`processed` 只留最近 PROCESSED_MAX 条（**去重的权威源是库里的 `src=` 标签**，state 只是快查缓存）。 */
export function pruneState(state) {
  const entries = Object.entries(state.processed ?? {});
  if (entries.length <= PROCESSED_MAX) return state;
  entries.sort((a, b) => String(a[1]?.at ?? '').localeCompare(String(b[1]?.at ?? '')));
  const keep = Object.fromEntries(entries.slice(entries.length - PROCESSED_MAX));
  return { ...state, processed: keep };
}

/** 成本闸判定：还能不能再调一次（§3.5：≤20 次/日、≤150K token/日，**超限即停不重试**）。 */
export function costGate(state, estimatedTokens, limits = COST_LIMITS) {
  const used = Number(state.cost.promptTokens ?? 0) + Number(state.cost.completionTokens ?? 0);
  const calls = Number(state.cost.calls ?? 0);
  if (calls >= limits.callsPerDay) return { ok: false, reason: `当日调用数已达上限 ${limits.callsPerDay} 次` };
  if (used >= limits.tokensPerDay) return { ok: false, reason: `当日 token 已达上限 ${limits.tokensPerDay}` };
  if (used + estimatedTokens > limits.tokensPerDay) {
    return { ok: false, reason: `本组估算 ${estimatedTokens} token 会超过当日上限（已用 ${used}/${limits.tokensPerDay}）` };
  }
  return { ok: true };
}

// ── 写入 ────────────────────────────────────────────────────────────────────

/** 带重试的写事务（口径与 domain-tags 的 `withBusyRetry` 同源）。 */
export async function withBusyRetry(db, fn, deps = {}) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const backoff = [1000, 4000, 16000];
  const cap = 60000;
  let waited = 0;
  const started = Date.now();
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = fn();
        db.exec('COMMIT');
        return { ok: true, value, attempts: attempt, waitedMs: waited };
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      }
    } catch (e) {
      lastErr = e;
      const busy = /busy|locked/i.test(String(e?.message ?? e));
      if (!busy || attempt === 3) break;
      const wait = backoff[attempt - 1];
      if (waited + wait > cap || Date.now() - started + wait > cap) break;
      await sleep(wait);
      waited += wait;
    }
  }
  return { ok: false, attempts: 3, error: String(lastErr?.message ?? lastErr), waitedMs: waited };
}

/**
 * 写入提炼条（**幂等**：库里已有同 `src=` 键 ⇒ 跳过）。
 * @returns {{written:number, skippedExisting:number, ids:number[], details:Array}}
 */
export async function applyDistilled(dbPath, results, opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const ownerUser = opts.ownerUser ?? null;
  const visibility = opts.visibility ?? 'private_owner';
  const deps = opts.deps ?? {};
  const db = new DatabaseSync(dbPath);
  let out = { written: 0, skippedExisting: 0, ids: [], details: [] };
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    const cols = db.prepare('PRAGMA table_info(memories)').all().map((r) => r.name);
    const hasOwner = cols.includes('owner_user') && cols.includes('visibility');
    const existing = new Set(
      db.prepare("SELECT tags FROM memories WHERE tags LIKE 'distilled%'").all()
        .map((r) => srcKeyInTags(r.tags)).filter(Boolean),
    );
    const details = [];
    let written = 0;
    let skippedExisting = 0;
    const ids = [];
    const r = await withBusyRetry(db, () => {
      const ins = hasOwner
        ? db.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at, owner_user, visibility) VALUES (?, ?, 0, ?, ?, ?, ?)')
        : db.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, 0, ?, ?)');
      for (const it of results) {
        const key = shortKey(it.srcKey);
        if (existing.has(key)) { skippedExisting += 1; details.push({ srcKey: key, action: 'already-in-db' }); continue; }
        const tags = distilledTagOf({ srcKey: key, srcIds: it.srcIds ?? [], now });
        const info = hasOwner
          ? ins.run(it.conclusion, tags, now, now, it.ownerUser ?? ownerUser, it.visibility ?? visibility)
          : ins.run(it.conclusion, tags, now, now);
        const newId = Number(info.lastInsertRowid ?? 0);
        ids.push(newId);
        written += 1;
        details.push({ srcKey: key, action: 'written', id: newId, tags, chars: String(it.conclusion).length });
      }
      return { written, skippedExisting };
    }, deps);
    out = { ...out, written: r.value?.written ?? 0, skippedExisting: r.value?.skippedExisting ?? 0, ids, details, ok: r.ok, error: r.error ?? null };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return out;
}

// ── 日报行 ──────────────────────────────────────────────────────────────────

export const DAILY_SECTION_TITLE = '## 🧪 记忆提炼（memory-distill）';

/** 「条数 + 首行样本 + 当日调用数与 token」（方案 §3.5 可观测行）。 */
export function renderDailyLine({ mode, run, cost, limits = COST_LIMITS, stopping = null }) {
  const used = Number(cost.promptTokens ?? 0) + Number(cost.completionTokens ?? 0);
  const parts = [
    `模式 ${mode}`,
    `输入 ${run?.inputs ?? 0} 条/${run?.clustersPlanned ?? 0} 组`,
    `提炼条数 ${run?.written ?? 0}`,
    `跳过(去重) ${run?.skippedDuplicate ?? 0}`,
    `跳过(非本机owner/家人) ${(run?.skippedOwner ?? 0) + (run?.skippedFamily ?? 0)}`,
    `当日调用 ${cost.calls ?? 0}/${limits.callsPerDay}`,
    `当日 token ${used}/${limits.tokensPerDay}`,
    `首行样本：${run?.firstSample ? `「${String(run.firstSample).slice(0, 60)}」` : '（无）'}`,
  ];
  // 单轮组数上限（`--max-clusters`）是**截断**不是"停机"：必须写清本轮到哪、还剩多少
  if (run?.capped?.capped) parts.push(`本轮处理 ${run.capped.processed}/${run.capped.plannedCalls} 组（单轮上限 ${run.capped.cap}）`);
  if (stopping) parts.push(`停机原因：${stopping}`);
  return parts.join(' · ');
}

/** 把日报行做「段级替换」（口径同 domain-tags；日报不存在则不新建）。 */
export function updateDailySection({ file, line, dryRun = false }) {
  if (!fs.existsSync(file)) return { ok: false, reason: '日报不存在（不新建）', file };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const idx = lines.findIndex((l) => l.trim() === DAILY_SECTION_TITLE);
  const block = [DAILY_SECTION_TITLE, '', `> ${line}`, ''];
  let next;
  if (idx >= 0) {
    let end = idx + 1;
    while (end < lines.length && !(lines[end].startsWith('## ') && end > idx + 1)) end += 1;
    next = [...lines.slice(0, idx), ...block, ...lines.slice(end)];
  } else {
    next = [...lines, ...block];
  }
  if (!dryRun) fs.writeFileSync(file, next.join('\n'), 'utf8');
  return { ok: true, replaced: idx >= 0, file };
}

export function dailyReportPath({ docsDir = path.join(process.cwd(), 'docs'), host = null, now = Date.now() } = {}) {
  const name = host || process.env.COMPUTERNAME || 'unknown-host';
  return path.join(docsDir, '管家报告', `${localDateIso(now)}-${name}.md`);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

/**
 * 一轮提炼（dry-run 时不写任何东西：不调 LLM、不写库、不写 state、不写台账）。
 *
 * @param {object} p
 * @param {string} p.memoryDb     记忆库路径（**测试一律副本**）
 * @param {string} p.vectorsDb    向量库路径（聚类 + 台账）
 * @param {string} p.stateFile    `butler-distill-state.json`
 * @param {boolean} p.apply       false = dry-run（默认）
 */
export async function runDistill(p = {}) {
  const {
    memoryDb, vectorsDb, stateFile,
    now = Date.now(), windowHours = DEFAULT_WINDOW_HOURS, apply = false,
    limits = COST_LIMITS, model = DEFAULT_LLM.model, baseUrl = DEFAULT_LLM.baseUrl,
    apiKey = null, fetchImpl = fetch, timeoutMs = DEFAULT_LLM.timeoutMs,
    localOwner = null, limit = 0, extraIds = [], dirtyProbe = true,
    simThreshold = CLUSTER_DEFAULTS.simThreshold,
    maxItemsPerCluster = CLUSTER_DEFAULTS.maxItemsPerCluster,
    maxCharsPerItem = CLUSTER_DEFAULTS.maxCharsPerItem,
    minClusterChars = CLUSTER_DEFAULTS.minClusterChars,
    minClusterSize = CLUSTER_DEFAULTS.minClusterSize,
    maxClustersPerRun = CLUSTER_DEFAULTS.maxClustersPerRun,
    snapshotFile = null, log = () => {}, deps = {},
  } = p;

  const mode = apply ? 'apply' : 'dry-run';
  const nowIso = new Date(Number(now)).toISOString();
  const result = {
    ok: true, mode, at: nowIso, memoryDb, vectorsDb, stateFile, model, baseUrl,
    windowHours, limits, localOwner,
    inputs: null, clusters: [], planned: [], calls: [], written: 0, writtenIds: [],
    cost: null, stopping: null, dailyLine: null, warnings: [], dirty: null, snapshot: null,
    state: null, exitCode: 0,
  };

  if (!memoryDb || !fs.existsSync(memoryDb)) {
    result.ok = false;
    result.exitCode = 3;
    result.stopping = `记忆库不存在：${memoryDb}`;
    return result;
  }

  // ① 台账（补 A7 盲区）：dry-run 只算不写
  let dirtyIds = [];
  if (dirtyProbe) {
    const d = detectDirty({ dbPath: memoryDb, vectorsDbPath: vectorsDb, record: apply, now });
    const led = readDirtyIds(vectorsDb);
    dirtyIds = [...new Set([...led.ids, ...d.mismatched])];
    result.dirty = { mismatched: d.mismatched.length, missingVectors: d.missing.length, ledgerOpen: led.stats.open, ledgerTable: led.stats.table };
    if (d.mismatched.length) log(`[distill] 全表 hash 比对：${d.mismatched.length} 条正文与向量库不符（台账补充输入）`);
  }

  // ② 挑输入（含 D2 从严筛）
  const sel = selectInputs({
    dbPath: memoryDb, now, windowHours, dirtyIds, extraIds, localOwner,
    maxCharsPerItem, limit,
  });
  result.inputs = sel.stats;
  result.dirtyInputIds = dirtyIds;
  if (sel.family.length) result.warnings.push(`D2：${sel.family.length} 条 visibility=family 已排除（不进第三方）`);
  if (sel.unknownOwner.length) result.warnings.push(`D2：${sel.unknownOwner.length} 条归属不可判定已排除（不进第三方）`);
  if (!sel.ownerColumn) result.warnings.push('库无 owner_user 列 ⇒ 归属不可判定，本轮 0 调用（红线：不猜）');
  log(`[distill] 输入：窗口 ${sel.stats.windowRows} + 台账 ${sel.stats.dirtyRows} ⇒ 候选 ${sel.stats.candidates}，`
    + `接受 ${sel.stats.accepted}（排除 family ${sel.stats.skippedFamily} / 非本机 owner ${sel.stats.skippedUnknownOwner} / distilled ${sel.stats.distilledExcluded}）`);

  // ③ 聚类 + 去重规划
  const cl = clusterRows(sel.accepted, { vectorsDbPath: vectorsDb, simThreshold, maxItemsPerCluster });
  result.clusterStats = cl.stats;
  const existing = existingDistilled(memoryDb);
  const state = readState(stateFile ?? path.join(path.dirname(memoryDb), '..', 'butler-distill-state.json'), memoryDb, nowIso);
  const today = localDateIso(now);
  const planned = [];
  for (const c of cl.clusters.sort((a, b) => b.members.length - a.members.length || a.ids[0] - b.ids[0])) {
    const key = shortKey(c.key);
    if (c.members.length < Number(minClusterSize)) {
      planned.push({ key, ids: c.ids, action: 'skip-singleton', chars: c.chars, reason: `组内 ${c.members.length} 条 < minClusterSize ${minClusterSize}` });
      continue;
    }
    if (c.chars < minClusterChars) { planned.push({ key, ids: c.ids, action: 'skip-too-short', chars: c.chars }); continue; }
    if (state.processed[key]) { planned.push({ key, ids: c.ids, action: 'skip-processed', at: state.processed[key].at }); continue; }
    if (existing.keys.has(key)) { planned.push({ key, ids: c.ids, action: 'skip-in-db' }); continue; }
    // 同日已尝试过且失败/无结论 ⇒ **同一天不再试**（"不重试"要跨轮也成立；换日才给第二次机会）。
    //   实测依据：上游限流（智谱档时期曾实测 429「当前访问量过大」）⇒ 若同日重跑会对同一组再烧一次额度。
    const sk = state.skipped[key];
    if (sk && (sk.day ?? String(sk.at ?? '').slice(0, 10)) === today) {
      planned.push({ key, ids: c.ids, action: 'skip-failed-today', reason: sk.reason });
      continue;
    }
    planned.push({ key, ids: c.ids, action: 'call', chars: c.chars, members: c.members });
  }
  result.planned = planned.map((x) => ({ key: x.key, ids: x.ids, action: x.action, chars: x.chars, reason: x.reason ?? null }));
  const plannedCalls = planned.filter((x) => x.action === 'call');
  const todo = plannedCalls.slice(0, Math.max(0, Number(maxClustersPerRun)));
  result.capped = {
    plannedCalls: plannedCalls.length, processed: todo.length,
    capped: plannedCalls.length > todo.length,
    cap: Number(maxClustersPerRun),
  };
  result.clusters = todo.length;

  if (!apply) {
    result.cost = { ...state.cost };
    result.run = {
      inputs: sel.stats.accepted, clustersPlanned: plannedCalls.length,
      written: 0, skippedDuplicate: planned.filter((x) => x.action !== 'call').length,
      skippedOwner: sel.stats.skippedUnknownOwner, skippedFamily: sel.stats.skippedFamily, firstSample: null,
      capped: result.capped,
    };
    result.dailyLine = renderDailyLine({ mode, run: result.run, cost: state.cost, limits, stopping: 'dry-run 不调用模型' });
    log('[distill] dry-run：不调模型、不写库、不写 state');
    return result;
  }

  // ④ 逐组调用（成本闸逐次判；超限即停、不重试）
  let apiKeyResolved = apiKey;
  if (!apiKeyResolved) {
    const key = readCredential(DEFAULT_LLM.credentialKey);
    if (!key) {
      result.ok = false;
      result.exitCode = 1;
      result.stopping = `读不到凭证 ${DEFAULT_LLM.credentialKey}（.credentials.yaml）`;
      return result;
    }
    apiKeyResolved = key;
  }
  const callKey = apiKeyResolved;

  // 写库前快照（调用方给了才做；`VACUUM INTO` 只读源库）
  if (snapshotFile) {
    try {
      vacuumInto(memoryDb, snapshotFile);
      result.snapshot = snapshotFile;
      log(`[distill] 写前快照：${snapshotFile}`);
    } catch (e) {
      result.warnings.push(`快照失败（不阻断写库）：${e?.message ?? e}`);
    }
  }

  const run = {
    inputs: sel.stats.accepted, clustersPlanned: plannedCalls.length,
    written: 0, skippedDuplicate: planned.filter((x) => x.action !== 'call').length,
    skippedOwner: sel.stats.skippedUnknownOwner, skippedFamily: sel.stats.skippedFamily,
    calls: 0, promptTokens: 0, completionTokens: 0, firstSample: null, modelFailures: 0,
    capped: result.capped,
  };
  for (const job of todo) {
    const est = estimateTokens([{ chars: job.chars }]);
    const gate = costGate(state, est, limits);
    if (!gate.ok) { result.stopping = gate.reason; log(`[distill] 成本闸停：${gate.reason}`); break; }
    const r = await callDistiller({ clusters: [job], apiKey: callKey, baseUrl, model, fetchImpl, timeoutMs, maxTokens: DEFAULT_LLM.maxTokens });
    state.cost.calls = Number(state.cost.calls ?? 0) + 1; // 调用即记账（失败也记：额度真花了）
    run.calls += 1;
    const usage = r.usage ?? {};
    state.cost.promptTokens = Number(state.cost.promptTokens ?? 0) + Number(usage.prompt_tokens ?? 0);
    state.cost.completionTokens = Number(state.cost.completionTokens ?? 0) + Number(usage.completion_tokens ?? 0);
    const item = (r.items ?? []).find((x) => shortKey(x?.key) === job.key) ?? (r.items ?? [])[0];
    const conclusion = String(item?.conclusion ?? '').trim();
    result.calls.push({
      key: job.key, ids: job.ids, ok: r.ok, ms: r.ms ?? null,
      tokens: Number(usage.prompt_tokens ?? 0) + Number(usage.completion_tokens ?? 0),
      conclusionChars: conclusion.length, error: r.ok ? null : r.error,
    });
    if (!r.ok) {
      run.modelFailures += 1;
      state.skipped[job.key] = { at: nowIso, day: today, reason: `model-error: ${String(r.error).slice(0, 160)}` };
      continue; // ❗ 不重试（方案 §3.5 成本闸）；同日重跑也不再试（见 plan 的 skip-failed-today）
    }
    if (!conclusion) {
      state.skipped[job.key] = { at: nowIso, day: today, reason: '模型判定无可提炼的长期结论' };
      continue;
    }
    const w = await applyDistilled(memoryDb, [{ srcKey: job.key, srcIds: job.ids, conclusion, ownerUser: job.members[0]?.ownerUser, visibility: 'private_owner' }], { now, ownerUser: localOwner, deps });
    result.written += w.written;
    if (w.written) {
      result.writtenIds.push(...w.ids);
      run.written += w.written;
      if (!run.firstSample) run.firstSample = conclusion;
      state.processed[job.key] = { at: nowIso, ids: job.ids, outHash: textHash(conclusion), written: w.written, rowIds: w.ids };
    } else {
      result.warnings.push(`写库被跳过（库里已有同源键）：${job.key}`);
      state.processed[job.key] = { at: nowIso, ids: job.ids, outHash: textHash(conclusion), written: 0 };
    }
  }

  // ⑤ 台账标记已消费（**只标真正并进输入的那些**：被 D2 排除的条保持 open，留着可见、不静默吞掉）
  const acceptedIds = new Set(sel.accepted.map((a) => a.id));
  const consumedIds = dirtyIds.filter((id) => acceptedIds.has(Number(id)));
  if (consumedIds.length) {
    try {
      const vec = new DatabaseSync(vectorsDb);
      try { ensureDirtySchema(vec); markConsumed(vec, consumedIds, { now }); } finally { try { vec.close(); } catch { /* ignore */ } }
    } catch (e) {
      result.warnings.push(`台账标记失败（不阻断）：${e?.message ?? e}`);
    }
  }
  result.dirtyConsumed = consumedIds;

  // ⑥ state 落盘（原子写）
  result.cost = { ...state.cost };
  result.run = run;
  result.stopping = result.stopping ?? null;
  const dailyLine = renderDailyLine({ mode, run, cost: state.cost, limits, stopping: result.stopping });
  state.lastRun = { at: nowIso, mode, inputs: sel.stats, clusters: result.planned, calls: result.calls, written: result.written, writtenIds: result.writtenIds, stopping: result.stopping, model };
  state.lastDailyLine = dailyLine;
  state.history = [...(state.history ?? []), { at: nowIso, written: result.written, calls: run.calls, tokens: Number(state.cost.promptTokens) + Number(state.cost.completionTokens), stopping: result.stopping }].slice(-DEFAULT_HISTORY_MAX);
  state.updatedAt = nowIso;
  state.stats = {
    ...state.stats,
    runs: Number(state.stats?.runs ?? 0) + 1,
    written: Number(state.stats?.written ?? 0) + result.written,
    calls: Number(state.stats?.calls ?? 0) + run.calls,
    stopped: Number(state.stats?.stopped ?? 0) + (result.stopping ? 1 : 0),
  };
  if (stateFile) writeState(stateFile, state);
  result.state = state;
  result.dailyLine = dailyLine;
  return result;
}

export { vacuumInto, dirtyStats };
