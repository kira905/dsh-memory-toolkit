// 会话日志 → 记忆条的提炼管线（零依赖）。
//
// 分工：session-source.mjs 负责「挑句子 + 记来源」，这里负责「预算闸 → 调一次模型 → 写回 → 记账」。
//
// 三条不变式（写在这里，因为它们是这张卡的全部意义）：
//   ① **没配每日预算 ⇒ 一次模型都不调**：闸在读凭证之前，也在 openai 之前。
//   ② 写库前必须拍快照（VACUUM INTO），没快照不写。
//   ③ 一批一个来源键（srcKey）⇒ 撤回器一条 `--key` 命令就能整批撤掉。
//
// 写回形态与内核一致：tags 以 `distilled` 开头（撤回器认这个前缀），
//   另加 `sess=` 与 `run=session:<runId>` 两个属性位，方便"按场次/按批次"回指。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { extractCandidates, summarizeSkipped } from './session-source.mjs';
import {
  DISTILL_PREFIX, DEFAULT_LLM, shortKey, distilledTagOf, withBusyRetry,
  localDateIso,
} from './distill.mjs';
import { extractJson, vacuumInto, readCredential } from './domain-tags.mjs';

export const STATE_SCHEMA = 1;

/** 一轮最多写几条（卡面口径：≤5）。 */
export const DEFAULT_LIMIT = 5;

/** 标签里记批次的属性位：`run=session:<runId>`。 */
export const RUN_TAG_PREFIX = 'run=session:';

/** 「没有预算」的那句人话 —— 逐字出现在 CLI、README、测试里，避免各处口径漂移。 */
export const NO_BUDGET_MESSAGE = '未配置每日预算 ⇒ 本轮不跑（这是故意的）';

const TAG_RUN_RE = /(?:^|\s)run=session:([0-9A-Za-z._-]+)(?:\s|$)/;
const TAG_SESS_RE = /(?:^|\s)sess=([^\s]+)(?:\s|$)/;

// ── 小工具 ─────────────────────────────────────────────────────────────────

const textHash = (text) => crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

/** 一批一个来源键：同一个 runId 永远映射到同一个键 ⇒ 幂等 + 整批撤回。 */
export function runKeyOf(runId) {
  return `d${textHash(`session-distill:${runId}`).slice(0, 16)}`;
}

/** 一轮的 runId 缺省值：本地时间戳 + 6 位随机，肉眼可读、也不撞车。 */
export function makeRunId(now = Date.now()) {
  const stamp = new Date(Number(now)).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `run-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/** 估算一次调用的 token（保守：提示按 1.4 字/token，输出按每条 120 token 留余量）。 */
export function estimateSessionTokens(promptChars, limit = DEFAULT_LIMIT) {
  const promptTokens = Math.ceil(Number(promptChars) / 1.4);
  const completionTokens = Math.max(240, Number(limit) * 120);
  return promptTokens + completionTokens;
}

// ── 台账（--state） ────────────────────────────────────────────────────────

export function blankState(nowIso) {
  return {
    schemaVersion: STATE_SCHEMA,
    budget: { tokensPerDay: null, source: null, updatedAt: nowIso },
    cost: { date: localDateIso(Date.parse(nowIso) || Date.now()), calls: 0, promptTokens: 0, completionTokens: 0 },
    processed: {},
    runs: [],
    updatedAt: nowIso,
  };
}

export function readState(stateFile, nowIso = new Date().toISOString()) {
  if (!stateFile || !fs.existsSync(stateFile)) return blankState(nowIso);
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const base = blankState(nowIso);
    return {
      ...base,
      ...parsed,
      budget: { ...base.budget, ...(parsed.budget ?? {}) },
      cost: { ...base.cost, ...(parsed.cost ?? {}) },
      processed: { ...(parsed.processed ?? {}) },
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
    };
  } catch (failure) {
    throw new Error(`台账读不动（${stateFile}）：${failure && failure.message ? failure.message : failure}`);
  }
}

/** 原子写：同目录临时文件 + rename（同盘，不动跨盘那条路）。 */
export function writeState(stateFile, state) {
  const abs = path.resolve(stateFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, abs);
  return abs;
}

/** 当日已花 token（跨天自动清零，但不清 processed —— 那是"这条来源句做过了"）。 */
export function spendOf(state, now = Date.now()) {
  const today = localDateIso(Number(now));
  if (String(state?.cost?.date ?? '') !== today) return 0;
  return Number(state?.cost?.promptTokens ?? 0) + Number(state?.cost?.completionTokens ?? 0);
}

/**
 * 预算闸：先看命令行给的，再看台账里配的；都没有 ⇒ tokens=null（这就是"没配预算"）。
 * ⚠️ 绝不回落到内核那个 150000 —— 没配就是没配，不是"无限"。
 */
export function resolveBudget({ flagTokens = null, state = null, now = Date.now() } = {}) {
  const pick = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const fromFlag = pick(flagTokens);
  const fromState = pick(state?.budget?.tokensPerDay);
  const tokens = fromFlag ?? fromState;
  const spent = spendOf(state, now);
  return {
    tokens,
    source: fromFlag !== null ? 'cli' : (fromState !== null ? 'state' : null),
    day: localDateIso(Number(now)),
    spent,
    remaining: tokens === null ? null : Math.max(0, tokens - spent),
    exhausted: tokens === null ? false : spent >= tokens,
  };
}

// ── 提示词与模型调用 ───────────────────────────────────────────────────────

export const SESSION_SYSTEM_RULES = Object.freeze([
  '你在做「会话日志 → 长期记忆」的提炼。输入是一场会话里挑出来的候选句（编号 + 线索类别 + 原文）。',
  '任务：从中挑出真正值得长期记住的，合并成若干条独立结论。',
  '硬约束：',
  '· 只能使用候选句里已经写明的信息；不许补常识、不许推断动机、不许加评价。',
  '· 每条结论必须报出它引用了哪几条候选（refs 写候选编号，从 1 开始）。',
  '· 同一件事的候选合并成一条；不是同一件事就分开写，不要硬凑。',
  '· 结论是中文一整段，不超过 120 字，不分点、不带 markdown；不要出现「今天/昨天/刚才/本次」这类相对时间。',
  '· 候选里挑不出值得长期记住的 ⇒ items 给空数组（宁缺勿滥）。',
  '输出：严格 JSON，形如 {"items":[{"refs":[2,5],"conclusion":"……"}]}，按重要性降序；',
  '不要代码围栏、不要解释文字、不要输出候选编号以外的字段。',
]);

export function buildSessionSystemPrompt() {
  return SESSION_SYSTEM_RULES.join('\n');
}

export function buildSessionUserPrompt(candidates, limit = DEFAULT_LIMIT) {
  const blocks = candidates.map((candidate, index) => {
    const body = String(candidate.text).replace(/\s+/g, ' ').trim();
    return `[${index + 1}] (${candidate.kind}) ${body}`;
  });
  return [
    `共 ${candidates.length} 条候选，最多输出 ${limit} 条结论。`,
    '每条结论都要用 refs 指明依据的候选编号（可多条）。',
    '',
    blocks.join('\n'),
  ].join('\n');
}

/**
 * 调一次提炼模型。`fetchImpl` 可注入 ⇒ 单测不联网。
 * 只调一次、不重试：重试等于偷花第二份钱。
 */
export async function callSessionModel({
  candidates, limit = DEFAULT_LIMIT, apiKey, baseUrl = DEFAULT_LLM.baseUrl,
  model = DEFAULT_LLM.model, fetchImpl = fetch, timeoutMs = DEFAULT_LLM.timeoutMs,
  maxTokens = DEFAULT_LLM.maxTokens, temperature = 0.2,
} = {}) {
  const payload = {
    model,
    messages: [
      { role: 'system', content: buildSessionSystemPrompt() },
      { role: 'user', content: buildSessionUserPrompt(candidates, limit) },
    ],
    thinking: { type: 'disabled' },
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs));
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    const ms = Date.now() - startedAt;
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}：${raw.slice(0, 240)}`, ms };
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (failure) {
      return { ok: false, error: `响应不是 JSON：${failure.message}`, raw: raw.slice(0, 240), ms };
    }
    const content = envelope?.choices?.[0]?.message?.content ?? '';
    const usage = envelope?.usage ?? {};
    const parsed = extractJson(content);
    if (!parsed) return { ok: false, error: '模型输出里没有可解析的 JSON', raw: String(content).slice(0, 240), usage, ms };
    const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : null);
    if (!items) return { ok: false, error: 'JSON 里没有 items 数组', raw: String(content).slice(0, 240), usage, ms };
    return { ok: true, items, usage, ms, promptChars: buildSessionSystemPrompt().length + buildSessionUserPrompt(candidates, limit).length };
  } catch (failure) {
    return { ok: false, error: `请求失败：${failure && failure.message ? failure.message : failure}`, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 收口模型输出：refs 落在 1..candidates.length 之外的、conclusion 太短的、撞车的全部剔掉，
 * 并把每条结论挂回候选的 sourceRef（这样"能回指"不靠模型自觉）。
 */
export function attachSourceRefs(items, candidates, { limit = DEFAULT_LIMIT, minChars = 8 } = {}) {
  const kept = [];
  const rejected = [];
  const seen = new Set();
  for (const item of items ?? []) {
    const text = String(item?.conclusion ?? '').trim();
    const refs = Array.isArray(item?.refs) ? item.refs.map((n) => Number(n)).filter((n) => Number.isInteger(n)) : [];
    const valid = refs.filter((n) => n >= 1 && n <= candidates.length);
    if (!text || text.length < minChars) {
      rejected.push({ why: 'too-short-or-empty', text: text.slice(0, 40) });
      continue;
    }
    if (!valid.length) {
      rejected.push({ why: 'no-valid-ref', text: text.slice(0, 40) });
      continue;
    }
    if (text.length > 120) {
      rejected.push({ why: 'over-120-chars', text: text.slice(0, 40) });
      continue;
    }
    const fingerprint = text.replace(/\s+/g, '');
    if (seen.has(fingerprint)) {
      rejected.push({ why: 'duplicate', text: text.slice(0, 40) });
      continue;
    }
    seen.add(fingerprint);
    if (kept.length >= limit) {
      rejected.push({ why: 'over-limit', text: text.slice(0, 40) });
      continue;
    }
    const refsOut = valid.map((n) => ({ index: n, kind: candidates[n - 1].kind, sourceRef: candidates[n - 1].sourceRef }));
    kept.push({
      conclusion: text,
      chars: text.length,
      refs: valid,
      candidateIndices: valid.map((n) => n - 1),
      lines: [...new Set(refsOut.map((ref) => ref.sourceRef.line))].sort((a, b) => a - b),
      sessionIds: [...new Set(refsOut.map((ref) => ref.sourceRef.sessionId))],
      anchors: refsOut.map((ref) => ({ line: ref.sourceRef.line, anchor: ref.sourceRef.anchor })),
      sources: refsOut,
    });
  }
  return { items: kept, rejected };
}

// ── 写库 ───────────────────────────────────────────────────────────────────

function hasOwnerColumns(handle) {
  try {
    const columns = handle.prepare('PRAGMA table_info(memories);').all().map((row) => row.name);
    return columns.includes('owner_user') && columns.includes('visibility');
  } catch {
    return false;
  }
}

/** 这一批的标签：内核那四个属性位 + 场次 + 批次。 */
export function sessionTagOf({ srcKey, lines, sessionId, runId, now }) {
  const base = distilledTagOf({ srcKey: shortKey(srcKey), srcIds: lines ?? [], now });
  const sess = sessionId && sessionId !== 'unknown' ? ` sess=${sessionId}` : '';
  return `${base}${sess} ${RUN_TAG_PREFIX}${runId}`;
}

export function tagsOfRun(tags) {
  const raw = String(tags ?? '');
  if (!raw.startsWith(DISTILL_PREFIX)) return null;
  const run = TAG_RUN_RE.exec(raw);
  const sess = TAG_SESS_RE.exec(raw);
  return { runId: run ? run[1] : null, sessionId: sess ? sess[1] : null };
}

/**
 * 写回一批（幂等：同一 runId 已写过就跳过；同正文已存在也跳过）。
 * 事务里逐条插，库被占用按内核那套退避重试。
 */
export async function writeSessionItems({ dbPath, items, runId, srcKey, now = Date.now(), ownerUser = null, visibility = 'private_owner', deps = {} } = {}) {
  const stamp = Number(now);
  const handle = new DatabaseSync(dbPath);
  const ids = [];
  const details = [];
  let written = 0;
  let skippedExisting = 0;
  try {
    handle.exec('PRAGMA busy_timeout = 5000;');
    const withOwner = hasOwnerColumns(handle);
    const existing = handle.prepare("SELECT id, text, tags FROM memories WHERE tags LIKE 'distilled%';").all();
    const sameRun = new Set();
    const seenText = new Set();
    for (const row of existing) {
      const meta = tagsOfRun(row.tags);
      if (meta && meta.runId === runId) sameRun.add(row.id);
      seenText.add(textHash(row.text));
    }
    const insert = withOwner
      ? handle.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at, owner_user, visibility) VALUES (?,?,0,?,?,?,?);')
      : handle.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?,?,0,?,?);');

    const outcome = await withBusyRetry(handle, () => {
      for (const item of items) {
        const digest = textHash(item.conclusion);
        if (seenText.has(digest)) {
          skippedExisting += 1;
          details.push({ action: 'already-in-db', chars: item.chars });
          continue;
        }
        const tags = sessionTagOf({ srcKey, lines: item.lines, sessionId: item.sessionIds?.[0], runId, now: stamp });
        const info = withOwner
          ? insert.run(item.conclusion, tags, stamp, stamp, ownerUser ?? 'local', visibility)
          : insert.run(item.conclusion, tags, stamp, stamp);
        const newId = Number(info.lastInsertRowid ?? 0);
        ids.push(newId);
        written += 1;
        seenText.add(digest);
        details.push({ action: 'written', id: newId, chars: item.chars, lines: item.lines, tags });
      }
      return { written, skippedExisting };
    }, deps);

    return { written, skippedExisting, ids, details, ok: outcome.ok, error: outcome.error ?? null, sameRunRows: sameRun.size, ownerColumns: withOwner };
  } finally {
    try { handle.close(); } catch { /* 关不掉不影响结果 */ }
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

const uniq = (list) => [...new Set(list.filter(Boolean))];

/**
 * 跑一轮「会话 → 记忆」。缺省 dry-run：只抽、只规划，不调模型、不写库、不写台账。
 *
 * @returns {object} 结果对象（含 stopping 与人话 message），CLI 只负责把它讲出来。
 */
export async function runSessionDistill(opts = {}) {
  const now = Number(opts.now ?? Date.now());
  const nowIso = new Date(now).toISOString();
  const mode = opts.apply ? 'apply' : 'dry-run';
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) >= 1 ? Number(opts.limit) : DEFAULT_LIMIT;
  const runId = String(opts.runId ?? makeRunId(now));
  const srcKey = runKeyOf(runId);
  const stateFile = opts.stateFile ? path.resolve(opts.stateFile) : null;
  const warnings = [];
  const result = {
    ok: true, mode, at: nowIso, runId, srcKey: shortKey(srcKey), source: null, extraction: null,
    budget: null, stopping: null, message: null, calls: 0, tokens: null, planned: [], model: null,
    written: 0, writtenIds: [], snapshot: null, stateFile, warnings, exitCode: 0,
  };

  // ① 抽句（纯本地，不花钱）
  let extraction;
  try {
    extraction = extractCandidates({
      file: opts.source,
      text: opts.text,
      sessionId: opts.sessionId,
      defaults: { maxChars: opts.maxChars ?? undefined },
    });
  } catch (failure) {
    result.ok = false;
    result.exitCode = failure?.code === 'SOURCE_MISSING' ? 3 : 3;
    result.stopping = 'SOURCE_UNREADABLE';
    result.message = String(failure?.message ?? failure);
    return result;
  }
  result.source = { file: extraction.file, sessionId: extraction.sessionId, compressed: extraction.compressed, note: extraction.note };
  result.extraction = {
    lines: extraction.lines, events: extraction.events, candidates: extraction.candidates.length,
    skipped: extraction.skipped, skippedLine: summarizeSkipped(extraction.skipped),
  };
  result.warnings.push(...extraction.warnings);
  if (extraction.note) result.warnings.push(extraction.note);
  const candidates = extraction.candidates;

  if (!candidates.length) {
    result.stopping = 'NO_CANDIDATES';
    result.message = '这份日志里没有抽到能回指来源的结论句 ⇒ 不调模型、不写库（抽句统计见 skipped）';
    return result;
  }

  // ② 预算闸 —— 必须在读凭证、调模型之前
  const state = stateFile ? readState(stateFile, nowIso) : blankState(nowIso);
  const budget = resolveBudget({ flagTokens: opts.maxTokens, state, now });
  result.budget = budget;
  if (budget.tokens === null) {
    result.stopping = 'NO_BUDGET';
    result.message = NO_BUDGET_MESSAGE;
    return result;
  }
  if (budget.exhausted) {
    result.stopping = 'BUDGET_SPENT';
    result.message = `今日已用 ${budget.spent} / 预算 ${budget.tokens} token ⇒ 本轮不跑（等明天或调高预算）`;
    return result;
  }

  // ③ 去重：台账记过的来源句不再产（同一句反复进模型 = 重复花钱）
  const pending = candidates.filter((candidate) => {
    const key = processedKey(extraction.file, extraction.sessionId, candidate);
    return !state.processed?.[key];
  });
  const alreadyProcessed = candidates.length - pending.length;
  if (alreadyProcessed) warnings.push(`${alreadyProcessed} 条候选在台账里已产出过（按「文件 + 行号 + 句子哈希」认），本批跳过`);
  if (!pending.length) {
    result.stopping = 'ALL_PROCESSED';
    result.message = '候选句都产出过 ⇒ 本轮无事可做（不调模型）';
    return result;
  }

  // ④ 估算过闸：这一次调用会超预算就干脆不调
  const promptChars = buildSessionSystemPrompt().length + buildSessionUserPrompt(pending, limit).length;
  const estimated = estimateSessionTokens(promptChars, limit);
  result.tokens = { estimated, promptChars, reservedCompletion: Math.max(240, limit * 120) };
  if (estimated > budget.remaining) {
    result.stopping = 'ESTIMATE_OVER';
    result.message = `本轮估算 ${estimated} token > 今日剩余 ${budget.remaining}（已用 ${budget.spent}/${budget.tokens}）⇒ 不跑`;
    return result;
  }

  // ⑤ dry-run 到此为止：把"会写什么"讲清楚，一个字节都不动
  result.planned = pending.slice(0, limit * 2).map((candidate, index) => ({
    index: index + 1, kind: candidate.kind, chars: candidate.chars,
    text: candidate.text, anchor: candidate.sourceRef.anchor, line: candidate.sourceRef.line,
  }));
  if (!opts.apply) {
    result.message = `dry-run：抽到 ${candidates.length} 条候选、待产 ${pending.length} 条（最多写 ${limit} 条）；`
      + `估算 ${estimated} token / 今日剩余 ${budget.remaining}，库与台账都没动`;
    return result;
  }

  // ⑥ 凭证
  const apiKey = opts.apiKey || readCredential(DEFAULT_LLM.credentialKey);
  if (!apiKey) {
    result.ok = false;
    result.exitCode = 1;
    result.stopping = 'NO_CREDENTIAL';
    result.message = `读不到凭证 ${DEFAULT_LLM.credentialKey}（.credentials.yaml）`;
    return result;
  }

  // ⑦ 写库前快照（唯一回滚点，没拍成就别写）
  const snapshotFile = opts.snapshotFile
    ?? path.join(opts.snapshotDir ?? path.join(path.dirname(opts.dbPath ?? ''), 'snapshots'), `memory-before-session-distill-${runId}.db`);
  try {
    vacuumInto(opts.dbPath, snapshotFile);
    result.snapshot = snapshotFile;
  } catch (failure) {
    result.ok = false;
    result.exitCode = 1;
    result.stopping = 'SNAPSHOT_FAILED';
    result.message = `写库前快照失败 ⇒ 按规矩不写库：${failure && failure.message ? failure.message : failure}`;
    return result;
  }

  // ⑧ 调一次模型
  const call = await callSessionModel({
    candidates: pending, limit, apiKey,
    baseUrl: opts.baseUrl ?? DEFAULT_LLM.baseUrl,
    model: opts.model ?? DEFAULT_LLM.model,
    fetchImpl: opts.fetchImpl ?? fetch,
    timeoutMs: opts.timeoutMs ?? DEFAULT_LLM.timeoutMs,
    maxTokens: opts.modelMaxTokens ?? DEFAULT_LLM.maxTokens,
  });
  result.calls = 1;
  const usage = call.usage ?? {};
  const promptTokens = Number(usage.prompt_tokens ?? 0) || Math.ceil(promptChars / 1.4);
  const completionTokens = Number(usage.completion_tokens ?? 0) || Math.max(0, estimated - Math.ceil(promptChars / 1.4));
  result.model = { ok: Boolean(call.ok), error: call.error ?? null, ms: call.ms ?? null, promptTokens, completionTokens, model: opts.model ?? DEFAULT_LLM.model };

  // 无论成败都记账（失败也花了 token，装看不见等于浪费下一天的额度）
  const charged = {
    date: budget.day,
    calls: 1,
    promptTokens,
    completionTokens,
  };
  state.cost = mergeCost(state, budget, charged);

  if (!call.ok) {
    result.ok = false;
    result.exitCode = 1;
    result.stopping = 'MODEL_FAILED';
    result.message = `模型调用失败（已记账 ${promptTokens + completionTokens} token）：${call.error}`;
    persistRun({ state, stateFile, result, runId, nowIso, mode, extraction, pending, limit, budget, now });
    return result;
  }

  // ⑨ 收口 + 写库
  const { items, rejected } = attachSourceRefs(call.items, pending, { limit });
  result.rejected = rejected;
  if (!items.length) {
    result.stopping = 'NOTHING_KEPT';
    result.message = '模型给回来的条目没有一条能挂回候选（或都不值得留）⇒ 不写库（已花的 token 已记账）';
    persistRun({ state, stateFile, result, runId, nowIso, mode, extraction, pending, limit, budget, now });
    return result;
  }
  const write = await writeSessionItems({
    dbPath: opts.dbPath, items, runId, srcKey, now,
    ownerUser: opts.ownerUser ?? null, visibility: opts.visibility ?? 'private_owner', deps: opts.deps ?? {},
  });
  result.ownerColumns = write.ownerColumns;
  if (write.ownerColumns && !opts.ownerUser) warnings.push('库有 owner_user 列但没给 --owner-user ⇒ 按 local 落库（回指仍然靠标签）');
  if (!write.ok) {
    result.ok = false;
    result.exitCode = 1;
    result.stopping = 'WRITE_FAILED';
    result.message = `写库失败（快照在 ${snapshotFile}，可整批撤回）：${write.error}`;
    persistRun({ state, stateFile, result, runId, nowIso, mode, extraction, pending, limit, budget, now });
    return result;
  }
  result.written = write.written;
  result.writtenIds = write.ids;
  result.skippedExisting = write.skippedExisting;
  result.planned = items.map((item, index) => ({
    index: index + 1, chars: item.chars, lines: item.lines, anchors: item.anchors, conclusion: item.conclusion, refs: item.refs,
  }));

  // ⑩ 台账：已产出的来源句 + 本轮摘要
  for (const item of items) {
    for (const index of item.candidateIndices ?? []) {
      const candidate = pending[index];
      if (candidate) state.processed[processedKey(extraction.file, extraction.sessionId, candidate)] = nowIso;
    }
  }
  result.message = `已写 ${write.written} 条（跳过已存在 ${write.skippedExisting} 条），批次键 ${result.srcKey} ⇒ 撤回：`
    + `node memory-engine/cli/distill-rollback.mjs --db <memory.db> --key ${result.srcKey} --apply`;
  persistRun({ state, stateFile, result, runId, nowIso, mode, extraction, pending, limit, budget, now });
  return result;
}

/** 台账里"这条来源句做过了"的键：文件 + 行号 + 句子哈希（换文件/换行都不会误判）。 */
export function processedKey(file, sessionId, candidate) {
  const where = file ? path.basename(file) : (sessionId ?? 'unknown');
  return `${where}:${candidate?.sourceRef?.line ?? 0}:${textHash(candidate?.text ?? '').slice(0, 12)}`;
}

function mergeCost(state, budget, charged) {
  const sameDay = String(state?.cost?.date ?? '') === budget.day;
  return {
    date: budget.day,
    calls: (sameDay ? Number(state.cost?.calls ?? 0) : 0) + charged.calls,
    promptTokens: (sameDay ? Number(state.cost?.promptTokens ?? 0) : 0) + charged.promptTokens,
    completionTokens: (sameDay ? Number(state.cost?.completionTokens ?? 0) : 0) + charged.completionTokens,
  };
}

function persistRun({ state, stateFile, result, runId, nowIso, mode, extraction, pending, limit, budget, now }) {
  if (!stateFile) return;
  if (Number(budget?.tokens ?? 0) > 0 && budget.source === 'cli') {
    state.budget = { tokensPerDay: budget.tokens, source: 'cli', updatedAt: nowIso };
  }
  state.lastRun = {
    runId, at: nowIso, mode, srcKey: result.srcKey,
    source: { file: extraction.file, sessionId: extraction.sessionId, candidates: pending.length },
    limit, budget: { tokens: budget.tokens, spent: budget.spent },
    calls: result.calls, tokens: result.model ? result.model.promptTokens + result.model.completionTokens : 0,
    written: result.written, writtenIds: result.writtenIds, stopping: result.stopping, snapshot: result.snapshot,
  };
  state.runs = [...(state.runs ?? []), {
    runId, at: nowIso, mode, written: result.written, calls: result.calls,
    promptTokens: result.model?.promptTokens ?? 0, completionTokens: result.model?.completionTokens ?? 0,
    stopping: result.stopping,
  }].slice(-20);
  state.updatedAt = nowIso;
  writeState(stateFile, state);
  result.stateWritten = stateFile;
}

/** 已写过哪些批次（给"这个 run 写过没"这类问题用；只读）。 */
export function listSessionRuns(dbPath) {
  const handle = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = handle.prepare("SELECT tags FROM memories WHERE tags LIKE 'distilled%';").all();
    const runs = new Map();
    for (const row of rows) {
      const meta = tagsOfRun(row.tags);
      if (!meta?.runId) continue;
      runs.set(meta.runId, (runs.get(meta.runId) ?? 0) + 1);
    }
    return [...runs.entries()].map(([runId, rows2]) => ({ runId, rows: rows2 }));
  } finally {
    try { handle.close(); } catch { /* ignore */ }
  }
}


