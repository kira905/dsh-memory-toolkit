// 记忆引擎 v2 · 离线层 —— 增量同步 CLI
//
// 用法：
//   node cli/sync.mjs                        # 增量（只读 memory.db → 写 vectors.db）
//   node cli/sync.mjs --full                 # 全量重建（换模型/维度也自动触发）
//   node cli/sync.mjs --dry-run              # 只算不写（计划与差异）
//   node cli/sync.mjs --json                 # 机器可读（日志走 stderr）
//   node cli/sync.mjs --stub-embedder        # 骨架模式（无模型依赖）
//   node cli/sync.mjs --source pitfall       # 同步**坑库**来源（默认 memory；两来源共库、meta 分命名空间）
//   路径可注入：--memory-db / --vectors-db / --pitfalls-file / --model-dir / --model / --dim / --batch
import { isMainEntry, parseArgs, makeLogger, openRuntime, num } from '../lib/cli-util.mjs';
import { runIncrementalSync } from '../lib/sync.mjs';

async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = makeLogger({ json, quiet: Boolean(flags.quiet) });
  let rt = null;
  try {
    rt = await openRuntime(flags);
    const stats = await runIncrementalSync({
      source: rt.source,
      store: rt.store,
      embedder: rt.embedder,
      modelId: rt.config.modelId,
      dim: rt.config.dim,
      sourceName: rt.sourceName,
      batchSize: num(flags.batch, rt.config.batchSize),
      full: Boolean(flags.full),
      dryRun: Boolean(flags['dry-run']),
      log,
    });
    const out = {
      ok: !stats.error,
      source: rt.sourceName,
      // 兼容字段：默认来源（memory）时语义与旧版一致
      memoryDb: rt.config.memoryDb,
      dataSource: rt.source.dbPath,
      vectorsDb: rt.config.vectorsDb,
      modelId: rt.config.modelId,
      ...stats,
    };
    if (json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else {
      log('');
      log('=== 增量同步结果 ===');
      log(`模式        : ${stats.mode}${stats.reasons.length ? `（${stats.reasons.join(' / ')}）` : ''}`);
      log(`来源        : ${rt.sourceName}（${rt.source.dbPath}）`);
      log(`向量库      : ${rt.config.vectorsDb}`);
      log(`模型        : ${rt.config.modelId}（${rt.embedder.dim} 维）`);
      log(`扫描/编码   : ${stats.scanned} / ${stats.encoded}（同哈希跳过 ${stats.skippedSameHash}）`);
      log(`向量条数    : ${stats.vectorsBefore} → ${stats.vectorsAfter}`);
      log(`水位        : ${stats.watermarkStart} → ${stats.watermarkEnd}`);
      log(`耗时        : ${(stats.elapsedMs / 1000).toFixed(2)}s`);
      if (stats.error) log(`❌ 失败      : ${stats.error}（进度已保留，可直接续跑）`);
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
