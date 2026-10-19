// 记忆引擎 v2 · 离线层 —— 坑库向量同步钩子 CLI（A 点 · 标记/状态/消费三用）
//
// 用法：
//   node cli/pitfall-hook.mjs --status --json            # 只读：标记现值 + 两个来源的向量条数
//   node cli/pitfall-hook.mjs --run --json               # **预演**（默认 dry-run：只算不写、不清标记）
//   node cli/pitfall-hook.mjs --run --apply --json       # 真消费（写向量 + 清标记）
//   node cli/pitfall-hook.mjs --mark --reason "pitfall job 变动"   # 置标记（pitfall job 侧一行调用）
//   路径可注入：--marker-file / --pitfalls-file / --vectors-db / --dsh-home
//
// ⚠️ 生态规矩：动数据的动作一律**默认 dry-run**，`--apply` 才真写。
import { isMainEntry, parseArgs, makeLogger, openRuntime, num } from '../lib/cli-util.mjs';
import { readMarker, markDirty, runPitfallHook } from '../lib/tick-hook.mjs';
import { countVectors } from '../lib/vectors-store.mjs';

async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = makeLogger({ json, quiet: Boolean(flags.quiet) });
  const mode = flags.run ? 'run' : flags.mark ? 'mark' : 'status';
  const apply = Boolean(flags.apply);
  let rt = null;
  try {
    // 钩子只关心坑源 ⇒ 不预开默认来源（默认来源 = memory，会被守卫拒掉）
    rt = await openRuntime(flags, { withSource: false, withEmbedder: mode === 'run' });
    const markerPath = rt.config.pitfallVectorDirtyFile;
    const out = {
      ok: true,
      mode,
      apply,
      markerPath,
      pitfallsFile: rt.config.pitfallsFile,
      vectorsDb: rt.config.vectorsDb,
      counts: { memory: countVectors(rt.store.db, 'memory'), pitfall: countVectors(rt.store.db, 'pitfall') },
    };

    if (mode === 'status') {
      const r = readMarker(markerPath);
      out.marker = { present: r.present, value: r.marker, error: r.error };
    } else if (mode === 'mark') {
      out.mark = markDirty(markerPath, {
        reason: flags.reason === undefined || flags.reason === true ? null : String(flags.reason),
        by: 'cli/pitfall-hook.mjs',
      });
    } else {
      out.hook = await runPitfallHook({
        markerPath,
        store: rt.store,
        // ⚠️ 必须是**坑源**：默认来源（memory）会被 runPitfallHook 的守卫拒掉
        source: rt.openSource('pitfall'),
        embedder: rt.embedder,
        modelId: rt.config.modelId,
        dim: rt.config.dim,
        batchSize: num(flags.batch, rt.config.batchSize),
        full: Boolean(flags.full),
        dryRun: !apply,
        log,
      });
      out.countsAfter = {
        memory: countVectors(rt.store.db, 'memory'),
        pitfall: countVectors(rt.store.db, 'pitfall'),
      };
    }

    if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else {
      log(`=== 坑库向量钩子（${mode}${apply ? ' · --apply' : ' · 预演'}） ===`);
      log(`标记文件    : ${markerPath}`);
      log(`坑库        : ${rt.config.pitfallsFile}`);
      log(`向量库      : ${rt.config.vectorsDb}`);
      log(`向量条数    : memory=${out.counts.memory} / pitfall=${out.counts.pitfall}`);
      if (mode === 'status') log(`标记        : ${out.marker.present ? JSON.stringify(out.marker.value) : `无${out.marker.error ? `（读失败：${out.marker.error}）` : ''}`}`);
      if (mode === 'mark') log(`已置标记    : updatedAt=${out.mark.updatedAt}`);
      if (mode === 'run') {
        log(`钩子结果    : ${out.hook.ok ? '✅' : '❌'} ${out.hook.skipped ? `（${out.hook.skipped}）` : ''}`);
        if (out.hook.stats) log(`同步        : 扫 ${out.hook.stats.scanned} / 编码 ${out.hook.stats.encoded}（跳过 ${out.hook.stats.skippedSameHash}）向量 ${out.hook.stats.vectorsBefore} → ${out.hook.stats.vectorsAfter}`);
        log(`清标记      : ${JSON.stringify(out.hook.cleared)}`);
        log(`向量条数    : memory=${out.countsAfter.memory} / pitfall=${out.countsAfter.pitfall}`);
      }
    }
    process.exitCode = out.hook && out.hook.ok === false ? 1 : 0;
  } catch (e) {
    const msg = String(e && e.stack ? e.stack : e);
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
    else log(`❌ ${msg}`);
    process.exitCode = 2;
  } finally {
    if (rt) rt.close();
  }
}

if (isMainEntry(import.meta.url)) await main();
