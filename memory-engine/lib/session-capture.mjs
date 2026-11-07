#!/usr/bin/env node
// session-capture.mjs —— 会话提炼记忆 · **T1 提取层**（读会话 + 白名单 + 截断）
//
// 真源：`docs\方案-V3功能面-会话提炼记忆-20261026.md`
//   §4-1 输入边界（三道闸 + 白名单 + 五道上限）· §4-2 提炼口径（末 N 轮 / 60KB / 2,000 字）
//   §5 J1/J2 · 过审订正 I1（mtime 闸）/ I2（按 source.kind 剔注入）/ I3（user 正文在 data.content）
//
// ── 本件干什么（三件，不多干）────────────────────────────────────────────────
//   ① `collectSessionDirs()`  读 `$DSH_HOME\sessions\<bucket>\session-<id>\`，过 mtime 两道闸
//   ② `readSessionRecords()`  多帧 zstd 解压（**从 shadow-capture.mjs 抽出来的唯一一份**，那边改为 import）
//   ③ `extractWhitelist()`    白名单事件 + **按 `data.source.kind` 剔 7 种注入** + 末 N 轮 + 三道上限
//
// ── 硬边界 ──────────────────────────────────────────────────────────────────
//   ① **零写库**：本文件不出现 INSERT/UPDATE/DELETE/CREATE，不 import 任何 sqlite；
//   ② **零网络**：不 import 任何 LLM / fetch 通道（判不判是 T4 的事，本件只提取）；
//   ③ **只读 home**：只 stat/read `$DSH_HOME\sessions` 下的文件；`--probe` 只打印，不落盘；
//   ④ 判定规则**一条都不改**（`judgeMessage` 原样 import 自 `lib\capture-judge.mjs`，judgeVersion 仍 U1-2）。
//
// ── 过审 I2 的关键事实（别写成"已在位"）──────────────────────────────────────
//   `capture-judge.classifySource()` **只看 rpcId**（只分 user/relay/assistant），**不读 `source.kind`**
//   ⇒ 「按 kind 剔注入」是本文件的**新增实现**：`extractWhitelist()` 里 `classifySourceKind()` 才是那道闸。
//   实测泄漏形态：夹具里一条不带已知前缀的 `agent-instructions` 会被 capture-judge 判成候选（score 8）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { scanZstdFrames } from '../../lib/zstd-frames.mjs';
import { isSessionFileName, pickSessionFileInDir } from '../../lib/session-file-name.mjs';
import { extractText, isoLocal, judgeMessage, INJECTION_PREFIXES, JUDGE_VERSION } from './capture-judge.mjs';

export const CAPTURE_VERSION = 'T1-1';

/** 只取这两类事件（§4-1 白名单）。 */
export const WHITELIST_EVENT_TYPES = Object.freeze(['user/message', 'assistant/message']);

/**
 * 注入的 7 种 `data.source.kind`（2026-10-26 现读实测值；`user` = 真人输入，不在本表）。
 * ⚠️ 这是一张**封闭清单**：将来 harness 新增一种注入 kind ⇒ 本表不认它 ⇒ 会走 `kind-other:*` 分支被
 *   **fail-closed 丢掉并计数**（宁可少记，不可把注入当人话）。影子期据 `dropByReason` 增表。
 */
export const INJECTION_SOURCE_KINDS = Object.freeze([
  'time-context',
  'skill-catalog',
  'runtime-context',
  'memory-recall',
  'tool-jobs',
  'l3-pitfall-reminder',
  'agent-instructions',
]);

/** 真人输入在 `user/message` 上的 kind 值。 */
export const USER_SOURCE_KIND = 'user';

/** 五道上限 + 两道 mtime 闸（§4-1；§8 说"以下默认值可一句话改，不占拍板"）。 */
export const DEFAULT_LIMITS = Object.freeze({
  minAgeHours: 12,                 // 闸②：日志 mtime 至少 12 小时前（= 已结束且不再活跃）
  windowDays: 7,                   // 上界：与 shadow-capture 的 --window-days 同口径（最近 N 天之内）
  lastTurns: 3,                    // 单会话只取末 3 轮
  singleChars: 2000,               // 单条正文截断
  assistantCharsPerSession: 60 * 1024, // 单会话 assistant 正文合计上限
  maxSessions: 40,                 // 单次运行会话数上限
  totalChars: 1200 * 1024,         // 单次运行总字符上限
});

/** 截断标记（§4-1：截断处必须留标记，且记账本 —— 记账本在 T2）。 */
export const TRUNCATED_MARK = '[truncated]';

/** home 解析（与 `shadow-capture.mjs#resolveHome` **同一口径**：`--home` > $DSH_HOME > $BUTLER_DSH_HOME > ~/.dsh）。 */
export function resolveCaptureHome(opts = {}) {
  if (opts.home) return path.resolve(opts.home);
  const envH = process.env.DSH_HOME || process.env.BUTLER_DSH_HOME;
  return envH && String(envH).trim() ? path.resolve(String(envH).trim()) : path.join(os.homedir(), '.dsh');
}

/**
 * 读一个会话目录里"当前那份"日志并解出事件（多帧 zstd；撕裂帧丢弃、不猜长度）。
 * ⚠️ 本函数是 **CLI 侧唯一一份**（2026-10-26 从 `shadow-capture.mjs` 抽进来，那边改为 import）——
 *   改这里等于同时改 shadow-capture 的行为，改前先跑 `--self-test` 与 I1 的逐字节对照。
 */
export function readSessionRecords(dir) {
  const file = pickSessionFileInDir(dir);
  if (!file) return { file: null, records: [], frames: 0, torn: false, badFrames: 0, badLines: 0 };
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return { file, records: [], error: `read:${e?.message ?? e}` }; }
  const { frames, tornStart } = scanZstdFrames(buf);
  const records = [];
  let badFrames = 0;
  let badLines = 0;
  for (const f of frames) {
    let dec;
    try { dec = zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'); } catch { badFrames += 1; continue; }
    for (const line of dec.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { records.push(JSON.parse(t)); } catch { badLines += 1; }
    }
  }
  return { file, records, frames: frames.length, torn: tornStart !== undefined, badFrames, badLines };
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 会话发现（mtime 两道闸 + 排除）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 列出候选会话目录（**只 stat，不读正文**）。
 * @param {{home?:string, windowDays?:number, minAgeHours?:number, nowMs?:number,
 *          exclude?:Set<string>|string[], includeSession?:string|null}} opts
 * @returns {{candidates:object[], skipped:{sessionId:string,reason:string}[], stats:object}}
 */
export function collectSessionDirs(opts = {}) {
  const home = resolveCaptureHome(opts);
  const limits = { ...DEFAULT_LIMITS, ...pickLimits(opts) };
  const nowMs = Number(opts.nowMs ?? Date.now());
  const exclude = new Set([...(opts.exclude ?? [])].map((s) => String(s).replace(/^session-/, '')));
  const only = opts.includeSession ? String(opts.includeSession).replace(/^session-/, '') : null;
  const sessRoot = path.join(home, 'sessions');

  const out = { home, sessRoot, exists: fs.existsSync(sessRoot), candidates: [], skipped: [], stats: { seen: 0, byReason: {} } };
  if (!out.exists) return out;
  const reasons = out.stats.byReason;
  const bump = (k) => { reasons[k] = (reasons[k] ?? 0) + 1; };

  const cutoff = Number.isFinite(limits.windowDays) && limits.windowDays > 0 ? nowMs - limits.windowDays * 24 * 3600 * 1000 : null;
  const minAgeMs = Number.isFinite(limits.minAgeHours) && limits.minAgeHours > 0 ? limits.minAgeHours * 3600 * 1000 : 0;

  for (const ws of fs.readdirSync(sessRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(sessRoot, ws.name);
    let subs;
    try { subs = fs.readdirSync(wsDir, { withFileTypes: true }); } catch { continue; }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      out.stats.seen += 1;
      const sessionId = sub.name.replace(/^session-/, '');
      const dir = path.join(wsDir, sub.name);
      if (only && sessionId !== only) continue;
      if (exclude.has(sessionId)) { out.skipped.push({ sessionId, reason: 'excluded' }); bump('excluded'); continue; }
      const file = pickSessionFileInDir(dir);
      if (!file) { out.skipped.push({ sessionId, reason: 'no-session-file' }); bump('no-session-file'); continue; }
      let st;
      try { st = fs.statSync(file); } catch { out.skipped.push({ sessionId, reason: 'stat-failed' }); bump('stat-failed'); continue; }
      // 闸① 上界（最近 N 天之内）—— 与 shadow-capture --window-days 同口径
      if (cutoff !== null && st.mtimeMs < cutoff) { out.skipped.push({ sessionId, reason: 'out-of-window' }); bump('out-of-window'); continue; }
      // 闸② 下界（至少 N 小时没动过）—— 本件新增，shadow-capture 用 --min-age-hours 表达同一件事
      const ageMs = nowMs - st.mtimeMs;
      if (minAgeMs > 0 && ageMs < minAgeMs) { out.skipped.push({ sessionId, reason: 'too-recent' }); bump('too-recent'); continue; }
      out.candidates.push({
        sessionId, workspaceDir: ws.name, dir, file,
        bytes: st.size, mtimeMs: Math.round(st.mtimeMs), mtime: isoLocal(st.mtimeMs), ageHours: Math.round(ageMs / 36000) / 100,
      });
    }
  }
  // 最近结束的先处理（确定性；上限 maxSessions 截断时优先保留新的）
  out.candidates.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.sessionId < b.sessionId ? -1 : 1));
  return out;
}

function pickLimits(o) {
  const keys = ['minAgeHours', 'windowDays', 'lastTurns', 'singleChars', 'assistantCharsPerSession', 'maxSessions', 'totalChars'];
  const out = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && Number.isFinite(Number(o[k]))) out[k] = Number(o[k]);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// ② 白名单提取（I2 的真闸在这里）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一条事件的"来源 kind"：
 *   assistant/message ⇒ 'assistant'
 *   user/message      ⇒ `data.source.kind` 原值（真人 = 'user'；7 种注入见 INJECTION_SOURCE_KINDS）
 *   **缺 kind ⇒ null**（fail-closed：不把身份不明的消息当人话）
 */
export function classifySourceKind(record) {
  if (record?.type === 'assistant/message') return 'assistant';
  const kind = record?.data?.source?.kind;
  return typeof kind === 'string' && kind.trim() ? kind.trim() : null;
}

/** 残留前缀兜底（§4-1「双判据」）：kind 是对了但正文还是注入块形态的，也挡掉。 */
export function startsWithInjectionPrefix(text) {
  const t = String(text ?? '').trimStart();
  return INJECTION_PREFIXES.some((p) => t.startsWith(p));
}

/** 单条截断（留标记；标记本身不计入上限之外的语义）。 */
export function truncateText(text, max) {
  const s = String(text ?? '');
  if (!Number.isFinite(max) || max <= 0 || s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max) + TRUNCATED_MARK, truncated: true };
}

/** 把截断后的正文塞回一条**克隆**记录（judgeMessage 只认 extractText 那两条通路）。 */
function cloneRecordWithText(record, text) {
  if (record?.type === 'assistant/message') {
    const msg = record?.data?.message ?? {};
    return { ...record, data: { ...record.data, message: { ...msg, content: [{ type: 'text', text }] } } };
  }
  return { ...record, data: { ...record.data, content: text } };
}

/** 往记录的 `x-capture` 私字段里挂 seq/at 之类（供 T3 写 `src:session:<id8>:<seq>`；judge 不读它）。 */
function stamp(record, extra) {
  Object.defineProperty(record, 'xCapture', { value: extra, enumerable: false, configurable: true });
  return record;
}

/**
 * 白名单提取（纯函数，可夹具）：事件数组 ⇒ 可送去判定的消息数组。
 * @param {object[]} records
 * @param {{lastTurns?:number, singleChars?:number, assistantCharsPerSession?:number}} [opts]
 * @returns {{messages:object[], stats:object}}
 */
export function extractWhitelist(records, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...pickLimits(opts) };
  const stats = {
    records: records?.length ?? 0,
    whitelistType: 0,
    kept: 0,
    dropped: 0,
    byReason: {},
    turnsTotal: 0,
    turnsKept: 0,
    truncatedSingle: 0,
    droppedAssistantOverflow: 0,
    charsKept: 0,
  };
  const bump = (k) => { stats.byReason[k] = (stats.byReason[k] ?? 0) + 1; stats.dropped += 1; };

  // 轮次编号：`turn/start` 出现一次 = 进一轮；消息归到"它所在的轮"
  let turn = 0;
  const seqTurn = new Map();
  for (const r of records ?? []) {
    if (r?.type === 'turn/start') turn += 1;
    if (typeof r?.seq === 'number') seqTurn.set(r.seq, turn);
  }
  stats.turnsTotal = turn;
  const keepFromTurn = turn > 0 ? Math.max(1, turn - limits.lastTurns + 1) : 0; // 只保留 >= keepFromTurn 的轮
  stats.turnsKept = turn > 0 ? Math.min(limits.lastTurns, turn) : 0;

  const messages = [];
  for (const rec of records ?? []) {
    const type = rec?.type;
    if (!WHITELIST_EVENT_TYPES.includes(type)) { bump(`type:${String(type)}`); continue; }
    stats.whitelistType += 1;
    if (keepFromTurn > 0) {
      const t = typeof rec.seq === 'number' ? (seqTurn.get(rec.seq) ?? 0) : 0;
      if (t < keepFromTurn) { bump('old-turn'); continue; }
    }
    const kind = classifySourceKind(rec);
    if (type === 'user/message') {
      if (kind === null) { bump('kind-missing'); continue; }
      if (INJECTION_SOURCE_KINDS.includes(kind)) { bump(`inject:${kind}`); continue; }
      if (kind !== USER_SOURCE_KIND) { bump(`kind-other:${kind}`); continue; }
    }
    const raw = extractText(rec);            // ⚠️ I3：user 正文在 data.content，本函数认这条路
    if (!raw || !raw.trim()) { bump('empty'); continue; }
    if (startsWithInjectionPrefix(raw)) { bump('prefix-residual'); continue; }
    const { text, truncated } = truncateText(raw, limits.singleChars);
    if (truncated) stats.truncatedSingle += 1;
    messages.push({
      seq: typeof rec.seq === 'number' ? rec.seq : null,
      type, sourceKind: kind,
      at: isoLocal(rec?.time ?? Date.now()),
      turn: typeof rec.seq === 'number' ? (seqTurn.get(rec.seq) ?? 0) : 0,
      chars: text.length, truncated,
      text,
      record: truncated ? cloneRecordWithText(rec, text) : rec,
    });
  }

  // 单会话 assistant 正文合计上限：从**最新**往回装，装不下的丢（并计数），再恢复时间序
  const budget = limits.assistantCharsPerSession;
  if (Number.isFinite(budget) && budget > 0) {
    let acc = 0;
    const keepFlags = new Array(messages.length).fill(true);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type !== 'assistant/message') continue;
      if (acc + messages[i].chars > budget) { keepFlags[i] = false; stats.droppedAssistantOverflow += 1; continue; }
      acc += messages[i].chars;
    }
    const kept = messages.filter((_, i) => keepFlags[i]);
    stats.dropped += messages.length - kept.length;
    messages.length = 0;
    messages.push(...kept);
  }

  stats.kept = messages.length;
  stats.charsKept = messages.reduce((n, m) => n + m.chars, 0);
  for (const m of messages) stamp(m.record, { seq: m.seq, at: m.at, sourceKind: m.sourceKind });
  return { messages, stats };
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ 判定（消费 capture-judge，不改它的规则）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 对提取结果跑规则判定（`judgeVersion` 不变；这一步只是把 `judgeMessage` 接到白名单结果上）。
 * @returns {{candidates:object[], codes:object}}
 */
export function judgeExtracted(messages, ctx = {}) {
  const candidates = [];
  const codes = {};
  for (const m of messages) {
    const res = judgeMessage(m.record, { sessionId: ctx.sessionId ?? null, workspaceDir: ctx.workspaceDir ?? null, includeRelay: false, preset: ctx.preset ?? null });
    codes[res.code] = (codes[res.code] ?? 0) + 1;
    if (res.code === 'candidate') candidates.push({ ...res.candidate, turn: m.turn, truncated: m.truncated });
  }
  return { candidates, codes };
}

/** 一段区间的正文哈希（游标的第二判据：seq 相同但内容变了 ⇒ 不算判过）。 */
export function contentHashOfRange(records, { fromSeqExclusive = -Infinity, toSeq = Infinity } = {}) {
  const h = crypto.createHash('sha256');
  for (const r of records ?? []) {
    if (typeof r?.seq !== 'number') continue;
    if (r.seq <= fromSeqExclusive || r.seq > toSeq) continue;
    h.update(String(r.seq)).update('\u0000').update(String(r.type ?? '')).update('\u0000');
    if (WHITELIST_EVENT_TYPES.includes(r.type)) h.update(extractText(r));
    h.update('\u0001');
  }
  return 'sha256:' + h.digest('hex').slice(0, 32);
}

// ═══════════════════════════════════════════════════════════════════════════
// ④ 全流程（collect → 逐会话 read/extract/judge → 汇总；**只读，不落盘**）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {{home?:string, minAgeHours?:number, windowDays?:number, lastTurns?:number,
 *          singleChars?:number, assistantCharsPerSession?:number, maxSessions?:number,
 *          totalChars?:number, nowMs?:number, exclude?:string[], includeSession?:string|null}} opts
 */
export function runExtract(opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...pickLimits(opts) };
  const t0 = Date.now();
  const collected = collectSessionDirs({ ...opts, ...limits });
  const res = {
    captureVersion: CAPTURE_VERSION,
    judgeVersion: JUDGE_VERSION,
    home: collected.home,
    sessRoot: collected.sessRoot,
    limits,
    sessions: [],
    messages: [],
    candidates: [],
    skipped: collected.skipped,
    stats: {
      sessionsSeen: collected.stats.seen,
      skippedByReason: collected.stats.byReason,
      sessionsAnalyzed: 0,
      sessionsSkipped: {},
      noTurnEnd: 0,
      records: 0,
      messagesKept: 0,
      candidates: 0,
      charsKept: 0,
      stopped: null,
      elapsedMs: 0,
    },
  };
  const skip = (k) => { res.stats.sessionsSkipped[k] = (res.stats.sessionsSkipped[k] ?? 0) + 1; };

  for (const s of collected.candidates) {
    if (res.sessions.length >= limits.maxSessions) { res.stats.stopped = 'max-sessions'; break; }
    if (res.stats.charsKept >= limits.totalChars) { res.stats.stopped = 'total-chars'; break; }
    const rd = readSessionRecords(s.dir);
    if (rd.error) { skip('read-error'); res.sessions.push({ ...s, error: rd.error }); continue; }
    const turnEnds = rd.records.filter((r) => r?.type === 'turn/end').length;
    const header = rd.records.find((r) => r?.type === 'session') ?? null;
    const row = {
      sessionId: s.sessionId, workspaceDir: s.workspaceDir, dir: s.dir, file: s.file,
      mtime: s.mtime, ageHours: s.ageHours,
      bytes: s.bytes, records: rd.records.length, frames: rd.frames, torn: rd.torn, turnEnds,
      cwd: header?.cwd ?? null, preset: header?.agentPreset ?? null,
    };
    // 闸③：必须至少有一轮真正跑完（空壳会话不进提炼）
    if (turnEnds < 1) { skip('no-turn-end'); res.stats.noTurnEnd += 1; res.sessions.push({ ...row, skipped: 'no-turn-end' }); continue; }
    const ex = extractWhitelist(rd.records, limits);
    const jd = judgeExtracted(ex.messages, {
      sessionId: s.sessionId, workspaceDir: s.workspaceDir, preset: header?.agentPreset ?? null,
    });
    res.stats.sessionsAnalyzed += 1;
    res.stats.records += rd.records.length;
    res.stats.messagesKept += ex.messages.length;
    res.stats.candidates += jd.candidates.length;
    res.stats.charsKept += ex.stats.charsKept;
    res.sessions.push({ ...row, keep: ex.stats.kept, dropped: ex.stats.byReason, candidates: jd.candidates.length, turnsTotal: ex.stats.turnsTotal, turnsKept: ex.stats.turnsKept });
    for (const m of ex.messages) res.messages.push({ sessionId: s.sessionId, workspaceDir: s.workspaceDir, ...m, record: undefined });
    for (const c of jd.candidates) res.candidates.push(c);
  }
  res.stats.elapsedMs = Date.now() - t0;
  return res;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI（--probe / --self-test）
// ═══════════════════════════════════════════════════════════════════════════

const USAGE = [
  'usage: node session-capture.mjs --probe [--home <DSH 根>] [--min-age-hours 12] [--json]',
  '',
  '  --probe                只读扫会话 → 白名单提取 → 规则判定 → **只打印**（零写库、零写盘、零网络）',
  '  --home <目录>          默认 env DSH_HOME / BUTLER_DSH_HOME / ~/.dsh',
  '  --min-age-hours N      mtime 下界（默认 12；0 = 关掉这道闸，仅供对照）',
  '  --window-days N        mtime 上界（默认 7）',
  '  --last-turns N         单会话只取末 N 轮（默认 3）',
  '  --single-chars N       单条正文截断（默认 2000）',
  '  --assistant-chars N    单会话 assistant 正文合计上限（默认 61440）',
  '  --max-sessions N       单次会话数上限（默认 40）',
  '  --session <id>         只扫这一个会话',
  '  --json                 机器可读（人话写 stderr）',
  '  --self-test            纯函数夹具自测（不读生产、不落盘）',
].join('\n');

function parseCli(argv) {
  const o = { probe: false, selfTest: false, json: false, help: false };
  const need = (i, n) => { const v = argv[i]; if (v === undefined || v.startsWith('--')) throw new Error(`${n} 需要一个值`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--probe') o.probe = true;
    else if (a === '--json') o.json = true;
    else if (a === '--self-test') o.selfTest = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--home') o.home = need(++i, a);
    else if (a === '--session') o.includeSession = need(++i, a);
    else if (a === '--min-age-hours') o.minAgeHours = Number(need(++i, a));
    else if (a === '--window-days') o.windowDays = Number(need(++i, a));
    else if (a === '--last-turns') o.lastTurns = Number(need(++i, a));
    else if (a === '--single-chars') o.singleChars = Number(need(++i, a));
    else if (a === '--assistant-chars') o.assistantCharsPerSession = Number(need(++i, a));
    else if (a === '--max-sessions') o.maxSessions = Number(need(++i, a));
    else throw new Error(`未知参数：${a}`);
  }
  return o;
}

/** 夹具自测（纯函数，不碰文件系统）。T3 起若改白名单，**这里是第一个红的地方**。 */
export function selfTest() {
  const results = [];
  const t = (name, fn) => {
    try { fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, detail: String(e?.message ?? e) }); }
  };
  const eq = (a, b, m = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };

  const user = (text, kind = 'user', seq = 1) => ({ type: 'user/message', seq, time: 1761400000000 + seq, data: { content: text, source: { kind } } });
  const asst = (text, seq = 2) => ({ type: 'assistant/message', seq, time: 1761400000000 + seq, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });

  t('extractText: user 正文在 data.content（I3）', () => {
    eq(extractText(user('真人说话')), '真人说话');
  });
  t('extractText: assistant 正文在 data.message.content', () => {
    eq(extractText(asst('我说的话')), '我说的话');
  });
  t('7 种注入 kind 全被剔（I2）', () => {
    const recs = INJECTION_SOURCE_KINDS.map((k, i) => user(`注入块内容第 ${i} 条，故意写得够长够像话`, k, 10 + i));
    const { messages, stats } = extractWhitelist(recs, { lastTurns: 0 });
    eq(messages.length, 0, '被剔条数');
    for (const k of INJECTION_SOURCE_KINDS) eq(stats.byReason[`inject:${k}`], 1, k);
  });
  t('缺 kind 的 user/message 是 fail-closed 丢掉', () => {
    const r = { type: 'user/message', seq: 1, data: { content: '没有 source.kind 的一条' } };
    eq(extractWhitelist([r]).messages.length, 0);
    eq(extractWhitelist([r]).stats.byReason['kind-missing'], 1);
  });
  t('真 user + assistant 都留（白名单不是把 user 一并剔掉）', () => {
    const { messages } = extractWhitelist([user('这是真人说的一句够长的话'), asst('这是本鱼的结论，也够长了')]);
    eq(messages.map((m) => m.sourceKind), ['user', 'assistant']);
  });
  t('残留前缀兜底（kind=user 但正文是注入块）', () => {
    const { stats } = extractWhitelist([user('<system-reminder> 这是一段注入，长度够')]);
    eq(stats.byReason['prefix-residual'], 1);
  });
  t('末 N 轮：更早的轮次被丢', () => {
    const recs = [
      { type: 'turn/start', seq: 1 }, user('第一轮的话，长度足够长', 'user', 2), asst('第一轮的答复，长度也够', 3), { type: 'turn/end', seq: 4 },
      { type: 'turn/start', seq: 5 }, user('第二轮的话，长度足够长', 'user', 6), asst('第二轮的答复，长度也够', 7), { type: 'turn/end', seq: 8 },
    ];
    const { messages, stats } = extractWhitelist(recs, { lastTurns: 1 });
    eq(stats.turnsTotal, 2);
    eq(messages.map((m) => m.seq), [6, 7]);
  });
  t('单条截断留标记（[truncated]）', () => {
    const long = 'a'.repeat(50);
    const { messages, stats } = extractWhitelist([user(long)], { singleChars: 10 });
    eq(stats.truncatedSingle, 1);
    eq(messages[0].chars, 10 + TRUNCATED_MARK.length);
    if (!messages[0].text.endsWith(TRUNCATED_MARK)) throw new Error('缺截断标记');
  });
  t('assistant 单会话合计超限时丢最旧的', () => {
    const recs = [asst('X'.repeat(50), 1), asst('Y'.repeat(50), 2)];
    const { stats, messages } = extractWhitelist(recs, { assistantCharsPerSession: 60 });
    eq(stats.droppedAssistantOverflow, 1);
    eq(messages.length, 1);
    if (!messages[0].text.startsWith('Y')) throw new Error('应保留最新那条');
  });
  t('按 kind 剔注入后 judge 侧不再出候选（I2 端到端）', () => {
    const recs = INJECTION_SOURCE_KINDS.map((k, i) => user(`拍板：以后一律按这个走，第 ${i} 条（注入）`, k, 10 + i));
    const ex = extractWhitelist(recs);
    const jd = judgeExtracted(ex.messages, { sessionId: 'x' });
    eq(jd.candidates.length, 0);
  });
  return { passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, total: results.length, results };
}

export function isMainEntry(argv1 = process.argv[1]) {
  if (!argv1) return false;
  const self = fileURLToPath(import.meta.url);
  try { return fs.realpathSync(argv1) === fs.realpathSync(self); } catch { return false; }
}

async function cliMain() {
  let o;
  try { o = parseCli(process.argv.slice(2)); } catch (e) { console.error(`[usage] ${e.message}\n\n${USAGE}`); process.exitCode = 2; return; }
  if (o.help) { console.log(USAGE); return; }
  if (o.selfTest) {
    const st = selfTest();
    console.log(`[self-test] ${st.passed}/${st.total} 通过${st.failed ? `，失败 ${st.failed}` : ''}`);
    for (const r of st.results) if (!r.pass) console.log(`  ✗ ${r.name} ${r.detail ?? ''}`);
    if (st.failed) process.exitCode = 1;
    return;
  }
  if (!o.probe) { console.error(`[usage] 需要 --probe（或 --self-test）\n\n${USAGE}`); process.exitCode = 2; return; }

  const res = runExtract(o);
  if (o.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    const S = res.stats;
    console.log(`[session-capture] T1 提取（captureVersion=${CAPTURE_VERSION} · judgeVersion=${res.judgeVersion}）`);
    console.log(`  home=${res.home}`);
    console.log(`  闸：mtime ${res.limits.minAgeHours}h~${res.limits.windowDays}d · 末 ${res.limits.lastTurns} 轮 · 单条 ${res.limits.singleChars} 字 · assistant/会话 ${res.limits.assistantCharsPerSession} 字`);
    console.log(`  会话：看见 ${S.sessionsSeen} · 分析 ${S.sessionsAnalyzed} · 无 turn/end ${S.noTurnEnd} · 跳过明细 ${JSON.stringify(S.skippedByReason)}`);
    console.log(`  消息：保留 ${S.messagesKept} 条 / ${S.charsKept} 字 ⇒ 候选 ${S.candidates} 条${S.stopped ? ` · 提前停：${S.stopped}` : ''}`);
    for (const s of res.sessions) {
      console.log(`  · ${String(s.sessionId).slice(0, 8)} mtime=${String(s.mtime).slice(5, 16)} 龄=${s.ageHours}h records=${s.records} turnEnd=${s.turnEnds}${s.skipped ? ` 跳过=${s.skipped}` : ` 保留=${s.keep} 候选=${s.candidates}`}`);
      if (s.dropped && Object.keys(s.dropped).length) {
        const drop = Object.entries(s.dropped).filter(([k]) => !k.startsWith('type:')).map(([k, v]) => `${k}=${v}`);
        if (drop.length) console.log(`     剔：${drop.join(' ')}`);
      }
    }
    for (const c of res.candidates) console.log(`  ▸ 候选 [${c.sourceKind}] seq ${c.seq} score ${c.score} ${c.signals.join('+')} :: ${c.claim}`);
  }
  process.exitCode = 0;
}

if (isMainEntry()) await cliMain();
