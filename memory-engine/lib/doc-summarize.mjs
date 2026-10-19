// 记忆引擎 v2 · 离线层 —— 索引条摘要生成（方案 §3.2 粒度 + §3.5 成本闸）
//
// 两条通路，**默认 rule（确定性抽取式，零外部调用）**：
//   · `rule`  —— 从文档结构直接抽取（标题 + 关键章节 + 各节首句）。零成本、零外发、
//     可复现（同一文档两次生成逐字节相同）⇒ 满足本卡「重建到与首跑一致」与「幂等」两条验收。
//   · `llm`   —— 便宜模型批量润色（方案 §3.2 原语句「摘要生成：便宜模型批量（一次性成本）」）。
//     **输入是压缩视图（骨架 + 各节首段截断），不是全文** ⇒ token 可控；受 §3.5 同一成本闸
//     （调用 ≤20 次/日、token ≤150K/日、超限即停 + 日报一行）。
// ⚠️ 家人相关数据不进第三方（方案 §3.5/§3.6 订正注：按 D2 从严读）——见 `assertNoFamilyContent`。
import fs from 'node:fs';
import { textHash } from './hashes.mjs';
import { SUMMARY_MAX_CHARS, firstSentence, pickParagraph, shortTitle, stripMd } from './doc-scan.mjs';

/** §3.5 成本闸（与提炼 job 同一上限；先定，实测后调）。 */
export const LLM_LIMITS = { callsPerDay: 20, tokensPerDay: 150000 };

/** 压缩视图上限（喂 LLM 的骨架文本；不是全文）。 */
export const LLM_VIEW_MAX_CHARS = 4000;
/** 单节在压缩视图里的截断长度。 */
export const LLM_SECTION_PREVIEW_CHARS = 220;

/** 规则摘要的片段预算（合计 ≤ SUMMARY_MAX_CHARS）。 */
const BUDGET = {
  head: 90,
  chapters: 170,
  points: 240,
};

// ---------------------------------------------------------------- 成本闸

/** 当日成本台账的空态。 */
export function emptyCost(date) {
  return { date, calls: 0, tokens: 0 };
}

/** 跨日重置（口径：按**本机本地日期**分段）。 */
export function rolloverCost(cost, date) {
  if (!cost || cost.date !== date) return emptyCost(date);
  return { date: cost.date, calls: Number(cost.calls) || 0, tokens: Number(cost.tokens) || 0 };
}

/**
 * 成本闸判定（超限即停，不重试——方案 §3.5）。
 * @returns {{allowed:boolean, reason:string}}
 */
export function checkCostGate(cost, limits = LLM_LIMITS) {
  if (Number(cost?.calls) >= limits.callsPerDay) {
    return { allowed: false, reason: `调用次数达上限 ${limits.callsPerDay}/日` };
  }
  if (Number(cost?.tokens) >= limits.tokensPerDay) {
    return { allowed: false, reason: `token 达上限 ${limits.tokensPerDay}/日` };
  }
  return { allowed: true, reason: '' };
}

// ---------------------------------------------------------------- 规则摘要（默认）

/** 摘要片段拼装：按预算装，装不下就丢尾（保证 ≤500 字且截断可预期）。 */
function joinWithin(parts, maxChars) {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    const next = out ? `${out}${p}` : p;
    if (next.length > maxChars) return out || next.slice(0, maxChars);
    out = next;
  }
  return out;
}

/**
 * 抽取式摘要（确定性：同一输入两次调用逐字节相同）。
 * @param {{rel:string, structure:{title:string,intro:string,sections:Array}}} doc
 * @param {{key:string,index:number,total:number,sections:Array, intro:string}} row
 */
export function buildRuleSummary(doc, row) {
  const title = doc.structure.title || doc.rel;
  const head =
    row.total > 1
      ? `【${title}】（第 ${row.index + 1}/${row.total} 段）`
      : `【${title}】`;

  const introLine = row.intro ? firstSentence(pickParagraph(row.intro, 300), 110) : '';
  const chapters = row.sections.map((s) => shortTitle(s.title)).filter(Boolean);
  const chapterLine = chapters.length ? `关键章节：${chapters.join('、')}` : '';

  // 要点：每节首句（上限 5 条，每条 ≤70 字）
  const points = [];
  for (const s of row.sections) {
    if (points.length >= 5) break;
    const p = firstSentence(pickParagraph(s.body, 260), 70);
    if (p) points.push(`${shortTitle(s.title, 20)}：${p}`);
  }

  const parts = [head];
  if (introLine) parts.push(`说明：${introLine}`);
  if (chapterLine) parts.push(chapterLine);
  let summary = joinWithin(parts, BUDGET.head + BUDGET.chapters + 40).trim();
  // 要点：**逐条装**——预算是硬的，但装不下只丢尾，绝不因为"整段超限"把要点全删
  //（实测踩过：6 个长章节名吃掉 142 字后，原先的整段装法直接 return，索引条里一条要点都没有）
  const remain = SUMMARY_MAX_CHARS - summary.length - 5;
  if (points.length && remain > 30) {
    let acc = '';
    for (const p of points) {
      const piece = `${acc ? '；' : ''}· ${p}`;
      if (acc.length + piece.length > remain) break;
      acc += piece;
    }
    if (acc) summary += ` 要点：${acc}`;
  }
  if (summary.length > SUMMARY_MAX_CHARS) summary = `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
  return summary.replace(/】(说明|关键章节|要点)：/g, '】 $1：');
}

// ---------------------------------------------------------------- LLM 通路（可选）

/** 家族/隐私哨兵：输入里出现这些标记 ⇒ 停手申报（D2 从严读）。 */
export const FAMILY_SENTINELS = ['家人档', '家人投喂', '家庭成员'];

/**
 * 压缩视图（喂 LLM 的输入）：标题 + 引言截断 + 各节标题 + 各节首段截断。
 * **绝不送全文**（token 闸的物理前提）。
 */
export function buildLlmView(doc, { maxChars = LLM_VIEW_MAX_CHARS, previewChars = LLM_SECTION_PREVIEW_CHARS } = {}) {
  const { title, intro, sections } = doc.structure;
  const lines = [`文档：${doc.rel}`, `标题：${title}`];
  const introS = firstSentence(pickParagraph(intro, 600), 300);
  if (introS) lines.push(`引言：${introS}`);
  lines.push('章节：');
  for (const s of sections) {
    const prev = firstSentence(pickParagraph(s.body, previewChars * 2), previewChars);
    lines.push(`- ${s.title}${prev ? `：${prev}` : ''}`);
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[截断]` : text;
}

/** 压缩视图里的家人哨兵扫描（命中的路径名单；非空 ⇒ 调用方必须停手申报）。 */
export function assertNoFamilyContent(doc) {
  const hay = `${doc.rel}\n${doc.structure.title}\n${doc.structure.intro}\n${doc.structure.sections
    .map((s) => `${s.title}\n${s.body}`)
    .join('\n')}`;
  return FAMILY_SENTINELS.filter((k) => hay.includes(k));
}

/** 提示词（要求 JSON 输出，逐条 ≤500 字）。 */
export function buildLlmPrompt(doc, rows) {
  const view = buildLlmView(doc);
  const ask = rows
    .map((r) => `  {"index": ${r.index}, "summary": "…"}`)
    .join(',\n');
  return [
    '你在为一个本地文档索引库生成检索摘要。只输出 JSON，不要解释、不要代码块围栏。',
    `文档路径：${doc.rel}`,
    `要求：为下面 ${rows.length} 个分段各写一条中文摘要，每条 ≤500 字，必须包含：这段覆盖的关键章节名 + 这些章节讲什么。`,
    '不要复述整篇文档；不要编造未出现的内容；不要输出 markdown 标题记号。',
    `输出格式：{"rows": [\n${ask}\n]}`,
    '',
    '=== 文档骨架（压缩视图，非全文）===',
    view,
  ].join('\n');
}

/** 从模型回复里稳健地抽出 JSON（容忍 ```json 围栏与前后废话）。 */
export function parseLlmRows(raw) {
  const s = String(raw ?? '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型输出里找不到 JSON 对象');
  const obj = JSON.parse(body.slice(start, end + 1));
  const rows = Array.isArray(obj?.rows) ? obj.rows : null;
  if (!rows) throw new Error('模型输出缺 rows 数组');
  return rows.map((r) => ({ index: Number(r.index), summary: stripMd(String(r.summary ?? '')) }));
}

/** 读凭证（`DEEPSEEK_API_KEY` 环境变量 > `~/.dsh/.credentials.yaml` 的简单解析；不打印密钥）。 */
export function resolveApiKey({ env = process.env, credentialsFile } = {}) {
  if (env.DEEPSEEK_API_KEY && String(env.DEEPSEEK_API_KEY).trim()) return String(env.DEEPSEEK_API_KEY).trim();
  if (!credentialsFile) return null;
  try {
    const txt = fs.readFileSync(credentialsFile, 'utf8');
    const m = /DEEPSEEK_API_KEY\s*:\s*["']?([^"'\r\n]+)["']?/.exec(txt);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * 调一次便宜模型（一篇文档一次调用）；返回 { ok, rows, tokens, model, error }。
 * `deps.fetch` 可注入 ⇒ 单测零网络。
 */
export async function callLlmOnce({ doc, rows, llm, deps = {} }) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const key = llm.apiKey;
  if (!key) return { ok: false, error: '缺少 DEEPSEEK_API_KEY（凭证文件或环境变量）', rows: [], tokens: 0 };
  const prompt = buildLlmPrompt(doc, rows);
  let res;
  try {
    res = await doFetch(`${llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        stream: false,
      }),
      signal: deps.signal,
    });
  } catch (e) {
    return { ok: false, error: `请求失败：${String((e && e.message) || e)}`, rows: [], tokens: 0 };
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, error: `响应非 JSON（HTTP ${res.status}）`, rows: [], tokens: 0 };
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
    return { ok: false, error: `模型报错：${msg}`, rows: [], tokens: 0 };
  }
  const raw = body?.choices?.[0]?.message?.content ?? '';
  const usage = body?.usage ?? {};
  const tokens = Number(usage.total_tokens ?? 0) || estimateTokens(prompt) + estimateTokens(raw);
  try {
    const parsed = parseLlmRows(raw);
    return { ok: true, rows: parsed, tokens, model: body?.model ?? llm.model, usage };
  } catch (e) {
    return { ok: false, error: `解析失败：${String((e && e.message) || e)}`, rows: [], tokens, raw: String(raw).slice(0, 200) };
  }
}

/** token 估算（模型未返回 usage 时的兜底记账；中文按 1 字 ≈ 1 token 保守估）。 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length);
}

/**
 * 为一批文档计划生成摘要（逐篇调用；受成本闸约束）。
 * @returns {Promise<{byKey:Map<string,{summary:string,textHash:string}>, cost:object,
 *   calls:number, tokens:number, stopped:string|null, failures:Array, skippedForFamily:string[]}>}
 */
export async function summarizeAll({ docs, plans, mode = 'rule', cost, llm = null, deps = {}, date = '' }) {
  const byKey = new Map();
  const failures = [];
  const skippedForFamily = [];
  let calls = 0;
  let tokens = 0;
  let stopped = null;
  let working = rolloverCost(cost, date);

  for (const doc of docs) {
    const rows = plans.get(doc.rel) ?? [];
    if (mode !== 'llm') {
      for (const r of rows) {
        const summary = buildRuleSummary(doc, r);
        byKey.set(r.key, { summary, textHash: textHash(summary) });
      }
      continue;
    }
    // LLM 通路：先过家人哨兵（D2 从严读），再过成本闸
    const family = assertNoFamilyContent(doc);
    if (family.length) {
      skippedForFamily.push(doc.rel);
      failures.push({ path: doc.rel, error: `家人相关标记命中（${family.join('/')}）⇒ 按 D2 从严读不送第三方，改用规则摘要` });
      for (const r of rows) {
        const summary = buildRuleSummary(doc, r);
        byKey.set(r.key, { summary, textHash: textHash(summary) });
      }
      continue;
    }
    const gate = checkCostGate(working, LLM_LIMITS);
    if (!gate.allowed) {
      stopped = gate.reason;
      break; // 超限即停（不重试）
    }
    const res = await callLlmOnce({ doc, rows, llm, deps });
    calls += 1;
    tokens += Number(res.tokens) || 0;
    working = { date, calls: working.calls + 1, tokens: working.tokens + (Number(res.tokens) || 0) };
    if (!res.ok) {
      failures.push({ path: doc.rel, error: res.error });
      for (const r of rows) {
        const summary = buildRuleSummary(doc, r); // 失败降级到规则摘要（不报错给主人）
        byKey.set(r.key, { summary, textHash: textHash(summary) });
      }
      continue;
    }
    for (const r of rows) {
      const hit = res.rows.find((x) => x.index === r.index);
      const summary = clampSummary(hit?.summary || buildRuleSummary(doc, r));
      byKey.set(r.key, { summary, textHash: textHash(summary) });
    }
  }
  return { byKey, cost: working, calls, tokens, stopped, failures, skippedForFamily };
}

/** 摘要长度闸（≤500 字；超长按字截断）。 */
export function clampSummary(s) {
  const t = String(s ?? '').trim();
  return t.length > SUMMARY_MAX_CHARS ? `${t.slice(0, SUMMARY_MAX_CHARS - 1)}…` : t;
}
