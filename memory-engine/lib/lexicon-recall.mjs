// 词表第二路召回：把「字面撞没撞上」这一路补回来。
//
// 为什么需要它：纯向量召回对**精确词**（专有名词、命令名、错别字极少的术语）不敏感，
// 一句话里那个唯一的线索词常常被语义相近的段落挤掉。SQLite 的 FTS5 在本仓只认英文/数字
// （unicode61 不切中文），中文提问那一路等于不存在 ⇒ 这里自带一份词典做最长匹配切词。
//
// 打分用 BM25（tf 饱和 + 文档长度归一 + 语料内 idf），再乘一个「通用词常见度」折扣：
// 越常见的中文词越不像检索线索（词频表来自 jieba，值越大越具体），低于门限的词直接不参与。
//
// 三条硬边界：
//   ① 对数据源**只读**：只调 `allTexts()` / `allTags()` / `count()` / `maxUpdatedAt()`，
//      不自己开库、不建表、不写。
//   ② **不会拖慢主路**：索引进程内缓存 + 后台预热；首次调用拿不到就先只走向量路，
//      预热完下一轮自然带上（`allowBuild: true` 时当场建，给命令行与夹具用）。
//   ③ **缺素材不算错**：词典/词频/开关文件缺失或坏掉 ⇒ 这一路返回空，绝不抛错。
//
// 许可：`dict/词典.txt` 与 `dict/词频.txt` 来自 jieba 的 extra_dict/dict.txt.small（MIT），
// 来源与署名见 `dict/LICENSE-词典.md`（随包分发必须保留）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 素材目录的出厂位置：`memory-engine/dict/`（与 lib 同级，随包发布）。 */
const DEFAULT_ASSET_DIR = path.join(LIB_DIR, '..', 'dict');

export const ASSET_FILES = Object.freeze({
  words: '词典.txt',
  freq: '词频.txt',
  switch: 'lexicon-config.json',
});

/**
 * 当前素材目录：环境变量 `MEMORY_ENGINE_DICT_DIR` 可覆盖（打包方换位置、夹具演"词典缺失"都用它）。
 * 每次现读环境变量 —— 不许在模块加载时定死。
 */
export function assetDir() {
  const fromEnv = process.env.MEMORY_ENGINE_DICT_DIR;
  return fromEnv ? path.resolve(String(fromEnv)) : DEFAULT_ASSET_DIR;
}

/** 出厂的默认值；开关文件缺失/坏掉时用这一套（口径：词表默认**关**，见 README「设计依据」）。 */
export const LEXICON_DEFAULTS = Object.freeze({
  enabled: false,
  topK: 20,
  floor: 0.3,
  ttlMs: 600000,
  k1: 1.2,
  b: 0.75,
});

/** 切词窗口上限：词典里最长的词条是 15 个字，留一格余量。 */
const WINDOW_LIMIT = 16;
const ENV_SWITCH = 'MEMORY_ENGINE_LEXICON';
const ENV_TOPK = 'MEMORY_ENGINE_LEXICON_TOPK';
const ENV_FLOOR = 'MEMORY_ENGINE_LEXICON_FLOOR';

/** 多字虚词/口头语：切出来也不当线索（单字一律不当线索，见 tokenizeLexiconQuery）。 */
const STOP_TERMS = new Set([
  '什么', '怎么', '怎么样', '为什么', '哪里', '哪儿', '现在', '目前', '当前', '刚才', '然后',
  '记得', '记住', '告诉', '请问', '一下', '来着', '我们', '你们', '他们', '她们', '这个',
  '那个', '哪些', '是否', '有没有', '是不是', '可以', '还是', '其实', '因为', '所以', '如果',
]);

/* ─────────────────────────────── 素材读取 ─────────────────────────────── */

// 素材读不到就回空串：调用方只需要知道「有没有」，不需要异常。
function readAsset(dir, name) {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return '';
  }
}

let TABLE = null;

/**
 * 词典 + 词频（同一目录只读一次，约 1.2 MB 常驻）。
 * 缺文件不抛错：`available: false` ⇒ 这一路整体空手（正确退化到纯向量）。
 * @param {{dir?:string, fresh?:boolean}} [options]
 * @returns {{dir:string, words:Set<string>, freq:Map<string,number>, longest:number, available:boolean, loadedAt:number}}
 */
export function loadWordTable(options = {}) {
  const dir = options.dir ? path.resolve(String(options.dir)) : assetDir();
  if (TABLE && TABLE.dir === dir && !options.fresh) return TABLE;
  const words = new Set();
  let longest = 2;
  for (const line of readAsset(dir, ASSET_FILES.words).split(/\r?\n/)) {
    const word = line.trim();
    if (!word) continue;
    words.add(word);
    if (word.length > longest) longest = word.length;
  }
  if (longest > WINDOW_LIMIT) longest = WINDOW_LIMIT;

  const freq = new Map();
  for (const line of readAsset(dir, ASSET_FILES.freq).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const value = Number(parts[1]);
    if (parts[0] && Number.isFinite(value)) freq.set(parts[0], value);
  }

  TABLE = { dir, words, freq, longest, available: words.size > 0, loadedAt: Date.now() };
  return TABLE;
}

/** 素材清单（诊断用；也给「词典在不在」这类判据一个现成的出处）。 */
export function lexiconAssets() {
  const dir = assetDir();
  const bytes = {};
  for (const [key, name] of Object.entries(ASSET_FILES)) {
    try {
      bytes[key] = fs.statSync(path.join(dir, name)).size;
    } catch {
      bytes[key] = null;
    }
  }
  return { dir, files: { ...ASSET_FILES }, bytes };
}

/* ─────────────────────────────── 开关 ─────────────────────────────────── */

let SWITCH_CACHE = null;

const asBool = (value, fallback) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['1', 'on', 'true', 'yes', 'enable', 'enabled'].includes(text)) return true;
    if (['0', 'off', 'false', 'no', 'disable', 'disabled'].includes(text)) return false;
  }
  return fallback;
};

const asNumber = (value, fallback, lo, hi) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < lo) return lo;
  if (parsed > hi) return hi;
  return parsed;
};

/**
 * 解析开关：显式入参 > 环境变量 > `dict/lexicon-config.json` > 默认值。
 * 配置文件按 mtime + 字节数缓存 ⇒ 改文件立刻生效，不必重启；代码改了仍要重启（模块在 boot 读）。
 * @param {{enabled?:boolean|null, topK?:number|null, floor?:number|null, k1?:number|null, b?:number|null,
 *          file?:string, env?:object, fresh?:boolean}} [overrides]
 */
export function resolveLexiconSwitch(overrides = {}) {
  const env = overrides.env || process.env;
  const file = overrides.file || path.join(assetDir(), ASSET_FILES.switch);
  let fromFile = null;
  try {
    const stat = fs.statSync(file);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    if (overrides.fresh || !SWITCH_CACHE || SWITCH_CACHE.stamp !== stamp || SWITCH_CACHE.file !== file) {
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        parsed = null;
      }
      SWITCH_CACHE = { file, stamp, value: parsed && typeof parsed === 'object' ? parsed : null };
    }
    fromFile = SWITCH_CACHE.value;
  } catch {
    fromFile = null;
  }

  const pick = (explicit, envName, field, fallback) => {
    if (explicit !== undefined && explicit !== null) return explicit;
    if (envName && env && env[envName] !== undefined && env[envName] !== '') return env[envName];
    if (fromFile && fromFile[field] !== undefined && fromFile[field] !== null) return fromFile[field];
    return fallback;
  };

  const sourceTag = (() => {
    if (overrides.enabled !== undefined && overrides.enabled !== null) return 'argument';
    if (env && env[ENV_SWITCH] !== undefined && env[ENV_SWITCH] !== '') return 'env';
    return fromFile ? 'file' : 'default';
  })();

  return {
    enabled: asBool(pick(overrides.enabled, ENV_SWITCH, 'enabled', LEXICON_DEFAULTS.enabled), LEXICON_DEFAULTS.enabled),
    topK: Math.trunc(asNumber(pick(overrides.topK, ENV_TOPK, 'topK', LEXICON_DEFAULTS.topK), LEXICON_DEFAULTS.topK, 1, 500)),
    floor: asNumber(pick(overrides.floor, ENV_FLOOR, 'floor', LEXICON_DEFAULTS.floor), LEXICON_DEFAULTS.floor, 0, 1),
    ttlMs: asNumber(pick(overrides.ttlMs, null, 'ttlMs', LEXICON_DEFAULTS.ttlMs), LEXICON_DEFAULTS.ttlMs, 0, 86400000),
    k1: asNumber(pick(overrides.k1, null, 'k1', LEXICON_DEFAULTS.k1), LEXICON_DEFAULTS.k1, 0.01, 10),
    b: asNumber(pick(overrides.b, null, 'b', LEXICON_DEFAULTS.b), LEXICON_DEFAULTS.b, 0, 1),
    source: sourceTag,
    file,
  };
}

/* ─────────────────────────────── 切词 ─────────────────────────────────── */

/** 「这个词在通用中文里有多具体」：0 = 最常见（不当线索）/ 1 = 很具体（查不到也算 1）。 */
function specificityOf(term, table) {
  const raw = table.freq.get(term);
  if (raw === undefined) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(1, Math.max(0, parsed / 99));
}

/** 连成一串的汉字按词典做最长匹配；切不出词就退化成单字（后面还要过停用字表）。 */
function segmentHanRun(run, table) {
  const pieces = [];
  let at = 0;
  while (at < run.length) {
    const cap = Math.min(table.longest, run.length - at);
    let width = 0;
    for (let size = cap; size >= 2; size -= 1) {
      if (table.words.has(run.slice(at, at + size))) {
        width = size;
        break;
      }
    }
    if (width === 0) {
      pieces.push(run.slice(at, at + 1));
      at += 1;
      continue;
    }
    pieces.push(run.slice(at, at + width));
    at += width;
  }
  return pieces;
}

/**
 * 切词：英文/数字串（≥2 字符）+ 汉字按词典最长匹配。
 * 单字与虚词一律丢掉 —— 单字几乎不是检索线索，留着只会把噪声拉进融合。
 * 命中集去重（BM25 不重复计同一个词）。
 * @param {string} text
 * @param {object} [table] 事先取好的词表（省一次表查找）
 * @returns {string[]}
 */
export function tokenizeLexiconQuery(text, table = loadWordTable()) {
  const out = new Set();
  const body = String(text ?? '').toLowerCase();
  for (const match of body.matchAll(/[a-z0-9][a-z0-9_.+-]*/g)) {
    if (match[0].length >= 2) out.add(match[0]);
  }
  for (const run of body.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) || []) {
    for (const piece of segmentHanRun(run, table)) {
      if (piece.length < 2) continue;
      if (STOP_TERMS.has(piece)) continue;
      out.add(piece);
    }
  }
  return [...out];
}

/* ─────────────────────────────── 索引 ─────────────────────────────────── */

/**
 * 建词表索引：读全量正文与标签 → 切词 → 倒排（词 → [文档序号, tf, ...]）+ 文档长度。
 * **一次性几百毫秒，别放在每轮对话的热路径上**（用 getLexiconIndex 的缓存/预热）。
 * @param {object} source 数据源（memory / pitfall / policy 任一）
 * @param {{dir?:string}} [options] 词典目录（缺省 = assetDir()）
 * @returns {object|null}
 */
export function buildLexiconIndex(source, options = {}) {
  const started = Date.now();
  const table = loadWordTable({ dir: options.dir });
  if (!table.available) return null;
  if (!source || typeof source.allTexts !== 'function') return null;

  const tagsById = new Map();
  try {
    if (typeof source.allTags === 'function') {
      for (const row of source.allTags()) tagsById.set(Number(row.id), row.tags);
    }
  } catch {
    tagsById.clear();
  }

  const ids = [];
  const lens = [];
  const df = new Map();
  const postings = new Map();
  let maxId = 0;
  let totalLen = 0;

  for (const row of source.allTexts()) {
    const id = Number(row.id);
    const tagText = String(tagsById.get(id) ?? '').replace(/[,，]/g, ' ');
    const tokens = tokenizeLexiconQuery(`${row.text ?? ''} ${tagText}`, table);
    const doc = ids.length;
    ids.push(id);
    if (id > maxId) maxId = id;

    let length = 0;
    const seen = new Map();
    for (const token of tokens) {
      seen.set(token, (seen.get(token) || 0) + 1);
      length += 1;
    }
    lens.push(length);
    totalLen += length;

    for (const [term, count] of seen) {
      const row2 = postings.get(term);
      if (row2) row2.push(doc, count);
      else postings.set(term, [doc, count]);
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  const docCount = ids.length;
  return {
    ids,
    lens: Uint32Array.from(lens),
    avgLen: docCount ? totalLen / docCount : 0,
    df,
    postings,
    docCount,
    maxId,
    dictDir: table.dir,
    sourceName: source.sourceName || null,
    available: true,
    builtAt: Date.now(),
    buildMs: Date.now() - started,
  };
}

/**
 * BM25 打分：score(d) = Σ_t w(t) · tf·(k1+1) / (tf + k1·(1-b+b·|d|/avgdl))，
 * 其中 w(t) = idf(t) · 通用具体度(t)，且只保留具体度 ≥ floor 的词。
 * @param {string} query
 * @param {object} index buildLexiconIndex 的产物
 * @param {{topK?:number, floor?:number, k1?:number, b?:number}} [options]
 * @returns {Array<{id:number, score:number, rank:number}>} 已降序、已截断
 */
export function rankByLexicon(query, index, options = {}) {
  if (!index || !index.docCount || !index.available) return [];
  const table = loadWordTable({ dir: index.dictDir });
  const topK = Math.trunc(asNumber(options.topK, LEXICON_DEFAULTS.topK, 1, 500));
  const floor = asNumber(options.floor, LEXICON_DEFAULTS.floor, 0, 1);
  const k1 = asNumber(options.k1, LEXICON_DEFAULTS.k1, 0.01, 10);
  const b = asNumber(options.b, LEXICON_DEFAULTS.b, 0, 1);

  const terms = tokenizeLexiconQuery(query, table).filter(
    (term) => specificityOf(term, table) >= floor && index.postings.has(term),
  );
  if (!terms.length) return [];

  const scores = new Float64Array(index.docCount);
  const visited = new Uint8Array(index.docCount);
  const touched = [];
  const avgLen = index.avgLen || 1;

  for (const term of terms) {
    const df = index.df.get(term) || 0;
    const idf = Math.log(1 + (index.docCount - df + 0.5) / (df + 0.5));
    const weight = idf * specificityOf(term, table);
    if (!(weight > 0)) continue;
    const row = index.postings.get(term);
    for (let at = 0; at < row.length; at += 2) {
      const doc = row[at];
      const tf = row[at + 1];
      const lengthNorm = 1 - b + (b * index.lens[doc]) / avgLen;
      const gain = (tf * (k1 + 1)) / (tf + k1 * lengthNorm);
      if (!visited[doc]) {
        visited[doc] = 1;
        touched.push(doc);
      }
      scores[doc] += weight * gain;
    }
  }

  const ranked = [];
  for (const doc of touched) {
    if (scores[doc] > 0) ranked.push({ doc, id: index.ids[doc], score: scores[doc] });
  }
  ranked.sort((left, right) => right.score - left.score || left.doc - right.doc);
  return ranked.slice(0, topK).map((row, at) => ({ id: row.id, score: row.score, rank: at + 1 }));
}

/* ─────────────────────────── 进程内缓存 / 预热 ─────────────────────────── */

let CACHE = null; // { key, index }
let WARMING = false;

const sourceTagOf = (source) => String(source?.dbPath || source?.sourceName || '(anonymous)');

function stampOf(source) {
  const count = typeof source?.count === 'function' ? Number(source.count()) : 0;
  const updated = typeof source?.maxUpdatedAt === 'function' ? Number(source.maxUpdatedAt()) : 0;
  return {
    count: Number.isFinite(count) ? count : 0,
    updated: Number.isFinite(updated) ? updated : 0,
  };
}

function warmInBackground(source, key) {
  if (WARMING) return;
  WARMING = true;
  const timer = setImmediate(() => {
    try {
      // 期间可能已被别人建好（同 key 就直接复用）
      if (!CACHE || CACHE.key !== key) {
        const index = buildLexiconIndex(source);
        if (index) CACHE = { key, index };
      }
    } catch {
      // fail-open：建不起来就一直只走向量路，不打扰主路
    } finally {
      WARMING = false;
    }
  });
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * 取（可能陈旧一轮的）词表索引。**永不抛错**。
 * - 命中缓存且未过期 ⇒ 直接给；
 * - `allowBuild: true` ⇒ 当场建（命令行 / 夹具用，几百毫秒）；
 * - 否则后台预热并返回同源的旧索引或 null（null ⇒ 调用方这一轮只走向量路）。
 * @param {object} source
 * @param {{allowBuild?:boolean, force?:boolean}} [options]
 * @returns {object|null}
 */
export function getLexiconIndex(source, options = {}) {
  const wantBuild = Boolean(options.allowBuild);
  const force = Boolean(options.force);
  try {
    if (!source || typeof source.allTexts !== 'function') return null;
    const switchValue = resolveLexiconSwitch();
    const stamp = stampOf(source);
    const key = `${sourceTagOf(source)}|${stamp.count}|${stamp.updated}`;
    const cached = CACHE && CACHE.key === key ? CACHE.index : null;
    const fresh = cached && !force && Date.now() - cached.builtAt < switchValue.ttlMs;
    if (fresh) return cached;
    if (!wantBuild) {
      warmInBackground(source, key);
      return cached; // 同源旧索引可以先用（TTL 与条数/max(updated_at) 兜底）
    }
    const index = buildLexiconIndex(source);
    if (index) CACHE = { key, index };
    return index;
  } catch {
    return null;
  }
}

/** 显式丢弃缓存（写库后、或测试里要干净起点时用）。 */
export function resetLexiconIndex() {
  CACHE = null;
}

/** 只读诊断面：不建索引、不预热，给自检/探针用。 */
export function lexiconStatus() {
  const table = loadWordTable();
  return {
    assets: lexiconAssets(),
    config: resolveLexiconSwitch(),
    table: { available: table.available, words: table.words.size, freq: table.freq.size, longest: table.longest },
    cache: CACHE
      ? {
          key: CACHE.key,
          docCount: CACHE.index.docCount,
          buildMs: CACHE.index.buildMs,
          builtAt: CACHE.index.builtAt,
          ageMs: Date.now() - CACHE.index.builtAt,
        }
      : null,
    warming: WARMING,
  };
}
