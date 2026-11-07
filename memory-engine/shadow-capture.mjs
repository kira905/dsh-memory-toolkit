#!/usr/bin/env node
// shadow-capture.mjs —— 自动提炼影子 · 「什么该记」候选器（U2 · **影子只出候选**）
//
// 口径真源：本仓 README §「什么该记」判定器（U1-1）
// 判定实现：`lib\capture-judge.mjs`（本文件只做 IO 编排：读会话日志 → 判定 → 去重 → 落候选）
//
// ── 零接线（**删掉本文件 + lib\capture-judge.mjs = 完全回到 2026-10-25 之前**）──────────
//   · 不加 tickd job、不改任何现成 job / preset / persona / 配置；
//   · 没有 `--apply` 这条路（真给 `--apply` 直接拒绝，rc=2）—— 本器具**永不写库**；
//   · 默认**零模型调用**（`--model` 才开，且开了要在摘要里报 token）。
//
// ── 硬边界 ──────────────────────────────────────────────────────────────────
//   ① 打记忆库只有一处：`loadMemoryPool()` 里的 `readOnly: true`；本文件不出现 INSERT/UPDATE/DELETE/CREATE。
//   ② 只写 `--out` 目录下三个文件（`candidates.jsonl` / `candidates.md` / `run.json`）；`--no-write` 则一个都不写。
//   ③ 只读**本机** `~/.dsh/sessions`；**不连 M6800、不读家人会话**（家人表存在时按身份跳过并计数）。
//   ④ 日志是**多帧 zstd**：走 `tools\lib\zstd-frames.mjs#scanZstdFrames`（严格帧结构解析，不吃魔数搜索），
//      读取函数本身 = `lib\session-capture.mjs#readSessionRecords`（2026-10-26 从本文件抽出，本文件改为 import）；
//      文件名走 `tools\lib\session-file-name.mjs`（认全世代：`session.jsonl.zstd` / `v3` / `v4` / 任意 `vN`）。
//   ⑤ 退出码走 `process.exitCode`（Windows 上强退会崩）；入口守卫**双方 realpath 后再比**（junction 场景）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isSessionFileName, pickSessionFileInDir } from '../lib/session-file-name.mjs';
import {
  JUDGE_VERSION, THRESHOLD, judgeMessage, judgeDedup, loadMemoryPool, buildPoolIndex,
  dedupeCandidates, candidateText, isoLocal, selfTest, judgeWithModel,
} from './lib/capture-judge.mjs';
// T1（2026-10-26 · 卡「会话提炼T0T2」）：`readSessionRecords` 与 home 解析**抽进 lib\session-capture.mjs**，
//   本文件改为 import —— 同一份实现、同一段代码，行为不变（判据见 `--min-age-hours` 的逐字节对照）。
import { readSessionRecords, resolveCaptureHome } from './lib/session-capture.mjs';

export const VERSION = '0.1.0';

/** 默认扫描窗口（天）—— 卡面 §可改点：最近 7 天。 */
export const DEFAULT_WINDOW_DAYS = 7;
const DATE_YMD = (ms) => { const d = new Date(ms); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };

function resolveHome(opts = {}) {
  return resolveCaptureHome(opts);
}

function parseArgs(argv) {
  const o = {
    home: null, out: null, windowDays: DEFAULT_WINDOW_DAYS, session: null, excludeSessions: [],
    includeCurrent: false, model: false, includeBorderline: false, noWrite: false, json: false,
    selfTest: false, verbose: false, limit: null, help: false, apply: false, includeRelay: false,
    // 闸② 的下界参数（2026-10-26 新增 · 卡「会话提炼T0T2」I1）：**缺省 null = 现行为一点不变**。
    //   `--window-days N` 只表达"最近 N 天之内"，表达不了"至少 N 小时没动过"——方案 §4-1 闸② 必须靠这个。
    minAgeHours: null,
  };
  const need = (i, name) => { const v = argv[i]; if (v === undefined || v.startsWith('--')) throw new Error(`${name} 需要一个值`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--home') { o.home = need(++i, a); continue; }
    if (a === '--out') { o.out = need(++i, a); continue; }
    if (a === '--window-days') { o.windowDays = Number(need(++i, a)); continue; }
    if (a === '--min-age-hours') { o.minAgeHours = Number(need(++i, a)); continue; }
    if (a === '--session') { o.session = need(++i, a); continue; }
    if (a === '--exclude-session') { o.excludeSessions.push(need(++i, a)); continue; }
    if (a === '--limit') { o.limit = Number(need(++i, a)); continue; }
    if (a === '--include-current') { o.includeCurrent = true; continue; }
    if (a === '--include-relay') { o.includeRelay = true; continue; }
    if (a === '--model') { o.model = true; continue; }
    if (a === '--include-borderline') { o.includeBorderline = true; continue; }
    if (a === '--no-write') { o.noWrite = true; continue; }
    if (a === '--json') { o.json = true; continue; }
    if (a === '--self-test') { o.selfTest = true; continue; }
    if (a === '--verbose') { o.verbose = true; continue; }
    if (a === '--apply') { o.apply = true; continue; }
    if (a === '-h' || a === '--help') { o.help = true; continue; }
    throw new Error(`未知参数：${a}`);
  }
  return o;
}

const USAGE = [
  'usage: node shadow-capture.mjs [选项]',
  '',
  '  --window-days N       扫描窗口（默认 7 天，按会话日志 mtime）',
  '  --min-age-hours N     只收"至少 N 小时没动过"的会话（默认不开；方案 §4-1 闸② 建议 12）',
  '  --out <目录>          候选落点（默认 <系统临时目录>/capture-shadow-<今天>）',
  '  --home <DSH 根>       默认 env DSH_HOME 或 ~/.dsh',
  '  --session <id>        只扫这一个会话',
  '  --exclude-session <id> 跳过某会话（可多次）',
  '  --include-current     把当前正在跑的会话也算进来（默认排除：它的日志还没写完、且会自引本卡）',
  '  --include-relay       把"接力指令"也算进判定（默认排除：机器模板，口径真源在 persona/交接档）',
  '  --model               开模型二判（**默认关**；开会报 token 消耗）',
  '  --include-borderline  边框档（1.0≤score<2.0）也落候选（默认只计数）',
  '  --limit N             最多落 N 条候选',
  '  --no-write            只打印统计，不落任何文件',
  '  --json                摘要走 JSON（人话写 stderr）',
  '  --self-test           夹具自测（不读生产会话、不读库、不发网络）',
  '  --verbose             每条丢弃也打一行原因',
  '',
  '  本器具**没有 --apply**（永不写库）。给 --apply 会被拒绝（rc=2）。',
].join('\n');

function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}

/** 只读 stat（给"token 账本没被动过"这条判据用）。 */
function statOf(p) {
  try { const st = fs.statSync(p); return { size: st.size, mtimeMs: Math.round(st.mtimeMs) }; } catch { return null; }
}

/** 家人身份键（表可能不存在 —— 本机 2026-10-25 现查 NOT-EXISTS）。 */
function loadFamilySessionIds(home) {
  const f = path.join(home, 'family-sessions.json');
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const ids = new Set();
    const walk = (v) => {
      if (!v) return;
      if (Array.isArray(v)) { for (const x of v) walk(x); return; }
      if (typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          if (/session-?id$/i.test(k) && typeof val === 'string') ids.add(val);
          walk(val);
        }
      }
    };
    walk(raw);
    return { exists: true, file: f, ids };
  } catch {
    return { exists: false, file: f, ids: new Set() };
  }
}

async function main() {
  const t0 = Date.now();
  // ── 零模型自证：装一个 fetch 计数器（本进程内所有 fetch 都过它）─────────────────
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  if (typeof realFetch === 'function') {
    globalThis.fetch = (...args) => { fetchCalls += 1; return realFetch(...args); };
  }

  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`[usage] ${e.message}\n\n${USAGE}`);
    process.exitCode = 2; return;
  }
  if (opts.help) { console.log(USAGE); return; }
  if (opts.apply) {
    console.error('拒绝：本器具**永久没有写库路径**（影子只出候选）。`--apply` 属 U3/U4 档，须另起卡。');
    process.exitCode = 2; return;
  }

  if (opts.selfTest) {
    const st = selfTest();
    console.log(`[self-test] ${st.passed}/${st.total} 通过${st.failed ? `，失败 ${st.failed}` : ''}`);
    for (const r of st.results) if (!r.pass) console.log(`  ✗ ${r.name} ${r.detail}`);
    if (st.failed) process.exitCode = 1;
    return;
  }

  const home = resolveHome(opts);
  const today = DATE_YMD(Date.now());
  const outDir = path.join(os.tmpdir(), `capture-shadow-${today}`);
  const effectiveOut = opts.out ? path.resolve(opts.out) : outDir;
  // 「token 账本没被动过」的判据：跑前 / 跑后 stat 同一份 distill state（本器具绝不写它）
  const ledgerFile = path.join(home, 'butler-distill-state.json');
  const ledgerBefore = statOf(ledgerFile);
  const stats = {
    version: VERSION, judgeVersion: JUDGE_VERSION, at: isoLocal(Date.now()), home,
    windowDays: opts.windowDays, outDir: opts.noWrite ? null : effectiveOut,
    sessionsSeen: 0, sessionsScanned: 0, sessionsSkipped: new Set(), skipReasons: {},
    messages: 0, dropCodes: {}, candidates: 0, borderline: 0, mergedSameSession: 0, mergedCrossSession: 0, crossSessionTwins: 0,
    dedupDropped: 0, dedupNear: 0, alreadyDistilled: 0, familySessionsSkipped: 0,
    model: { enabled: Boolean(opts.model), calls: 0, promptTokens: 0, completionTokens: 0 },
    fetchCalls: 0, tokenLedgerUnchanged: null, elapsedMs: 0,
  };
  const bump = (k) => { stats.dropCodes[k] = (stats.dropCodes[k] ?? 0) + 1; };

  // 会话根（**只本机**）
  const sessRoot = path.join(home, 'sessions');
  if (!fs.existsSync(sessRoot)) { console.error(`[fatal] 会话根不存在：${sessRoot}`); process.exitCode = 3; return; }

  const family = loadFamilySessionIds(home);
  const currentSid = String(process.env.DSH_SESSION_ID ?? '').trim();
  const exclude = new Set(opts.excludeSessions.map((s) => s.replace(/^session-/, '')));
  if (currentSid && !opts.includeCurrent) exclude.add(currentSid.replace(/^session-/, ''));

  const cutoff = Date.now() - Number(opts.windowDays) * 24 * 3600 * 1000;
  const rawCands = [];
  const perSession = [];

  for (const ws of fs.readdirSync(sessRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const wsDir = path.join(sessRoot, ws.name);
    for (const sub of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      stats.sessionsSeen += 1;
      const sid = sub.name.replace(/^session-/, '');
      const sDir = path.join(wsDir, sub.name);
      const hasSessionFile = fs.readdirSync(sDir, { withFileTypes: true }).some((e) => e.isFile() && isSessionFileName(e.name));
      if (!hasSessionFile) { stats.sessionsSkipped.add(sid); stats.skipReasons['no-session-file'] = (stats.skipReasons['no-session-file'] ?? 0) + 1; continue; }
      if (opts.session && sid !== String(opts.session).replace(/^session-/, '')) continue;
      if (exclude.has(sid)) { stats.sessionsSkipped.add(sid); stats.skipReasons['excluded'] = (stats.skipReasons['excluded'] ?? 0) + 1; continue; }
      // 家人会话：本机表不存在 ⇒ 无可跳过；存在则按身份键跳过（**禁读家人会话**）
      if (family.exists && family.ids.has(sid)) { stats.familySessionsSkipped += 1; stats.sessionsSkipped.add(sid); continue; }
      const filePath = pickSessionFileInDir(sDir);
      let st;
      try { st = fs.statSync(filePath); } catch { stats.sessionsSkipped.add(sid); stats.skipReasons['stat-failed'] = (stats.skipReasons['stat-failed'] ?? 0) + 1; continue; }
      if (st.mtimeMs < cutoff) { stats.sessionsSkipped.add(sid); stats.skipReasons['out-of-window'] = (stats.skipReasons['out-of-window'] ?? 0) + 1; continue; }
      // 闸② 下界（2026-10-26 · 可选）：mtime 太新的会话（可能还在写）不进。
      //   ⚠️ 刻意**不加进 stats 的键集**：`run.json` 的字段集合必须与改前一致，这样"缺省行为不变"
      //   才能用"去掉运行时刻字段后逐字节相等"证明（见交付报告 I1 判据）。参数只在 USAGE 与注释里。
      if (opts.minAgeHours !== null && Number.isFinite(opts.minAgeHours) && opts.minAgeHours > 0
        && (Date.now() - st.mtimeMs) < opts.minAgeHours * 3600 * 1000) {
        stats.sessionsSkipped.add(sid); stats.skipReasons['too-recent'] = (stats.skipReasons['too-recent'] ?? 0) + 1; continue;
      }

      const rd = readSessionRecords(sDir);
      stats.sessionsScanned += 1;
      const header = rd.records.find((r) => r?.type === 'session') ?? null;
      const judged = [];
      for (const rec of rd.records) {
        if (rec?.type !== 'user/message' && rec?.type !== 'assistant/message') continue;
        stats.messages += 1;
        const res = judgeMessage(rec, { sessionId: sid, workspaceDir: ws.name, includeRelay: opts.includeRelay, preset: header?.agentPreset ?? null });
        if (res.code === 'candidate') judged.push({ ...res.candidate, _sessionMtime: Math.round(st.mtimeMs) });
        else {
          bump(res.code.startsWith('sensitive') ? 'sensitive' : res.code);
          if (res.code === 'borderline') stats.borderline += 1;
        }
      }
      for (const c of judged) rawCands.push(c);
      perSession.push({
        sessionId: sid, workspaceDir: ws.name, bytes: st.size, mtime: isoLocal(st.mtimeMs),
        frames: rd.frames, torn: rd.torn, records: rd.records.length, messages: judged.length,
        cwd: header?.cwd ?? null, preset: header?.agentPreset ?? null,
      });
      if (opts.verbose) console.error(`[scan] ${ws.name}/${sid.slice(0, 8)} 记录 ${rd.records.length} 候选 ${judged.length}`);
    }
  }

  // ── 候选排序（确定性：事件时间 → 会话 → seq），再候选间去重 ──────────────────
  rawCands.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.sessionId === b.sessionId ? (a.seq ?? 0) - (b.seq ?? 0) : a.sessionId < b.sessionId ? -1 : 1));
  rawCands.forEach((c, i) => { c.candId = `cap-${String(c.at).slice(0, 10).replace(/-/g, '')}-${String(i + 1).padStart(4, '0')}`; });
  const dd = dedupeCandidates(rawCands);
  stats.mergedSameSession = dd.merged;
  stats.mergedCrossSession = dd.mergedCross ?? 0;
  stats.crossSessionTwins = dd.twins;

  // ── 与库里已有条目去重（只读池；dup 挡掉、near 保留并标注）─────────────────
  const dbPath = path.join(home, 'memory', 'memory.db');
  let pool = { docs: [], index: new Map() };
  let dbNote = null;
  try {
    const rows = loadMemoryPool(dbPath, { windowDays: 90, cap: 2000, nowMs: Date.now() });
    pool = buildPoolIndex(rows);
    dbNote = { dbPath, poolRows: rows.length, indexed: pool.docs.length };
  } catch (e) {
    dbNote = { dbPath, error: String(e?.message ?? e) };
    console.error(`[warn] 记忆库打不开（去重降级为"全 new"）：${dbNote.error}`);
  }
  const kept = [];
  for (const c of dd.list) {
    const r = judgeDedup(candidateText(c), pool);
    c.dedup = r;
    if (r.verdict === 'dup') { stats.dedupDropped += 1; continue; }
    if (r.verdict === 'near') stats.dedupNear += 1;
    if (r.alreadyDistilled) stats.alreadyDistilled += 1;
    kept.push(c);
  }
  if (opts.limit) kept.length = Math.min(kept.length, Number(opts.limit));
  stats.candidates = kept.length;

  // ── 可选：模型二判（**默认关**；关着时下面这个 if 一个字节都不进，也就不 import LLM 相关件）──
  let modelResult = null;
  if (opts.model && kept.length) {
    modelResult = await judgeWithModel(kept, {});
    stats.model.calls = modelResult.calls;
    stats.model.promptTokens = modelResult.usage.prompt_tokens;
    stats.model.completionTokens = modelResult.usage.completion_tokens;
    if (modelResult.ok) {
      const byId = new Map((modelResult.items ?? []).map((x) => [String(x.candId), x]));
      for (const c of kept) {
        const v = byId.get(c.candId);
        if (v) c.model = { verdict: v.verdict ?? null, claim: v.claim ?? null };
      }
      // 模型判 no 的候选不删（影子期只标注，不替人做决定），但摘要里报出来
      modelResult.droppedByModel = kept.filter((c) => c.model?.verdict === 'no').length;
    }
  }

  // ── 落盘 ──────────────────────────────────────────────────────────────────
  stats.fetchCalls = fetchCalls;
  stats.elapsedMs = Date.now() - t0;
  const ledgerAfter = statOf(ledgerFile);
  stats.tokenLedgerUnchanged = JSON.stringify(ledgerBefore) === JSON.stringify(ledgerAfter);
  if (!opts.noWrite) {
    fs.mkdirSync(effectiveOut, { recursive: true });
    const jsonl = kept.map((c) => JSON.stringify(c)).join('\n') + (kept.length ? '\n' : '');
    fs.writeFileSync(path.join(effectiveOut, 'candidates.jsonl'), jsonl, 'utf8');
    fs.writeFileSync(path.join(effectiveOut, 'candidates.md'), renderMarkdown(kept, stats, perSession, dbNote, modelResult), 'utf8');
    fs.writeFileSync(path.join(effectiveOut, 'run.json'), JSON.stringify({ stats, perSession, db: dbNote, skipped: [...stats.sessionsSkipped], model: modelResult }, null, 2), 'utf8');
  }

  const summary = {
    judgeVersion: JUDGE_VERSION, windowDays: opts.windowDays,
    sessionsScanned: stats.sessionsScanned, messages: stats.messages,
    candidates: stats.candidates, borderline: stats.borderline,
    mergedSameSession: stats.mergedSameSession, crossSessionTwins: stats.crossSessionTwins,
    dedupDropped: stats.dedupDropped, dedupNear: stats.dedupNear, alreadyDistilled: stats.alreadyDistilled,
    modelCalls: stats.model.calls, fetchCalls: stats.fetchCalls, outDir: opts.noWrite ? null : effectiveOut,
    tokenLedgerUnchanged: stats.tokenLedgerUnchanged,
    elapsedMs: stats.elapsedMs,
  };
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[shadow-capture] judgeVersion=${JUDGE_VERSION} 窗口 ${opts.windowDays} 天`);
    console.log(`  扫过会话 ${stats.sessionsScanned} / 消息 ${stats.messages} ⇒ 候选 ${stats.candidates}（边框档 ${stats.borderline} 只计数）`);
    console.log(`  候选间：同会话合并 ${stats.mergedSameSession} · 跨会话近似合并 ${stats.mergedCrossSession} · 跨会话同题 twin ${stats.crossSessionTwins}`);
    console.log(`  库内去重：dup 挡掉 ${stats.dedupDropped} · near 保留 ${stats.dedupNear} · 已提炼过 ${stats.alreadyDistilled}`);
    console.log(`  模型调用 ${stats.model.calls} 次 / fetch ${stats.fetchCalls} 次${opts.model ? '' : '（--model 未开 ⇒ 结构性为零）'} · token 账本未动=${stats.tokenLedgerUnchanged}`);
    console.log(`  耗时 ${stats.elapsedMs} ms${opts.noWrite ? '（--no-write：未落任何文件）' : ` · 落点 ${effectiveOut}`}`);
  }

  // ── 断言（失败 ⇒ rc=4）：默认档零模型 / 零网络 ────────────────────────────────
  if (!opts.model && (stats.model.calls > 0 || fetchCalls > 0)) {
    console.error(`[assert] 默认档竟然发生了模型调用（fetch=${fetchCalls}）—— 判据失败`);
    process.exitCode = 4; return;
  }
  process.exitCode = 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 渲染（人读的 candidates.md）
// ═══════════════════════════════════════════════════════════════════════════

function renderMarkdown(cands, stats, perSession, dbNote, modelResult) {
  const L = [];
  L.push('# 自动提炼影子 · 候选清单（只出候选 · 零写库）');
  L.push('');
  L.push(`- 判定口径：\`docs\\口径-什么该记（判定器）-20261025.md\` · **judgeVersion = ${JUDGE_VERSION}**`);
  L.push(`- 跑的时间：${stats.at} · 窗口：最近 ${stats.windowDays} 天（按会话日志 mtime）`);
  L.push(`- 扫过会话 **${stats.sessionsScanned}** 个 / 消息 **${stats.messages}** 条 ⇒ 候选 **${cands.length}** 条（边框档 ${stats.borderline} 只计数、不落候选）`);
  L.push(`- 去重：与库内已有条目 **dup 挡掉 ${stats.dedupDropped}** · near 保留 ${stats.dedupNear} · 已被提炼过 ${stats.alreadyDistilled}；候选间 同会话合并 ${stats.mergedSameSession} · 跨会话近似合并 ${stats.mergedCrossSession ?? 0} · 跨会话同题 twin ${stats.crossSessionTwins}`);
  L.push(`- 池：${dbNote?.error ? `**打不开**（${dbNote.error}）` : `${dbNote?.indexed ?? 0} 条已索引（近 90 天 ∪ distilled）`}`);
  L.push(`- **零写库**：本文件由 \`shadow-capture.mjs\` 只读产出；记忆库只以 readOnly 打开；模型调用 ${stats.model.calls} 次 · fetch ${stats.fetchCalls} 次`);
  L.push('');
  L.push('## 一、候选表（先扫这一屏）');
  L.push('');
  L.push('| # | candId | 时间 | 会话 | 来源 | 信号 | 分 | 主张 |');
  L.push('|---|---|---|---|---|---|---|---|');
  cands.forEach((c, i) => {
    L.push(`| ${i + 1} | \`${c.candId}\` | ${String(c.at).slice(5, 16)} | ${c.workspaceDir}/${String(c.sessionId).slice(0, 8)} | ${c.sourceKind} | ${c.signals.join('+')} | ${c.score} | ${esc(c.claim)} |`);
  });
  L.push('');
  L.push('## 二、逐条明细（为什么该记 + 原文片段 ≤80 字）');
  L.push('');
  cands.forEach((c, i) => {
    L.push(`### ${i + 1}. ${c.candId} · score ${c.score} · ${c.signals.join('+')}`);
    L.push('');
    L.push(`- 会话：\`${c.sessionId}\`（${c.workspaceDir}）seq ${c.seq} · 事件时间 ${c.at} · 来源 **${c.sourceKind}**${c.selfReported ? ' · **自述**（S5/S8 已降权）' : ''}`);
    L.push(`- **主张**：${esc(c.claim)}`);
    L.push(`- 片段：> ${esc(c.quote)}`);
    L.push(`- 为什么该记：${esc(c.reason)}`);
    L.push(`- tags：${c.tags.join(' / ')}`);
    const d = c.dedup ?? {};
    L.push(`- 去重：${d.verdict}${d.nearestId ? `（最近 #${d.nearestId} · sim ${d.sim}）` : ''}${d.alreadyDistilled ? ' · **已被提炼过（distilled）**' : ''}${c.crossSessionTwin ? ` · 跨会话同题 \`${c.crossSessionTwin}\`` : ''}${c.alsoSeen ? ` · 同会话重复 ${c.alsoSeen} 次` : ''}`);
    L.push('');
  });
  L.push('## 三、丢弃原因计数（判据的健康度）');
  L.push('');
  L.push('| 原因 | 条数 |');
  L.push('|---|---|');
  for (const [k, v] of Object.entries(stats.dropCodes).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v} |`);
  L.push('');
  L.push('## 四、扫过的会话（可复核窗口口径）');
  L.push('');
  L.push('| 会话 | 工作区 | mtime | 记录 | 候选 | 撕裂帧 |');
  L.push('|---|---|---|---|---|---|');
  for (const s of perSession) L.push(`| \`${String(s.sessionId).slice(0, 8)}\` | ${s.workspaceDir} | ${String(s.mtime).slice(5, 16)} | ${s.records} | ${s.messages} | ${s.torn ? '有' : '-'} |`);
  L.push('');
  if (modelResult) {
    L.push('## 五、模型二判（--model 开启）');
    L.push('');
    L.push(`- 调用 ${modelResult.calls} 次 · prompt ${modelResult.usage.prompt_tokens} tok · completion ${modelResult.usage.completion_tokens} tok`);
    L.push(`- 结果：${modelResult.ok ? `should ${(modelResult.items ?? []).filter((x) => x.verdict === 'should').length} / no ${(modelResult.items ?? []).filter((x) => x.verdict === 'no').length}` : `失败：${modelResult.error}`}`);
    L.push('');
  }
  return L.join('\n');
}

function esc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ═══════════════════════════════════════════════════════════════════════════
// 入口（async 版：模型档需要 await；守卫用 realpath 双方比）
// ═══════════════════════════════════════════════════════════════════════════

export function isMainEntry(argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMainEntry()) await main();
