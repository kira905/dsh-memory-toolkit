// 记忆引擎 v2 · 离线层 —— 召回 CLI（向量 + FTS 补位 + RRF 融合 + 排除 pinned）
//
// 用法：
//   node cli/recall.mjs --query "退下吧" [--top-k 8]
//   node cli/recall.mjs --query "task-board 看板" --json
//   node cli/recall.mjs --query "..." --repeat 100     # 计时（V2 用 bench 更完整）
//   node cli/recall.mjs --query "..." --source pitfall          # 只召回坑源（默认 memory）
//   node cli/recall.mjs --query "..." --sources memory,pitfall  # 多来源召回（RRF 跨源融合）
import { isMainEntry, parseArgs, makeLogger, openRuntime, num } from '../lib/cli-util.mjs';
import {
  recall,
  recallMulti,
  buildVectorIndex,
  shouldTrigger,
  extractFtsTokens,
  buildFtsMatch,
} from '../lib/recall.mjs';

function parseSourceList(flags) {
  const raw = flags.sources;
  if (raw === undefined || raw === true || raw === '') return null;
  const list = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = makeLogger({ json, quiet: Boolean(flags.quiet) });
  const query = flags.query === undefined || flags.query === true ? '' : String(flags.query);
  const multiSources = parseSourceList(flags);
  let rt = null;
  try {
    rt = await openRuntime(flags);
    const repeat = num(flags.repeat, 1);
    let last = null;
    const times = [];
    let indexSize = 0;

    for (let i = 0; i < repeat; i += 1) {
      if (multiSources) {
        const entries = multiSources.map((name) => ({
          name,
          source: rt.openSource(name),
          index: buildVectorIndex(rt.store.db, { source: name }),
        }));
        indexSize = entries.reduce((a, e) => a + (e.index.count || 0), 0);
        last = await recallMulti({
          query,
          store: rt.store,
          entries,
          embedder: rt.embedder,
          perSourceTopK: num(flags['per-source-top-k'], 5),
          rrfK: num(flags['rrf-k'], rt.config.rrfK),
          resultTopK: num(flags['top-k'], rt.config.resultTopK),
          log,
        });
      } else {
        const index = buildVectorIndex(rt.store.db, { source: rt.sourceName });
        indexSize = index.count;
        last = await recall({
          query,
          store: rt.store,
          source: rt.source,
          embedder: rt.embedder,
          index,
          sourceName: rt.sourceName,
          vectorTopK: num(flags['vector-top-k'], rt.config.vectorTopK),
          ftsTopK: num(flags['fts-top-k'], rt.config.ftsTopK),
          rrfK: num(flags['rrf-k'], rt.config.rrfK),
          resultTopK: num(flags['top-k'], rt.config.resultTopK),
          log,
        });
      }
      times.push(last.timings.totalMs);
    }
    times.sort((a, b) => a - b);
    const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];

    const out = {
      ok: true,
      source: multiSources ? multiSources.join(',') : rt.sourceName,
      vectorsDb: rt.config.vectorsDb,
      indexSize,
      gate: shouldTrigger(query),
      ftsTokens: extractFtsTokens(query),
      ftsMatchExpr: buildFtsMatch(extractFtsTokens(query)),
      ...last,
      repeat: { n: times.length, p50: pct(50), p95: pct(95), min: times[0], max: times[times.length - 1] },
    };
    if (json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else {
      log(`=== 召回 ===`);
      log(`来源        : ${out.source}`);
      log(`查询        : ${JSON.stringify(query)}`);
      log(`触发        : ${last.triggered ? `是（${last.reason}）` : `否（${last.reason}）`}`);
      if (last.triggered) {
        if (multiSources) {
          for (const [name, rec] of Object.entries(last.perSource || {})) {
            log(
              `  · ${name}: 索引 ${rec.indexSize} 条 / 排除 pinned ${rec.pinnedExcluded} / 向量命中 ${rec.vectorHits} / FTS 命中 ${rec.ftsHits}${rec.error ? ` / ⚠️ ${rec.error}` : ''}`,
            );
          }
        } else {
          log(`索引规模    : ${last.stats.indexSize} 条向量 / 排除 pinned ${last.stats.pinnedExcluded} 条`);
          log(`FTS 补位    : tokens=${JSON.stringify(last.stats.ftsTokens)} → 命中 ${last.stats.ftsMatched}`);
        }
        log(`耗时        : 编码 ${last.timings.encodeMs.toFixed(1)}ms / 向量 ${last.timings.vectorMs.toFixed(1)}ms / 融合 ${last.timings.fuseMs.toFixed(1)}ms / 合计 ${last.timings.totalMs.toFixed(1)}ms`);
        log(`命中 top-${last.hits.length}：`);
        for (const h of last.hits) {
          log(
            `  #${h.refId}${multiSources ? ` [${h.source}]` : ''}  score=${h.score.toFixed(5)}  来源=${h.sources.join('+')}  vecRank=${h.vectorRank ?? '-'} ftsRank=${h.ftsRank ?? '-'}`,
          );
        }
      }
      if (repeat > 1) log(`重复 ${times.length} 次：P50 ${pct(50).toFixed(1)}ms / P95 ${pct(95).toFixed(1)}ms`);
    }
    process.exitCode = 0;
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
