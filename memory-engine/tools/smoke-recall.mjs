// 记忆引擎 v2 · 离线层 —— 真实模型召回冒烟（人读证据）
//
// 为什么单独一个脚本：命令行传中文经 cmd/ssh 会乱码，这里把查询集写死在文件里，
// 在目标机上直接跑，得到「真实模型 + 真实语料」的可读召回证据（含短暗号）。
import fs from 'node:fs';
import { parseArgs, isMainEntry } from '../lib/cli-util.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { openVectorsStore, countVectors, getMetaAll } from '../lib/vectors-store.mjs';
import { openMemorySource } from '../lib/memory-source.mjs';
import { createLocalEmbedder } from '../lib/embedder.mjs';
import { recall, buildVectorIndex, shouldTrigger } from '../lib/recall.mjs';

const QUERIES = [
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

async function main() {
  const { flags } = parseArgs();
  const config = resolveConfig({
    memoryDb: flags['memory-db'] || undefined,
    vectorsDb: flags['vectors-db'] || undefined,
    modelDir: flags['model-dir'] || undefined,
    modelId: flags.model || undefined,
    dim: flags.dim ? Number(flags.dim) : undefined,
  });
  if (!fs.existsSync(config.memoryDb)) throw new Error(`记忆库不存在：${config.memoryDb}`);

  const embedder = await createLocalEmbedder({
    modelDir: config.modelDir,
    modelId: config.modelId,
    dim: config.dim,
  });
  const store = openVectorsStore(config.vectorsDb);
  const source = openMemorySource(config.memoryDb);
  const index = buildVectorIndex(store.db, { source: 'memory' });

  console.log('=== 真实模型召回冒烟 ===');
  console.log(`主机     : ${process.env.COMPUTERNAME || '?'}`);
  console.log(`记忆库   : ${config.memoryDb}（${source.count()} 条 / pinned ${source.pinnedIds().length} 条）`);
  console.log(`向量库   : ${config.vectorsDb}（${countVectors(store.db, 'memory')} 条向量）`);
  console.log(`meta     : ${JSON.stringify(getMetaAll(store.db))}`);
  console.log(`模型     : ${config.modelId} dim=${embedder.dim}`);
  console.log('');

  const pinned = new Set(source.pinnedIds().map(String));
  let pinnedLeak = 0;
  for (const q of QUERIES) {
    const gate = shouldTrigger(q);
    const t0 = performance.now();
    const r = await recall({ query: q, store, source, embedder, index, resultTopK: 5 });
    const ms = performance.now() - t0;
    console.log(`【${q}】触发=${gate.trigger ? '是' : `否(${gate.reason})`} 命中 ${r.hits.length} 条 · ${ms.toFixed(1)}ms · FTS命中=${r.stats.ftsMatched ?? 0}`);
    for (const h of r.hits) {
      if (pinned.has(String(h.refId))) pinnedLeak += 1;
      const row = source.getById(h.id);
      const brief = (row ? row.text : '(已删除)').replace(/\s+/g, ' ').slice(0, 58);
      console.log(`   #${h.refId} score=${h.score.toFixed(5)} [${h.sources.join('+')}] pinned=${row ? row.pinned : '?'} · ${brief}…`);
    }
    console.log('');
  }
  console.log(`pinned 泄漏检查：${pinnedLeak === 0 ? '✅ 0 条（排除生效）' : `❌ ${pinnedLeak} 条`}`);
  source.close();
  store.db.close();
  process.exitCode = pinnedLeak === 0 ? 0 : 4;
}

if (isMainEntry(import.meta.url)) await main();
