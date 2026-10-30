// 记忆引擎 · 离线层 —— 真实模型召回冒烟（给人读的证据）
//
// 单独成一个脚本的理由：中文查询经 cmd/ssh 传过去会变乱码，所以把探针查询集写死在
// 这个文件里当数据用；在目标机上跑一条命令，就能拿到「真模型 + 真语料」的可读召回
// 证据（含短暗号）。
import { existsSync } from 'node:fs';
import { parseArgs, isMainEntry } from '../lib/cli-util.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { openVectorsStore, countVectors, getMetaAll } from '../lib/vectors-store.mjs';
import { openMemorySource } from '../lib/memory-source.mjs';
import { createLocalEmbedder } from '../lib/embedder.mjs';
import { recall, buildVectorIndex, shouldTrigger } from '../lib/recall.mjs';

/** 固定探针集：日常暗号、工程问题，外加一个裸端口号。 */
const PROBES = [
  '退下吧',
  '整夜干活',
  '去深水区',
  '跨机同步挡推',
  '看板卡怎么验收',
  '守护鱼崩溃了怎么办',
  '生图角色一致性',
  'FTS5 中文分词',
  'task-board 并回账本',
  '3080 端口',
];

/** CLI 里能改配置路径的几个开关。 */
const PATH_FLAGS = [
  ['memoryDb', 'memory-db'],
  ['vectorsDb', 'vectors-db'],
  ['modelDir', 'model-dir'],
];

const LABEL_COLUMNS = 9;
const HIT_INDENT = '   ';
const MAX_BRIEF_CHARS = 58;
const TOP_K = 5;

/** 字符串的终端宽度：CJK 码点按两列算（首列才能对齐）。 */
const widthOf = (text) => [...text].reduce((cols, ch) => cols + (ch.codePointAt(0) > 0x2e7f ? 2 : 1), 0);

const padLabel = (text) => text + ' '.repeat(Math.max(0, LABEL_COLUMNS - widthOf(text)));

const collapse = (text) => String(text).replace(/\s+/g, ' ');

/** 一条记忆的单行、截断版摘要。 */
const excerpt = (text) => collapse(text).slice(0, MAX_BRIEF_CHARS);

const gateVerdict = (gate) => (gate.trigger ? '是' : `否(${gate.reason})`);

/** 把命令行开关翻成 resolveConfig 的覆盖项；没给的键一律不出现。 */
function overridesFrom(flags) {
  const overrides = {};
  for (const [key, flag] of PATH_FLAGS) {
    if (flags[flag]) overrides[key] = flags[flag];
  }
  if (flags.model) overrides.modelId = flags.model;
  if (flags.dim) overrides.dim = Number(flags.dim);
  return overrides;
}

/** 表头段：查之前先把语料形状交代清楚。 */
function printCorpora({ config, source, store, embedder }) {
  const rows = [
    ['主机', process.env.COMPUTERNAME || '?'],
    ['记忆库', `${config.memoryDb}（${source.count()} 条 / pinned ${source.pinnedIds().length} 条）`],
    ['向量库', `${config.vectorsDb}（${countVectors(store.db, 'memory')} 条向量）`],
    ['meta', JSON.stringify(getMetaAll(store.db))],
    ['模型', `${config.modelId} dim=${embedder.dim}`],
  ];
  console.log('=== 真实模型召回冒烟 ===');
  for (const [label, value] of rows) console.log(`${padLabel(label)}: ${value}`);
  console.log('');
}

function printHit(hit, row) {
  const stored = row ? row.pinned : '?';
  const text = excerpt(row ? row.text : '(已删除)');
  console.log(`${HIT_INDENT}#${hit.refId} score=${hit.score.toFixed(5)} [${hit.sources.join('+')}] pinned=${stored} · ${text}…`);
}

/** 跑一条探针；返回这条命中里漏进了几条 pinned。 */
async function runProbe({ query, store, source, embedder, index, pinnedIds }) {
  const gate = shouldTrigger(query);
  const startedAt = performance.now();
  const outcome = await recall({ query, store, source, embedder, index, resultTopK: TOP_K });
  const elapsed = performance.now() - startedAt;

  const ftsMatched = outcome.stats.ftsMatched ?? 0;
  console.log(`【${query}】触发=${gateVerdict(gate)} 命中 ${outcome.hits.length} 条 · ${elapsed.toFixed(1)}ms · FTS命中=${ftsMatched}`);

  let leaked = 0;
  for (const hit of outcome.hits) {
    if (pinnedIds.has(String(hit.refId))) leaked += 1;
    printHit(hit, source.getById(hit.id));
  }
  console.log('');
  return leaked;
}

async function main() {
  const { flags } = parseArgs();
  const config = resolveConfig(overridesFrom(flags));
  if (!existsSync(config.memoryDb)) throw new Error(`记忆库不存在：${config.memoryDb}`);

  const embedder = await createLocalEmbedder({
    modelDir: config.modelDir,
    modelId: config.modelId,
    dim: config.dim,
  });
  const store = openVectorsStore(config.vectorsDb);
  const source = openMemorySource(config.memoryDb);
  const index = buildVectorIndex(store.db, { source: 'memory' });

  printCorpora({ config, source, store, embedder });

  const pinnedIds = new Set(source.pinnedIds().map(String));
  let leakedTotal = 0;
  try {
    for (const query of PROBES) {
      leakedTotal += await runProbe({ query, store, source, embedder, index, pinnedIds });
    }
    console.log(`pinned 泄漏检查：${leakedTotal === 0 ? '✅ 0 条（排除生效）' : `❌ ${leakedTotal} 条`}`);
  } finally {
    source.close();
    store.db.close();
  }
  process.exitCode = leakedTotal === 0 ? 0 : 4;
}

if (isMainEntry(import.meta.url)) await main();
