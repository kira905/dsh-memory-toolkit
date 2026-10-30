// 记忆引擎 v2 · 离线层 —— 基准（方案 §9 V1 / V2，判据只认真机实测）
//
// V1：① 单句编码延迟  ② 全量记忆条编码耗时（首次全量 / 重建成本）
// V2：100 次召回（含 query 编码 + 余弦 + FTS 补位 + RRF 融合）对照 §3.4 的 300ms 硬预算
//
// 用法（数据源必须是记忆库副本，绝不直连在用库）：
//   node bench/bench.mjs --memory-db <记忆库副本路径>
//        [--vectors-db <path>] [--model-dir <dir>] [--iterations 100] [--json] [--out report.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, isMainEntry } from '../lib/cli-util.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { openVectorsStore, countVectors } from '../lib/vectors-store.mjs';
import { openMemorySource } from '../lib/memory-source.mjs';
import { createLocalEmbedder } from '../lib/embedder.mjs';
import { runIncrementalSync } from '../lib/sync.mjs';
import { recall, buildVectorIndex, shouldTrigger } from '../lib/recall.mjs';
import { runSelfcheck } from '../lib/selfcheck.mjs';

const SHORT_QUERIES = ['退下吧', '整夜干活', '去深水区', '落卡', '回浅水区'];

function stats(samples) {
  const a = [...samples].sort((x, y) => x - y);
  const at = (p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
  const mean = a.reduce((s, v) => s + v, 0) / (a.length || 1);
  return {
    n: a.length,
    min: +a[0].toFixed(2),
    p50: +at(50).toFixed(2),
    p95: +at(95).toFixed(2),
    max: +a[a.length - 1].toFixed(2),
    mean: +mean.toFixed(2),
  };
}

export async function runBench({ config, iterations = 100, log = console.log, doSync = true }) {
  const report = {
    at: new Date().toISOString(),
    host: os.hostname(),
    platform: `${process.platform} ${os.arch()}`,
    node: process.version,
    cpu: (os.cpus()[0] || {}).model || 'unknown',
    cpuCount: os.cpus().length,
    totalMemGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    config: {
      memoryDb: config.memoryDb,
      vectorsDb: config.vectorsDb,
      modelId: config.modelId,
      modelDir: config.modelDir,
    },
    v1: {},
    v2: {},
    selfcheck: null,
  };

  // 冷启动：模型加载计时
  const tLoad0 = performance.now();
  const embedder = await createLocalEmbedder({
    modelDir: config.modelDir,
    modelId: config.modelId,
    dim: config.dim,
    quantized: Boolean(config.quantized),
  });
  report.v1.modelLoadMs = +(performance.now() - tLoad0).toFixed(1);
  report.v1.dim = embedder.dim;
  report.v1.embedder = embedder.describe();
  log(`[V1] 模型加载（冷启动）：${report.v1.modelLoadMs} ms · dim=${embedder.dim} · ${JSON.stringify(embedder.describe())}`);

  const store = openVectorsStore(config.vectorsDb);
  store.hostId = config.hostId;
  const source = openMemorySource(config.memoryDb);
  const total = source.count();
  report.v1.memoryRows = total;

  // ① 全量编码计时（逐条，含批 50 的同步写库）
  let syncStats = null;
  if (doSync) {
    const tFull0 = performance.now();
    syncStats = await runIncrementalSync({
      source,
      store,
      embedder,
      modelId: config.modelId,
      dim: config.dim,
      batchSize: config.batchSize,
      full: true,
      log: () => {},
    });
    const fullMs = performance.now() - tFull0;
    report.v1.fullEncode = {
      rows: syncStats.encoded,
      batches: syncStats.batches,
      totalMs: +fullMs.toFixed(1),
      perItemMs: +(fullMs / Math.max(1, syncStats.encoded)).toFixed(2),
      error: syncStats.error || null,
    };
    log(
      `[V1] 全量编码 ${syncStats.encoded} 条：${fullMs.toFixed(0)} ms（${(fullMs / Math.max(1, syncStats.encoded)).toFixed(2)} ms/条，${syncStats.batches} 批）`,
    );
  } else {
    report.v1.fullEncode = { rows: countVectors(store.db, 'memory'), skipped: true };
    log('[V1] 跳过全量编码（--no-sync）');
  }

  // ② 单句编码计时
  const singleSamples = [];
  const probeText = '跨机同步的挡推裁决口径与三仓推送顺序';
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await embedder.encode(probeText);
    singleSamples.push(performance.now() - t0);
  }
  report.v1.singleEncode = stats(singleSamples);
  log(`[V1] 单句编码 ${iterations} 次：P50 ${report.v1.singleEncode.p50} ms / P95 ${report.v1.singleEncode.p95} ms`);

  // ③ 长句编码（记忆条均长 740 字）
  const longRows = source.incrementalPage(0, 0, 20);
  const longText = longRows.map((r) => r.text).join('\n').slice(0, 2000) || probeText.repeat(20);
  const longSamples = [];
  for (let i = 0; i < Math.min(30, iterations); i += 1) {
    const t0 = performance.now();
    await embedder.encode(longText);
    longSamples.push(performance.now() - t0);
  }
  report.v1.longEncode = { chars: longText.length, ...stats(longSamples) };
  log(
    `[V1] 长文本（${longText.length} 字）编码 ${longSamples.length} 次：P50 ${report.v1.longEncode.p50} ms / P95 ${report.v1.longEncode.p95} ms`,
  );

  // V2：召回计时
  const index = buildVectorIndex(store.db, { source: 'memory' });
  report.v2.indexSize = index.count;
  const idx = { source: 'memory', model: config.modelId };
  void idx;
  const queries = [];
  const seed = source.incrementalPage(0, 0, Math.min(10, total)) || [];
  for (const r of seed) queries.push(String(r.text).slice(0, 40));
  queries.push(...SHORT_QUERIES);
  const fireable = queries.filter((q) => shouldTrigger(q).trigger);
  report.v2.querySet = { count: fireable.length, samples: fireable.slice(0, 5) };

  const recallSamples = [];
  const parts = { encodeMs: [], vectorMs: [], ftsMs: [], fuseMs: [] };
  const qStats = new Map();
  for (let i = 0; i < iterations; i += 1) {
    const q = fireable[i % fireable.length];
    const r = await recall({ query: q, store, source, embedder, index, resultTopK: config.resultTopK });
    recallSamples.push(r.timings.totalMs);
    parts.encodeMs.push(r.timings.encodeMs);
    parts.vectorMs.push(r.timings.vectorMs);
    parts.ftsMs.push(r.timings.ftsMs);
    parts.fuseMs.push(r.timings.fuseMs);
    const cur = qStats.get(q) || [];
    cur.push(r.timings.totalMs);
    qStats.set(q, cur);
  }
  report.v2.recall = stats(recallSamples);
  report.v2.budgetMs = 300;
  report.v2.verdict = report.v2.recall.p95 <= 300 ? 'PASS' : 'FAIL';
  report.v2.breakdown = {
    encode: stats(parts.encodeMs),
    vector: stats(parts.vectorMs),
    fts: stats(parts.ftsMs),
    fuse: stats(parts.fuseMs),
  };
  report.v2.perQuery = [...qStats.entries()].map(([q, v]) => ({ query: q, ...stats(v) }));
  log(
    `[V2] 召回 ${iterations} 次：P50 ${report.v2.recall.p50} ms / P95 ${report.v2.recall.p95} ms / max ${report.v2.recall.max} ms（预算 ${report.v2.budgetMs} ms ⇒ ${report.v2.verdict}）`,
  );
  log(
    `     分解 P50：编码 ${report.v2.breakdown.encode.p50} · 向量 ${report.v2.breakdown.vector.p50} · FTS ${report.v2.breakdown.fts.p50} · 融合 ${report.v2.breakdown.fuse.p50} ms`,
  );

  // 顺带跑一次启动自检（交付物 #9 的现场证据）
  report.selfcheck = await runSelfcheck({ store, source, embedder, config });
  log(`[自检] ${report.selfcheck.ok ? '✅ 通过' : '❌ 失败'}（warn ${report.selfcheck.warned} / fail ${report.selfcheck.failed}）`);

  source.close();
  store.db.close();
  return report;
}

async function main() {
  const { flags } = parseArgs();
  const config = resolveConfig({
    memoryDb: flags['memory-db'] || undefined,
    vectorsDb: flags['vectors-db'] || undefined,
    vectorsDir: flags['vectors-dir'] || undefined,
    modelDir: flags['model-dir'] || undefined,
    modelId: flags.model || undefined,
    dim: flags.dim ? Number(flags.dim) : undefined,
    hostId: flags.host || undefined,
    batchSize: flags.batch ? Number(flags.batch) : undefined,
  });
  if (!fs.existsSync(config.memoryDb)) {
    throw new Error(`记忆库不存在：${config.memoryDb}（须用生产库的只读副本，勿指向生产库）`);
  }
  console.log('=== 记忆引擎 v2 · 离线层基准 ===');
  console.log(`主机     : ${os.hostname()} · ${os.cpus().length} 核 ${(os.cpus()[0] || {}).model}`);
  console.log(`内存     : ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB · node ${process.version}`);
  console.log(`记忆库   : ${config.memoryDb}`);
  console.log(`向量库   : ${config.vectorsDb}`);
  console.log(`模型目录 : ${config.modelDir}`);
  console.log('');
  const report = await runBench({
    config,
    iterations: Number(flags.iterations || 100),
    log: (m) => console.log(m),
    doSync: !flags['no-sync'],
  });
  if (flags.out) {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
    fs.writeFileSync(path.resolve(flags.out), JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n报告已写入：${path.resolve(flags.out)}`);
  }
  if (flags.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.v2.verdict === 'PASS' || flags['allow-slow'] ? 0 : 3;
}

if (isMainEntry(import.meta.url)) await main();
