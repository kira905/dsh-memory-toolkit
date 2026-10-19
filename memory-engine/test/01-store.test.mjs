// 01 · 向量库（独立库 / schema / meta / Float32 往返）
import fs from 'node:fs';
import { test, assert, assertEq } from './harness.mjs';
import { makeTempRoot } from './fixtures.mjs';
import {
  openVectorsStore,
  META_KEYS,
  getMeta,
  setMeta,
  getMetaAll,
  upsertVectors,
  loadMatrix,
  getHashes,
  countVectors,
  deleteSource,
  vecToBlob,
  blobToVec,
} from '../lib/vectors-store.mjs';

export const __section = '01 · 向量库（独立库 / schema / meta / Float32 往返）';

test('建库：vectors + meta 表按需创建，schemaVersion 自动落 meta', () => {
  const t = makeTempRoot();
  try {
    const store = openVectorsStore(t.paths.vectorsDb);
    assertEq(store.schema.tables.vectors, true, 'vectors 表');
    assertEq(store.schema.tables.meta, true, 'meta 表');
    assert(store.schema.created.includes('vectors'), '首次应报告新建 vectors');
    // 【2026-10-10 · 补坑库联动A】**有意**由 '1' 改为 '2'：meta 键位加 `<key>:<source>` 命名空间（表结构未变）。
    //   本断言改写属口径变更登记，不是"为过测而改用例"（未改断言语义，只跟版本号）。
    assertEq(getMeta(store.db, META_KEYS.schemaVersion), '2', 'schemaVersion');
    const again = openVectorsStore(t.paths.vectorsDb);
    assertEq(again.schema.created.length, 0, '重开不应再创建表（幂等）');
    store.db.close();
    again.db.close();
    assert(fs.existsSync(t.paths.vectorsDb), '库文件存在');
  } finally {
    t.cleanup();
  }
});

test('Float32 往返：BLOB 读回数值逐位相等（含非零 byteOffset 场景）', () => {
  const t = makeTempRoot();
  try {
    const store = openVectorsStore(t.paths.vectorsDb);
    const vec = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i) * 1.5);
    upsertVectors(store.db, [
      { source: 'memory', refId: '1', model: 'm', dim: 512, vec, textHash: 'h1', updatedAt: 1 },
    ]);
    const m = loadMatrix(store.db, 'memory');
    assertEq(m.count, 1, '条数');
    assertEq(m.dim, 512, '维度');
    let maxDiff = 0;
    for (let i = 0; i < 512; i += 1) maxDiff = Math.max(maxDiff, Math.abs(m.data[i] - vec[i]));
    assertEq(maxDiff, 0, '往返误差');
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('upsert 幂等：同 ref_id 覆盖不新增行，hash/向量同步更新', () => {
  const t = makeTempRoot();
  try {
    const store = openVectorsStore(t.paths.vectorsDb);
    const v1 = Float32Array.from([1, 0, 0]);
    const v2 = Float32Array.from([0, 1, 0]);
    upsertVectors(store.db, [{ source: 'memory', refId: '7', model: 'm', dim: 3, vec: v1, textHash: 'a', updatedAt: 1 }]);
    upsertVectors(store.db, [{ source: 'memory', refId: '7', model: 'm', dim: 3, vec: v2, textHash: 'b', updatedAt: 2 }]);
    assertEq(countVectors(store.db, 'memory'), 1, '仍只有 1 行');
    assertEq(getHashes(store.db, 'memory', ['7']).get('7'), 'b', 'hash 已更新');
    const m = loadMatrix(store.db, 'memory');
    assertEq(Array.from(m.data), [0, 1, 0], '向量已更新');
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('meta 读写与 deleteSource：按 source 清理（可重建载体）', () => {
  const t = makeTempRoot();
  try {
    const store = openVectorsStore(t.paths.vectorsDb);
    setMeta(store.db, 'k1', 'v1');
    setMeta(store.db, 'k1', 'v2');
    assertEq(getMeta(store.db, 'k1'), 'v2', 'meta 覆盖写');
    upsertVectors(store.db, [
      { source: 'memory', refId: '1', model: 'm', dim: 2, vec: Float32Array.from([1, 0]), textHash: 'x', updatedAt: 1 },
      { source: 'doc', refId: 'p#1', model: 'm', dim: 2, vec: Float32Array.from([0, 1]), textHash: 'y', updatedAt: 1 },
    ]);
    assertEq(countVectors(store.db), 2, '全库 2 条');
    assertEq(deleteSource(store.db, 'memory'), 1, '删 memory 源');
    assertEq(countVectors(store.db, 'doc'), 1, 'doc 源留存');
    assert(getMetaAll(store.db).k1 === 'v2', 'getMetaAll 可读');
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('维度混入：loadMatrix 遇到不一致维度必须大声报错（不静默复用）', () => {
  const t = makeTempRoot();
  try {
    const store = openVectorsStore(t.paths.vectorsDb);
    upsertVectors(store.db, [
      { source: 'memory', refId: '1', model: 'm', dim: 4, vec: Float32Array.from([1, 0, 0, 0]), textHash: 'x', updatedAt: 1 },
      { source: 'memory', refId: '2', model: 'm', dim: 8, vec: Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]), textHash: 'y', updatedAt: 2 },
    ]);
    let err = null;
    try {
      loadMatrix(store.db, 'memory');
    } catch (e) {
      err = e;
    }
    assert(err && /维度不一致/.test(err.message), `应报维度不一致，实际 ${err && err.message}`);
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('vecToBlob/blobToVec：往返一致，blob 长度 = dim*4', () => {
  const v = Float32Array.from([0.5, -0.25, 1, 0]);
  const b = vecToBlob(v);
  assertEq(b.byteLength, 16, 'blob 长度');
  assertEq(Array.from(blobToVec(b)), Array.from(v), '往返');
});
