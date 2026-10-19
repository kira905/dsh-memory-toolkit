// 03 · 兜底：全表 text_hash 段轮转（专治"改 text 不动 updated_at"的外部写口）
import { test, assert, assertEq } from './harness.mjs';
import { makeTempRoot, makeMemoryDb, sampleRows, silentTextUpdate, readVectorHash } from './fixtures.mjs';
import { openVectorsStore, META_KEYS, getMeta, countVectors } from '../lib/vectors-store.mjs';
import { openMemorySource } from '../lib/memory-source.mjs';
import { runIncrementalSync } from '../lib/sync.mjs';
import { runHashSweep } from '../lib/sweep.mjs';
import { createStubEmbedder } from '../lib/embedder.mjs';
import { textHash } from '../lib/hashes.mjs';
import { listDirty } from '../lib/dirty-ledger.mjs';

export const __section = '03 · 兜底 hash 轮转（A7 盲区）';

function setup(n = 10) {
  const t = makeTempRoot();
  makeMemoryDb(t.paths.memoryDb, sampleRows(n));
  const store = openVectorsStore(t.paths.vectorsDb);
  const source = openMemorySource(t.paths.memoryDb);
  return { t, store, source, embedder: createStubEmbedder({ dim: 512 }) };
}

test('命中人为改动：改 text 不动 updated_at ⇒ 增量扫不到、兜底能捞到并重编码', async () => {
  const { t, store, source, embedder } = setup(10);
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const oldHash = readVectorHash(store.db, 'memory', 3);

    // 模拟 apply-pinned-refine.mjs:110 的行为：直接改 text，updated_at 纹丝不动
    source.close();
    silentTextUpdate(t.paths.memoryDb, 3, '【勘误后】跨机同步的挡推裁决口径（版本 B，人工修订）');
    const source2 = openMemorySource(t.paths.memoryDb);

    // 主路径：增量窗口看不到它
    const inc = await runIncrementalSync({ source: source2, store, embedder, modelId: 'stub-ngram', dim: 512 });
    assertEq(inc.encoded, 0, '增量主路径扫不到（零编码）⇒ 盲区成立');
    assertEq(readVectorHash(store.db, 'memory', 3), oldHash, '向量里的 hash 仍是旧的');

    // 兜底：段轮转全表校验
    const sweep = await runHashSweep({
      source: source2,
      store,
      embedder,
      modelId: 'stub-ngram',
      dim: 512,
      segments: 5,
      rounds: 5,
    });
    assertEq(sweep.mismatched, 1, '恰好 1 条哈希不符（就是被手改的那条）');
    assertEq(sweep.fixed, 1, '重编码 1 条');
    assertEq(sweep.completedFullSweep, true, '一轮完整覆盖完成');
    assertEq(
      readVectorHash(store.db, 'memory', 3),
      textHash('【勘误后】跨机同步的挡推裁决口径（版本 B，人工修订）'),
      '兜底后 hash 与新文本一致',
    );
    assert(readVectorHash(store.db, 'memory', 3) !== oldHash, 'hash 确已变化');
    // 【S3c 挂钩】兜底轮转的差异必须落 `memories_dirty` 台账（否则重编码后差异信号就永久消失了）
    assertEq(sweep.dirtyRecorded, 1, '差异已入台账');
    const led = listDirty(store.db, { openOnly: true });
    assertEq(led.map((x) => Number(x.refId)), [3], '台账里正是被手改的那条（提炼 job 的补充输入源）');
    assertEq(led[0].oldHash, oldHash, '台账留着改动前的 hash（可追）');
    assertEq(led[0].newHash, textHash('【勘误后】跨机同步的挡推裁决口径（版本 B，人工修订）'), '台账记着改动后的 hash');
    source2.close();
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('段轮转游标：每次推进一段，跑满 segments 轮才写 lastFullHashSweepAt', async () => {
  const { t, store, source, embedder } = setup(12);
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const seg = 4;
    const s1 = await runHashSweep({ source, store, embedder, modelId: 'stub-ngram', dim: 512, segments: seg, rounds: 1 });
    assertEq(s1.cursorStart, 0, '起始游标 0');
    assertEq(s1.cursorEnd, 1, '推进一段');
    assertEq(s1.completedFullSweep, false, '未跑满一轮');
    assertEq(getMeta(store.db, META_KEYS.lastFullHashSweepAt), null, '未写 lastFullHashSweepAt');

    await runHashSweep({ source, store, embedder, modelId: 'stub-ngram', dim: 512, segments: seg, rounds: 3 });
    assertEq(Number(getMeta(store.db, META_KEYS.hashSweepCursor)), 0, '游标回到 0');
    assert(getMeta(store.db, META_KEYS.lastFullHashSweepAt) !== null, '一轮覆盖完成 ⇒ 写了 lastFullHashSweepAt');
    assert(
      Number(getMeta(store.db, META_KEYS.lastFullHashSweepAt)) > 0,
      'lastFullHashSweepAt 是时间戳',
    );
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('段轮转覆盖全表：所有段累计扫描条数 = 记忆总条数（无漏段）', async () => {
  const { t, store, source, embedder } = setup(12);
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const seg = 5;
    let scanned = 0;
    for (let i = 0; i < seg; i += 1) {
      const s = await runHashSweep({ source, store, embedder, modelId: 'stub-ngram', dim: 512, segments: seg, rounds: 1 });
      scanned += s.scanned;
      // 覆盖到的 id 不重复：用段报告核对
      assert(s.segmentReports.length === 1, '每次一段');
    }
    assertEq(scanned, source.count(), '一轮 5 段累计扫描 = 12 条（无重叠无遗漏）');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('缺失向量补齐：库里被删掉的条目，轮转时按 missing 重编码', async () => {
  const { t, store, source, embedder } = setup(6);
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    store.db.prepare('DELETE FROM vectors WHERE source = ? AND ref_id = ?').run('memory', '2');
    assertEq(countVectors(store.db, 'memory'), 5, '先删掉 1 条');

    const sweep = await runHashSweep({ source, store, embedder, modelId: 'stub-ngram', dim: 512, segments: 2, rounds: 2 });
    assertEq(sweep.missing, 1, '报告缺失 1 条');
    assertEq(countVectors(store.db, 'memory'), 6, '补齐回 6 条');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('兜底不改增量水位（两条路径不共用候选集）', async () => {
  const { t, store, source, embedder } = setup(5);
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const wmBefore = getMeta(store.db, META_KEYS.lastIncrementalSyncAt);
    await runHashSweep({ source, store, embedder, modelId: 'stub-ngram', dim: 512, segments: 2, rounds: 2 });
    assertEq(getMeta(store.db, META_KEYS.lastIncrementalSyncAt), wmBefore, '增量水位未被兜底改动');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});
