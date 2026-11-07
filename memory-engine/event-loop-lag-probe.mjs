#!/usr/bin/env node
/**
 * event-loop-lag-probe.mjs — 外部零侵入「同步长阻塞」探测器具 v1.0.0
 *
 * 目的：不改 dsh 进程一行代码，用最便宜的只读端点按固定 100ms 节奏打点，
 *      用「请求往返耗时 RTT」当事件循环延迟的代理指标。
 *      服务端事件循环被同步段堵住时，HTTP 响应就会被推后 ⇒ RTT 出现长尾。
 *
 * 设计要点（为什么这么写）：
 *  1) 串行单连接：上一发回来才发下一发。好处是「一次阻塞 = 一条长样本」，
 *     长样本的 ms 直接就是阻塞时长（并发打点反而会把一次阻塞摊到 N 条样本里）。
 *  2) 漂移补偿但不突发追赶：下一发目标时刻 = 上一发目标 + interval；
 *     若已超时太多（> interval），把目标重设为 now，绝不在一个时刻连发多枚
 *     ⇒ 天然满足「≤20 req/s」（interval 下限 50ms）。
 *  3) 只 GET、只读端点、无 body、无 cookie、不复用生产浏览器会话。
 *  4) 每发都记 status，4xx 也是有效读数（说明事件循环活着、只是路由没命中）。
 *
 * 用法：
 *   node event-loop-lag-probe.mjs --bench
 *       # 端点选型：逐个候选打 N 发，报 p50/p90/p99/max + 响应体字节数
 *   node event-loop-lag-probe.mjs --duration 60 --label idle-60s
 *       # 采样 60 秒（默认 100ms 间隔 ⇒ 约 600 点）
 *   node event-loop-lag-probe.mjs --duration 1260 --label main-idle
 *       # 主采样 21 分钟（约 12600 点）
 *   node event-loop-lag-probe.mjs --points 600 --label quick
 *       # 按点数采样
 *
 * 参数：
 *   --url <url>        探测目标（默认 http://127.0.0.1:3080/api/health）
 *   --interval <ms>    打点间隔，默认 100（下限 50）
 *   --duration <sec>   采样时长（秒）
 *   --points <n>       采样点数（与 --duration 二选一，duration 优先）
 *   --out <path>       JSONL 落点（默认 <系统临时目录>/event-loop-lag.jsonl，追加写）
 *   --label <name>     窗口标签（写进每条记录，也用于 summary 文件名）
 *   --slow <ms>        慢阈值，默认 200（超过则 slow=true，并在 stdout 打一行）
 *   --timeout <ms>     单发超时，默认 5000
 *   --bench            端点选型模式
 *   --bench-n <n>      每候选打几发，默认 120
 *   --truncate         先清空 --out（默认追加，方便多窗口累积）
 *   --quiet            不在 stdout 逐条打慢样本
 *   --help
 *
 * 注意（口径）：
 *  - 用 127.0.0.1，不要 localhost（Windows 可能先走 IPv6 回退，污染读数）。
 *  - 本器具只读、只 GET；不要拿它打写接口。
 *  - 阴性对照必须做：空闲 60 秒应 >90% 打点 <100ms，否则你测的是自己。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_OUT = path.join(os.tmpdir(), 'event-loop-lag.jsonl');
const DEFAULT_URL = 'http://127.0.0.1:3080/api/health';

function parseArgs(argv) {
  const a = {
    url: DEFAULT_URL,
    interval: 100,
    duration: null,
    points: null,
    out: DEFAULT_OUT,
    label: 'probe',
    slow: 200,
    timeout: 5000,
    bench: false,
    benchN: 120,
    truncate: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`参数 ${k} 缺值`);
      return v;
    };
    switch (k) {
      case '--url': a.url = next(); break;
      case '--interval': a.interval = Number(next()); break;
      case '--duration': a.duration = Number(next()); break;
      case '--points': a.points = Number(next()); break;
      case '--out': a.out = next(); break;
      case '--label': a.label = next(); break;
      case '--slow': a.slow = Number(next()); break;
      case '--timeout': a.timeout = Number(next()); break;
      case '--bench': a.bench = true; break;
      case '--bench-n': a.benchN = Number(next()); break;
      case '--truncate': a.truncate = true; break;
      case '--quiet': a.quiet = true; break;
      case '--help': case '-h': a.help = true; break;
      default:
        throw new Error(`未知参数 ${k}（--help 看用法）`);
    }
  }
  if (!Number.isFinite(a.interval) || a.interval < 50) {
    throw new Error('--interval 必须是 ≥50 的数字（上限 20 req/s）');
  }
  if (a.duration !== null && (!Number.isFinite(a.duration) || a.duration <= 0)) {
    throw new Error('--duration 必须是 >0 的数字（秒）');
  }
  if (a.points !== null && (!Number.isFinite(a.points) || a.points <= 0)) {
    throw new Error('--points 必须是 >0 的数字');
  }
  return a;
}

function usage() {
  const self = path.basename(process.argv[1] || 'event-loop-lag-probe.mjs');
  console.log(`event-loop-lag-probe.mjs v1.0.0 — dsh 进程内长同步阻塞的外部探测器具

用法:
  node ${self} --bench                                   # 端点选型（各候选打 --bench-n 发）
  node ${self} --duration 60   --label idle-60s           # 阴性对照：空闲 60 秒
  node ${self} --duration 1260 --label main              # 主采样 21 分钟
  node ${self} --points 600    --label quick             # 按点数

参数:
  --url <url>        默认 ${DEFAULT_URL}
  --interval <ms>    默认 100（下限 50 ⇒ ≤20 req/s）
  --duration <sec>   采样时长；与 --points 二选一（duration 优先）
  --points <n>       采样点数
  --out <path>       JSONL 落点，默认 ${DEFAULT_OUT}（追加写）
  --label <name>     窗口标签，默认 probe
  --slow <ms>        慢阈值，默认 200
  --timeout <ms>     单发超时，默认 5000
  --bench / --bench-n <n>   端点选型 / 每候选发几发（默认 120）
  --truncate         先清空 --out
  --quiet            不逐条打慢样本
  -h / --help

读数口径:
  只 GET、只读端点；串行单连接（一次阻塞 = 一条长样本，ms 即阻塞时长）。
  用 127.0.0.1，别用 localhost。
  阴性对照未过（空闲 60 秒内 >90% 打点 <100ms）⇒ 读数不可用，先查器具/机器。
`);
}

function httpGetOnce(url, timeoutMs, agent) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let done = false;
    const finish = (rec) => {
      if (done) return;
      done = true;
      const t1 = process.hrtime.bigint();
      rec.ms = Number(t1 - t0) / 1e6;
      resolve(rec);
    };
    let req;
    try {
      req = http.request(url, { method: 'GET', agent, headers: { accept: '*/*' } }, (res) => {
        let bytes = 0;
        res.on('data', (c) => { bytes += c.length; });
        res.on('end', () => finish({ status: res.statusCode, bytes }));
        res.on('error', (e) => finish({ status: 0, bytes, err: String(e && e.message || e) }));
      });
    } catch (e) {
      return finish({ status: 0, bytes: 0, err: String(e && e.message || e) });
    }
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(new Error(`timeout>${timeoutMs}ms`)); } catch { /* ignore */ }
    });
    req.on('error', (e) => finish({ status: 0, bytes: 0, err: String(e && e.message || e) }));
    req.end();
  });
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function summarize(msList, slowThreshold) {
  const s = [...msList].sort((x, y) => x - y);
  const n = s.length;
  const sum = s.reduce((acc, v) => acc + v, 0);
  const out = {
    n,
    mean: n ? +(sum / n).toFixed(2) : 0,
    p50: +pct(s, 50).toFixed(2),
    p90: +pct(s, 90).toFixed(2),
    p95: +pct(s, 95).toFixed(2),
    p99: +pct(s, 99).toFixed(2),
    max: n ? +s[n - 1].toFixed(2) : 0,
    min: n ? +s[0].toFixed(2) : 0,
    gt100: s.filter((v) => v > 100).length,
    gt200: s.filter((v) => v > 200).length,
    gt500: s.filter((v) => v > 500).length,
    gt1000: s.filter((v) => v > 1000).length,
    pctLt100: n ? +((s.filter((v) => v < 100).length / n) * 100).toFixed(2) : 0,
    slowThreshold,
  };
  return out;
}

async function bench(a) {
  const candidates = [
    'http://127.0.0.1:3080/api/health',
    'http://127.0.0.1:3080/',
    'http://127.0.0.1:3080/favicon.ico',
    'http://127.0.0.1:3080/api/dsh-lag-probe-404',
    'http://127.0.0.1:3080/api/version',
    'http://127.0.0.1:3080/api/status',
  ];
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const rows = [];
  for (const url of candidates) {
    const ms = [];
    const statuses = {};
    const bytesSet = new Set();
    for (let i = 0; i < a.benchN; i++) {
      const r = await httpGetOnce(url, a.timeout, agent);
      ms.push(r.ms);
      const key = String(r.status || r.err || 'err');
      statuses[key] = (statuses[key] || 0) + 1;
      if (r.bytes) bytesSet.add(r.bytes);
    }
    const sm = summarize(ms, a.slow);
    rows.push({ url, statuses, bytes: [...bytesSet].join('|') || '0', ...sm });
    await new Promise((r) => setTimeout(r, 50));
  }
  agent.destroy();
  console.log('=== 端点选型（每候选 ' + a.benchN + ' 发，串行单连接，127.0.0.1）===');
  for (const r of rows) {
    console.log(
      `${r.url}\n   status=${JSON.stringify(r.statuses)} bytes=${r.bytes}` +
      ` p50=${r.p50} p90=${r.p90} p99=${r.p99} max=${r.max} mean=${r.mean}`
    );
  }
  console.log('\n选型建议：挑 p50 最低 + 响应体字节最小 + 状态稳定（2xx 或固定 4xx，别飘）的那个。');
  return rows;
}

async function probe(a) {
  const interval = a.interval;
  const url = new URL(a.url);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  fs.mkdirSync(path.dirname(a.out), { recursive: true });
  if (a.truncate) fs.writeFileSync(a.out, '', 'utf8');
  const stream = fs.createWriteStream(a.out, { flags: 'a', encoding: 'utf8' });

  const pointBudget = a.duration !== null
    ? Math.max(1, Math.round((a.duration * 1000) / interval))
    : (a.points ?? 100);
  const deadline = Date.now() + pointBudget * interval;

  const msList = [];
  const slowEvents = [];
  const statusCount = {};
  let errCount = 0;
  let seq = 0;
  let target = Date.now();

  const t0 = Date.now();
  console.log(`[probe] start url=${url.href} interval=${interval}ms points=${pointBudget} out=${a.out} label=${a.label}`);

  while (seq < pointBudget && Date.now() < deadline + 5000) {
    // 漂移补偿：正常就按 target 走；落后超过一个间隔就重置，不追赶突发
    const now0 = Date.now();
    const wait = target - now0;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const fireLate = Date.now() - target; // >0 说明客户端自己也被堵了
    const r = await httpGetOnce(url.href, a.timeout, agent);
    seq++;

    const rec = {
      seq,
      t: new Date().toISOString(),
      label: a.label,
      ms: +r.ms.toFixed(2),
      status: r.status,
      bytes: r.bytes ?? 0,
      fireLate: fireLate > 0 ? fireLate : 0,
      slow: r.ms > a.slow,
    };
    if (r.err) rec.err = r.err;
    msList.push(r.ms);
    const sk = String(r.status || 'err');
    statusCount[sk] = (statusCount[sk] || 0) + 1;
    if (r.err) errCount++;
    if (rec.slow) {
      slowEvents.push(rec);
      if (!a.quiet) console.log(`  [slow] #${rec.seq} ${rec.t} ${rec.ms.toFixed(1)}ms status=${rec.status}${r.err ? ' err=' + r.err : ''}`);
    }
    stream.write(JSON.stringify(rec) + '\n');

    target += interval;
    if (Date.now() - target > interval) target = Date.now(); // 防突发追赶
  }

  await new Promise((r) => stream.end(r));
  agent.destroy();
  const wall = ((Date.now() - t0) / 1000).toFixed(1);

  const sum = summarize(msList, a.slow);
  const summary = {
    tool: 'event-loop-lag-probe.mjs',
    version: '1.0.0',
    label: a.label,
    url: url.href,
    intervalMs: interval,
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date().toISOString(),
    wallSeconds: Number(wall),
    out: a.out,
    statusCount,
    errCount,
    ...sum,
    slowEvents: slowEvents.map((e) => ({ seq: e.seq, t: e.t, ms: e.ms, status: e.status, fireLate: e.fireLate })),
  };
  const sumPath = a.out.replace(/\.jsonl$/i, '') + `-summary-${a.label}.json`;
  fs.writeFileSync(sumPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n=== 汇总 ===');
  console.log(`label=${a.label} wall=${wall}s n=${sum.n} status=${JSON.stringify(statusCount)} err=${errCount}`);
  console.log(`p50=${sum.p50} p90=${sum.p90} p95=${sum.p95} p99=${sum.p99} max=${sum.max} mean=${sum.mean}`);
  console.log(`>100ms=${sum.gt100} >200ms=${sum.gt200} >500ms=${sum.gt500} >1000ms=${sum.gt1000} <100ms占比=${sum.pctLt100}%`);
  console.log(`JSONL=${a.out}`);
  console.log(`SUM  =${sumPath}`);
  if (slowEvents.length) {
    console.log('\n慢样本（按耗时降序）:');
    for (const e of [...slowEvents].sort((x, y) => y.ms - x.ms)) {
      console.log(`  ${e.t}  ${e.ms.toFixed(1)}ms  status=${e.status}  seq=${e.seq}`);
    }
  }
  return summary;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exitCode = 0;
} else {
  (args.bench ? bench(args) : probe(args)).catch((e) => {
    console.error('[probe] 失败:', e && e.stack || e);
    process.exitCode = 1;
  });
}
