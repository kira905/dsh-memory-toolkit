#!/usr/bin/env node
// capture-ledger.mjs —— 会话提炼记忆 · **T2 跨运行账本**（cursor 只前进 + seen[textHash] + retention）
//
// 真源：`docs\方案-V3功能面-会话提炼记忆-20261026.md` §4-3（结构 / 三条硬口径 / 写入顺序 / retention）
//       + 过审 E1（`runs[]` 补 `cost` / `writtenIds` / `failed` 三字段）+ E2（`runs` 90 天保留）
//       + §5 J6（幂等）/ J7（游标只前进）
//
// ── 三条硬口径（改这里之前先读）──────────────────────────────────────────────
//   ① **游标只前进**：`throughSeq = max(旧, 新)`。绝不因为"这轮重跑"回退 —— 回退会让同一批候选被
//      反复判、反复落库。
//   ② **`textHash` 是去重键，不是运行键**：同一事实换会话出现（跨会话 twin）⇒ 命中 `seen` ⇒ 直接弃，
//      不再调 LLM。`runId` 只用来"按批次撤销"（配 `rollback-capture.mjs --run`），不参与去重。
//   ③ **先库后账**：本件**只负责账**。写库在前（T3 的 writeMemories）⇒ 拿到 memoryId ⇒ 再 `markSeen()`。
//      反过来的失败是"静默丢知识"（账本说处理过、库里没有），不可恢复。
//
// ── 本件不干什么 ────────────────────────────────────────────────────────────
//   · 不写生产 `memory.db`（一行都不写；本件**不 import sqlite**）；
//   · 不调 LLM、不发网络；
//   · 不做"关段"判断（那是 T3 的闸文件）；读不出来时只如实给 `status`，由调用方 fail-closed。
//
// ── 两处刻意偏离方案字面（都写在这里，交付报告同款登记）──────────────────────
//   ① home 解析用 `lib\session-capture.mjs#resolveCaptureHome`（`--home` > $DSH_HOME > $BUTLER_DSH_HOME > ~/.dsh），
//      **没有**用 `dsh-butler/lib/state-paths.mjs#resolveStatePath`：那是 butler 状态文件的"新旧名迁移层"
//      （`butler-` 前缀 + mode 判定），本件的固定子路径 `memory-capture/ledger.json` 没有迁移语义；更关键的是
//      **它的 home 优先级是 BUTLER_DSH_HOME 优先**，与 `shadow-capture.mjs`（DSH_HOME 优先）不同 ⇒
//      一条流水线里两个 home = "读一个 home、写另一个 home"（方案 §5-④ 明写的坑）。**一个 home 比"照字面"重要。**
//   ② 原子写**照 `dsh-butler/lib/store.mjs#writeTextAtomic` 的语义自己实现**（tmp → fsync → rename → 占用重试
//      50/150/400ms → 失败保留 tmp 抛错，绝不退化为直写目标），不 import 它：那个模块会连带拉起
//      `production-guard` 的 R-065 删除/搬移闸（对"写账本"这种高频小写是多余风险面）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 账本与提取层必须认同一个 home（见上「偏离①」）。
import { resolveCaptureHome } from './session-capture.mjs';
// 去重口径复用既有件（与 capture-judge / shadow-verdict 同一套规范化，不另立第二套）。
import { normalizeText } from '../../lib/text-similarity.mjs';

export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_DIR = 'memory-capture';
export const LEDGER_FILE = 'ledger.json';
/** `runs[]` 保留天数（§4-3 retention：更老的丢，库里有 `capture:` 标签可反查）。 */
export const RUNS_RETENTION_DAYS = 90;
/** `seen[textHash].textHead` 只留头部（不存全文）。 */
export const TEXT_HEAD_CHARS = 60;

/** 账本路径：`<home>\memory-capture\ledger.json`。 */
export function ledgerPath(home = resolveCaptureHome()) {
  return path.join(path.resolve(home), LEDGER_DIR, LEDGER_FILE);
}

const iso = (ms = Date.now()) => new Date(Number(ms)).toISOString();

/**
 * 当日/成本日的口径（**UTC 日**，与 `dsh-butler/lib/p4-digest.mjs#p4CostDay` 同一表达式）。
 * ⚠️ 不 import 那个函数（它连带 store/guards）；T5 统一预算闸时再收敛成一份引用。
 */
export const costDay = (nowMs = Date.now()) => new Date(Number(nowMs)).toISOString().slice(0, 10);

/** 空账本（全新起点）。 */
export function emptyLedger(nowMs = Date.now()) {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    updatedAt: iso(nowMs),
    cursor: {},
    seen: {},
    cost: { day: costDay(nowMs), calls: 0, tokens: 0 },
    runs: [],
  };
}

/** 形状兜底（缺哪段补哪段；不认识的多余键**保留**，不静默丢数据）。 */
export function normalizeLedger(raw, nowMs = Date.now()) {
  const base = raw && typeof raw === 'object' ? { ...raw } : {};
  return {
    ...base,
    schemaVersion: Number(base.schemaVersion ?? LEDGER_SCHEMA_VERSION),
    updatedAt: typeof base.updatedAt === 'string' ? base.updatedAt : iso(nowMs),
    cursor: base.cursor && typeof base.cursor === 'object' ? base.cursor : {},
    seen: base.seen && typeof base.seen === 'object' ? base.seen : {},
    cost: base.cost && typeof base.cost === 'object'
      ? { day: String(base.cost.day ?? costDay(nowMs)), calls: Number(base.cost.calls ?? 0), tokens: Number(base.cost.tokens ?? 0) }
      : { day: costDay(nowMs), calls: 0, tokens: 0 },
    runs: Array.isArray(base.runs) ? base.runs : [],
  };
}

/**
 * 读账本（**fail-closed 的第一步**：读不出来就如实报状态，绝不"当空的继续跑"）。
 * @returns {{status:'missing'|'ok'|'recovered-bak'|'corrupt'|'schema-newer', ledger:object|null, file:string, error?:string}}
 */
export function readLedger(file = ledgerPath()) {
  const bak = file + '.bak';
  const parseFile = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!fs.existsSync(file)) return { status: 'missing', ledger: emptyLedger(), file };
  let doc;
  try { doc = parseFile(file); } catch (e) {
    if (fs.existsSync(bak)) {
      try {
        const fromBak = normalizeLedger(parseFile(bak));
        return { status: 'recovered-bak', ledger: fromBak, file, error: `主账本坏（${e?.message ?? e}），已用 .bak` };
      } catch { /* 落到下面 corrupt */ }
    }
    return { status: 'corrupt', ledger: null, file, error: String(e?.message ?? e) };
  }
  const normalized = normalizeLedger(doc);
  if (normalized.schemaVersion > LEDGER_SCHEMA_VERSION) {
    return { status: 'schema-newer', ledger: null, file, error: `账本 schemaVersion=${normalized.schemaVersion} > 本件 ${LEDGER_SCHEMA_VERSION}` };
  }
  return { status: 'ok', ledger: normalized, file };
}

/** 原子写（语义照 `store.mjs#writeTextAtomic`；写前先把旧内容留一份 `.bak`）。 */
export function writeLedger(file = ledgerPath(), ledger, opts = {}) {
  const doc = { ...normalizeLedger(ledger, opts.nowMs ?? Date.now()), updatedAt: iso(opts.nowMs ?? Date.now()) };
  const text = JSON.stringify(doc, null, 2) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, file + '.bak'); } catch (e) { if (opts.strictBak) throw new Error(`.bak 写失败：${e?.message ?? e}`); }
  }
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const delays = opts.retryDelaysMs ?? [50, 150, 400];
  let lastErr;
  for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return { ok: true, file, bytes: Buffer.byteLength(text, 'utf8'), attempts: attempt, ledger: doc };
    } catch (e) {
      lastErr = e;
      if (attempt <= delays.length) sleepSync(delays[attempt - 1]);
    }
  }
  throw new Error(`原子写失败（保留 ${tmp} 待下次覆盖）：${lastErr?.code ?? ''} ${lastErr?.message ?? lastErr}`);
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// seen[textHash] —— 去重键（§4-3 硬口径②）
// ═══════════════════════════════════════════════════════════════════════════

/** `textHash = sha256(normalize(claim + quote))` —— 规范化走既有件，不另立第二套。 */
export function textHashOf(claim, quote) {
  const s = normalizeText(`${claim ?? ''}\n${quote ?? ''}`);
  return 'sha256:' + crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

export function isSeen(ledger, textHash) {
  return Boolean(ledger?.seen && Object.prototype.hasOwnProperty.call(ledger.seen, textHash));
}

/**
 * 记一条 seen（**必须在库写成功之后调用** —— 硬口径③）。
 * `verdict` = '记' | '弃' | 'borderline'（弃的也要记：否则下轮还会重判同一条）。
 */
export function markSeen(ledger, textHash, { verdict, memoryId = null, runId = null, textHead = '', nowMs = Date.now() } = {}) {
  if (!ledger.seen) ledger.seen = {};
  const prev = ledger.seen[textHash] ?? null;
  const head = String(textHead ?? prev?.textHead ?? '').slice(0, TEXT_HEAD_CHARS);
  ledger.seen[textHash] = {
    firstSeenAt: prev?.firstSeenAt ?? iso(nowMs),
    verdict: String(verdict ?? '弃'),
    memoryId: verdict === '记' ? (Number.isInteger(Number(memoryId)) ? Number(memoryId) : null) : (memoryId ?? null),
    runId: runId ?? prev?.runId ?? null,
    textHead: head,
  };
  return ledger.seen[textHash];
}

/** 拆一批条目：命中 seen 的进 `seen`，其余进 `fresh`（这一对就是 J6 的判据）。 */
export function filterUnseen(ledger, items, { hashOf } = {}) {
  const pick = hashOf ?? ((it) => it?.textHash ?? textHashOf(it?.claim, it?.quote));
  const seen = [];
  const fresh = [];
  for (const it of items ?? []) {
    const h = pick(it);
    if (isSeen(ledger, h)) seen.push({ ...it, textHash: h });
    else fresh.push({ ...it, textHash: h });
  }
  return { fresh, seen };
}

// ═══════════════════════════════════════════════════════════════════════════
// cursor —— 只前进（§4-3 硬口径① / J7）
// ═══════════════════════════════════════════════════════════════════════════

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const newerIso = (a, b) => {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
};

/**
 * 推进某会话的游标。**只前进**：传小值不会让游标回退（J7）。
 * @param {object} ledger
 * @param {string} sessionId
 * @param {{throughSeq:number, lastActiveAt?:string, contentHash?:string, state?:'done'|'partial'}} next
 * @returns {{changed:boolean, advanced:boolean, before:object|null, entry:object}}
 */
export function advanceCursor(ledger, sessionId, next = {}) {
  if (!ledger.cursor) ledger.cursor = {};
  const sid = String(sessionId);
  const prev = ledger.cursor[sid] ?? null;
  const prevSeq = num(prev?.throughSeq);
  const nextSeq = num(next.throughSeq);
  const throughSeq = Math.max(prevSeq, nextSeq);
  const advanced = throughSeq > prevSeq;
  // contentHash 跟着"最大 seq 那一刻"走：只有真正前进（或原来是空）时才覆盖，
  // 否则"重跑同一区间"会把旧区间哈希改掉 ⇒ 与 seq 配不上（§4-3 为什么必须带 contentHash）。
  const contentHash = advanced || !prev?.contentHash ? (next.contentHash ?? prev?.contentHash ?? null) : prev.contentHash;
  // state：显式 done 才清掉 partial；显式 partial 直接置 partial；都不给则沿用
  const state = next.state === 'partial' ? 'partial' : next.state === 'done' ? 'done' : (prev?.state ?? 'done');
  const entry = {
    throughSeq,
    lastActiveAt: newerIso(prev?.lastActiveAt, next.lastActiveAt),
    contentHash,
    state,
  };
  const changed = !prev || JSON.stringify(prev) !== JSON.stringify(entry);
  ledger.cursor[sid] = entry;
  return { changed, advanced, before: prev, entry };
}

/**
 * 这一段要不要跳过：**判据 = seq 相同 + contentHash 相同**（只靠 seq 会把"内容变了的区间"误判成判过了）。
 */
export function shouldSkipRange(ledger, sessionId, { throughSeq = 0, contentHash = null } = {}) {
  const e = ledger?.cursor?.[String(sessionId)];
  if (!e) return false;
  if (num(e.throughSeq) < num(throughSeq)) return false;
  if (!contentHash) return true;                 // 调用方没给哈希 ⇒ 只按 seq 判（偏保守地"跳过"）
  if (!e.contentHash) return false;              // 账本里没哈希 ⇒ 不敢跳（宁可重判一次）
  return e.contentHash === contentHash;
}

// ═══════════════════════════════════════════════════════════════════════════
// cost / runs（过审 E1 的 `cost` + `writtenIds` + `failed`）
// ═══════════════════════════════════════════════════════════════════════════

/** 当日累计（跨 run 累加；**跨天自动归零**）。J9「把当日 calls 设成 8」动的就是这里。 */
export function bumpCost(ledger, { day = costDay(), calls = 0, tokens = 0, nowMs = Date.now() } = {}) {
  const d = String(day);
  if (!ledger.cost || String(ledger.cost.day) !== d) ledger.cost = { day: d, calls: 0, tokens: 0 };
  ledger.cost.calls = num(ledger.cost.calls) + num(calls);
  ledger.cost.tokens = num(ledger.cost.tokens) + num(tokens);
  ledger.updatedAt = iso(nowMs);
  return ledger.cost;
}

/**
 * 追加一轮运行记录（字段与方案 §4-3 一字对齐；`writtenIds` / `failed` / `cost` 是过审 E1 的增补）。
 * @param {object} ledger
 * @param {{runId:string, at?:string, sessions?:number, candidates?:number, judged?:object,
 *          calls?:number, tokens?:number, written?:number, writtenIds?:number[], failed?:object[],
 *          stopping?:string|null, ms?:number}} run
 */
export function appendRun(ledger, run = {}, { nowMs = Date.now(), runsRetentionDays = RUNS_RETENTION_DAYS } = {}) {
  if (!Array.isArray(ledger.runs)) ledger.runs = [];
  const row = {
    runId: String(run.runId ?? `run-${iso(nowMs).replace(/[-:TZ.]/g, '').slice(0, 14)}`),
    at: run.at ?? iso(nowMs),
    sessions: num(run.sessions),
    candidates: num(run.candidates),
    judged: run.judged ?? {},
    calls: num(run.calls),
    tokens: num(run.tokens),
    written: num(run.written),
    writtenIds: Array.isArray(run.writtenIds) ? run.writtenIds.map(Number).filter(Number.isInteger) : [],
    failed: Array.isArray(run.failed) ? run.failed : [],
    stopping: run.stopping ?? null,
    ms: num(run.ms),
  };
  ledger.runs.push(row);
  pruneLedger(ledger, { nowMs, runsRetentionDays });
  ledger.updatedAt = iso(nowMs);
  return row;
}

/**
 * retention（§4-3）：`runs[]` 只留最近 N 天；`seen` **永久保留**（去重键，删了就重复落库）；
 * `cursor` 默认**一条都不删**，只有调用方显式给 `liveSessionIds`（现存会话 id 集）时才回收
 * "会话目录已被删除"的那些（归档 ≠ 删除 ⇒ 归档会话的游标必须留着，否则 D-2 一旦拍"读归档"就会重判）。
 */
export function pruneLedger(ledger, { nowMs = Date.now(), runsRetentionDays = RUNS_RETENTION_DAYS, liveSessionIds = null } = {}) {
  const cutoff = Number(nowMs) - num(runsRetentionDays) * 24 * 3600 * 1000;
  const before = Array.isArray(ledger.runs) ? ledger.runs.length : 0;
  ledger.runs = (ledger.runs ?? []).filter((r) => {
    const t = Date.parse(r?.at ?? '');
    return Number.isFinite(t) ? t >= cutoff : true; // 没有时间戳的保留（宁可留，不误删）
  });
  let removedCursors = 0;
  if (liveSessionIds) {
    const live = liveSessionIds instanceof Set ? liveSessionIds : new Set([...liveSessionIds].map(String));
    for (const sid of Object.keys(ledger.cursor ?? {})) {
      if (!live.has(String(sid))) { delete ledger.cursor[sid]; removedCursors += 1; }
    }
  }
  return { removedRuns: before - ledger.runs.length, removedCursors, keptRuns: ledger.runs.length, keptCursors: Object.keys(ledger.cursor ?? {}).length, keptSeen: Object.keys(ledger.seen ?? {}).length };
}

/** 人读摘要（日报 / 报告用）。 */
export function ledgerSummary(ledger) {
  const runs = ledger?.runs ?? [];
  const last = runs.length ? runs[runs.length - 1] : null;
  return {
    schemaVersion: ledger?.schemaVersion ?? null,
    updatedAt: ledger?.updatedAt ?? null,
    cursorSessions: Object.keys(ledger?.cursor ?? {}).length,
    seenCount: Object.keys(ledger?.seen ?? {}).length,
    runs: runs.length,
    lastRun: last ? { runId: last.runId, at: last.at, written: last.written, writtenIds: last.writtenIds?.length ?? 0, failed: last.failed?.length ?? 0, stopping: last.stopping } : null,
    cost: ledger?.cost ?? null,
  };
}
