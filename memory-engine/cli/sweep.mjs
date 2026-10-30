// 兜底轮转入口：按 id 段一圈一圈扫全表，重编码「正文哈希与向量库不符」和「库里压根没有」的条目。
// 主增量路径靠 updated_at 水位，摸不到那种「改了正文却没动 updated_at」的勘误；本命令就是补它的。
//
//   node cli/sweep.mjs                  # 走 1 段（默认把全表切 20 段，一周跑一次足够）
//   node cli/sweep.mjs --rounds 5
//   node cli/sweep.mjs --all            # 一次走完一整圈（= --rounds <段数>）
//   node cli/sweep.mjs --dry-run --json
//   node cli/sweep.mjs --source pitfall  # 换来源（坑源按 lastSeen 排序后切片）
//
// 退出码：0 = 跑完 · 1 = 中途失败 · 2 = 启动即炸。
import { isMainEntry, parseArgs, makeLogger, openRuntime, num } from '../lib/cli-util.mjs';
import { runHashSweep } from '../lib/sweep.mjs';

const OK = 0;
const FAIL_RUN = 1;
const CRASH = 2;
const COLUMNS = 13;

/** 统一的启动三件套：原始 flag、是否机器可读、以及分好流的 logger */
function boot() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  return { flags, json, log: makeLogger({ json, quiet: Boolean(flags.quiet) }) };
}

/** 开一个运行时，交给回调用，出了什么事都把库关掉 */
async function withRuntime(flags, work) {
  const rt = await openRuntime(flags);
  try {
    return await work(rt);
  } finally {
    rt.close();
  }
}

/** 起来就炸：json 走 stdout，文本走 logger，退出码固定 2 */
function oops(json, log, err) {
  const detail = String(err?.stack ?? err);
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: detail }, null, 2)}\n`);
  else log(`❌ ${detail}`);
  process.exitCode = CRASH;
}

/** 中文占两格：按显示宽度补空格，冒号右对齐 */
function field(text) {
  let used = 0;
  for (const ch of String(text)) used += ch.codePointAt(0) > 0xff ? 2 : 1;
  return String(text) + ' '.repeat(Math.max(0, COLUMNS - used));
}

function report(log, sourceName, stats) {
  const row = (name, value) => log(`${field(name)}: ${value}`);
  log('');
  log('=== 兜底 hash 段轮转结果 ===');
  row('来源', sourceName);
  row('id 段', `${stats.range.lo} - ${stats.range.hi}（${stats.range.n} 条）`);
  row('轮转游标', `${stats.cursorStart} → ${stats.cursorEnd} / ${stats.segments}`);
  row('扫描/重编码', `${stats.scanned} / ${stats.fixed}（缺失 ${stats.missing} / 哈希不符 ${stats.mismatched}）`);
  row('一轮完整覆盖', stats.completedFullSweep ? '是（已更新 lastFullHashSweepAt）' : '否');
  row('耗时', `${(stats.elapsedMs / 1000).toFixed(2)}s`);
  if (stats.error) log(`❌ 失败      : ${stats.error}`);
  else log('✅ 完成');
}

async function work(rt, flags, log, json) {
  const { config, embedder, source, sourceName, store } = rt;
  const segments = num(flags.segments, config.sweepSegments);
  // --all 就是把段数当轮数（一次覆盖全表）；否则默认只走 1 段
  const rounds = flags.all ? segments : num(flags.rounds, 1);
  const stats = await runHashSweep({
    source,
    store,
    embedder,
    modelId: config.modelId,
    dim: config.dim,
    sourceName,
    segments,
    rounds,
    dryRun: Boolean(flags['dry-run']),
    log,
  });
  const out = { ok: !stats.error, source: sourceName, vectorsDb: config.vectorsDb, ...stats };
  if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else report(log, sourceName, stats);
  process.exitCode = stats.error ? FAIL_RUN : OK;
}

async function main() {
  const { flags, json, log } = boot();
  try {
    await withRuntime(flags, (rt) => work(rt, flags, log, json));
  } catch (err) {
    oops(json, log, err);
  }
}

if (isMainEntry(import.meta.url)) await main();
