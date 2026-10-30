// 离线层 —— 索引条摘要生成（两种通路：规则的确定性抽取 / 可选的模型润色）
//
// 默认走规则通路：直接从文档骨架里抽「标题 + 关键章节 + 各节首句」。
//   零成本、零外发、同一份文档两次生成逐字节相同 ⇒ 才能拿来做「重建后与首跑一致」的验收。
// 模型通路是可选增益：喂进去的是**压缩视图（骨架 + 各节首段截断）**，绝不是全文，
//   因此 token 可控；调用前照样过每日成本闸（次数 / token 双上限，触顶即停不重试）。
// 家人相关内容一律不送出去（按从严口径读）：命中哨兵就退回规则摘要并记一条失败。
import fs from 'node:fs';
import { textHash } from './hashes.mjs';
import { SUMMARY_MAX_CHARS, firstSentence, pickParagraph, shortTitle, stripMd } from './doc-scan.mjs';

// 每日成本闸（与提炼那条链同一档上限）
export const LLM_LIMITS = { callsPerDay: 20, tokensPerDay: 150000 };

// 喂模型的压缩视图上限（字符）；单节在视图里只留开头这么多
export const LLM_VIEW_MAX_CHARS = 4000;
export const LLM_SECTION_PREVIEW_CHARS = 220;

// 规则摘要的字符预算：标题行 90 + 章节行 170，再加 40 余量给拼接处
const SCATTER_ROOM = 90 + 170 + 40;

// 家族 / 隐私哨兵：压缩视图里出现这些词就停手申报
export const FAMILY_SENTINELS = ['家人档', '家人投喂', '家庭成员'];

// ── 成本台账 ────────────────────────────────────────────────────────────────

export const emptyCost = (date) => ({ date, calls: 0, tokens: 0 });

// 跨日重置：按本机本地日期分段，日期一变当日计数归零
export const rolloverCost = (cost, date) =>
  !cost || cost.date !== date
    ? emptyCost(date)
    : { date: cost.date, calls: Number(cost.calls) || 0, tokens: Number(cost.tokens) || 0 };

// 还能不能再调一次：次数与 token 任一触顶就拒；reason 给调用方直接落日志
export function checkCostGate(cost, limits = LLM_LIMITS) {
  const usedCalls = Number(cost?.calls);
  const usedTokens = Number(cost?.tokens);
  if (usedCalls >= limits.callsPerDay) return { allowed: false, reason: `调用次数达上限 ${limits.callsPerDay}/日` };
  if (usedTokens >= limits.tokensPerDay) return { allowed: false, reason: `token 达上限 ${limits.tokensPerDay}/日` };
  return { allowed: true, reason: '' };
}

// ── 规则摘要（默认通路） ────────────────────────────────────────────────────

// 按顺序往一行里塞片段，塞不下就丢尾；第一段就超长则硬截
function packPieces(pieces, limit) {
  let line = '';
  for (const piece of pieces) {
    if (!piece) continue;
    const grown = line ? line + piece : piece;
    if (grown.length > limit) return line || grown.slice(0, limit);
    line = grown;
  }
  return line;
}

// 每节首句（最多 5 条，每条 ≤70 字），前缀小节名
function collectBullets(sections) {
  const bullets = [];
  for (const s of sections) {
    const sentence = firstSentence(pickParagraph(s.body, 260), 70);
    if (sentence) bullets.push(`${shortTitle(s.title, 20)}：${sentence}`);
  }
  return bullets.slice(0, 5);
}

/**
 * 抽取式摘要（确定性：同一输入两次调用逐字节相同）。
 * @param {{rel:string, structure:{title:string,intro:string,sections:Array}}} doc
 * @param {{key:string,index:number,total:number,sections:Array,intro:string}} row
 */
export function buildRuleSummary(doc, row) {
  const name = doc.structure.title || doc.rel;
  const opening = row.total > 1 ? `【${name}】（第 ${row.index + 1}/${row.total} 段）` : `【${name}】`;
  const lead = row.intro ? firstSentence(pickParagraph(row.intro, 300), 110) : '';
  const chapterNames = row.sections.map((s) => shortTitle(s.title)).filter(Boolean);

  const scaffold = [
    opening,
    lead ? `说明：${lead}` : '',
    chapterNames.length ? `关键章节：${chapterNames.join('、')}` : '',
  ];
  let brief = packPieces(scaffold, SCATTER_ROOM).trim();

  // 要点逐条装：预算硬，但装不下只丢尾 —— 绝不因为「整段超限」把要点一条不留
  const room = SUMMARY_MAX_CHARS - brief.length - 5;
  if (room > 30) {
    let tail = '';
    for (const bullet of collectBullets(row.sections)) {
      const piece = `${tail ? '；' : ''}· ${bullet}`;
      if (tail.length + piece.length > room) break;
      tail += piece;
    }
    if (tail) brief += ` 要点：${tail}`;
  }

  if (brief.length > SUMMARY_MAX_CHARS) brief = `${brief.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
  // 标题行紧贴下一行时补个空格，别糊在一起
  return brief.replace(/】(说明|关键章节|要点)：/g, '】 $1：');
}

// ── 压缩视图与哨兵扫描 ──────────────────────────────────────────────────────

// 压缩视图：标题 + 引言截断 + 各节标题 + 各节首段截断。**绝不送全文**。
export function buildLlmView(
  doc,
  { maxChars = LLM_VIEW_MAX_CHARS, previewChars = LLM_SECTION_PREVIEW_CHARS } = {},
) {
  const { title, intro, sections } = doc.structure;
  const head = [`文档：${doc.rel}`, `标题：${title}`];
  const lead = firstSentence(pickParagraph(intro, 600), 300);
  if (lead) head.push(`引言：${lead}`);
  head.push('章节：');
  for (const s of sections) {
    const glimpse = firstSentence(pickParagraph(s.body, previewChars * 2), previewChars);
    head.push(glimpse ? `- ${s.title}：${glimpse}` : `- ${s.title}`);
  }
  const skeleton = head.join('\n');
  return skeleton.length > maxChars ? `${skeleton.slice(0, maxChars)}\n…[截断]` : skeleton;
}

// 哨兵扫描：返回命中的关键词列表；非空 ⇒ 调用方必须放弃外发
export function assertNoFamilyContent(doc) {
  const hay = [
    doc.rel,
    doc.structure.title,
    doc.structure.intro,
    ...doc.structure.sections.flatMap((s) => [s.title, s.body]),
  ].join('\n');
  return FAMILY_SENTINELS.filter((word) => hay.includes(word));
}

// 提示词：要求逐条 JSON，并给出每一段的序号占位
export function buildLlmPrompt(doc, rows) {
  const skeleton = buildLlmView(doc);
  const shape = rows.map((r) => `  {"index": ${r.index}, "summary": "…"}`).join(',\n');
  return [
    '你在为一个本地文档索引库生成检索摘要。只输出 JSON，不要解释、不要代码块围栏。',
    `文档路径：${doc.rel}`,
    `要求：为下面 ${rows.length} 个分段各写一条中文摘要，每条 ≤500 字，必须包含：这段覆盖的关键章节名 + 这些章节讲什么。`,
    '不要复述整篇文档；不要编造未出现的内容；不要输出 markdown 标题记号。',
    `输出格式：{"rows": [\n${shape}\n]}`,
    '',
    '=== 文档骨架（压缩视图，非全文）===',
    skeleton,
  ].join('\n');
}

// 从模型回复里稳健地抠 JSON：容忍 ```json 围栏，也容忍前后废话
export function parseLlmRows(raw) {
  const text = String(raw ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('模型输出里找不到 JSON 对象');
  const parsed = JSON.parse(body.slice(first, last + 1));
  if (!Array.isArray(parsed?.rows)) throw new Error('模型输出缺 rows 数组');
  return parsed.rows.map((r) => ({ index: Number(r.index), summary: stripMd(String(r.summary ?? '')) }));
}

// 凭证：环境变量优先，其次 `~/.dsh/.credentials.yaml` 里的简单键值（绝不打印密钥）
export const resolveApiKey = ({ env = process.env, credentialsFile } = {}) => {
  const fromEnv = String(env.DEEPSEEK_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  if (!credentialsFile) return null;
  let txt;
  try {
    txt = fs.readFileSync(credentialsFile, 'utf8');
  } catch {
    return null;
  }
  const hit = /DEEPSEEK_API_KEY\s*:\s*["']?([^"'\r\n]+)["']?/.exec(txt);
  return hit ? hit[1].trim() : null;
};

// token 估算：模型没回 usage 时的兜底记账（中文按 1 字 ≈ 1 token 保守估）
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length);

// 摘要长度闸（≤SUMMARY_MAX_CHARS；超长按字截断并补省略号）
export const clampSummary = (s) => {
  const trimmed = String(s ?? '').trim();
  return trimmed.length > SUMMARY_MAX_CHARS ? `${trimmed.slice(0, SUMMARY_MAX_CHARS - 1)}…` : trimmed;
};

// ── 模型调用 ────────────────────────────────────────────────────────────────

/**
 * 调一次便宜模型（一篇文档一次）。返回 {ok, rows, tokens, model, usage}
 * 或 {ok:false, error, rows, tokens}。`deps.fetch` 可注入 ⇒ 单测零网络。
 */
export async function callLlmOnce({ doc, rows, llm, deps = {} }) {
  const send = deps.fetch ?? globalThis.fetch;
  if (!llm.apiKey) return { ok: false, error: '缺少 DEEPSEEK_API_KEY（凭证文件或环境变量）', rows: [], tokens: 0 };

  const prompt = buildLlmPrompt(doc, rows);
  const endpoint = `${llm.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const payload = {
    model: llm.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    stream: false,
  };

  let reply;
  try {
    reply = await send(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify(payload),
      signal: deps.signal,
    });
  } catch (e) {
    return { ok: false, error: `请求失败：${String((e && e.message) || e)}`, rows: [], tokens: 0 };
  }

  let envelope;
  try {
    envelope = await reply.json();
  } catch {
    return { ok: false, error: `响应非 JSON（HTTP ${reply.status}）`, rows: [], tokens: 0 };
  }

  if (!reply.ok) {
    const detail = envelope?.error?.message || envelope?.message || `HTTP ${reply.status}`;
    return { ok: false, error: `模型报错：${detail}`, rows: [], tokens: 0 };
  }

  const content = envelope?.choices?.[0]?.message?.content ?? '';
  const usage = envelope?.usage ?? {};
  const tokens = Number(usage.total_tokens ?? 0) || estimateTokens(prompt) + estimateTokens(content);
  try {
    return { ok: true, rows: parseLlmRows(content), tokens, model: envelope?.model ?? llm.model, usage };
  } catch (e) {
    return { ok: false, error: `解析失败：${String((e && e.message) || e)}`, rows: [], tokens, raw: String(content).slice(0, 200) };
  }
}

// ── 编排 ────────────────────────────────────────────────────────────────────

// 一串行 → 规则摘要写进 byKey（规则通路 / 失败降级 / 家人命中三处共用的收口）
function emitRuleSummaries(doc, planRows, byKey) {
  for (const row of planRows) {
    const summary = buildRuleSummary(doc, row);
    byKey.set(row.key, { summary, textHash: textHash(summary) });
  }
}

// 模型答了：按 index 对号入座；对不上的那条退回规则摘要
function adoptModelRows(doc, planRows, modelRows, byKey) {
  for (const row of planRows) {
    const picked = modelRows.find((m) => m.index === row.index);
    const summary = clampSummary(picked?.summary || buildRuleSummary(doc, row));
    byKey.set(row.key, { summary, textHash: textHash(summary) });
  }
}

/**
 * 为一批文档计划生成摘要（逐篇调用，受成本闸约束）。
 * @returns {Promise<{byKey:Map<string,{summary:string,textHash:string}>, cost:object,
 *   calls:number, tokens:number, stopped:string|null, failures:Array, skippedForFamily:string[]}>}
 */
export async function summarizeAll({ docs, plans, mode = 'rule', cost, llm = null, deps = {}, date = '' }) {
  const ledger = {
    byKey: new Map(),
    cost: rolloverCost(cost, date),
    calls: 0,
    tokens: 0,
    stopped: null,
    failures: [],
    skippedForFamily: [],
  };
  const useLlm = mode === 'llm';

  for (const doc of docs) {
    const planRows = plans.get(doc.rel) ?? [];

    // 规则通路（默认）：逐条抽，零外部调用
    if (!useLlm) {
      emitRuleSummaries(doc, planRows, ledger.byKey);
      continue;
    }

    // 模型通路：先过家人哨兵（收紧口径），再过成本闸
    const familyHits = assertNoFamilyContent(doc);
    if (familyHits.length) {
      ledger.skippedForFamily.push(doc.rel);
      ledger.failures.push({
        path: doc.rel,
        error: `命中家人相关标记（${familyHits.join('/')}）⇒ 不送第三方，本轮回退规则摘要`,
      });
      emitRuleSummaries(doc, planRows, ledger.byKey);
      continue;
    }

    const gate = checkCostGate(ledger.cost, LLM_LIMITS);
    if (!gate.allowed) {
      ledger.stopped = gate.reason;
      break; // 触顶即停，剩余文档本轮不做了
    }

    const reply = await callLlmOnce({ doc, rows: planRows, llm, deps });
    const spent = Number(reply.tokens) || 0;
    ledger.calls += 1;
    ledger.tokens += spent;
    ledger.cost = { date, calls: ledger.cost.calls + 1, tokens: ledger.cost.tokens + spent };

    if (!reply.ok) {
      // 模型挂了也不报错给主人：降级成规则摘要，失败照实记一条
      ledger.failures.push({ path: doc.rel, error: reply.error });
      emitRuleSummaries(doc, planRows, ledger.byKey);
      continue;
    }

    adoptModelRows(doc, planRows, reply.rows, ledger.byKey);
  }

  return ledger;
}
