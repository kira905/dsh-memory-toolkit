// 召回链验收夹具（本版新增能力的一次性现跑证据，不参与单测）。
//
//   node tools/verify-recall-chain.mjs                       # 只跑本版十项判据
//   node tools/verify-recall-chain.mjs --baseline <旧版 lib>  # 追加「开关关掉后与旧版逐字一致」对拍
//   node tools/verify-recall-chain.mjs --keep                 # 保留夹具目录（排查用）
//
// 全部夹具落系统临时目录；对生产库、生产向量库**零读写**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeTempRoot, makeMemoryDb, sampleRows, setPinned } from '../test/fixtures.mjs';
import { openVectorsStore } from '../lib/vectors-store.mjs';
import { openMemorySource } from '../lib/memory-source.mjs';
import { runIncrementalSync } from '../lib/sync.mjs';
import { createStubEmbedder } from '../lib/embedder.mjs';
import {
  recall,
  recallMulti,
  buildVectorIndex,
  truncateQuery,
  QUERY_CHAR_LIMIT,
  FALLBACK_TOP_K,
} from '../lib/recall.mjs';
import {
  buildLexiconIndex,
  rankByLexicon,
  loadWordTable,
  resetLexiconIndex,
  resolveLexiconSwitch,
  lexiconAssets,
} from '../lib/lexicon-recall.mjs';
import { createRecallLog, openRecallLog, recordRecall } from '../lib/recall-log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, '..');
const CLI = path.join(ENGINE, 'cli', 'recall.mjs');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : null;
};
const BASELINE = argOf('--baseline');
const KEEP = argv.includes('--keep');

const results = [];
let failed = 0;

async function check(title, body) {
  const started = Date.now();
  try {
    const detail = await body();
    results.push({ ok: true, title, detail, ms: Date.now() - started });
    console.log(`✅ ${title}${detail ? `\n     ↳ ${detail}` : ''}`);
  } catch (err) {
    failed += 1;
    results.push({ ok: false, title, detail: String(err && err.message ? err.message : err), ms: Date.now() - started });
    console.log(`❌ ${title}\n     ↳ ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 3).join('\n       ')}`);
  }
}

const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const idsOf = (hits) => hits.map((hit) => String(hit.refId));

// 编码器三态：正常 / 必超时 / 必抛错 / 空向量
const hangingEmbedder = { kind: 'hanging', encode: () => new Promise(() => {}) };
const brokenEmbedder = {
  kind: 'broken',
  encode: async () => {
    const err = new Error('bridge down');
    err.name = 'BridgeError';
    throw err;
  },
};
const emptyEmbedder = { kind: 'empty', encode: async () => new Float32Array(0) };

const embedder = createStubEmbedder({ dim: 512 });
const temp = makeTempRoot('dsh-k4-recall-');
const dirs = { root: temp.root, log: path.join(temp.root, 'recall-log'), dict: path.join(temp.root, 'empty-dict') };
fs.mkdirSync(dirs.dict, { recursive: true });

makeMemoryDb(temp.paths.memoryDb, sampleRows(10));
const store = openVectorsStore(temp.paths.vectorsDb);
let source = openMemorySource(temp.paths.memoryDb);
await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });

const index = buildVectorIndex(store.db, { source: 'memory' });
const ALL = 10;
const QUERY = '跨机同步的挡推裁决口径 task-board 3080';
const SHORT = '挡推裁决口径';

const close = () => {
  try { source.close(); } catch { /* ignore */ }
  try { store.db.close(); } catch { /* ignore */ }
};

console.log(`召回链验收夹具 · 引擎目录 = ${ENGINE}`);
console.log(`夹具根 = ${temp.root}${BASELINE ? ` · 基线（旧版 lib）= ${BASELINE}` : ''}\n`);

try {
  await check('① 查询截断：300 字 → 256 字（码点计），短查询不截断', () => {
    const long = truncateQuery(`召回 ${'长'.repeat(300)}`);
    ensure(long.truncated && long.text.length === QUERY_CHAR_LIMIT, `截断后长度异常：${long.text.length}`);
    ensure(long.chars === 303, `原长应记为 303，实际 ${long.chars}`);
    const emoji = truncateQuery('🐟'.repeat(400));
    ensure(emoji.text.length === QUERY_CHAR_LIMIT * 2, `emoji 按码点截断应得 ${QUERY_CHAR_LIMIT} 个字符，实际 UTF-16 长度 ${emoji.text.length}`);
    ensure(truncateQuery('短查询').truncated === false, '短查询不该被标截断');
    return `长查询 chars=303 → used=${QUERY_CHAR_LIMIT}；emoji 400 → ${emoji.text.length / 2} 个码点、无半个代理对`;
  });

  await check('①-b 截断贯通到召回：超长 query 的结果里 queryTruncated=true', async () => {
    const longQuery = `${QUERY} ${'补充说明'.repeat(60)}`;
    const out = await recall({ query: longQuery, store, source, embedder, index, resultTopK: 3, lexiconEnabled: false });
    ensure(out.stats.queryTruncated === true, 'stats.queryTruncated 应为 true');
    ensure(out.stats.queryChars > out.stats.queryCharsUsed, '原长应大于实际用到的长度');
    ensure(out.hits.length > 0, '截断后仍应有命中');
    return `queryChars=${out.stats.queryChars} / used=${out.stats.queryCharsUsed} / 命中 ${out.hits.length} 条`;
  });

  await check(`①-c 必修时编码器 → 固定 Top-${FALLBACK_TOP_K}（不返回空、标降级）`, async () => {
    const lines = [];
    const out = await recall({
      query: QUERY, store, source, embedder: hangingEmbedder, index,
      encodeTimeoutMs: 30, fallbackTopK: FALLBACK_TOP_K, resultTopK: FALLBACK_TOP_K,
      log: (line) => lines.push(String(line)),
    });
    ensure(out.triggered === true, '仍应判定触发');
    ensure(out.hits.length === FALLBACK_TOP_K, `应得 ${FALLBACK_TOP_K} 条，实际 ${out.hits.length}`);
    ensure(out.degraded && out.degraded.mode === 'fixed-topk', 'degraded.mode 应为 fixed-topk');
    ensure(out.encodeError && out.encodeError.name === 'TimeoutError', `encodeError.name 应为 TimeoutError，实际 ${out.encodeError && out.encodeError.name}`);
    ensure(out.hits.every((hit) => hit.sources.join('+') === 'fallback'), '兜底命中来源应全为 fallback');
    ensure(out.hits[0].fallbackRank === 1 && out.hits.at(-1).fallbackRank === FALLBACK_TOP_K, 'fallbackRank 应从 1 起连续');
    const expected = [10, 9, 8, 7, 6, 5, 4, 3];
    ensure(same(idsOf(out.hits), expected.map(String)), `兜底应按最近改动降序，期望 ${expected.join(',')}，实际 ${idsOf(out.hits).join(',')}`);
    ensure(lines.some((line) => line.includes('编码降级')), '日志应留一行「编码降级」痕迹');
    return `hits=${idsOf(out.hits).join(',')} · degraded=${out.degraded.mode}/${out.degraded.reason} · 日志：「${lines.find((l) => l.includes('编码降级'))}」`;
  });

  await check('①-d 抛错 / 空向量同样降级（错误名分别如实记录）', async () => {
    const broken = await recall({ query: QUERY, store, source, embedder: brokenEmbedder, index, resultTopK: 8, fallbackTopK: 8 });
    ensure(broken.hits.length === 8, `抛错时应给 8 条，实际 ${broken.hits.length}`);
    ensure(broken.encodeError.name === 'BridgeError', `错误名应如实，实际 ${broken.encodeError.name}`);
    const empty = await recall({ query: QUERY, store, source, embedder: emptyEmbedder, index, resultTopK: 8, fallbackTopK: 8 });
    ensure(empty.hits.length === 8 && empty.encodeError.name === 'EmptyVectorError', `空向量应降级为 EmptyVectorError，实际 ${empty.encodeError && empty.encodeError.name}`);
    return `BridgeError → ${broken.hits.length} 条 · EmptyVectorError → ${empty.hits.length} 条`;
  });

  await check('①-e 兜底仍排除 pinned（pin 掉最新那条，兜底第一条换成 9）', async () => {
    source.close();
    setPinned(temp.paths.memoryDb, 10, 1);
    source = openMemorySource(temp.paths.memoryDb);
    const out = await recall({ query: QUERY, store, source, embedder: hangingEmbedder, index, encodeTimeoutMs: 20, fallbackTopK: 8, resultTopK: 8 });
    ensure(!idsOf(out.hits).includes('10'), 'pinned 条不该出现在兜底里');
    ensure(idsOf(out.hits)[0] === '9', `兜底第一条应为 9，实际 ${idsOf(out.hits)[0]}`);
    ensure(out.stats.pinnedExcluded === 1, `应记录排除 1 条 pinned，实际 ${out.stats.pinnedExcluded}`);
    setPinned(temp.paths.memoryDb, 10, 0);
    source.close();
    source = openMemorySource(temp.paths.memoryDb);
    return `兜底前八 = ${idsOf(out.hits).join(',')}（已剔 pinned #10）`;
  });

  await check('②-a 词表路：BM25 给出候选，且排序与向量路不同', async () => {
    const assets = lexiconAssets();
    ensure(assets.bytes.words > 0 && assets.bytes.freq > 0, '词典/词频素材应存在');
    const lexIndex = buildLexiconIndex(source);
    ensure(lexIndex && lexIndex.docCount === ALL, `词表索引应覆盖 ${ALL} 行，实际 ${lexIndex && lexIndex.docCount}`);
    const ranked = rankByLexicon(SHORT, lexIndex, { topK: 20, floor: 0.3 });
    ensure(ranked.length > 0, '词表路应有候选（查询词在库里存在）');
    const { cosineTopK } = await import('../lib/recall.mjs');
    const vectorRanked = cosineTopK(index, await embedder.encode(SHORT), 20);
    ensure(!same(ranked.map((hit) => String(hit.id)), vectorRanked.map((hit) => String(hit.refId))), '两路排序不应完全相同');
    return `词表去 ${ranked.length} 条（${ranked.slice(0, 4).map((h) => h.id).join(',')}…）· 向量 top4（${vectorRanked.slice(0, 4).map((h) => h.refId).join(',')}…）· 排序有差异`;
  });

  await check('②-b 开关开 → 融合结果里出现 lexicon 来源（真起作用）', async () => {
    const lexIndex = buildLexiconIndex(source);
    const on = await recall({
      query: SHORT, store, source, embedder, index, resultTopK: 5,
      lexiconEnabled: true, lexiconIndex: lexIndex,
    });
    ensure(on.stats.lexiconEnabled === true, 'stats.lexiconEnabled 应为 true');
    ensure(on.stats.lexiconStatus === 'ok', `词表状态应为 ok，实际 ${on.stats.lexiconStatus}`);
    ensure(on.stats.lexiconHits > 0, '词表路应有命中');
    ensure(on.hits.some((hit) => hit.sources.includes('lexicon')), '融合命中里应出现 lexicon 来源');
    return `词表候选 ${on.stats.lexiconHits} 条 · 命中里带 lexicon 的 ${on.hits.filter((h) => h.sources.includes('lexicon')).length} 条 · id=${idsOf(on.hits).join(',')}`;
  });

  await check('②-c 开关关 → 与「默认（出厂关）」逐字一致', async () => {
    const explicitOff = await recall({ query: QUERY, store, source, embedder, index, resultTopK: 8, lexiconEnabled: false });
    const byDefault = await recall({ query: QUERY, store, source, embedder, index, resultTopK: 8 });
    ensure(byDefault.stats.lexiconEnabled === false, '出厂默认应为关');
    ensure(same(byDefault.hits, explicitOff.hits), '默认与显式关的结果应逐字一致');
    return `两条结果逐字相同（${idsOf(byDefault.hits).join(',')}）· 出厂开关来源=${byDefault.stats.lexiconSwitchSource}`;
  });

  if (BASELINE) {
    await check('②-d 开关关 → 与改动前旧版逐字对拍（同一夹具、同一索引）', async () => {
      const oldModule = await import(pathToFileURL(path.join(BASELINE, 'recall.mjs')).href);
      const project = (out) => ({
        triggered: out.triggered,
        reason: out.reason,
        hits: out.hits.map((hit) => ({
          refId: hit.refId, id: hit.id, score: hit.score, sources: hit.sources,
          vectorRank: hit.vectorRank, ftsRank: hit.ftsRank,
        })),
        stats: {
          indexSize: out.stats.indexSize,
          pinnedExcluded: out.stats.pinnedExcluded,
          vectorCandidates: out.stats.vectorCandidates,
          vectorHits: out.stats.vectorHits,
          ftsTokens: out.stats.ftsTokens,
          ftsMatchExpr: out.stats.ftsMatchExpr,
          ftsMatched: out.stats.ftsMatched,
          ftsHits: out.stats.ftsHits,
          fused: out.stats.fused,
        },
      });
      const queries = [QUERY, SHORT, '记忆库的 FTS5 分词实测结论', 'ledger 并回'];
      const report = [];
      for (const query of queries) {
        const before = await oldModule.recall({ query, store, source, embedder, index, resultTopK: 8 });
        const after = await recall({ query, store, source, embedder, index, resultTopK: 8, lexiconEnabled: false });
        ensure(same(project(before), project(after)), `对拍不一致：${query}`);
        report.push(`${query.slice(0, 8)}… ${idsOf(before.hits).length} 条一致`);
      }
      return `4 条查询逐字节一致 · ${report.join(' / ')}`;
    });
  }

  await check('②-e 词典缺失 → 优雅退化（不抛错、结果与纯向量一致）', async () => {
    const off = await recall({ query: SHORT, store, source, embedder, index, resultTopK: 5, lexiconEnabled: false });
    const previous = process.env.MEMORY_ENGINE_DICT_DIR;
    process.env.MEMORY_ENGINE_DICT_DIR = dirs.dict; // 空目录 = 没有词典
    resetLexiconIndex();
    try {
      const table = loadWordTable({ fresh: true });
      ensure(table.available === false, '空目录下应判定为「没有词表」');
      ensure(buildLexiconIndex(source) === null, '没有词典时建索引应返回 null');
      const on = await recall({ query: SHORT, store, source, embedder, index, resultTopK: 5, lexiconEnabled: true });
      ensure(same(on.hits, off.hits), '没有词典时结果应与纯向量完全一致');
      ensure(on.stats.lexiconStatus === 'warming' || on.stats.lexiconStatus === 'ok', `状态应为 warming/ok，实际 ${on.stats.lexiconStatus}`);
      ensure(on.stats.lexiconHits === 0, '没有词典时词表路应零命中');
      return `状态=${on.stats.lexiconStatus} · 命中 ${on.hits.length} 条，与纯向量逐字一致`;
    } finally {
      if (previous === undefined) delete process.env.MEMORY_ENGINE_DICT_DIR;
      else process.env.MEMORY_ENGINE_DICT_DIR = previous;
      loadWordTable({ fresh: true });
      resetLexiconIndex();
    }
  });

  await check('③ 留痕开 → JSONL 一行、字段齐（含降级轮）', async () => {
    const logger = createRecallLog({ dir: dirs.log, maxBytes: 1024 * 1024 });
    const normal = await recall({ query: QUERY, store, source, embedder, index, resultTopK: 4, recallLog: logger });
    const degraded = await recall({ query: QUERY, store, source, embedder: brokenEmbedder, index, resultTopK: 4, recallLog: logger });
    const lines = fs.readFileSync(logger.file, 'utf8').trim().split('\n');
    ensure(lines.length === 2, `应有 2 行，实际 ${lines.length}`);
    const [first, second] = lines.map((line) => JSON.parse(line));
    ensure(typeof first.t === 'string' && !Number.isNaN(Date.parse(first.t)), '时刻应可解析');
    ensure(first.query === QUERY && first.queryChars === QUERY.length, 'query 与长度应如实');
    ensure(Array.isArray(first.hits) && first.hits.length === normal.hits.length, '命中条数应与结果一致');
    ensure(typeof first.hits[0].score === 'number' && typeof first.hits[0].refId === 'string', '命中应有 id/refId/score');
    ensure(first.degraded === null, '正常轮 degraded 应为 null');
    ensure(second.degraded && second.degraded.mode === 'fixed-topk', '降级轮应如实标记');
    ensure(second.encodeError && second.encodeError.name === 'BridgeError', '降级轮应记错误名');
    ensure(same(first.hits.map((hit) => hit.refId), normal.hits.map((hit) => String(hit.refId))), '留痕顺序应与结果一致');
    return `${lines.length} 行 · 正常轮 hitCount=${first.hitCount} · 降级轮 degraded=${second.degraded.mode} · 文件 ${path.basename(logger.file)}`;
  });

  await check('③-b 留痕关 → 一个字节都不写', () => {
    const silentDir = path.join(dirs.root, 'log-off');
    ensure(openRecallLog({ dir: null, env: {} }) === null, '没给目录应返回 null');
    ensure(openRecallLog({ dir: silentDir, enabled: false }) === null, '开关关应返回 null');
    ensure(openRecallLog({ dir: silentDir, env: { DSH_MEMORY_RECALL_LOG: 'off' } }) === null, '环境变量 off 应返回 null');
    const instance = createRecallLog({ dir: silentDir, enabled: false });
    ensure(instance.record({ query: 'x' }) === false, '关掉的实例 record 应返回 false');
    ensure(!fs.existsSync(silentDir), '关掉时不该创建目录');
    ensure(recordRecall(null, { hits: [] }) === false, 'null logger 应空操作');
    return '四种关法（无目录 / enabled:false / 环境变量 off / null）均零写入，目录未创建';
  });

  await check('③-c 上限 → 按字节轮转，留 N 代不无限增长；超天数的旧代被清', () => {
    const rotateDir = path.join(dirs.root, 'log-rotate');
    const logger = createRecallLog({ dir: rotateDir, maxBytes: 900, keepFiles: 2, keepDays: 14 });
    for (let n = 0; n < 80; n += 1) logger.record({ event: 'recall', n, pad: 'x'.repeat(40) });
    const files = fs.readdirSync(rotateDir).sort();
    const active = fs.statSync(logger.file).size;
    ensure(active <= 900, `当前文件应不超过 900 B，实际 ${active}`);
    ensure(files.length <= 3, `最多应有 3 份（当前 + 2 代），实际 ${files.length}：${files.join(',')}`);
    ensure(files.includes('recall.1.jsonl'), '应出现第一代轮转文件');

    // 天数闸：把两代改成 30 天前，再让一个 keepDays=14 的实例 prune 一次
    for (const name of files) {
      if (name === 'recall.jsonl') continue;
      const full = path.join(rotateDir, name);
      const old = new Date(Date.now() - 30 * 86400000);
      fs.utimesSync(full, old, old);
    }
    const sweeper = createRecallLog({ dir: rotateDir, maxBytes: 900, keepFiles: 2, keepDays: 14 });
    sweeper.prune();
    const left = fs.readdirSync(rotateDir);
    ensure(!left.some((name) => name !== 'recall.jsonl'), `30 天前的旧代应被清掉，实际剩 ${left.join(',')}`);
    return `80 行写入 → 当前 ${active} B + ${files.filter((n) => n !== 'recall.jsonl').length} 代；旧代（30 天前）prune 后清空`;
  });

  await check('③-d keepFiles=0 → 只留当前文件（超限清空重开，不产生代）', () => {
    const truncDir = path.join(dirs.root, 'log-truncate');
    const logger = createRecallLog({ dir: truncDir, maxBytes: 500, keepFiles: 0, keepDays: 0 });
    for (let n = 0; n < 40; n += 1) logger.record({ n, pad: 'y'.repeat(40) });
    const files = fs.readdirSync(truncDir);
    ensure(files.length === 1 && files[0] === 'recall.jsonl', `只该有当前文件，实际 ${files.join(',')}`);
    ensure(fs.statSync(logger.file).size <= 500, '当前文件应不超上限');
    return `40 行写入后仅 1 份文件（${fs.statSync(logger.file).size} B）`;
  });

  await check('④ 多来源：编码失败也降级（每源固定 Top-K，不抛错）', async () => {
    const pitfallPath = temp.paths.pitfallsFile;
    const { makePitfallJson, samplePitfalls } = await import('../test/fixtures.mjs');
    const { openPitfallSource } = await import('../lib/pitfall-source.mjs');
    makePitfallJson(pitfallPath, samplePitfalls(4));
    const pitfall = openPitfallSource(pitfallPath);
    await runIncrementalSync({ source: pitfall, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const out = await recallMulti({
      query: QUERY, store, embedder: brokenEmbedder,
      entries: [
        { name: 'memory', source, index: buildVectorIndex(store.db, { source: 'memory' }) },
        { name: 'pitfall', source: pitfall, index: buildVectorIndex(store.db, { source: 'pitfall' }) },
      ],
      perSourceTopK: 3, resultTopK: 6,
    });
    ensure(out.degraded && out.degraded.mode === 'fixed-topk', '多来源降级标记应存在');
    ensure(out.hits.length > 0, '多来源降级不该返回空');
    ensure(out.hits.every((hit) => String(hit.sources.join('+')).includes('fallback')), '命中来源应标 fallback');
    pitfall.close();
    return `perSource=${Object.entries(out.perSource).map(([name, rec]) => `${name}:${rec.fallbackHits}`).join(' / ')} · 命中 ${out.hits.length} 条`;
  });

  await check('⑤ CLI 端到端：新开关生效 + 旧参数照旧 + 编码失败仍出结果', () => {
    const cliLogDir = path.join(dirs.root, 'cli-log');
    const common = [
      '--memory-db', temp.paths.memoryDb,
      '--vectors-db', temp.paths.vectorsDb,
      '--stub-embedder',
      '--query', QUERY,
      '--json',
    ];
    const run = (extra) => {
      const out = spawnSync(process.execPath, [CLI, ...common, ...extra], { cwd: ENGINE, encoding: 'utf8' });
      ensure(out.status === 0, `CLI 退出码应为 0，实际 ${out.status}；stderr=${String(out.stderr).slice(0, 400)}`);
      return JSON.parse(out.stdout);
    };

    const plain = run([]);
    ensure(plain.gate.trigger === true && plain.hits.length > 0, '旧参数（不加任何新开关）应照旧出结果');
    ensure(plain.lexicon && plain.lexicon.enabled === false, '默认应为词表关');
    ensure(plain.degraded == null, '正常轮不该有降级标记');

    const withLexicon = run(['--lexicon', 'on', '--recall-log', cliLogDir]);
    ensure(withLexicon.lexicon.enabled === true, '--lexicon on 应生效');
    ensure(withLexicon.stats.lexiconStatus === 'ok', `词表状态应为 ok，实际 ${withLexicon.stats.lexiconStatus}`);
    ensure(withLexicon.recallLog && fs.existsSync(withLexicon.recallLog.file), '应写出留痕文件');
    ensure(fs.readFileSync(withLexicon.recallLog.file, 'utf8').trim().split('\n').length >= 1, '留痕文件应至少 1 行');

    const degraded = spawnSync(process.execPath, [
      CLI, '--memory-db', temp.paths.memoryDb, '--vectors-db', temp.paths.vectorsDb,
      '--http-embedder', '--bridge-port', '1', '--query', QUERY, '--json',
      '--fallback-top-k', '6',
    ], { cwd: ENGINE, encoding: 'utf8' });
    ensure(degraded.status === 0, `编码不可用时 CLI 仍应退出 0，实际 ${degraded.status}`);
    const degradedJson = JSON.parse(degraded.stdout);
    ensure(degradedJson.degraded && degradedJson.degraded.mode === 'fixed-topk', 'CLI 应带降级标记');
    ensure(degradedJson.hits.length === 6, `应给 6 条兜底，实际 ${degradedJson.hits.length}`);
    return `默认 ${plain.hits.length} 条 / 词表开 ${withLexicon.stats.lexiconHits} 候选 / 桥不可用降级 ${degradedJson.hits.length} 条（rc 0）`;
  });

  if (BASELINE) {
    await check('⑤-b CLI 旧新对拍：旧版与新版在默认开关下 hits 完全一致', () => {
      const OLD_CLI = path.join(BASELINE, '..', 'cli', 'recall.mjs');
      ensure(fs.existsSync(OLD_CLI), `旧版 CLI 不在：${OLD_CLI}`);
      const common = [
        '--memory-db', temp.paths.memoryDb,
        '--vectors-db', temp.paths.vectorsDb,
        '--stub-embedder',
        '--query', SHORT,
        '--json',
      ];
      const grab = (cli) => {
        const out = spawnSync(process.execPath, [cli, ...common], { cwd: ENGINE, encoding: 'utf8' });
        ensure(out.status === 0, `CLI ${cli} 退出码 ${out.status}`);
        const json = JSON.parse(out.stdout);
        return json.hits.map((hit) => ({ refId: hit.refId, id: hit.id, score: hit.score, sources: hit.sources, vectorRank: hit.vectorRank, ftsRank: hit.ftsRank }));
      };
      const before = grab(OLD_CLI);
      const after = grab(CLI);
      ensure(same(before, after), '旧新 CLI 的 hits 应逐字一致');
      return `${before.length} 条命中逐字一致（${before.map((hit) => hit.refId).join(',')}）`;
    });
  }
} finally {
  close();
  if (!KEEP) temp.cleanup();
}

const passed = results.filter((row) => row.ok).length;
console.log(`\n—— 合计 ${results.length} 项：通过 ${passed} / 失败 ${failed} ——`);
if (KEEP) console.log(`夹具目录保留在 ${temp.root}`);
process.exitCode = failed ? 1 : 0;
