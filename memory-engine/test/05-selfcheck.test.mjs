// 05 · 启动自检（模型可用性 / 维度一致 / 表存在性 / hostId 校验）
import { DatabaseSync } from 'node:sqlite';
import { test, assert, assertEq } from './harness.mjs';
import { makeTempRoot, makeMemoryDb, sampleRows } from './fixtures.mjs';
import { openVectorsStore, META_KEYS, setMeta, getMeta } from '../lib/vectors-store.mjs';
import { openMemorySource } from '../lib/memory-source.mjs';
import { runIncrementalSync } from '../lib/sync.mjs';
import { runSelfcheck } from '../lib/selfcheck.mjs';
import { createStubEmbedder, createHttpEmbedder } from '../lib/embedder.mjs';
import { resolveConfig } from '../lib/config.mjs';

export const __section = '05 · 启动自检';

function cfg(t, extra = {}) {
  return resolveConfig({
    memoryDb: t.paths.memoryDb,
    vectorsDb: t.paths.vectorsDb,
    stateFile: t.paths.stateFile,
    modelDir: t.paths.modelDir,
    dim: 512,
    hostId: 'TEST-HOST',
    clearEnv: true,
    env: {},
    ...extra,
  });
}

function pick(result, name) {
  return result.checks.find((c) => c.name === name);
}

test('全绿：正常库 + 可用编码器 ⇒ 四判据 ok', async () => {
  const t = makeTempRoot();
  try {
    makeMemoryDb(t.paths.memoryDb, sampleRows(4));
    const store = openVectorsStore(t.paths.vectorsDb);
    const source = openMemorySource(t.paths.memoryDb);
    const embedder = createStubEmbedder({ dim: 512, modelId: 'stub-ngram' });
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512, batchSize: 10 });
    const r = await runSelfcheck({ store, source, embedder, config: cfg(t) });
    assertEq(r.ok, true, `应全过：${JSON.stringify(r.checks.map((c) => [c.name, c.status]))}`);
    assertEq(pick(r, '表存在性').status, 'ok');
    assertEq(pick(r, '模型可用性').status, 'ok');
    assertEq(pick(r, '维度一致').status, 'ok');
    assertEq(pick(r, 'hostId 校验').status, 'ok');
    assertEq(pick(r, '向量覆盖度').status, 'info');
    assertEq(pick(r, '向量覆盖度').vecCount, 4, '覆盖度 4/4');
    source.close();
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('表存在性：表被删掉 ⇒ 自检报告"已重建"', async () => {
  const t = makeTempRoot();
  try {
    makeMemoryDb(t.paths.memoryDb, sampleRows(2));
    const s1 = openVectorsStore(t.paths.vectorsDb);
    setMeta(s1.db, META_KEYS.hostId, 'TEST-HOST');
    s1.db.close();
    // 手工毁表
    const raw = new DatabaseSync(t.paths.vectorsDb);
    raw.exec('DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS meta;');
    raw.close();

    const store = openVectorsStore(t.paths.vectorsDb);
    const source = openMemorySource(t.paths.memoryDb);
    const embedder = createStubEmbedder({ dim: 512 });
    const r = await runSelfcheck({ store, source, embedder, config: cfg(t) });
    const t1 = pick(r, '表存在性');
    assertEq(t1.status, 'ok', '重建成功');
    assert(/已重建/.test(t1.detail), `detail 应写明重建：${t1.detail}`);
    assert(t1.created.includes('vectors') && t1.created.includes('meta'), '两张表都在重建清单里');
    source.close();
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('维度一致：库内 meta.dim 与实测不符 ⇒ fail', async () => {
  const t = makeTempRoot();
  try {
    makeMemoryDb(t.paths.memoryDb, sampleRows(2));
    const store = openVectorsStore(t.paths.vectorsDb);
    const source = openMemorySource(t.paths.memoryDb);
    const embedder = createStubEmbedder({ dim: 512 });
    setMeta(store.db, META_KEYS.dim, '99');
    setMeta(store.db, META_KEYS.hostId, 'TEST-HOST');
    const r = await runSelfcheck({ store, source, embedder, config: cfg(t) });
    assertEq(pick(r, '维度一致').status, 'fail', '应判 fail');
    assert(/库内 99/.test(pick(r, '维度一致').detail), `detail 应包含库内维度：${pick(r, '维度一致').detail}`);
    assertEq(r.ok, false, '整体不通过');
    source.close();
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('维度一致：配置与实测不符 ⇒ fail（换模型维度时必须重建）', async () => {
  const t = makeTempRoot();
  try {
    makeMemoryDb(t.paths.memoryDb, sampleRows(2));
    const store = openVectorsStore(t.paths.vectorsDb);
    const source = openMemorySource(t.paths.memoryDb);
    const embedder = createStubEmbedder({ dim: 256 });
    setMeta(store.db, META_KEYS.hostId, 'TEST-HOST');
    const r = await runSelfcheck({ store, source, embedder, config: cfg(t, { dim: 512 }) });
    assertEq(pick(r, '维度一致').status, 'fail', '实测 256 vs 配置 512 ⇒ fail');
    source.close();
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('hostId：库来自别的机器 ⇒ warn（strict 时 fail）', async () => {
  const t = makeTempRoot();
  try {
    makeMemoryDb(t.paths.memoryDb, sampleRows(2));
    const store = openVectorsStore(t.paths.vectorsDb);
    const source = openMemorySource(t.paths.memoryDb);
    const embedder = createStubEmbedder({ dim: 512 });
    setMeta(store.db, META_KEYS.hostId, 'SOME-OTHER-HOST');
    const r1 = await runSelfcheck({ store, source, embedder, config: cfg(t), allowHostMismatch: true });
    assertEq(pick(r1, 'hostId 校验').status, 'warn', '默认 warn');
    assertEq(r1.ok, true, 'warn 不算失败');
    const r2 = await runSelfcheck({ store, source, embedder, config: cfg(t), allowHostMismatch: false });
    assertEq(pick(r2, 'hostId 校验').status, 'fail', 'strict 时 fail');
    assertEq(r2.ok, false, 'strict 整体不通过');
    source.close();
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('hostId：首次初始化自动写入当前主机名', async () => {
  const t = makeTempRoot();
  try {
    makeMemoryDb(t.paths.memoryDb, sampleRows(2));
    const store = openVectorsStore(t.paths.vectorsDb);
    const source = openMemorySource(t.paths.memoryDb);
    const embedder = createStubEmbedder({ dim: 512 });
    const r = await runSelfcheck({ store, source, embedder, config: cfg(t) });
    assertEq(pick(r, 'hostId 校验').status, 'ok');
    assert(/首次初始化/.test(pick(r, 'hostId 校验').detail), '应写明首次初始化');
    assertEq(getMeta(store.db, META_KEYS.hostId), 'TEST-HOST', '已落 meta');
    source.close();
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('模型不可用：桥不在 ⇒ 模型可用性 fail，但自检本身不抛错（fail-open 前置）', async () => {
  const t = makeTempRoot();
  try {
    makeMemoryDb(t.paths.memoryDb, sampleRows(2));
    const store = openVectorsStore(t.paths.vectorsDb);
    const source = openMemorySource(t.paths.memoryDb);
    const embedder = createHttpEmbedder({ port: 1, timeoutMs: 120 }); // 必然连不上
    const r = await runSelfcheck({ store, source, embedder, config: cfg(t) });
    assertEq(pick(r, '模型可用性').status, 'fail', '桥不在 ⇒ fail');
    assertEq(pick(r, '维度一致').status, 'fail', '编码探测也失败');
    assertEq(r.ok, false, '整体不通过');
    assert(r.checks.length >= 5, '仍返回完整判据清单（不抛错）');
    source.close();
    store.db.close();
  } finally {
    t.cleanup();
  }
});
