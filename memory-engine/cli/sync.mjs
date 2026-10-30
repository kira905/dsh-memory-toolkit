// 增量同步入口：把数据源里新增/改过的条目编码进独立向量库。
// 源库只读、向量库只写；--dry-run 时一条都不落盘，只报计划与差异。
// 换模型 / 换维度 / --full ⇒ 自动转全量重建（清掉该来源的旧向量再编）。
//
// 路径与模型一律可注入：--memory-db / --vectors-db / --pitfalls-file / --model-dir / --model / --dim / --batch
// 退出码：0 = 跑完（0 条也算跑完）· 1 = 中途失败（进度已保存，可直接续跑）· 2 = 启动即炸。
import { isMainEntry, parseArgs, makeLogger, openRuntime, num } from '../lib/cli-util.mjs';
import { runIncrementalSync } from '../lib/sync.mjs';

const OK = 0;
const FAIL_RUN = 1;
const CRASH = 2;
const COLUMNS = 12;

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

function report(log, view, stats) {
  const row = (name, value) => log(`${field(name)}: ${value}`);
  log('');
  log('=== 增量同步结果 ===');
  row('模式', stats.mode + (stats.reasons.length ? `（${stats.reasons.join(' / ')}）` : ''));
  row('来源', `${view.source}（${view.dataSource}）`);
  row('向量库', view.vectorsDb);
  row('模型', `${view.modelId}（${view.dim} 维）`);
  row('扫描/编码', `${stats.scanned} / ${stats.encoded}（同哈希跳过 ${stats.skippedSameHash}）`);
  row('向量条数', `${stats.vectorsBefore} → ${stats.vectorsAfter}`);
  row('水位', `${stats.watermarkStart} → ${stats.watermarkEnd}`);
  row('耗时', `${(stats.elapsedMs / 1000).toFixed(2)}s`);
  if (stats.error) log(`❌ 失败      : ${stats.error}（进度已保留，可直接续跑）`);
  else log('✅ 完成');
}

async function work(rt, flags, log, json) {
  const { config, embedder, source, sourceName, store } = rt;
  const stats = await runIncrementalSync({
    source,
    store,
    embedder,
    modelId: config.modelId,
    dim: config.dim,
    sourceName,
    batchSize: num(flags.batch, config.batchSize),
    full: Boolean(flags.full),
    dryRun: Boolean(flags['dry-run']),
    log,
  });
  const out = {
    ok: !stats.error,
    source: sourceName,
    // 兼容老读法：缺省来源（memory）时与旧字段同义
    memoryDb: config.memoryDb,
    dataSource: source.dbPath,
    vectorsDb: config.vectorsDb,
    modelId: config.modelId,
    ...stats,
  };
  if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else {
    report(log, {
      source: sourceName, dataSource: source.dbPath, vectorsDb: config.vectorsDb, modelId: config.modelId, dim: embedder.dim,
    }, stats);
  }
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
