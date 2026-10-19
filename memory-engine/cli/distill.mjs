#!/usr/bin/env node
// 记忆引擎 v2 · S3c —— 提炼 CLI（`cli/distill.mjs`）
//
// 用法：
//   node cli/distill.mjs --db <memory.db> [选项]              # 默认 **dry-run**（只打印不写库）
//   node cli/distill.mjs --db <memory.db> --apply             # 真跑：调模型 + 写库 + 写 state
//
// 选项：
//   --db <path>            记忆库（**必填**，无默认 —— 写死生产路径是明令禁止的）
//   --vectors-db <path>    向量库（默认 <home>/memory-vectors/vectors.db；home = db 的上上级）
//   --state <path>         提炼 state（默认 <home>/butler-distill-state.json）
//   --owner-user <id>      本机 owner 的 userid（缺省由身份表解析；解析不出 ⇒ **本轮 0 调用**）
//   --window-hours <n>     增量窗口（默认 24）
//   --limit <n>            输入条数上限（默认 0 = 不限）
//   --max-calls / --max-tokens   成本闸（默认 20 次 / 150000 token 每日）
//   --model / --base-url   模型档（默认 deepseek-flash @ 本鱼链；2026-09-21 主人拍板，不许改回第三方）
//   --sim-threshold <f>    聚类余弦阈值（默认 0.60）
//   --min-cluster-chars <n> 整组正文合计低于此值不调模型（默认 120）
//   --min-cluster-size <n>  组内少于 N 条不提炼（默认 **2**：单条自成一组不算聚类，且少写几条以护住 memory:recall 段）
//   --max-clusters <n>     单轮最多处理几组（默认 20）
//   --now <iso>            以某个时刻为"现在"（演练/三天不自我指涉模拟用）
//   --snapshot-dir <path>  写库前 `VACUUM INTO` 快照目录
//   --no-dirty-probe       不跑全表 hash 比对（不读 memories_dirty 补充源）
//   --daily-report <file>  追加/替换日报段（默认：今天的 <workspace>/docs/管家报告/<日期>-<设备>.md）
//   --no-daily             不写日报段
//   --json                 机器可读（stdout 只出 JSON，日志走 stderr）
//   --quiet / --help
//
// 退出码：0 = 正常（含"没活干"）/ 1 = 失败 / 2 = 用法错 / 3 = 环境不可用（库不在）
import fs from 'node:fs';
import path from 'node:path';
import { isMainEntry, parseArgs, makeLogger, num } from '../lib/cli-util.mjs';
import {
  runDistill, readState, renderDailyLine, updateDailySection, dailyReportPath,
  COST_LIMITS, DEFAULT_LLM, DEFAULT_WINDOW_HOURS, CLUSTER_DEFAULTS, STATE_SCHEMA,
} from '../lib/distill.mjs';

const USAGE = 'node cli/distill.mjs --db <memory.db> [--apply] [--window-hours 24] [--limit N] '
  + '[--max-calls 20] [--max-tokens 150000] [--max-clusters 20] [--min-cluster-size 2] [--min-cluster-chars 120] '
  + '[--model deepseek-flash] [--now <iso>] [--snapshot-dir <dir>] [--daily-report <file>] [--no-dirty-probe] '
  + '[--no-daily] [--json] [--help]';

/** 解析「本机 owner 的 userid」：权威实现优先，其次 fork 自检镜像，最后内置回落（与 domain-tags 同口径）。 */
async function resolveOwnerUser(explicit, home) {
  if (explicit) return { user: explicit, source: 'cli' };
  const cands = ['../../memory-db-tools/lib/memory-scope.mjs', '../dsh-memory-local/src/schema-migrate.mjs'];
  for (const rel of cands) {
    try {
      const mod = await import(new URL(rel, import.meta.url).href);
      const identity = mod.readIdentityTable ? mod.readIdentityTable(home) : null;
      const r = mod.resolveDefaultOwner ? mod.resolveDefaultOwner(identity) : null;
      if (r && r.ownerUser) return { user: r.ownerUser, source: `${rel} (${r.source})`, notes: r.notes ?? [] };
    } catch { /* 试下一个候选 */ }
  }
  return { user: null, source: '解析失败（两条权威源都不可用）', notes: ['⚠️ 本机 owner 解析不出来 ⇒ 按 D2 从严：本轮不调用任何第三方模型'] };
}

async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = makeLogger({ json, quiet: Boolean(flags.quiet) });
  if (flags.help) { process.stdout.write(`用法：${USAGE}\n`); return 0; }

  const dbPath = flags.db ? path.resolve(String(flags.db)) : null;
  if (!dbPath) {
    process.stderr.write('用法错：必须给 --db <库路径>（本脚本没有默认库路径）\n');
    return 2;
  }
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`环境不可用：库不存在 ${dbPath}\n`);
    return 3;
  }

  const home = path.resolve(flags.home ? String(flags.home) : path.dirname(path.dirname(dbPath)));
  const vectorsDb = flags['vectors-db'] ? path.resolve(String(flags['vectors-db'])) : path.join(home, 'memory-vectors', 'vectors.db');
  const stateFile = flags.state ? path.resolve(String(flags.state)) : path.join(home, 'butler-distill-state.json');
  const apply = Boolean(flags.apply);
  const now = flags.now ? Date.parse(String(flags.now)) : Date.now();
  if (!Number.isFinite(now)) { process.stderr.write(`用法错：--now 不是合法时间：${flags.now}\n`); return 2; }
  const limits = {
    callsPerDay: num(flags['max-calls'], COST_LIMITS.callsPerDay),
    tokensPerDay: num(flags['max-tokens'], COST_LIMITS.tokensPerDay),
  };
  const owner = await resolveOwnerUser(flags['owner-user'] ? String(flags['owner-user']) : null, home);
  const snapshotDir = flags['snapshot-dir'] ? path.resolve(String(flags['snapshot-dir'])) : null;

  log(`库      : ${dbPath}`);
  log(`向量库  : ${vectorsDb}`);
  log(`state   : ${stateFile}`);
  log(`本机 owner: ${owner.user ?? '(未解析)'}（来源 ${owner.source}）`);
  log(`模型    : ${flags.model ? String(flags.model) : DEFAULT_LLM.model}（成本闸 ≤${limits.callsPerDay} 次 / ≤${limits.tokensPerDay} token 每日）`);
  log(`模式    : ${apply ? 'APPLY（写库）' : 'DRY-RUN（只打印不写库）'}`);
  for (const n of owner.notes ?? []) log(`⚠️ ${n}`);

  const r = await runDistill({
    memoryDb: dbPath, vectorsDb, stateFile, now,
    windowHours: num(flags['window-hours'], DEFAULT_WINDOW_HOURS),
    apply,
    limits,
    model: flags.model ? String(flags.model) : DEFAULT_LLM.model,
    baseUrl: flags['base-url'] ? String(flags['base-url']) : DEFAULT_LLM.baseUrl,
    localOwner: owner.user,
    limit: num(flags.limit, 0),
    simThreshold: num(flags['sim-threshold'], CLUSTER_DEFAULTS.simThreshold),
    minClusterChars: num(flags['min-cluster-chars'], CLUSTER_DEFAULTS.minClusterChars),
    minClusterSize: num(flags['min-cluster-size'], CLUSTER_DEFAULTS.minClusterSize),
    maxClustersPerRun: num(flags['max-clusters'], CLUSTER_DEFAULTS.maxClustersPerRun),
    dirtyProbe: !flags['no-dirty-probe'],
    snapshotFile: snapshotDir ? path.join(snapshotDir, `memory-before-distill-${new Date(now).toISOString().replace(/[:.]/g, '-')}.db`) : null,
    log,
  });

  // 不调模型（dry-run / 环境问题）时也要留一行可查的"当日成本"，方便日报段
  const state = r.state ?? readState(stateFile, dbPath, new Date(now).toISOString());
  const dailyLine = r.dailyLine ?? renderDailyLine({ mode: r.mode, run: r.run ?? {}, cost: state.cost, limits, stopping: r.stopping });

  let daily = { ok: false, reason: '未写日报（--no-daily）' };
  if (!flags['no-daily'] && apply) {
    const file = flags['daily-report'] ? path.resolve(String(flags['daily-report'])) : dailyReportPath({ now });
    daily = updateDailySection({ file, line: dailyLine });
    if (daily.ok) log(`日报段已更新：${file}（${daily.replaced ? '替换既有段' : '追加新段'}）`);
    else log(`日报段未写：${daily.reason}（${file}）`);
  }

  const out = {
    ok: r.ok, mode: r.mode, at: new Date(now).toISOString(),
    db: dbPath, vectorsDb, stateFile, model: DEFAULT_LLM.model, ownerUser: owner.user, ownerSource: owner.source,
    limits, inputs: r.inputs, clusterStats: r.clusterStats ?? null, dirty: r.dirty ?? null,
    planned: r.planned, calls: r.calls, written: r.written, writtenIds: r.writtenIds,
    cost: state.cost ?? null, stopping: r.stopping, warnings: r.warnings, dailyLine, daily,
    snapshot: r.snapshot ?? null,
  };
  if (json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  else {
    log('');
    log(`输入 ${r.inputs?.accepted ?? 0} 条（窗口 ${r.inputs?.windowRows ?? 0} / 台账 ${r.inputs?.dirtyRows ?? 0}）⇒ 接受 ${r.inputs?.accepted ?? 0}`);
    log(`聚类 ${r.clusterStats?.clusters ?? 0} 组（单条组 ${r.clusterStats?.singletonClusters ?? 0} · 无向量 ${r.clusterStats?.noVector ?? 0}）`);
    for (const p of r.planned ?? []) log(`  ${p.action === 'call' ? '→ 调模型' : '· 跳过  '} ${p.key} ids=[${p.ids.join(',')}] ${p.action}${p.chars ? ` (${p.chars} 字)` : ''}`);
    for (const c of r.calls ?? []) log(`  ✦ ${c.key} 调用 ${c.ok ? 'OK' : '失败'} · ${c.tokens} token · 结论 ${c.conclusionChars} 字${c.error ? ` · ${c.error}` : ''}`);
    log(`提炼条数 ${r.written}${r.writtenIds?.length ? `（新 id ${r.writtenIds.join(',')}）` : ''}`);
    if (r.stopping) log(`停机：${r.stopping}`);
    log(`当日调用 ${state.cost?.calls ?? 0}/${limits.callsPerDay} · 当日 token ${(Number(state.cost?.promptTokens ?? 0) + Number(state.cost?.completionTokens ?? 0))}/${limits.tokensPerDay}`);
    for (const w of r.warnings ?? []) log(`⚠️ ${w}`);
    log(`日报行：${dailyLine}`);
  }
  return r.ok ? 0 : (r.exitCode || 1);
}

if (isMainEntry(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`未捕获异常：${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
}

export { main, resolveOwnerUser, STATE_SCHEMA };
