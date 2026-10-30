// 召回入口：向量召回 + FTS 补位 + 倒数排名融合，pinned 条目全程排除。
// 这里只管参数整形与结果排版；召回算法在 ../lib/recall.mjs。
//
// 常用姿势：
//   node cli/recall.mjs --query "某句暗号" --top-k 8
//   node cli/recall.mjs --query "task-board 看板" --json
//   node cli/recall.mjs --query "..." --repeat 100              # 连跑取分位数
//   node cli/recall.mjs --query "..." --source pitfall          # 换来源（缺省 memory）
//   node cli/recall.mjs --query "..." --sources memory,pitfall  # 多来源跨源融合
//
// 退出码：0 = 正常跑完（未触发也算正常）· 2 = 起不来/跑炸（--json 时错误也只上 stdout 的 JSON）。
import { isMainEntry, parseArgs, makeLogger, openRuntime, num } from '../lib/cli-util.mjs';
import {
  recall,
  recallMulti,
  buildVectorIndex,
  shouldTrigger,
  extractFtsTokens,
  buildFtsMatch,
} from '../lib/recall.mjs';

const CLEAN = 0;
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

/** 一列里中文占两格 ⇒ 自己算显示宽度再补空格，冒号才能对齐 */
function field(text) {
  let used = 0;
  for (const ch of String(text)) used += ch.codePointAt(0) > 0xff ? 2 : 1;
  return String(text) + ' '.repeat(Math.max(0, COLUMNS - used));
}

const row = (log, name, value) => log(`${field(name)}: ${value}`);

const readQuery = (flags) => (flags.query === undefined || flags.query === true ? '' : String(flags.query));

/** `--sources a,b` → ['a','b']；没给 / 给了空 ⇒ null（退回单来源那条路） */
function pickNames(flags) {
  const raw = flags.sources;
  if (raw === undefined || raw === true || raw === '') return null;
  const names = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return names.length ? names : null;
}

/** 分位数取最接近那条（不插值，和原来一致） */
const at = (sorted, pct) => sorted[Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))];

/** 单来源一轮：建一次向量索引，命中走 memory 语义 */
async function singleRound(rt, opts, log) {
  const { store, source, sourceName, embedder } = rt;
  const index = buildVectorIndex(store.db, { source: sourceName });
  const res = await recall({
    query: opts.query, store, source, embedder, index, sourceName,
    vectorTopK: opts.vectorTopK, ftsTopK: opts.ftsTopK, rrfK: opts.rrfK, resultTopK: opts.topK, log,
  });
  return { size: index.count, res };
}

/** 多来源一轮：每源各建索引、各出候选，融合交给 recallMulti */
async function fusedRound(rt, opts, log) {
  const { store, embedder } = rt;
  const entries = opts.names.map((name) => ({
    name, source: rt.openSource(name), index: buildVectorIndex(store.db, { source: name }),
  }));
  const res = await recallMulti({
    query: opts.query, store, entries, embedder,
    perSourceTopK: opts.perSource, rrfK: opts.rrfK, resultTopK: opts.topK, log,
  });
  return { size: entries.reduce((sum, e) => sum + (e.index.count || 0), 0), res };
}

function printHit(log, hit, multi) {
  const owner = multi ? ` [${hit.source}]` : '';
  const vec = hit.vectorRank ?? '-';
  const fts = hit.ftsRank ?? '-';
  log(`  #${hit.refId}${owner}  score=${hit.score.toFixed(5)}  来源=${hit.sources.join('+')}  vecRank=${vec} ftsRank=${fts}`);
}

function printReport(log, out, last, names, repeat, times) {
  const multi = Boolean(names);
  const timings = last.timings;
  log('=== 召回 ===');
  row(log, '来源', out.source);
  row(log, '查询', JSON.stringify(out.query));
  row(log, '触发', last.triggered ? `是（${last.reason}）` : `否（${last.reason}）`);
  if (last.triggered) {
    if (multi) {
      Object.entries(last.perSource || {}).forEach(([name, rec]) => log(
        `  · ${name}: 索引 ${rec.indexSize} 条 / 排除 pinned ${rec.pinnedExcluded} / 向量命中 ${rec.vectorHits} / FTS 命中 ${rec.ftsHits}${rec.error ? ` / ⚠️ ${rec.error}` : ''}`,
      ));
    } else {
      row(log, '索引规模', `${last.stats.indexSize} 条向量 / 排除 pinned ${last.stats.pinnedExcluded} 条`);
      row(log, 'FTS 补位', `tokens=${JSON.stringify(last.stats.ftsTokens)} → 命中 ${last.stats.ftsMatched}`);
    }
    row(
      log,
      '耗时',
      `编码 ${timings.encodeMs.toFixed(1)}ms / 向量 ${timings.vectorMs.toFixed(1)}ms / 融合 ${timings.fuseMs.toFixed(1)}ms / 合计 ${timings.totalMs.toFixed(1)}ms`,
    );
    log('命中 top-' + last.hits.length + '：');
    last.hits.forEach((hit) => printHit(log, hit, multi));
  }
  if (repeat > 1) {
    log(`重复 ${times.length} 次：P50 ${at(times, 50).toFixed(1)}ms / P95 ${at(times, 95).toFixed(1)}ms`);
  }
}

async function work(rt, flags, log, json) {
  const { config, sourceName } = rt;
  const query = readQuery(flags);
  const names = pickNames(flags);
  const repeat = num(flags.repeat, 1);
  const opts = {
    query,
    names,
    perSource: num(flags['per-source-top-k'], 5),
    vectorTopK: num(flags['vector-top-k'], config.vectorTopK),
    ftsTopK: num(flags['fts-top-k'], config.ftsTopK),
    rrfK: num(flags['rrf-k'], config.rrfK),
    topK: num(flags['top-k'], config.resultTopK),
  };
  // 连跑 --repeat 次只为拿分位数：每轮的结果都覆盖，只留最后一轮做展示
  const run = { times: [], last: null, indexSize: 0 };
  while (run.times.length < repeat) {
    const done = await (names ? fusedRound : singleRound)(rt, opts, log);
    run.indexSize = done.size;
    run.last = done.res;
    run.times.push(done.res.timings.totalMs);
  }
  run.times.sort((a, b) => a - b);
  const tokens = extractFtsTokens(query);
  const out = {
    ok: true,
    source: names ? names.join(',') : sourceName,
    vectorsDb: config.vectorsDb,
    indexSize: run.indexSize,
    gate: shouldTrigger(query),
    ftsTokens: tokens,
    ftsMatchExpr: buildFtsMatch(tokens),
    ...run.last,
    repeat: {
      n: run.times.length,
      p50: at(run.times, 50),
      p95: at(run.times, 95),
      min: run.times[0],
      max: run.times[run.times.length - 1],
    },
  };
  if (json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else printReport(log, out, run.last, names, repeat, run.times);
  process.exitCode = CLEAN;
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
