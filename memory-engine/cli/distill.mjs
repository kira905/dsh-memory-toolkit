#!/usr/bin/env node
// 提炼 CLI：把窗口内的记忆条目聚类，逐组交给模型压成一条「提炼产物」再写回库。
//
// 用法（对外契约：参数名 / 默认值 / 退出码都不变）：
//   node cli/distill.mjs --db <memory.db> [选项]      缺省是 **dry-run**：只算、只打印，不动库
//   node cli/distill.mjs --db <memory.db> --apply     真跑：调模型 → 写库 → 落 state → 写日报段
//
// 开关：
//   --db <path>              必填（无默认：写死生产路径是明令禁止的）
//   --vectors-db <path>      向量库（缺省 <home>/memory-vectors/vectors.db；home = 库文件的上一级目录）
//   --state <path>           提炼台账（缺省 <home>/butler-distill-state.json）
//   --owner-user <id>        本机 owner 的 userid（缺省查身份表；查不出 ⇒ 归属从严，本轮一次模型都不调）
//   --window-hours <n>       增量窗口（24）
//   --limit <n>              输入条数上限（0 = 不限）
//   --max-calls / --max-tokens   每日成本闸（20 次 / 150000 token）
//   --model / --base-url     模型档（缺省取库里的 DEFAULT_LLM）
//   --sim-threshold <f>      聚类余弦阈值（0.60）
//   --min-cluster-chars <n>  整组正文合计不到这个字数就不值得花一次调用（120）
//   --min-cluster-size <n>   组内少于 N 条不提炼（2：单条不成聚类，也为了别把 recall 段挤掉）
//   --max-clusters <n>       单轮最多处理几组（20）
//   --now <iso>              把某个时刻当"现在"（演练 / 模拟用）
//   --snapshot-dir <path>    写库前先 VACUUM INTO 到该目录
//   --no-dirty-probe         不做全表 hash 比对（不读 memories_dirty 补充源）
//   --daily-report <file>    覆盖日报落点（缺省是今天的管家报告）
//   --no-daily               不写日报段
//   --json                   stdout 只出 JSON，日志走 stderr
//   --quiet / --help
//
// 退出码：0 = 正常（含"没活干"）/ 1 = 失败 / 2 = 用法错 / 3 = 环境不可用（库不在）
import fs from 'node:fs';
import path from 'node:path';
import { isMainEntry, parseArgs, makeLogger, num } from '../lib/cli-util.mjs';
import {
  runDistill, readState, renderDailyLine, updateDailySection, dailyReportPath,
  COST_LIMITS, DEFAULT_LLM, DEFAULT_WINDOW_HOURS, CLUSTER_DEFAULTS, STATE_SCHEMA as LIB_STATE_SCHEMA,
} from '../lib/distill.mjs';

const USAGE = [
  'node cli/distill.mjs',
  '--db <memory.db>',
  '[--apply]',
  '[--window-hours 24]',
  '[--limit N]',
  '[--max-calls 20]',
  '[--max-tokens 150000]',
  '[--max-clusters 20]',
  '[--min-cluster-size 2]',
  '[--min-cluster-chars 120]',
  '[--model deepseek-flash]',
  '[--now <iso>]',
  '[--snapshot-dir <dir>]',
  '[--daily-report <file>]',
  '[--no-dirty-probe]',
  '[--no-daily]',
  '[--json]',
  '[--help]',
].join(' ');

export const STATE_SCHEMA = LIB_STATE_SCHEMA;

/** 数值旋钮表：flag 名 → 归一化字段 → 缺省值。 */
const KNOBS = [
  { flag: 'window-hours', field: 'windowHours', fallback: DEFAULT_WINDOW_HOURS },
  { flag: 'limit', field: 'limit', fallback: 0 },
  { flag: 'max-calls', field: 'callsPerDay', fallback: COST_LIMITS.callsPerDay },
  { flag: 'max-tokens', field: 'tokensPerDay', fallback: COST_LIMITS.tokensPerDay },
  { flag: 'sim-threshold', field: 'simThreshold', fallback: CLUSTER_DEFAULTS.simThreshold },
  { flag: 'min-cluster-chars', field: 'minClusterChars', fallback: CLUSTER_DEFAULTS.minClusterChars },
  { flag: 'min-cluster-size', field: 'minClusterSize', fallback: CLUSTER_DEFAULTS.minClusterSize },
  { flag: 'max-clusters', field: 'maxClustersPerRun', fallback: CLUSTER_DEFAULTS.maxClustersPerRun },
];

const OWNER_MODULES = ['../../memory-db-tools/lib/memory-scope.mjs', '../dsh-memory-local/src/schema-migrate.mjs'];

/** 本机 owner 的 userid：权威实现 → fork 自检镜像 → 内置回落（和域标签 CLI 同一口径）。 */
export async function resolveOwnerUser(explicit, home) {
  if (explicit) return { user: explicit, source: 'cli' };
  for (const spec of OWNER_MODULES) {
    const hit = await probeOwnerModule(spec, home);
    if (hit) return hit;
  }
  return {
    user: null,
    source: '解析失败（两条权威源都不可用）',
    notes: ['⚠️ 本机 owner 解析不出来 ⇒ 归属从严：本轮不调用任何第三方模型'],
  };
}

async function probeOwnerModule(spec, home) {
  try {
    const mod = await import(new URL(spec, import.meta.url).href);
    const table = mod.readIdentityTable ? mod.readIdentityTable(home) : null;
    const picked = mod.resolveDefaultOwner ? mod.resolveDefaultOwner(table) : null;
    if (!picked?.ownerUser) return null;
    return { user: picked.ownerUser, source: `${spec} (${picked.source})`, notes: picked.notes ?? [] };
  } catch {
    /* 换下一个候选 */
  }
  return null;
}

function readKnobs(flags) {
  const out = {};
  for (const knob of KNOBS) out[knob.field] = num(flags[knob.flag], knob.fallback);
  return out;
}

/** 参数校验：返回 {code} 表示当场收工，返回 {dbPath} 表示可以往下走。 */
function vetArgs(flags) {
  const dbPath = flags.db ? path.resolve(String(flags.db)) : null;
  if (!dbPath) {
    process.stderr.write('用法错：必须给 --db <库路径>（本脚本没有默认库路径）\n');
    return { code: 2 };
  }
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`环境不可用：库不存在 ${dbPath}\n`);
    return { code: 3 };
  }
  const now = flags.now ? Date.parse(String(flags.now)) : Date.now();
  if (!Number.isFinite(now)) {
    process.stderr.write(`用法错：--now 不是合法时间：${flags.now}\n`);
    return { code: 2 };
  }
  return { dbPath, now };
}

function composePayload({ r, state, limits, dailyLine, daily, ctx, owner }) {
  return {
    ok: r.ok,
    mode: r.mode,
    at: new Date(ctx.now).toISOString(),
    db: ctx.dbPath,
    vectorsDb: ctx.vectorsDb,
    stateFile: ctx.stateFile,
    model: DEFAULT_LLM.model,
    ownerUser: owner.user,
    ownerSource: owner.source,
    limits,
    inputs: r.inputs,
    clusterStats: r.clusterStats ?? null,
    dirty: r.dirty ?? null,
    planned: r.planned,
    calls: r.calls,
    written: r.written,
    writtenIds: r.writtenIds,
    cost: state.cost ?? null,
    stopping: r.stopping,
    warnings: r.warnings,
    dailyLine,
    daily,
    snapshot: r.snapshot ?? null,
  };
}

function printSummary({ r, state, limits, dailyLine, log }) {
  log('');
  log(`输入 ${r.inputs?.accepted ?? 0} 条（窗口 ${r.inputs?.windowRows ?? 0} / 台账 ${r.inputs?.dirtyRows ?? 0}）⇒ 接受 ${r.inputs?.accepted ?? 0}`);
  log(`聚类 ${r.clusterStats?.clusters ?? 0} 组（单条组 ${r.clusterStats?.singletonClusters ?? 0} · 无向量 ${r.clusterStats?.noVector ?? 0}）`);
  for (const step of r.planned ?? []) {
    const verb = step.action === 'call' ? '→ 调模型' : '· 跳过  ';
    const chars = step.chars ? ` (${step.chars} 字)` : '';
    log(`  ${verb} ${step.key} ids=[${step.ids.join(',')}] ${step.action}${chars}`);
  }
  for (const call of r.calls ?? []) {
    const tail = call.error ? ` · ${call.error}` : '';
    log(`  ✦ ${call.key} 调用 ${call.ok ? 'OK' : '失败'} · ${call.tokens} token · 结论 ${call.conclusionChars} 字${tail}`);
  }
  log(`提炼条数 ${r.written}${r.writtenIds?.length ? `（新 id ${r.writtenIds.join(',')}）` : ''}`);
  if (r.stopping) log(`停机：${r.stopping}`);
  const spent = Number(state.cost?.promptTokens ?? 0) + Number(state.cost?.completionTokens ?? 0);
  log(`当日调用 ${state.cost?.calls ?? 0}/${limits.callsPerDay} · 当日 token ${spent}/${limits.tokensPerDay}`);
  for (const warn of r.warnings ?? []) log(`⚠️ ${warn}`);
  log(`日报行：${dailyLine}`);
}

export async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = makeLogger({ json, quiet: Boolean(flags.quiet) });
  if (flags.help) {
    process.stdout.write(`用法：${USAGE}\n`);
    return 0;
  }

  const vetted = vetArgs(flags);
  if (vetted.code !== undefined) return vetted.code;
  const { dbPath, now } = vetted;

  const home = path.resolve(flags.home ? String(flags.home) : path.dirname(path.dirname(dbPath)));
  const vectorsDb = flags['vectors-db'] ? path.resolve(String(flags['vectors-db'])) : path.join(home, 'memory-vectors', 'vectors.db');
  const stateFile = flags.state ? path.resolve(String(flags.state)) : path.join(home, 'butler-distill-state.json');
  const apply = Boolean(flags.apply);
  const knobs = readKnobs(flags);
  const limits = { callsPerDay: knobs.callsPerDay, tokensPerDay: knobs.tokensPerDay };
  const owner = await resolveOwnerUser(flags['owner-user'] ? String(flags['owner-user']) : null, home);
  const snapshotDir = flags['snapshot-dir'] ? path.resolve(String(flags['snapshot-dir'])) : null;
  const model = flags.model ? String(flags.model) : DEFAULT_LLM.model;

  log(`库      : ${dbPath}`);
  log(`向量库  : ${vectorsDb}`);
  log(`state   : ${stateFile}`);
  log(`本机 owner: ${owner.user ?? '(未解析)'}（来源 ${owner.source}）`);
  log(`模型    : ${model}（成本闸 ≤${limits.callsPerDay} 次 / ≤${limits.tokensPerDay} token 每日）`);
  log(`模式    : ${apply ? 'APPLY（写库）' : 'DRY-RUN（只打印不写库）'}`);
  for (const note of owner.notes ?? []) log(`⚠️ ${note}`);

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const run = await runDistill({
    memoryDb: dbPath,
    vectorsDb,
    stateFile,
    now,
    windowHours: knobs.windowHours,
    apply,
    limits,
    model,
    baseUrl: flags['base-url'] ? String(flags['base-url']) : DEFAULT_LLM.baseUrl,
    localOwner: owner.user,
    limit: knobs.limit,
    simThreshold: knobs.simThreshold,
    minClusterChars: knobs.minClusterChars,
    minClusterSize: knobs.minClusterSize,
    maxClustersPerRun: knobs.maxClustersPerRun,
    dirtyProbe: !flags['no-dirty-probe'],
    snapshotFile: snapshotDir ? path.join(snapshotDir, `memory-before-distill-${stamp}.db`) : null,
    log,
  });

  // 没花一分钱（dry-run / 环境问题）也要给一行当日成本，日报段才拼得出来
  const state = run.state ?? readState(stateFile, dbPath, new Date(now).toISOString());
  const dailyLine = run.dailyLine ?? renderDailyLine({ mode: run.mode, run: run.run ?? {}, cost: state.cost, limits, stopping: run.stopping });

  let daily = { ok: false, reason: '未写日报（--no-daily）' };
  if (!flags['no-daily'] && apply) {
    const file = flags['daily-report'] ? path.resolve(String(flags['daily-report'])) : dailyReportPath({ now });
    daily = updateDailySection({ file, line: dailyLine });
    if (daily.ok) log(`日报段已更新：${file}（${daily.replaced ? '替换既有段' : '追加新段'}）`);
    else log(`日报段未写：${daily.reason}（${file}）`);
  }

  const ctx = { dbPath, vectorsDb, stateFile, now };
  const payload = composePayload({ r: run, state, limits, dailyLine, daily, ctx, owner });
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else printSummary({ r: run, state, limits, dailyLine, log });
  return run.ok ? 0 : (run.exitCode || 1);
}

if (isMainEntry(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`未捕获异常：${e?.stack ?? e}`);
      process.exitCode = 1;
    });
}
