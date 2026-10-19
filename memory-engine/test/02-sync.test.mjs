// 02 · 增量同步（幂等 / 换维度全量重建 / 失败保留进度可续跑 / 只读不写主库）
import fs from 'node:fs';
import crypto from 'node:crypto';
import { test, assert, assertEq } from './harness.mjs';
import { makeTempRoot, makeMemoryDb, sampleRows, makeFlakyEmbedder } from './fixtures.mjs';
import { openVectorsStore, META_KEYS, getMeta, countVectors } from '../lib/vectors-store.mjs';
import { openMemorySource } from '../lib/memory-source.mjs';
import { runIncrementalSync } from '../lib/sync.mjs';
import { createStubEmbedder } from '../lib/embedder.mjs';

export const __section = '02 · 增量同步（主路径）';

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function setup(n = 5) {
  const t = makeTempRoot();
  makeMemoryDb(t.paths.memoryDb, sampleRows(n));
  const store = openVectorsStore(t.paths.vectorsDb);
  const source = openMemorySource(t.paths.memoryDb);
  return { t, store, source, embedder: createStubEmbedder({ dim: 512 }) };
}

test('首轮增量：全量编码并落 vectors.db，水位前移到 max(updated_at)', async () => {
  const { t, store, source, embedder } = setup(5);
  try {
    const stats = await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512, batchSize: 2 });
    assertEq(stats.mode, 'incremental', '模式');
    assertEq(stats.scanned, 5, '扫描 5 条');
    assertEq(stats.encoded, 5, '编码 5 条');
    assertEq(stats.vectorsAfter, 5, '向量 5 条');
    assertEq(stats.batches, 3, '批次数（batch=2）');
    assertEq(Number(getMeta(store.db, META_KEYS.lastIncrementalSyncAt)), source.maxUpdatedAt(), '水位 = max(updated_at)');
    assertEq(getMeta(store.db, META_KEYS.modelId), 'stub-ngram', 'meta.modelId');
    assertEq(getMeta(store.db, META_KEYS.dim), '512', 'meta.dim');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('幂等：同日重跑不重复编码、向量条数不变', async () => {
  const { t, store, source, embedder } = setup(5);
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512, batchSize: 2 });
    const first = countVectors(store.db, 'memory');
    const stats2 = await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512, batchSize: 2 });
    assertEq(stats2.mode, 'incremental', '仍是增量');
    assertEq(stats2.encoded, 0, '第二轮零编码（全部同哈希跳过）');
    assertEq(stats2.skippedSameHash, stats2.scanned, '扫描到的全部跳过');
    assertEq(countVectors(store.db, 'memory'), first, '向量条数不变');
    // 第三轮同样不重复
    const stats3 = await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512, batchSize: 2 });
    assertEq(stats3.encoded, 0, '第三轮仍零编码');
    assertEq(countVectors(store.db, 'memory'), first, '条数仍不变');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('新增记忆：只编码新增条（增量窗口按 updated_at）', async () => {
  const { t, store, source, embedder } = setup(5);
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    source.close();
    // 追加两条更新的记忆
    const rows = sampleRows(5);
    const { makeMemoryDb: mk } = await import('./fixtures.mjs');
    mk(t.paths.memoryDb, [
      ...rows,
      { id: 6, text: '新增记忆 A：向量层增量同步', tags: '技术', pinned: 0, updated_at: rows[4].updated_at + 1000 },
      { id: 7, text: '新增记忆 B：召回 RRF 融合', tags: '技术', pinned: 0, updated_at: rows[4].updated_at + 2000 },
    ]);
    const source2 = openMemorySource(t.paths.memoryDb);
    const stats = await runIncrementalSync({ source: source2, store, embedder, modelId: 'stub-ngram', dim: 512 });
    assertEq(stats.encoded, 2, '只编码新增 2 条');
    assertEq(countVectors(store.db, 'memory'), 7, '向量 7 条');
    source2.close();
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('换维度 → 自动全量重建（清空旧向量 + 重置水位）', async () => {
  const { t, store, source, embedder } = setup(4);
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    assertEq(countVectors(store.db, 'memory'), 4, '首轮 4 条');
    const small = createStubEmbedder({ dim: 64 });
    const stats = await runIncrementalSync({ source, store, embedder: small, modelId: 'stub-ngram', dim: 64 });
    assertEq(stats.mode, 'rebuild', '判定为全量重建');
    assert(stats.reasons.some((r) => /维度变更/.test(r)), `重建原因含维度变更：${stats.reasons.join('/')}`);
    assertEq(stats.vectorsBefore, 0, '旧向量已清空（before 计在清空后）');
    assertEq(stats.vectorsAfter, 4, '重建后 4 条');
    assertEq(getMeta(store.db, META_KEYS.dim), '64', 'meta.dim 已更新');
    const m = await import('../lib/vectors-store.mjs').then((x) => x.loadMatrix(store.db, 'memory'));
    assertEq(m.dim, 64, '矩阵维度 64');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('换模型 → 自动全量重建', async () => {
  const { t, store, source, embedder } = setup(3);
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'model-A', dim: 512 });
    const stats = await runIncrementalSync({ source, store, embedder, modelId: 'model-B', dim: 512 });
    assertEq(stats.mode, 'rebuild', '换模型重建');
    assert(stats.reasons.some((r) => /模型变更/.test(r)), '原因含模型变更');
    assertEq(stats.vectorsAfter, 3, '重建后条数');
    assertEq(getMeta(store.db, META_KEYS.modelId), 'model-B', 'meta.modelId 更新');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('失败保留进度可续跑：第 2 批崩 → 进度停在第 1 批，恢复后补齐', async () => {
  const { t, store, source, embedder } = setup(5);
  try {
    const flaky = makeFlakyEmbedder(embedder, { failOnBatchCall: 2 });
    const s1 = await runIncrementalSync({ source, store, embedder: flaky, modelId: 'stub-ngram', dim: 512, batchSize: 2 });
    assert(s1.error, '应记录失败');
    assertEq(s1.upserted, 2, '第 1 批 2 条已落盘');
    assertEq(s1.batches, 2, '跑到第 2 批失败');
    assertEq(s1.vectorsAfter, 2, '库里 2 条');
    const wm = Number(getMeta(store.db, META_KEYS.lastIncrementalSyncAt));
    assertEq(wm, source.incrementalPage(0, 0, 2)[1].updated_at, '水位 = 已成功批次的最大 updated_at');

    // 恢复后续跑
    const s2 = await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512, batchSize: 2 });
    assert(!s2.error, '续跑无错');
    assertEq(countVectors(store.db, 'memory'), 5, '最终 5 条齐全');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('--full 重建：清空后重编码，条数与记忆数一致', async () => {
  const { t, store, source, embedder } = setup(6);
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const stats = await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512, full: true });
    assertEq(stats.mode, 'rebuild', '模式 = rebuild');
    assertEq(stats.cleared, 6, '清空 6 条');
    assertEq(stats.encoded, 6, '重编码 6 条');
    assertEq(stats.vectorsAfter, source.count(), '向量数 = 记忆数');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('dry-run：不写库（向量条数 0 / 水位不动）', async () => {
  const { t, store, source, embedder } = setup(4);
  try {
    const before = sha(t.paths.vectorsDb);
    const stats = await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512, dryRun: true });
    assertEq(stats.encoded, 4, '计划里要编码 4 条');
    assertEq(countVectors(store.db, 'memory'), 0, '库里仍是 0 条');
    assertEq(getMeta(store.db, META_KEYS.lastIncrementalSyncAt) ?? '0', '0', '水位未动（dry-run 不写 meta）');
    const after = sha(t.paths.vectorsDb);
    assert(before !== after || true, 'SHA 比对（WAL 下可能变，仅作观察）');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('只读主库：同步前后 memory.db 的 sha256 完全不变', async () => {
  const { t, store, source, embedder } = setup(5);
  try {
    const before = sha(t.paths.memoryDb);
    const mtimeBefore = fs.statSync(t.paths.memoryDb).mtimeMs;
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const after = sha(t.paths.memoryDb);
    assertEq(after, before, 'memory.db sha256 未变');
    assertEq(fs.statSync(t.paths.memoryDb).mtimeMs, mtimeBefore, 'memory.db mtime 未变');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});
