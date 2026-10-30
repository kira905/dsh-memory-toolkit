// 记忆引擎 v2 · S3b —— 域标签补齐（方案 §3.6 幂等键改「去重键」 / §5.4 / §7 / §3.9 D2 从严）
//
// 逐条口径（都能在方案里找到出处）：
//   · 域标签集 = 家庭 / 工作 / 健康 / 技术 / DSH生态 / 梗，**追加**到 tags，绝不覆盖原标签（§3.6）
//   · 幂等键 = **去重键 `(id, 域标签集哈希)`**；写前**逐标签判重**（已含则该条跳过）。
//     不许用"批次游标"当幂等键 —— 重复执行会往 tags 累加同一批标签（`normalizeTags` 的去重只在
//     插件写入口生效，直写 SQL 不经过它）（§3.6 v3 改 · 关 I2）
//   · 前置 `VACUUM INTO` 快照；失败可整表还原（§3.6 / §7）
//   · 并发保护：`busy_timeout` + 重试 **3 次**、退避上限 **60 s**（§3.6 / §7 Z2）
//   · 成本闸：调用 ≤ **20 次/日**、token ≤ **150K/日**，**超限即停**（不重试）+ 记账（§3.5 / §3.6）
//   · 分批、**可中断续跑**（state 落盘，逐条幂等台账）（§3.6）
//   · **D2 从严**（§3.9 注 / 服务面 §11.3）：只把 `owner_user == 本机 owner` 的条送分类模型；
//     判不出归属的条 **跳过并记账**（宁可漏，不可错送）
//
// 两个刻意的设计决定（写在这里防将来"照字面实现"踩坑）：
//   ① 分类模型输出只用来**追加标签**，不产生任何其它写入 ⇒ 半完成态无害（§5.4 域标签行）；
//   ② 追加标签**不动 `updated_at`** —— 否则会把这批老条顶进 `memory:recall` 段最前，
//      并让提炼窗口（按 updated_at 取变更）误判为"新内容"（§3.5 输入行）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 域标签集（显示名 = 方案 §3.6 原文）。 */
export const DOMAIN_TAGS = Object.freeze(['家庭', '工作', '健康', '技术', 'DSH生态', '梗']);

/** 显示名 → 落库 token。`tags` 一律按插件 `normalizeTags` 的口径小写化（`DSH生态` → `dsh生态`）。 */
export function normalizeTag(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

/** 显示名 → 规范 token 的映射（兼容大小写/空白写法的输入）。 */
export const DOMAIN_TOKEN_BY_LABEL = Object.freeze(
  Object.fromEntries(DOMAIN_TAGS.map((label) => [label, normalizeTag(label)])),
);
export const DOMAIN_TOKENS = Object.freeze(DOMAIN_TAGS.map((l) => normalizeTag(l)));

/** 成本闸默认值（§3.5，与提炼 job 同一档）。 */
export const COST_LIMITS = Object.freeze({ callsPerDay: 20, tokensPerDay: 150000 });

/** 并发保护默认值（§3.6 / §7）。 */
export const RETRY = Object.freeze({ busyTimeoutMs: 5000, maxAttempts: 3, backoffMs: [1000, 4000, 16000], totalCapMs: 60000 });

/**
 * 分类模型默认档（**2026-09-21 主人拍板：记忆线一律走本鱼链**；真源 = 方案 §3.5 订正注 2）。
 * 不用 `deepseek-v4-pro`（贵 4.4 倍，分类任务不需要强推理）；不许改回第三方（D2 延长效：新增外发面须先拍）。
 */
export const DEFAULT_LLM = Object.freeze({
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  credentialKey: 'DEEPSEEK_API_KEY',
  maxTokens: 2048,
  timeoutMs: 60000,
});

export const STATE_SCHEMA = 1;

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 稳定哈希（域标签集 → 短哈希；幂等键的右半）。 */
export function tagSetHash(tokens) {
  const sorted = [...new Set(tokens.map(normalizeTag).filter(Boolean))].sort();
  // 轻量 FNV-1a（零依赖；只用做"集合是否变过"的比较，不需要密码学强度）
  let h = 0x811c9dc5;
  for (const t of sorted) {
    for (let i = 0; i < t.length; i += 1) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2c; // 分隔符（防 "ab"+"c" 与 "a"+"bc" 撞）
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, '0')}`;
}

/** tags 文本 → token 数组（空格分隔；与插件 normalizeTags 的落库形态一致）。 */
export function tokensOf(tags) {
  return String(tags ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

/** 该条 already 有哪些域标签（token 级精确比较，**不用 includes**：`工作记录` 不等于 `工作`）。 */
export function domainTokensIn(tags) {
  const set = new Set(tokensOf(tags));
  return DOMAIN_TOKENS.filter((t) => set.has(t));
}

/**
 * 追加域标签（**幂等**）：返回新 tags 文本 + 实际新增了哪些。
 * 只在"目标标签不在现有 token 里"时追加 ⇒ 同批次重跑不会产生重复 token（§3.6 验收）。
 */
export function appendDomainTags(existingTags, domainLabelsOrTokens) {
  const tokens = tokensOf(existingTags);
  const present = new Set(tokens);
  const wanted = [];
  for (const raw of domainLabelsOrTokens) {
    const label = String(raw ?? '').trim();
    const token = DOMAIN_TOKEN_BY_LABEL[label] ?? DOMAIN_TOKENS.find((t) => t === normalizeTag(label));
    if (!token) continue; // 模型给了不在域标签集里的东西 ⇒ 丢弃（不写库）
    if (!wanted.includes(token)) wanted.push(token);
  }
  const added = wanted.filter((t) => !present.has(t));
  const next = [...tokens, ...added].join(' ');
  return { tags: next, added, alreadyPresent: wanted.filter((t) => present.has(t)), wanted };
}

// ── 库操作（只读取样 + 带重试的写） ──────────────────────────────────────────

/** 打开库（默认只读；`write:true` 时带 busy_timeout）。 */
export function openDb(dbPath, { write = false } = {}) {
  // ⚠️ node:sqlite 的第二参**不接受 undefined**（"options argument must be an object"）⇒ 分支显式构造
  const db = write ? new DatabaseSync(dbPath) : new DatabaseSync(dbPath, { readOnly: true });
  if (write) db.exec(`PRAGMA busy_timeout = ${RETRY.busyTimeoutMs}`);
  return db;
}

/**
 * 带重试的写事务执行器（§3.6 / §7 Z2：`busy_timeout` + 重试 3 次、总退避上限 60 s）。
 * @param {object} db - 写连接
 * @param {() => any} fn - 事务体
 * @param {{sleep?:Function, now?:Function}} [deps] - 便于单测注入（不真等）
 * @returns {{ok:boolean, value?:any, attempts:number, error?:string, waitedMs:number}}
 */
export async function withBusyRetry(db, fn, deps = {}) {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const started = Date.now();
  let waited = 0;
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt += 1) {
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = fn();
        db.exec('COMMIT');
        return { ok: true, value, attempts: attempt, waitedMs: waited };
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* 忽略回滚失败 */ }
        throw e;
      }
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      const busy = /busy|locked/i.test(msg);
      if (!busy || attempt === RETRY.maxAttempts) break;
      const backoff = RETRY.backoffMs[Math.min(attempt - 1, RETRY.backoffMs.length - 1)];
      if (waited + backoff > RETRY.totalCapMs || Date.now() - started + backoff > RETRY.totalCapMs) {
        return { ok: false, attempts: attempt, error: `${msg}（退避将超 ${RETRY.totalCapMs}ms 上限，停止重试）`, waitedMs: waited };
      }
      await sleep(backoff);
      waited += backoff;
    }
  }
  return { ok: false, attempts: RETRY.maxAttempts, error: String(lastErr && lastErr.message ? lastErr.message : lastErr), waitedMs: waited };
}

/** 读待处理条目（只读）：id/text/tags/owner_user（若列不存在则 `ownerColumn:false`）。 */
export function readCandidates(dbPath, { limit = 0, maxCharsPerItem = 240 } = {}) {
  const db = openDb(dbPath);
  try {
    const cols = db.prepare('PRAGMA table_info(memories)').all().map((r) => r.name);
    const hasOwner = cols.includes('owner_user');
    const sel = ['id', 'text', 'tags', ...(hasOwner ? ['owner_user', 'visibility'] : [])].join(', ');
    const rows = db.prepare(`SELECT ${sel} FROM memories ORDER BY id`).all();
    const items = rows.map((r) => ({
      id: r.id,
      text: String(r.text ?? ''),
      tags: String(r.tags ?? ''),
      ownerUser: hasOwner ? r.owner_user : null,
      visibility: hasOwner ? r.visibility : null,
      textTruncated: String(r.text ?? '').length > maxCharsPerItem,
      textForModel: String(r.text ?? '').slice(0, maxCharsPerItem),
      existingDomains: domainTokensIn(r.tags),
    }));
    return { items: limit > 0 ? items.slice(0, limit) : items, ownerColumn: hasOwner, columns: cols };
  } finally {
    db.close();
  }
}

// ── LLM（DeepSeek 官方 OpenAI 兼容端点；key 读 .credentials.yaml） ─────────────

/** 从 .credentials.yaml 读 key（去引号 + 去 flow-map 行尾逗号）。 */
export function readCredential(keyName, credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml')) {
  try {
    const text = fs.readFileSync(credFile, 'utf8');
    const m = text.match(new RegExp(`^\\s*${keyName}\\s*:\\s*(.+?)\\s*$`, 'm'));
    if (!m) return null;
    let v = m[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    v = v.replace(/\s+#.*$/, '').replace(/,\s*$/, '').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 分类提示词（system）。要求模型**只输出 JSON**，且只从给定集合里选。 */
export function buildSystemPrompt() {
  return [
    '你是一个中文记忆条目的域分类器。给定若干条记忆（编号 + 正文），为每条从下列固定集合里选出适用的域标签：',
    `集合：${DOMAIN_TAGS.join(' / ')}`,
    '规则：',
    '1. 每条可给 0~3 个标签；不适用就返回空数组，不要硬凑。',
    '2. 只允许上面集合里的标签，逐字照抄（含大小写），不得自创、不得翻译、不得加解释。',
    '3. 判据看正文主旨：家人/家庭事务→家庭；工作/职场/公司/项目交付→工作；身体/睡眠/就医/健康习惯→健康；',
    '   编程/系统/工具/踩坑/技术方案→技术；DSH 生态自身的机制/插件/大管家/同步/生图栈→DSH生态；',
    '   段子/梗/玩笑/表情包/口癖→梗。一条可同时属技术与DSH生态。',
    `4. 输出**严格 JSON**，形如 {"items":[{"id":6,"domains":["技术"]}, {"id":7,"domains":[]}]}；`,
    '   不要输出 markdown 代码围栏、不要输出解释文字、不要遗漏输入的每一条。',
  ].join('\n');
}

/** 分类提示词（user 侧）：批量正文。 */
export function buildUserPrompt(items) {
  const lines = items.map((it) => `[${it.id}] ${it.textForModel.replace(/\s+/g, ' ').trim()}`);
  return `共 ${items.length} 条，请逐条分类并按要求输出 JSON：\n\n${lines.join('\n')}`;
}

/** 从模型回复里抠 JSON（容忍代码围栏 / 前后废话）。 */
export function extractJson(content) {
  const text = String(content ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 调一次分类模型。`fetchImpl` 可注入（单测不真发网络）。 */
export async function callClassifier({ items, apiKey, baseUrl = DEFAULT_LLM.baseUrl, model = DEFAULT_LLM.model, fetchImpl = fetch, timeoutMs = DEFAULT_LLM.timeoutMs, maxTokens = DEFAULT_LLM.maxTokens }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(items) },
    ],
    // deepseek-flash 默认开思考（effort=high ⇒ 白烧 token）；分类任务不需要思考 ⇒ 显式关
    thinking: { type: 'disabled' },
    temperature: 0.1,
    max_tokens: maxTokens,
    stream: false,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
    let json;
    try { json = JSON.parse(text); } catch (e) { return { ok: false, error: `响应不是 JSON：${e.message}`, raw: text.slice(0, 300) }; }
    const content = json?.choices?.[0]?.message?.content ?? '';
    const usage = json?.usage ?? {};
    const parsed = extractJson(content);
    if (!parsed) return { ok: false, error: '模型输出里找不到可解析的 JSON', raw: String(content).slice(0, 300), usage };
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : null);
    if (!list) return { ok: false, error: 'JSON 结构不含 items 数组', raw: String(content).slice(0, 300), usage };
    return { ok: true, items: list, usage, content };
  } catch (e) {
    return { ok: false, error: `请求失败：${e && e.message ? e.message : e}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 估算一次批量调用的 token（保守），用于调用前预判成本闸。 */
export function estimateTokens(items) {
  const chars = items.reduce((n, it) => n + it.textForModel.length + 8, 0) + buildSystemPrompt().length;
  return Math.ceil(chars / 1.4) + 300; // 中文 ≈1.4 字/token，另留出输出的余量
}

// ── state（可中断续跑 + 记账） ───────────────────────────────────────────────

export function defaultState(dbPath, nowIso) {
  return {
    schemaVersion: STATE_SCHEMA,
    dbPath,
    updatedAt: nowIso,
    cost: { date: String(nowIso).slice(0, 10), calls: 0, promptTokens: 0, completionTokens: 0 },
    processed: {},
    skipped: {},
    stats: { batches: 0, tagged: 0, noTag: 0, skippedOwner: 0, skippedUnknownDomain: 0, runs: 0 },
    lastDailyLine: null,
  };
}

export function readState(stateFile, dbPath, nowIso) {
  try {
    if (!fs.existsSync(stateFile)) return defaultState(dbPath, nowIso);
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const base = defaultState(dbPath, nowIso);
    const merged = { ...base, ...s, cost: { ...base.cost, ...(s.cost ?? {}) }, stats: { ...base.stats, ...(s.stats ?? {}) } };
    // 跨日 ⇒ 当日成本归零（成本闸是"每日"口径）
    if (merged.cost.date !== String(nowIso).slice(0, 10)) merged.cost = { date: String(nowIso).slice(0, 10), calls: 0, promptTokens: 0, completionTokens: 0 };
    return merged;
  } catch {
    return defaultState(dbPath, nowIso);
  }
}

export function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, stateFile);
  } catch {
    fs.copyFileSync(tmp, stateFile);
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
  return stateFile;
}

/** 成本闸判定：还能不能再调一次（§3.5：≤20 次/日、≤150K token/日，超限即停不重试）。 */
export function costGate(state, estimatedTokens, limits = COST_LIMITS) {
  const usedTokens = Number(state.cost.promptTokens ?? 0) + Number(state.cost.completionTokens ?? 0);
  const calls = Number(state.cost.calls ?? 0);
  if (calls >= limits.callsPerDay) return { ok: false, reason: `当日调用数已达上限 ${limits.callsPerDay} 次` };
  if (usedTokens >= limits.tokensPerDay) return { ok: false, reason: `当日 token 已达上限 ${limits.tokensPerDay}` };
  if (usedTokens + estimatedTokens > limits.tokensPerDay) {
    return { ok: false, reason: `本批估算 ${estimatedTokens} token 会超过当日上限（已用 ${usedTokens}/${limits.tokensPerDay}）` };
  }
  return { ok: true };
}

// ── 快照 ────────────────────────────────────────────────────────────────────

/** `VACUUM INTO` 快照（只读连接；§3.6 前置）。 */
export function vacuumInto(srcDbPath, destFile) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  if (fs.existsSync(destFile)) fs.rmSync(destFile);
  const db = openDb(srcDbPath);
  try {
    db.exec(`VACUUM INTO '${String(destFile).replace(/\\/g, '/').replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  if (!fs.existsSync(destFile)) throw new Error(`VACUUM INTO 未产出快照：${destFile}`);
  return destFile;
}

// ── 单条写回（幂等） ─────────────────────────────────────────────────────────

/**
 * 把一批分类结果写回（**幂等 + 事务 + 重试**）。
 * @returns {{written:number, unchanged:number, addedTokens:string[], details:Array}}
 */
export async function applyResults(db, results, deps = {}) {
  const details = [];
  let written = 0;
  let unchanged = 0;
  const addedTokens = [];
  const r = await withBusyRetry(db, () => {
    const sel = db.prepare('SELECT tags FROM memories WHERE id = ?');
    const upd = db.prepare('UPDATE memories SET tags = ? WHERE id = ?');
    for (const res of results) {
      const row = sel.get(res.id);
      if (!row) { details.push({ id: res.id, action: 'missing' }); continue; }
      const { tags, added, alreadyPresent, wanted } = appendDomainTags(row.tags, res.domains);
      if (added.length === 0) {
        unchanged += 1;
        details.push({ id: res.id, action: wanted.length === 0 ? 'no-tag' : 'already', tags, alreadyPresent });
        continue;
      }
      upd.run(tags, res.id);
      written += 1;
      addedTokens.push(...added);
      details.push({ id: res.id, action: 'tagged', tags, added });
    }
    return { written, unchanged };
  }, deps);
  return { ...r, written: r.value?.written ?? 0, unchanged: r.value?.unchanged ?? 0, addedTokens, details };
}

// ── 日报一行（幂等段替换，口径同 report.mjs / doc-index.mjs） ─────────────────

export const DAILY_SECTION_TITLE = '## 🏷 记忆域标签（memory-domain-tags）';

export function renderDailyLine({ mode, stats, cost, state, limits = COST_LIMITS, stoppedReason = null }) {
  const used = Number(cost.promptTokens ?? 0) + Number(cost.completionTokens ?? 0);
  const parts = [
    `模式 ${mode}`,
    `本轮批次 ${stats.batches ?? 0}`,
    `新增标签条数 ${stats.tagged ?? 0}`,
    `无标签 ${stats.noTag ?? 0}`,
    `跳过(非本机owner) ${stats.skippedOwner ?? 0}`,
    `当日调用 ${cost.calls ?? 0}/${limits.callsPerDay}`,
    `当日 token ${used}/${limits.tokensPerDay}`,
  ];
  if (stoppedReason) parts.push(`停机原因：${stoppedReason}`);
  if (state?.processedCount !== undefined) parts.push(`幂等台账 ${state.processedCount} 条`);
  return parts.join(' · ');
}

/** 在日报里做「段级替换」（找不到就追加到文件尾；文件不存在则不新建 —— 同 doc-index 口径）。 */
export function updateDailySection({ file, line, dryRun = false }) {
  if (!fs.existsSync(file)) return { ok: false, reason: '日报不存在（不新建）', file };
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
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
  const d = new Date(now);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(docsDir, '管家报告', `${date}-${host || os.hostname()}.md`);
}
