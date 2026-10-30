// 坑库向量钩子入口：一个「置标记 / 看标记 / 消费标记」三用的小命令。
//
// 坑库那边改完之后不直接编向量（会拖慢它自己），只写一个标记文件；谁有空谁来看这个标记，
// 有标记就跑一轮坑源增量同步，跑成功才清标记 —— 跑失败一律保留，下一轮重试。
//
//   node cli/pitfall-hook.mjs --status --json        # 只看：标记现值 + 两个来源的向量条数
//   node cli/pitfall-hook.mjs --run --json           # 预演（缺省就是不写、不清标记）
//   node cli/pitfall-hook.mjs --run --apply --json   # 真消费（写向量 + 清标记）
//   node cli/pitfall-hook.mjs --mark --reason "原因"  # 置标记
//
// 路径可注入：--marker-file / --pitfalls-file / --vectors-db / --dsh-home
// 退出码：0 = 正常（含没标记可消费）· 1 = 消费失败（标记保留）· 2 = 起不来。
import { isMainEntry, parseArgs, makeLogger, openRuntime, num } from '../lib/cli-util.mjs';
import { readMarker, markDirty, runPitfallHook } from '../lib/tick-hook.mjs';
import { countVectors } from '../lib/vectors-store.mjs';

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
async function withRuntime(flags, work, opts) {
  const rt = await openRuntime(flags, opts);
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

/** 模式判定：--run 优先，其次 --mark，都没有就是 --status */
const readMode = (flags) => ['run', 'mark'].find((k) => Boolean(flags[k])) || 'status';

function banner(log, mode, apply) {
  log(`=== 坑库向量钩子（${mode}${apply ? ' · --apply' : ' · 预演'}） ===`);
}

function report(log, out) {
  const row = (name, value) => log(`${field(name)}: ${value}`);
  row('标记文件', out.markerPath);
  row('坑库', out.pitfallsFile);
  row('向量库', out.vectorsDb);
  row('向量条数', `memory=${out.counts.memory} / pitfall=${out.counts.pitfall}`);
  const hook = out.hook;
  if (out.mode === 'status') {
    const unread = !out.marker.present && out.marker.error;
    const shown = out.marker.present ? JSON.stringify(out.marker.value) : '无';
    row('标记', unread ? `${shown}（读失败：${out.marker.error}）` : shown);
  }
  if (out.mode === 'mark') row('已置标记', `updatedAt=${out.mark.updatedAt}`);
  if (hook) {
    const skip = hook.skipped ? `（${hook.skipped}）` : '';
    row('钩子结果', `${hook.ok ? '✅' : '❌'} ${skip}`);
    if (hook.stats) {
      const s = hook.stats;
      row('同步', `扫 ${s.scanned} / 编码 ${s.encoded}（跳过 ${s.skippedSameHash}）向量 ${s.vectorsBefore} → ${s.vectorsAfter}`);
    }
    row('清标记', JSON.stringify(hook.cleared));
    row('向量条数', `memory=${out.countsAfter.memory} / pitfall=${out.countsAfter.pitfall}`);
  }
}

/** 三种模式各交一段「往结果上补的字段」；消费是唯一异步的那个 */
function handlersFor(ctx) {
  const { rt, flags, markerPath, apply, tally, log } = ctx;
  return {
    status() {
      const seen = readMarker(markerPath);
      return { marker: { present: seen.present, value: seen.marker, error: seen.error } };
    },
    mark() {
      const reason = flags.reason === undefined || flags.reason === true ? null : String(flags.reason);
      return { mark: markDirty(markerPath, { reason, by: 'cli/pitfall-hook.mjs' }) };
    },
    async run() {
      const { config, embedder, store } = rt;
      const hook = await runPitfallHook({
        markerPath,
        store,
        // 必须是坑源：别的来源会被 runPitfallHook 的守卫直接拒掉
        source: rt.openSource('pitfall'),
        embedder,
        modelId: config.modelId,
        dim: config.dim,
        batchSize: num(flags.batch, config.batchSize),
        full: Boolean(flags.full),
        dryRun: !apply,
        log,
      });
      return { hook, countsAfter: tally() };
    },
  };
}

async function work(rt, flags, ctx) {
  const { json, log, mode } = ctx;
  const { config, store } = rt;
  const apply = Boolean(flags.apply);
  const markerPath = config.pitfallVectorDirtyFile;
  const tally = () => ({ memory: countVectors(store.db, 'memory'), pitfall: countVectors(store.db, 'pitfall') });
  const out = {
    ok: true,
    mode,
    apply,
    markerPath,
    pitfallsFile: config.pitfallsFile,
    vectorsDb: config.vectorsDb,
    counts: tally(),
  };
  Object.assign(out, await handlersFor({ rt, flags, markerPath, apply, tally, log })[mode]());
  if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else {
    banner(log, mode, apply);
    report(log, out);
  }
  const failed = out.hook !== undefined && out.hook.ok === false;
  process.exitCode = failed ? FAIL_RUN : OK;
}

async function main() {
  const { flags, json, log } = boot();
  const mode = readMode(flags);
  try {
    // 钩子只关心坑源 ⇒ 不预开默认来源（默认来源会被守卫拒掉）；非 run 模式连编码器都不建
    await withRuntime(flags, (rt) => work(rt, flags, { json, log, mode }), {
      withSource: false,
      withEmbedder: mode === 'run',
    });
  } catch (err) {
    oops(json, log, err);
  }
}

if (isMainEntry(import.meta.url)) await main();
