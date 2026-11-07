#!/usr/bin/env node
/**
 * 召回性能只读剖析器具（卡「召回性能与超时治本」· 2026-10-26）
 *
 * 只读：只读 `~/.dsh/logs/memory-recall.log`，**不写**除 `--out` 指定目录以外的任何东西，
 * 不碰 memory.db / vectors.db / 桥进程 / 插件源码。
 *
 * 口径（报告里必须同口径可比）：
 *   · 决策行（decision）= event 为 inject 或 skip 的行，**排除** expand / warmup / 坏行。
 *     「整轮不注入率」= count(reason=timeout) / 决策行 —— 这是卡里 3.9% 的分母。
 *   · 分位用**最近秩法**（nearest-rank，ceil(p*n)-1 取序），不是插值 ⇒ 读数恒为日志里真实出现过的值。
 *   · 日志时间戳是 UTC（`t` 字段带 Z）；「按小时分布」按**本地**（+08:00）归桶。
 *
 * 用法：
 *   node memory-engine/profile-recall.mjs                   # 默认近 7 天
 *   node memory-engine/profile-recall.mjs --days 1
 *   node memory-engine/profile-recall.mjs --since 2026-10-20 --until 2026-10-27
 *   node memory-engine/profile-recall.mjs --label after --out <输出目录>
 *   node memory-engine/profile-recall.mjs --json            # 只打 JSON 到 stdout
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TZ_OFFSET_MS = 8 * 3600 * 1000; // Asia/Shanghai（无夏令时）

function parseArgs(argv) {
  const out = { days: 7, out: null, label: 'baseline', json: false, log: null, since: null, until: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--log') out.log = argv[++i];
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--until') out.until = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write('用法见文件头注释\n');
      process.exit(0);
    }
  }
  return out;
}

/** 最近秩分位 */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

function stats(arr) {
  if (!arr.length) return { n: 0, min: null, p50: null, p90: null, p99: null, max: null, mean: null };
  const s = [...arr].sort((a, b) => a - b);
  const sum = s.reduce((x, y) => x + y, 0);
  return {
    n: s.length,
    min: round(s[0]),
    p50: round(quantile(s, 0.5)),
    p90: round(quantile(s, 0.9)),
    p99: round(quantile(s, 0.99)),
    max: round(s[s.length - 1]),
    mean: round(sum / s.length),
  };
}

const round = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10);

/** 本地时间键（YYYY-MM-DD / YYYY-MM-DDTHH） */
function localParts(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + TZ_OFFSET_MS); // 用 UTC getter 读 = 本地墙钟
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { date: ymd, hour: pad(d.getUTCHours()), minute: `${ymd}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`, dow: d.getUTCDay() };
}

/** 直方图分桶 */
function histogram(values, edges) {
  const buckets = edges.map((e, i) => ({
    label: i === 0 ? `<${e}` : `${edges[i - 1]}~${e}`,
    count: 0,
  }));
  buckets.push({ label: `>=${edges[edges.length - 1]}`, count: 0 });
  for (const v of values) {
    let placed = false;
    for (let i = 0; i < edges.length; i += 1) {
      if (v < edges[i]) {
        buckets[i].count += 1;
        placed = true;
        break;
      }
    }
    if (!placed) buckets[buckets.length - 1].count += 1;
  }
  return buckets;
}

function groupCount(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count);
}

// ───────────────────────────── 主流程 ─────────────────────────────
const args = parseArgs(process.argv.slice(2));
const logPath = args.log || path.join(os.homedir(), '.dsh', 'logs', 'memory-recall.log');
if (!fs.existsSync(logPath)) {
  process.stderr.write(`日志不存在：${logPath}\n`);
  process.exit(2);
}

const raw = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
const logBytes = fs.statSync(logPath).size;

// 时间窗
const nowMs = Date.now();
const untilMs = args.until ? Date.parse(args.until) : nowMs;
const sinceMs = args.since ? Date.parse(args.since) : untilMs - args.days * 86400000;

const parsed = [];
let badLines = 0;
let outOfWindow = 0;
for (const line of raw) {
  const s = line.trim();
  if (!s) continue;
  let o;
  try {
    o = JSON.parse(s);
  } catch {
    badLines += 1;
    continue;
  }
  const ms = Date.parse(o.t);
  if (Number.isNaN(ms)) {
    badLines += 1;
    continue;
  }
  if (ms < sinceMs || ms > untilMs) {
    outOfWindow += 1;
    continue;
  }
  parsed.push({ ...o, _ms: ms, _local: localParts(o.t) });
}

// 事件分类
const decisions = parsed.filter((r) => r.event === 'inject' || r.event === 'skip');
const injects = parsed.filter((r) => r.event === 'inject');
const skips = parsed.filter((r) => r.event === 'skip');
const timeouts = skips.filter((r) => r.reason === 'timeout');
const exceptions = skips.filter((r) => r.reason === 'exception');
const warmups = parsed.filter((r) => r.event === 'warmup');
const expands = parsed.filter((r) => r.event === 'expand');

// timings（只有 inject 行带）
const TK = ['encodeMs', 'vectorMs', 'ftsMs', 'lexiconMs', 'fuseMs', 'totalMs'];
const timingSeries = {};
for (const k of TK) timingSeries[k] = injects.map((r) => r.timings && r.timings[k]).filter((v) => typeof v === 'number');

const last100 = injects.slice(-100);
const last24h = parsed.filter((r) => r._ms >= untilMs - 86400000);
const injectLast24h = last24h.filter((r) => r.event === 'inject');
const decLast24h = last24h.filter((r) => r.event === 'inject' || r.event === 'skip');

const timingWindows = {
  all: Object.fromEntries(TK.map((k) => [k, stats(timingSeries[k])])),
  last100Inject: Object.fromEntries(TK.map((k) => [k, stats(last100.map((r) => r.timings && r.timings[k]).filter((v) => typeof v === 'number'))])),
  last24hInject: Object.fromEntries(TK.map((k) => [k, stats(injectLast24h.map((r) => r.timings && r.timings[k]).filter((v) => typeof v === 'number'))])),
};

// (a) 判据：warmup（= dsh 进程启动时刻）之后的第一个 inject 是否显著更贵
const restartAnalysis = [];
for (const w of warmups) {
  const after = injects.filter((r) => r._ms >= w._ms);
  if (!after.length) continue;
  // 同一个 warmup 周期内（下一个 warmup 之前）的第一个 inject
  const nextW = warmups.find((x) => x._ms > w._ms);
  const first = after[0];
  if (nextW && first._ms > nextW._ms) continue;
  const sameCycle = injects.filter((r) => r._ms >= w._ms && (!nextW || r._ms < nextW._ms));
  const rest = sameCycle.slice(1).map((r) => r.timings && r.timings.encodeMs).filter((v) => typeof v === 'number');
  restartAnalysis.push({
    warmupAt: w.t,
    warmupLocal: w._local && w._local.minute,
    ok: w.ok !== false,
    firstInjectAt: first.t,
    gapSec: Math.round((first._ms - w._ms) / 1000),
    firstEncodeMs: round(first.timings && first.timings.encodeMs),
    cycleInjectCount: sameCycle.length,
    restEncodeP50: stats(rest).p50,
    restEncodeN: rest.length,
  });
}

// (c) 判据：timeout 行的 ms 是否刚好卡在预算线
const timeoutMs = timeouts.map((r) => r.ms).filter((v) => typeof v === 'number');
const timeoutBudgets = groupCount(timeouts.filter((r) => r.budgetMs != null), (r) => String(r.budgetMs));
const timeoutOverBudgetRatio = timeouts
  .filter((r) => typeof r.ms === 'number' && typeof r.budgetMs === 'number' && r.budgetMs > 0)
  .map((r) => round(r.ms / r.budgetMs));

// (b) 判据：每分钟聚簇 —— 同分钟内有多个决策行 = 并发召回
const minuteMap = new Map();
for (const r of decisions) {
  const k = r._local && r._local.minute;
  if (!k) continue;
  const cur = minuteMap.get(k) || { minute: k, decisions: 0, injects: 0, timeouts: 0, exceptions: 0 };
  cur.decisions += 1;
  if (r.event === 'inject') cur.injects += 1;
  if (r.event === 'skip' && r.reason === 'timeout') cur.timeouts += 1;
  if (r.event === 'skip' && r.reason === 'exception') cur.exceptions += 1;
  minuteMap.set(k, cur);
}
const minutes = [...minuteMap.values()];
const busyMinutes = minutes.filter((m) => m.decisions > 1);
const timeoutMinutes = minutes.filter((m) => m.timeouts > 0);

/** timeout 与"同分钟并发"的交叉：timeout 所在分钟决策数分布 */
const timeoutMinuteConcurrency = groupCount(timeoutMinutes, (m) => String(m.decisions));

// 按小时 / 按天分布
const byHour = new Map();
for (let h = 0; h < 24; h += 1) byHour.set(String(h).padStart(2, '0'), { hour: String(h).padStart(2, '0'), injects: 0, timeouts: 0, exceptions: 0 });
for (const r of decisions) {
  const hh = r._local && r._local.hour;
  if (hh == null) continue;
  const cur = byHour.get(hh);
  if (!cur) continue;
  if (r.event === 'inject') cur.injects += 1;
  if (r.event === 'skip' && r.reason === 'timeout') cur.timeouts += 1;
  if (r.event === 'skip' && r.reason === 'exception') cur.exceptions += 1;
}

const byDay = groupCount(decisions, (r) => r._local && r._local.date).sort((a, b) => (a.key < b.key ? -1 : 1));
const dayDetail = byDay.map((d) => {
  const list = decisions.filter((r) => r._local && r._local.date === d.key);
  const inj = list.filter((r) => r.event === 'inject');
  return {
    date: d.key,
    decisions: list.length,
    injects: inj.length,
    timeouts: list.filter((r) => r.reason === 'timeout').length,
    exceptions: list.filter((r) => r.reason === 'exception').length,
    encodeP50: stats(inj.map((r) => r.timings && r.timings.encodeMs).filter((v) => typeof v === 'number')).p50,
    encodeP90: stats(inj.map((r) => r.timings && r.timings.encodeMs).filter((v) => typeof v === 'number')).p90,
  };
});

// 异常分组（error 摘要 -> 计数 + 首末时间）
const exGroups = (() => {
  const m = new Map();
  for (const r of exceptions) {
    const e = String(r.error || '');
    const head = e.split('\n')[0].slice(0, 160);
    const cur = m.get(head) || { key: head, count: 0, firstAt: r.t, lastAt: r.t };
    cur.count += 1;
    if (r._ms < Date.parse(cur.firstAt)) cur.firstAt = r.t;
    if (r._ms > Date.parse(cur.lastAt)) cur.lastAt = r.t;
    m.set(head, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
})();

const skipReasons = groupCount(skips, (r) => r.reason);

const encodeHist = histogram(timingSeries.encodeMs, [50, 100, 150, 200, 250, 300, 400]);
const totalHist = histogram(timingSeries.totalMs, [100, 150, 200, 250, 300, 400, 500, 700]);

const result = {
  meta: {
    generatedAtLocal: new Date(Date.now() + TZ_OFFSET_MS).toISOString().replace('Z', '+08:00'),
    logPath,
    logBytes,
    label: args.label,
    window: {
      sinceUtc: new Date(sinceMs).toISOString(),
      untilUtc: new Date(untilMs).toISOString(),
      sinceLocal: new Date(sinceMs + TZ_OFFSET_MS).toISOString().replace('Z', '+08:00'),
      untilLocal: new Date(untilMs + TZ_OFFSET_MS).toISOString().replace('Z', '+08:00'),
      days: args.days,
    },
    totalLines: raw.filter((s) => s.trim()).length,
    badLines,
    outOfWindow,
    inWindowLines: parsed.length,
  },
  counts: {
    decisions: decisions.length,
    injects: injects.length,
    skips: skips.length,
    timeouts: timeouts.length,
    exceptions: exceptions.length,
    warmups: warmups.length,
    expands: expands.length,
    timeoutRateOfDecisions: decisions.length ? round((timeouts.length / decisions.length) * 100) : null,
    exceptionRateOfDecisions: decisions.length ? round((exceptions.length / decisions.length) * 100) : null,
    skipReasons,
  },
  timings: timingWindows,
  histograms: { encodeMs: encodeHist, totalMs: totalHist },
  restartAnalysis, // (a)
  timeout: {
    ms: stats(timeoutMs),
    overBudgetRatio: stats(timeoutOverBudgetRatio),
    budgets: timeoutBudgets,
    lateTimerTrue: timeouts.filter((r) => r.lateTimer === true).length,
    lateTimerFalse: timeouts.filter((r) => r.lateTimer === false).length,
    byDay: groupCount(timeouts, (r) => r._local && r._local.date),
    byHour: groupCount(timeouts, (r) => r._local && r._local.hour).sort((a, b) => (a.key < b.key ? -1 : 1)),
    // 同一 session 的 timeout 前是否有别的会话在并发（用 minute 内 decisions 数近似）
    minuteConcurrency: timeoutMinuteConcurrency,
  },
  concurrency: {
    busyMinutes: busyMinutes.length,
    totalMinutesWithDecisions: minutes.length,
    maxDecisionsPerMinute: minutes.reduce((mx, m) => Math.max(mx, m.decisions), 0),
    topBusyMinutes: minutes.sort((a, b) => b.decisions - a.decisions).slice(0, 10),
  },
  byHour: [...byHour.values()],
  byDay: dayDetail,
  exceptionGroups: exGroups,
  last24h: {
    decisions: decLast24h.length,
    injects: injectLast24h.length,
    timeouts: decLast24h.filter((r) => r.reason === 'timeout').length,
    exceptions: decLast24h.filter((r) => r.reason === 'exception').length,
  },
};

// ───────────────────────────── 渲染 md ─────────────────────────────
function mdTable(rows, headers) {
  const head = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n`;
  return head + rows.map((r) => `| ${r.join(' | ')} |`).join('\n') + '\n';
}

function renderMd(R) {
  const L = [];
  L.push(`# 召回性能基线（${R.meta.label}）`);
  L.push('');
  L.push(`- 生成时刻（本地）：${R.meta.generatedAtLocal}`);
  L.push(`- 日志：\`${R.meta.logPath}\` · ${R.meta.logBytes} B · 总行 ${R.meta.totalLines}（坏行 ${R.meta.badLines}，窗外 ${R.meta.outOfWindow}，窗内 ${R.meta.inWindowLines}）`);
  L.push(`- 窗口（本地）：${R.meta.window.sinceLocal} → ${R.meta.window.untilLocal}（${R.meta.window.days} 天）`);
  L.push('');
  L.push('## 1. 计数与率');
  L.push('');
  L.push(mdTable([
    ['决策行（inject+skip）', R.counts.decisions],
    ['inject', R.counts.injects],
    ['skip 合计', R.counts.skips],
    ['　其中 timeout', R.counts.timeouts],
    ['　其中 exception', R.counts.exceptions],
    ['timeout 占决策行', `${R.counts.timeoutRateOfDecisions}%`],
    ['exception 占决策行', `${R.counts.exceptionRateOfDecisions}%`],
    ['warmup（≈ dsh 启动次数）', R.counts.warmups],
  ], ['项', '值']));
  L.push('skip 原因分布：');
  L.push('');
  L.push(mdTable(R.counts.skipReasons.map((s) => [`\`${s.key}\``, s.count]), ['reason', '次数']));

  L.push('## 2. timings 分位（最近秩法，ms）');
  L.push('');
  for (const [win, obj] of Object.entries(R.timings)) {
    L.push(`### ${win}`);
    L.push('');
    L.push(mdTable(
      Object.entries(obj).map(([k, v]) => [`\`${k}\``, v.n, v.p50, v.p90, v.p99, v.max]),
      ['字段', 'n', 'p50', 'p90', 'p99', 'max'],
    ));
  }

  L.push('## 3. encodeMs / totalMs 直方图');
  L.push('');
  L.push(`encodeMs：${R.histograms.encodeMs.map((b) => `${b.label}=${b.count}`).join(' · ')}`);
  L.push('');
  L.push(`totalMs：${R.histograms.totalMs.map((b) => `${b.label}=${b.count}`).join(' · ')}`);
  L.push('');

  L.push('## 4. 候选 (a)：编码器首调装载？— warmup 后首个 inject vs 同周期后续');
  L.push('');
  if (!R.restartAnalysis.length) L.push('（窗口内无可用 warmup 对齐样本）');
  else {
    L.push(mdTable(
      R.restartAnalysis.map((r) => [`${r.warmupLocal}`, r.ok ? 'ok' : 'fail', r.gapSec, r.firstEncodeMs ?? '—', r.restEncodeP50 ?? '—', r.restEncodeN]),
      ['warmup 本地时刻', '结果', '距首个 inject(s)', '首个 encodeMs', '同周期其余 p50', '其余 n'],
    ));
    const ratios = R.restartAnalysis.filter((r) => r.firstEncodeMs != null && r.restEncodeP50).map((r) => r.firstEncodeMs / r.restEncodeP50);
    L.push('');
    L.push(`首个/后续 比值：${ratios.length ? ratios.map((x) => round(x)).join(' · ') : '—'}`);
  }
  L.push('');

  L.push('## 5. 候选 (b)：并发？— 每分钟决策聚簇');
  L.push('');
  L.push(mdTable([
    ['有决策的分钟数', R.concurrency.totalMinutesWithDecisions],
    ['其中 >1 决策（并发分钟）', R.concurrency.busyMinutes],
    ['单分钟最大决策数', R.concurrency.maxDecisionsPerMinute],
  ], ['项', '值']));
  L.push('timeout 所在分钟的决策数分布（决策数=同分钟并发近似）：');
  L.push('');
  L.push(mdTable(R.timeout.minuteConcurrency.map((b) => [b.key, b.count]), ['同分钟决策数', 'timeout 次数']));
  L.push('最忙的 10 分钟：');
  L.push('');
  L.push(mdTable(R.concurrency.topBusyMinutes.map((m) => [m.minute, m.decisions, m.injects, m.timeouts, m.exceptions]), ['分钟(本地)', '决策', 'inject', 'timeout', 'exception']));

  L.push('## 6. 候选 (c)：预算太紧？— timeout 的 ms 与预算线');
  L.push('');
  L.push(mdTable([
    ['timeout 的 ms 分布', `n=${R.timeout.ms.n} min=${R.timeout.ms.min} p50=${R.timeout.ms.p50} p90=${R.timeout.ms.p90} max=${R.timeout.ms.max}`],
    ['ms / budgetMs 比值', `n=${R.timeout.overBudgetRatio.n} min=${R.timeout.overBudgetRatio.min} p50=${R.timeout.overBudgetRatio.p50} max=${R.timeout.overBudgetRatio.max}`],
    ['lateTimer=true（定时器被阻塞推后）', R.timeout.lateTimerTrue],
    ['lateTimer=false（定时器先到）', R.timeout.lateTimerFalse],
    ['出现的 budgetMs 取值', R.timeout.budgets.map((b) => `${b.key}(${b.count})`).join(' · ') || '—'],
  ], ['项', '值']));

  L.push('## 7. 按小时分布（本地）');
  L.push('');
  L.push(mdTable(R.byHour.map((h) => [h.hour, h.injects, h.timeouts, h.exceptions]), ['小时', 'inject', 'timeout', 'exception']));

  L.push('## 8. 按天');
  L.push('');
  L.push(mdTable(R.byDay.map((d) => [d.date, d.decisions, d.injects, d.timeouts, d.exceptions, d.encodeP50 ?? '—', d.encodeP90 ?? '—']), ['日期(本地)', '决策', 'inject', 'timeout', 'exception', 'encode p50', 'encode p90']));

  L.push('## 9. exception 分组（含时间窗，用于判"现在还在不在发生"）');
  L.push('');
  L.push(mdTable(R.exceptionGroups.map((g) => [`\`${g.key.replace(/\|/g, '\\|')}\``, g.count, g.firstAt, g.lastAt]), ['error 首行', '次数', '首次(UTC)', '末次(UTC)']));

  L.push('## 10. 最近 24h 摘要');
  L.push('');
  L.push(mdTable([
    ['决策', R.last24h.decisions],
    ['inject', R.last24h.injects],
    ['timeout', R.last24h.timeouts],
    ['exception', R.last24h.exceptions],
  ], ['项', '值']));
  return L.join('\n');
}

if (args.json) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = 0;
} else {
  const outDir = args.out || path.join(os.tmpdir(), `mem-perf-${new Date(Date.now() + TZ_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '')}`);
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, `${args.label}.md`);
  const jsonPath = path.join(outDir, `${args.label}.json`);
  const md = renderMd(result);
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf8');
  process.stdout.write(md + '\n');
  process.stdout.write(`\n[profile-recall] 已落：${mdPath}\n[profile-recall] 已落：${jsonPath}\n`);
}
