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
// 本版新增（都是可选开关，不改变既有默认行为）：
//   node cli/recall.mjs --query "..." --lexicon on               # 打开词表第二路（默认读 dict/lexicon-config.json）
//   node cli/recall.mjs --query "..." --fallback-top-k 8         # 编码失败时的固定兜底条数
//   node cli/recall.mjs --query "..." --encode-timeout-ms 1500   # 编码预算
//   node cli/recall.mjs --query "..." --recall-log <目录>         # 旁路留痕（默认不写）
//
// 退出码：0 = 正常跑完（未触发也算正常）· 2 = 起不来/跑炸（--json 时错误也只上 stdout 的 JSON）。
import path from 'node:path';
import { isMainEntry, parseArgs, makeLogger, openRuntime, num } from '../lib/cli-util.mjs';
import {
  recall,
  recallMulti,
  buildVectorIndex,
  shouldTrigger,
  extractFtsTokens,
  buildFtsMatch,
  truncateQuery,
  QUERY_CHAR_LIMIT,
  ENCODE_TIMEOUT_MS,
  FALLBACK_TOP_K,
} from '../lib/recall.mjs';
import { getLexiconIndex, resolveLexiconSwitch } from '../lib/lexicon-recall.mjs';
import { openRecallLog } from '../lib/recall-log.mjs';

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

/** 三态开关：`--lexicon`（裸）= 开；`--lexicon on/off` 两种写法都认；没给 ⇒ null（读配置文件）。 */
function triState(raw, name) {
  if (raw === undefined) return null;
  if (raw === true) return true;
  const text = String(raw).trim().toLowerCase();
  if (['on', '1', 'true', 'yes', 'enable', 'enabled'].includes(text)) return true;
  if (['off', '0', 'false', 'no', 'disable', 'disabled'].includes(text)) return false;
  throw new Error(`--${name} 只认 on / off（收到 ${JSON.stringify(String(raw))}）`);
}

/** 单来源一轮：建一次向量索引（词表路开着就顺手建好词表索引，省一次预热等待） */
async function singleRound(rt, opts, log) {
  const { store, source, sourceName, embedder } = rt;
  const index = buildVectorIndex(store.db, { source: sourceName });
  const lexiconIndex = opts.lexiconEnabled ? getLexiconIndex(source, { allowBuild: true }) : null;
  const res = await recall({
    query: opts.query, store, source, embedder, index, sourceName,
    vectorTopK: opts.vectorTopK, ftsTopK: opts.ftsTopK, rrfK: opts.rrfK, resultTopK: opts.topK,
    queryCharLimit: opts.queryCharLimit, encodeTimeoutMs: opts.encodeTimeoutMs, fallbackTopK: opts.fallbackTopK,
    lexiconEnabled: opts.lexiconEnabled, lexiconTopK: opts.lexiconTopK, lexiconFloor: opts.lexiconFloor,
    lexiconIndex, recallLog: opts.recallLog,
    log,
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
    perSourceTopK: opts.perSource, rrfK: opts.rrfK, resultTopK: opts.topK,
    queryCharLimit: opts.queryCharLimit, encodeTimeoutMs: opts.encodeTimeoutMs,
    lexiconEnabled: opts.lexiconEnabled, lexiconTopK: opts.lexiconTopK, lexiconFloor: opts.lexiconFloor,
    recallLog: opts.recallLog,
    log,
  });
  return { size: entries.reduce((sum, e) => sum + (e.index.count || 0), 0), res };
}

function printHit(log, hit, multi) {
  const owner = multi ? ` [${hit.source}]` : '';
  const vec = hit.vectorRank ?? '-';
  const fts = hit.ftsRank ?? '-';
  const lex = hit.lexiconRank == null ? '' : `  lexRank=${hit.lexiconRank}`;
  const fallback = hit.fallbackRank == null ? '' : `  fallback=${hit.fallbackRank}`;
  log(`  #${hit.refId}${owner}  score=${hit.score.toFixed(5)}  来源=${hit.sources.join('+')}  vecRank=${vec} ftsRank=${fts}${lex}${fallback}`);
}

function printReport(log, out, last, names, repeat, times) {
  const multi = Boolean(names);
  const timings = last.timings;
  log('=== 召回 ===');
  row(log, '来源', out.source);
  row(log, '查询', JSON.stringify(out.query));
  row(log, '触发', last.triggered ? `是（${last.reason}）` : `否（${last.reason}）`);
  if (last.triggered) {
    const stats = last.stats || {};
    if (stats.queryTruncated) {
      row(log, '查询截断', `${stats.queryChars} → ${stats.queryCharsUsed} 字符（上限 ${stats.queryCharLimit}）`);
    }
    // 降级是「这一轮记忆从哪来的」的判据：显眼打出来，别让 SLI 只看到"有命中"
    row(log, '降级', last.degraded
      ? `是（${last.degraded.mode} / ${last.degraded.reason}）→ 固定 Top-${last.hits.length}`
      : '否');
    if (multi) {
      Object.entries(last.perSource || {}).forEach(([name, rec]) => log(
        `  · ${name}: 索引 ${rec.indexSize} 条 / 排除 pinned ${rec.pinnedExcluded} / 向量命中 ${rec.vectorHits} / FTS 命中 ${rec.ftsHits}${rec.lexiconHits ? ` / 词表命中 ${rec.lexiconHits}` : ''}${rec.fallbackHits ? ` / 兜底 ${rec.fallbackHits}` : ''}${rec.error ? ` / ⚠️ ${rec.error}` : ''}`,
      ));
    } else {
      row(log, '索引规模', `${stats.indexSize} 条向量 / 排除 pinned ${stats.pinnedExcluded} 条`);
      row(log, 'FTS 补位', stats.ftsSkipped
        ? '本轮跳过（编码降级）'
        : `tokens=${JSON.stringify(stats.ftsTokens)} → 命中 ${stats.ftsMatched}`);
      row(log, '词表路', stats.lexiconEnabled
        ? `开（${stats.lexiconStatus}${stats.lexiconHits ? ` / 命中 ${stats.lexiconHits}` : ''}${stats.lexiconBuildMs != null ? ` / 建索引 ${stats.lexiconBuildMs}ms` : ''}）`
        : `关（${stats.lexiconSwitchSource || 'default'}）`);
    }
    const lexiconMs = timings.lexiconMs == null ? '' : `词表 ${timings.lexiconMs.toFixed(1)}ms / `;
    row(
      log,
      '耗时',
      `编码 ${timings.encodeMs.toFixed(1)}ms / 向量 ${timings.vectorMs.toFixed(1)}ms / ${lexiconMs}融合 ${timings.fuseMs.toFixed(1)}ms / 合计 ${timings.totalMs.toFixed(1)}ms`,
    );
    log('命中 top-' + last.hits.length + '：');
    last.hits.forEach((hit) => printHit(log, hit, multi));
  }
  if (out.recallLog) row(log, '留痕', out.recallLog.file);
  if (repeat > 1) {
    log(`重复 ${times.length} 次：P50 ${at(times, 50).toFixed(1)}ms / P95 ${at(times, 95).toFixed(1)}ms`);
  }
}

async function work(rt, flags, log, json) {
  const { config, sourceName } = rt;
  const query = readQuery(flags);
  const names = pickNames(flags);
  const repeat = num(flags.repeat, 1);
  // 词表开关：命令行 > 环境变量 > dict/lexicon-config.json > 默认（关）
  const lexiconSetting = resolveLexiconSwitch({
    enabled: triState(flags.lexicon, 'lexicon'),
    topK: num(flags['lexicon-top-k'], null),
    floor: num(flags['lexicon-floor'], null),
  });
  // 留痕：给了 --recall-log 才写；--no-recall-log 或 DSH_MEMORY_RECALL_LOG=off 一键关回
  const wantedLog = flags['no-recall-log'] ? false : flags['recall-log'] === undefined ? null : true;
  const logDir = flags['recall-log'] === true
    ? path.join(config.dshHome, 'logs', 'memory-recall')
    : typeof flags['recall-log'] === 'string' ? flags['recall-log'] : null;
  const recallLog = wantedLog === false ? null : openRecallLog({ dir: logDir, enabled: wantedLog, env: process.env });

  const opts = {
    query,
    names,
    perSource: num(flags['per-source-top-k'], 5),
    vectorTopK: num(flags['vector-top-k'], config.vectorTopK),
    ftsTopK: num(flags['fts-top-k'], config.ftsTopK),
    rrfK: num(flags['rrf-k'], config.rrfK),
    topK: num(flags['top-k'], config.resultTopK),
    queryCharLimit: num(flags['query-max-chars'], QUERY_CHAR_LIMIT),
    encodeTimeoutMs: num(flags['encode-timeout-ms'], ENCODE_TIMEOUT_MS),
    fallbackTopK: num(flags['fallback-top-k'], FALLBACK_TOP_K),
    lexiconEnabled: lexiconSetting.enabled,
    lexiconTopK: lexiconSetting.topK,
    lexiconFloor: lexiconSetting.floor,
    recallLog,
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
  const shaped = truncateQuery(query, opts.queryCharLimit);
  const tokens = extractFtsTokens(shaped.text);
  const out = {
    ok: true,
    source: names ? names.join(',') : sourceName,
    vectorsDb: config.vectorsDb,
    indexSize: run.indexSize,
    gate: shouldTrigger(shaped.text),
    ftsTokens: tokens,
    ftsMatchExpr: buildFtsMatch(tokens),
    lexicon: {
      enabled: lexiconSetting.enabled,
      switchSource: lexiconSetting.source,
      topK: lexiconSetting.topK,
      floor: lexiconSetting.floor,
    },
    recallLog: recallLog ? { file: recallLog.file, stats: recallLog.stats() } : null,
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
