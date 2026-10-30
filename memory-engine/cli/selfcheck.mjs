// 启动自检入口：把「向量表在不在 / schema 对不对 / 编码器活不活 / 维度合不合 / 库是不是本机的」一次问清，
// 顺带报一行各来源的向量覆盖度。warn 不算失败 —— 自检结果只是给人看和给调用方判断降级用。
//
//   node cli/selfcheck.mjs [--json] [--stub-embedder] [--memory-db X] [--vectors-db Y] [--model-dir Z]
//
// 退出码：0 = 没有 fail 项（warn 照旧 0）· 1 = 有 fail 项 · 2 = 跑不起来。
import { isMainEntry, parseArgs, makeLogger, openRuntime } from '../lib/cli-util.mjs';
import { runSelfcheck } from '../lib/selfcheck.mjs';

const OK = 0;
const FAIL_CHECK = 1;
const CRASH = 2;
const COLUMNS = 12;

const MARKS = new Map([
  ['ok', '✅'],
  ['warn', '⚠️ '],
  ['fail', '❌'],
  ['info', 'ℹ️ '],
]);

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

function report(log, view, result) {
  const row = (name, value) => log(`${field(name)}: ${value}`);
  log('=== 启动自检 ===');
  row('主机', view.host);
  row('记忆库', view.memoryDb);
  row('向量库', view.vectorsDb);
  row('编码器', JSON.stringify(view.embedder));
  log('');
  result.checks.forEach((c) => log(`${MARKS.get(c.status) || '·'} ${c.name}：${c.detail}`));
  log('');
  log(result.ok ? `✅ 自检通过（warn ${result.warned}）` : `❌ 自检失败（fail ${result.failed}）`);
}

async function work(rt, flags, log, json) {
  const { config, embedder, source, store } = rt;
  const result = await runSelfcheck({
    store,
    source,
    embedder,
    config,
    // 缺省容忍 hostId 不一致（只告警）；--strict-host 才当失败
    allowHostMismatch: !flags['strict-host'],
  });
  const described = embedder.describe();
  const out = {
    ok: result.ok,
    host: config.hostId,
    memoryDb: config.memoryDb,
    vectorsDb: config.vectorsDb,
    modelId: config.modelId,
    modelDir: config.modelDir,
    embedder: described,
    ...result,
  };
  if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else {
    report(log, {
      host: config.hostId, memoryDb: config.memoryDb, vectorsDb: config.vectorsDb, embedder: described,
    }, result);
  }
  process.exitCode = result.ok ? OK : FAIL_CHECK;
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
