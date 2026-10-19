// 记忆引擎 v2 · 离线层 —— 兜底 hash 段轮转 CLI（方案 §3.1 兜底）
//
// 用法：
//   node cli/sweep.mjs                  # 跑 1 段（默认 20 段轮转；每周跑一次即可）
//   node cli/sweep.mjs --rounds 5
//   node cli/sweep.mjs --all            # 一轮完整覆盖（= --rounds <segments>）
//   node cli/sweep.mjs --dry-run --json
//   node cli/sweep.mjs --source pitfall    # 坑源兜底轮转（默认 memory；坑源按 lastSeen 排序切片）
import { isMainEntry, parseArgs, makeLogger, openRuntime, num } from '../lib/cli-util.mjs';
import { runHashSweep } from '../lib/sweep.mjs';

async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = makeLogger({ json, quiet: Boolean(flags.quiet) });
  let rt = null;
  try {
    rt = await openRuntime(flags);
    const segments = num(flags.segments, rt.config.sweepSegments);
    const rounds = flags.all ? segments : num(flags.rounds, 1);
    const stats = await runHashSweep({
      source: rt.source,
      store: rt.store,
      embedder: rt.embedder,
      modelId: rt.config.modelId,
      dim: rt.config.dim,
      sourceName: rt.sourceName,
      segments,
      rounds,
      dryRun: Boolean(flags['dry-run']),
      log,
    });
    const out = { ok: !stats.error, source: rt.sourceName, vectorsDb: rt.config.vectorsDb, ...stats };
    if (json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else {
      log('');
      log('=== 兜底 hash 段轮转结果 ===');
      log(`来源         : ${rt.sourceName}`);
      log(`id 段        : ${stats.range.lo} - ${stats.range.hi}（${stats.range.n} 条）`);
      log(`轮转游标     : ${stats.cursorStart} → ${stats.cursorEnd} / ${stats.segments}`);
      log(`扫描/重编码  : ${stats.scanned} / ${stats.fixed}（缺失 ${stats.missing} / 哈希不符 ${stats.mismatched}）`);
      log(`一轮完整覆盖 : ${stats.completedFullSweep ? '是（已更新 lastFullHashSweepAt）' : '否'}`);
      log(`耗时         : ${(stats.elapsedMs / 1000).toFixed(2)}s`);
      if (stats.error) log(`❌ 失败      : ${stats.error}`);
      else log('✅ 完成');
    }
    process.exitCode = stats.error ? 1 : 0;
  } catch (e) {
    const msg = String(e && e.stack ? e.stack : e);
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
    else log(`❌ ${msg}`);
    process.exitCode = 2;
  } finally {
    if (rt) rt.close();
  }
}

if (isMainEntry(import.meta.url)) await main();
