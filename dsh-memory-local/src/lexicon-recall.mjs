/**
 * FORK-EDIT(2026-10-26 · 卡「词表第二召回通道」)
 * 真源：词表第二召回通道方案 §3.1 / §3.3（内部设计档，不随仓分发）
 *
 * 干什么：补上 hybrid search 里「稀疏」那一路（词面撞没撞上）。
 * 为什么要补：原来那一路是 FTS5，而 SQLite 的 `unicode61` 不切中文 ⇒ 中文提问 27.3% 出不了
 * token（那一路等于不存在），且净效应是负的（救回 2 题 / 挤掉 4 题，连"向量第 1 名"都被挤掉）。
 * 怎么补：jieba 词表最长匹配切词（窗口 ≤12）+ 「库里 df 的 IDF × 通用词频稀有度」打分，
 * 与向量路一起喂给现成的 RRF（k=60）融合器。
 *
 * 三条边界：
 *   ① 对 memory.db **只读**：复用 memory-read.mjs 的 reader（`source.count()` / `source.db`），
 *      本模块不自己开库、不建表、不写。
 *   ② 索引**进程内单例 + 后台预热 + fail-open**：建一次约 0.5 秒，绝不落在每轮对话上。
 *   ③ 开关与门槛读 `dict/lexicon-config.json`（**不在 cordis.patch.yml**：插件 config schema
 *      没有这四个键，而 `index.js` 会按显式字段映射给 injector、injector 也只显式传给 recall()
 *      ⇒ 写进 patch 的未知键会被静默丢掉。改这里 + 重启即生效，不用碰代码）。
 *
 * 许可：`dict/词典.txt` 与 `dict/词频.txt` 来自 jieba 的 extra_dict/dict.txt.small（MIT），
 * 来源声明见 `dict/LICENSE-词典.md`（随包分发必须保留）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DICT_DIR = path.join(HERE, 'dict');
const DICT_FILE = path.join(DICT_DIR, '词典.txt');
const FREQ_FILE = path.join(DICT_DIR, '词频.txt');
const CONFIG_FILE = path.join(DICT_DIR, 'lexicon-config.json');

/** 开关默认值（配置文件缺失/坏掉时用这套；口径 == 方案 §3.4） */
export const DEFAULT_CONFIG = Object.freeze({
  lexiconEnabled: true,
  lexiconGate: 0.3,
  lexiconTopK: 20,
  ftsEnabled: false,
  lexiconTtlMs: 600000,
});

/** 单字虚词表（照抄 bench2.mjs，实测口径，别改） */
const HAN_STOPS =
  /(?:怎么样|叫什么|名字|名叫|叫|用户|什么|怎么|哪里|哪儿|现在|目前|当前|记得|记住|告诉|可以|请问|一下|来着|我们|你们|他们|她们|这个|那个|哪些|是否|有没有|我|你|他|她|它|的|了|着|过|是|有|在|把|被|和|与|及|或|这|那|哪|吗|呢|吧|啊|呀|得|地|个|只|件|请|也|都|就|很|再|还|要)/gu;
const HAN_STOPS1 = new RegExp('^' + HAN_STOPS.source + '$', 'u');
const isStop1 = (w) => w.length === 1 && HAN_STOPS1.test(w);

let DICT = null; // { words:Set<string>, maxLen:number, freq:Map<string,number> }

/** 词典 + 词频只读一次（约 1.2MB，进程内常驻；读不到就退化成"没有词表"= 该路空手） */
function loadDict() {
  if (DICT) return DICT;
  const words = new Set();
  let maxLen = 2;
  for (const line of fs.readFileSync(DICT_FILE, 'utf8').split('\n')) {
    const w = line.trim();
    if (!w) continue;
    words.add(w);
    if (w.length > maxLen) maxLen = w.length;
  }
  if (maxLen > 12) maxLen = 12; // 窗口上限（方案 §3.1：≤12）
  const freq = new Map();
  for (const line of fs.readFileSync(FREQ_FILE, 'utf8').split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 2) continue;
    const v = Number(p[1]);
    if (p[0] && Number.isFinite(v)) freq.set(p[0], v);
  }
  DICT = { words, maxLen, freq };
  return DICT;
}

/** 通用词频稀有度：0 = 最常见的词（不当线索）/ 1 = 很具体的词（查不到就是 1） */
function commonRarity(k) {
  const { freq } = loadDict();
  return freq.has(k) ? freq.get(k) / 99 : 1;
}

/**
 * 词表最长匹配切词（中文窗口 ≤12）+ 抽 ASCII 词（≥2 字符）。
 * 与 `_tmp\fish-memory-probe-20261026\bench2.mjs` 的实现逐行同口径（那是实测数据来源）。
 * @param {string} s
 * @returns {Set<string>}
 */
export function tokenizeDict(s) {
  const { words, maxLen } = loadDict();
  const out = new Set();
  const clean = String(s || '').toLowerCase();
  for (const m of clean.matchAll(/[a-z0-9]{2,}/g)) out.add(m[0]);
  for (const run of clean.match(/[\u4e00-\u9fa5]+/g) || []) {
    let i = 0;
    while (i < run.length) {
      let take = 0;
      const cap = Math.min(maxLen, run.length - i);
      for (let n = cap; n >= 1; n -= 1) {
        if (words.has(run.slice(i, i + n))) {
          take = n;
          break;
        }
      }
      const w = take === 0 ? run[i] : run.slice(i, i + take);
      if (!isStop1(w)) out.add(w);
      i += take === 0 ? 1 : take;
    }
  }
  return out;
}

let CFG = null;

/**
 * 读开关配置（`dict/lexicon-config.json`）。按 mtime+size 缓存 ⇒ 改文件不用重启进程，
 * 但**代码/lib 变了仍然要重启**（lib 在 boot 读）。坏文件 = 用默认值，不抛。
 * @returns {{lexiconEnabled:boolean, lexiconGate:number, lexiconTopK:number, ftsEnabled:boolean, lexiconTtlMs:number, source:string}}
 */
export function readLexiconConfig() {
  let st = null;
  try {
    st = fs.statSync(CONFIG_FILE);
  } catch {
    return { ...DEFAULT_CONFIG, source: 'default' };
  }
  const key = `${st.mtimeMs}:${st.size}`;
  if (CFG && CFG.key === key) return CFG.value;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    raw = null;
  }
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  const value = {
    lexiconEnabled: bool(raw && raw.lexiconEnabled, DEFAULT_CONFIG.lexiconEnabled),
    lexiconGate: Number.isFinite(Number(raw && raw.lexiconGate)) ? Number(raw.lexiconGate) : DEFAULT_CONFIG.lexiconGate,
    lexiconTopK: num(raw && raw.lexiconTopK, DEFAULT_CONFIG.lexiconTopK),
    ftsEnabled: bool(raw && raw.ftsEnabled, DEFAULT_CONFIG.ftsEnabled),
    lexiconTtlMs: num(raw && raw.lexiconTtlMs, DEFAULT_CONFIG.lexiconTtlMs),
    source: raw ? 'file' : 'default',
  };
  CFG = { key, value };
  return value;
}

/**
 * 建索引：读全部记忆 → 切词 → df + 归一化常数。**一次性 ~0.5s，别在热路径上调**。
 * @param {{db?:object, count?:Function}} memSource memory-read.mjs 的 reader（也可直接给 DatabaseSync）
 * @returns {{ids:number[], toks:Array<Set<string>>, df:Map<string,number>, total:number, topLog:number, rowCount:number, builtAt:number}}
 */
export function buildLexiconIndex(memSource, { table = 'memories' } = {}) {
  const t0 = Date.now();
  const db = memSource && memSource.db ? memSource.db : memSource;
  if (!db || typeof db.prepare !== 'function') throw new Error('lexicon-recall: 需要 memory reader 或 DatabaseSync');
  const rows = db.prepare(`SELECT id, text, tags FROM ${table}`).all();
  const ids = new Array(rows.length);
  const toks = new Array(rows.length);
  const df = new Map();
  const post = new Map(); // 倒排：词 → 命中的行下标（升序）
  let maxId = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    ids[i] = Number(r.id);
    if (ids[i] > maxId) maxId = ids[i];
    const s = tokenizeDict(`${String(r.text || '')} ${String(r.tags || '').replace(/,/g, ' ')}`);
    toks[i] = s;
    for (const k of s) {
      df.set(k, (df.get(k) || 0) + 1);
      const p = post.get(k);
      if (p) p.push(i);
      else post.set(k, [i]);
    }
  }
  const total = rows.length;
  const topLog = Math.log((total + 1) / 2);
  return { ids, toks, post, df, total, topLog, rowCount: total, maxId, builtAt: Date.now(), buildMs: Date.now() - t0 };
}

/** 库里 IDF（归一化到 0~1）：越少见越靠近 1 */
function rarity(index, k) {
  const { total, topLog, df } = index;
  if (!(total > 1)) return df.get(k) ? 1 : 0;
  if (!(topLog > 0)) return 0;
  const v = Math.log((total + 1) / ((df.get(k) || 0) + 1)) / topLog;
  return v > 1 ? 1 : v > 0 ? v : 0;
}

/**
 * 按词表给全库打分（`Σ 库里IDF × 通用稀有度`）。
 * @param {string} query
 * @param {object} index buildLexiconIndex 的产物
 * @param {{gate?:number, depth?:number}} [opts]
 * @returns {Array<{id:number, s:number, rank:number}>} 已降序、已截 depth（只留 s>0）
 */
export function rankByLexicon(query, index, { gate = DEFAULT_CONFIG.lexiconGate, depth = DEFAULT_CONFIG.lexiconTopK } = {}) {
  if (!index || !index.ids || !index.ids.length) return [];
  const tokens = [...tokenizeDict(query)].filter((k) => commonRarity(k) >= Number(gate));
  if (!tokens.length) return [];
  const weights = tokens.map((k) => ({ k, w: rarity(index, k) * commonRarity(k) }));
  // 倒排累加：每条记录的分数 = 它**含有**的那些词的权重之和（无 tf、无长度归一 ⇒ 与词序无关，
  // 逐条累加的先后完全按 query 词序 ⇒ 与朴素双重循环（bench2/bench6 口径）浮点结果一致）。
  const acc = new Float64Array(index.ids.length);
  const touched = [];
  for (let j = 0; j < weights.length; j += 1) {
    const { k, w } = weights[j];
    const posting = index.post ? index.post.get(k) : null;
    if (!posting) continue;
    for (let n = 0; n < posting.length; n += 1) {
      const di = posting[n];
      if (!acc[di]) touched.push(di);
      acc[di] += w;
    }
  }
  const scored = [];
  for (let n = 0; n < touched.length; n += 1) {
    const i = touched[n];
    const s = acc[i];
    if (s > 0) scored.push({ id: index.ids[i], s, idx: i });
  }
  scored.sort((a, b) => b.s - a.s || a.idx - b.idx);
  const k = Math.min(Number(depth) || 0, scored.length);
  const out = [];
  for (let i = 0; i < k; i += 1) out.push({ id: scored[i].id, s: scored[i].s, rank: i + 1 });
  return out;
}

// ---- 进程内单例（方案 §3.3：rowCount 检查 + TTL + 后台预热 + fail-open） ----
let SINGLETON = null; // { index, builtAt, rowCount }
let WARMING = false;

/** 显式失效（写记忆后调用）。注意：index.js 侧没接钩子（红线），实际靠 rowCount + TTL 兜。 */
export function invalidateLexiconIndex() {
  SINGLETON = null;
}

function dbOf(memSource) {
  const db = memSource && memSource.db ? memSource.db : memSource;
  if (!db || typeof db.prepare !== 'function') throw new Error('lexicon-recall: 需要 memory reader 或 DatabaseSync');
  return db;
}

/** 一条索引查询拿「条数 + 最大 id」（≈0.1ms） */
function readCounts(memSource, table = 'memories') {
  const db = dbOf(memSource);
  const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM ${table}`).get();
  return { n: Number(r.n), m: Number(r.m) };
}

/**
 * **增量快路径**：只切「id 比索引里最大值更大的」新行，追加进现有索引（几毫秒）。
 * 为什么值得：整份重建 ~500ms 且是同步的 —— 写一条记忆就重建一次会把 500ms 砸在某一轮对话上，
 * 而记忆写入常有成批（蒸馏/夜班）。删改（条数没增、最大 id 没增）走整份重建，见 getLexiconIndex。
 * 先算完再改（`partial` 标记）⇒ 中途抛错时索引被标脏，下一次直接整份重建。
 * @returns {number} 追加的行数
 */
function appendNewRows(index, memSource, table = 'memories') {
  const db = dbOf(memSource);
  const rows = db.prepare(`SELECT id, text, tags FROM ${table} WHERE id > ? ORDER BY id`).all(index.maxId || 0);
  if (!rows.length) return 0;
  // ① 先算（这一步抛错不改索引）
  const add = rows.map((r) => ({
    id: Number(r.id),
    toks: tokenizeDict(`${String(r.text || '')} ${String(r.tags || '').replace(/,/g, ' ')}`),
  }));
  // ② 再改（纯内存 push/set，不会抛）
  index.partial = true;
  for (const a of add) {
    const i = index.ids.length;
    index.ids.push(a.id);
    index.toks.push(a.toks);
    for (const k of a.toks) {
      index.df.set(k, (index.df.get(k) || 0) + 1);
      const p = index.post.get(k);
      if (p) p.push(i);
      else index.post.set(k, [i]);
    }
    if (a.id > (index.maxId || 0)) index.maxId = a.id;
  }
  index.total = index.ids.length;
  index.rowCount = index.total;
  index.topLog = Math.log((index.total + 1) / 2);
  index.appended = (index.appended || 0) + add.length;
  index.partial = false;
  return add.length;
}

/**
 * 取（可能陈旧一轮的）单例索引；**永不抛错、永不阻塞**。
 * 首次调用 / 失效后：后台 `setTimeout(0)` 刷新，**本轮返回旧索引或 null**
 * （null ⇒ 调用方退化成"只有向量"，与词表上线前的向量主路等价）。
 * 失效判据（任一）：① 条数或最大 id 变了 ② 距上次构建超过 `lexiconTtlMs`（兜住"改一条"这种
 * 条数不变的编辑）③ 显式 `invalidateLexiconIndex()`。
 * @param {{db?:object, count?:Function}} memSource
 * @returns {object|null}
 */
export function getLexiconIndex(memSource) {
  try {
    const cfg = readLexiconConfig();
    const ttlMs = Number(cfg.lexiconTtlMs) || DEFAULT_CONFIG.lexiconTtlMs;
    const cur = SINGLETON ? SINGLETON.index : null;
    const counts = readCounts(memSource);
    const stale =
      !cur ||
      cur.partial === true ||
      cur.total !== counts.n ||
      Number(cur.maxId || 0) !== counts.m ||
      Date.now() - cur.builtAt >= ttlMs;
    if (!stale) return cur;
    if (!WARMING) {
      WARMING = true;
      const timer = setTimeout(() => {
        try {
          const c = readCounts(memSource);
          let next = SINGLETON ? SINGLETON.index : null;
          // 快路径：只是"多了新行"⇒ 增量追加；条数/最大 id 对不上就整份重建
          if (next && next.partial !== true && c.n > next.total && c.m > Number(next.maxId || 0)) {
            appendNewRows(next, memSource);
            if (next.total !== c.n || Number(next.maxId || 0) !== c.m) next = null;
          } else {
            next = null;
          }
          const index = next || buildLexiconIndex(memSource);
          index.rebuilds = (index.rebuilds || 0) + 1;
          SINGLETON = { index, builtAt: Date.now(), rowCount: index.rowCount };
        } catch {
          /* fail-open：建不起来就一直走"只有向量" */
        } finally {
          WARMING = false;
        }
      }, 0);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return SINGLETON ? SINGLETON.index : null;
  } catch {
    return null;
  }
}

/** 只读诊断面（自测/探针用，不进热路径） */
export function lexiconStatus() {
  return {
    loaded: Boolean(DICT),
    built: Boolean(SINGLETON),
    builtAt: SINGLETON ? SINGLETON.builtAt : null,
    rowCount: SINGLETON ? SINGLETON.rowCount : null,
    maxId: SINGLETON ? SINGLETON.index.maxId : null,
    appended: SINGLETON ? SINGLETON.index.appended || 0 : 0,
    warming: WARMING,
    config: readLexiconConfig(),
    dictDir: DICT_DIR,
  };
}
