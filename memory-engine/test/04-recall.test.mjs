// 04 · 召回（向量为主 + FTS 补位 + RRF 融合 + 排除 pinned + 触发条件）
import { test, assert, assertEq } from './harness.mjs';
import { makeTempRoot, makeMemoryDb, setPinned } from './fixtures.mjs';
import { openVectorsStore } from '../lib/vectors-store.mjs';
import { openMemorySource } from '../lib/memory-source.mjs';
import { runIncrementalSync } from '../lib/sync.mjs';
import { createStubEmbedder } from '../lib/embedder.mjs';
import {
  shouldTrigger,
  extractFtsTokens,
  buildFtsMatch,
  recall,
  buildVectorIndex,
  rrfFuse,
  cosineTopK,
} from '../lib/recall.mjs';

export const __section = '04 · 召回层';

const TS = 1_760_000_000_000;
const ROWS = [
  { id: 1, text: '跨机同步的挡推裁决口径：先看方向再看闸门，task-board 账本走 Host API 并回', tags: 'task-board, 同步', pinned: 0, updated_at: TS + 1000 },
  { id: 2, text: '守护鱼崩溃链路：120s 内连崩 3 次才唤醒分身，日志在 TEMP', tags: '守护鱼', pinned: 0, updated_at: TS + 2000 },
  { id: 3, text: '生图角色一致性的参考图与提示词模板，锁身份用 U1.5', tags: '生图', pinned: 0, updated_at: TS + 3000 },
  { id: 4, text: '记忆库 FTS5 分词实测：中文连续串只有完全相等才命中', tags: '记忆', pinned: 0, updated_at: TS + 4000 },
  { id: 5, text: '本地 ComfyUI 栈启动与模型切换，端口 8199 是共享桥', tags: '生图, 本地', pinned: 0, updated_at: TS + 5000 },
  { id: 6, text: '跨机同步的挡推裁决口径：先看方向再看闸门，task-board 账本走 Host API 并回（P0 必读）', tags: 'task-board, 同步', pinned: 1, updated_at: TS + 6000 },
  { id: 7, text: '端口 3080 是 DSH 的 web 服务端口，守护鱼负责拉起', tags: 'DSH, 端口', pinned: 0, updated_at: TS + 7000 },
];

function setup() {
  const t = makeTempRoot();
  makeMemoryDb(t.paths.memoryDb, ROWS);
  const store = openVectorsStore(t.paths.vectorsDb);
  const source = openMemorySource(t.paths.memoryDb);
  const embedder = createStubEmbedder({ dim: 512 });
  return { t, store, source, embedder };
}

test('触发条件：非空即触发；纯符号 / 单字跳过', () => {
  assertEq(shouldTrigger('退下吧').trigger, true, '三字短暗号应触发');
  assertEq(shouldTrigger('整夜干活').trigger, true, '短句应触发');
  assertEq(shouldTrigger('3080').trigger, true, '纯数字应触发');
  assertEq(shouldTrigger('hi').trigger, true, '两字母应触发');
  assertEq(shouldTrigger('').trigger, false, '空串不触发');
  assertEq(shouldTrigger('   ').reason, 'empty', '空白 = empty');
  assertEq(shouldTrigger('！！！').reason, 'symbols-only', '纯符号不触发');
  assertEq(shouldTrigger('?').reason, 'symbols-only', '单符号不触发');
  assertEq(shouldTrigger('啊').reason, 'single-char', '单字不触发');
  assertEq(shouldTrigger('a').reason, 'single-char', '单字母不触发');
});

test('FTS token 抽取：只取英文/数字，长度 ≥2，去重且限量', () => {
  assertEq(extractFtsTokens('跨机同步 task-board 与 3080'), ['task-board', '3080'], '英文+数字');
  assertEq(extractFtsTokens('看板 ledger-v2.json 并回'), ['ledger-v2.json'], '连字符与点');
  assertEq(extractFtsTokens('中文连续串不产出任何东西'), [], '中文不产出 token');
  assertEq(extractFtsTokens('a b c'), [], '单字符全过滤');
  assertEq(buildFtsMatch(['task-board', '3080']), '"task-board" OR "3080"', 'MATCH 表达式');
  assertEq(buildFtsMatch([]), null, '空 token → 不参与');
});

test('RRF 融合（k=60）：两路都命中的条目得分最高', () => {
  const fused = rrfFuse(
    [
      { source: 'vector', ids: ['3', '1', '5'] },
      { source: 'fts', ids: ['1', '7'] },
    ],
    60,
  );
  assertEq(fused[0].id, '1', '两路命中排第一');
  assertEq(fused[0].sources.sort().join('+'), 'fts+vector', '来源合并');
  const expected = 1 / (60 + 2) + 1 / (60 + 1);
  assertEq(Math.abs(fused[0].score - expected) < 1e-12, true, 'RRF 分值公式');
  assertEq(fused[1].id, '3', '仅向量且 rank1 排第二');
});

test('向量召回：查询与某条文本重合时该条排第一（余弦主导）', async () => {
  const { t, store, source, embedder } = setup();
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const r = await recall({
      query: '生图角色一致性的参考图与提示词模板，锁身份用 U1.5',
      store,
      source,
      embedder,
      resultTopK: 5,
    });
    assertEq(r.triggered, true, '已触发');
    assertEq(r.hits[0].id, 3, '完全重合条排第一');
    assert(r.hits[0].sources.includes('vector'), '来自向量路');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('排除 pinned：pinned 条即使文本完全一致也不出现在召回结果里', async () => {
  const { t, store, source, embedder } = setup();
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const q = ROWS[5].text; // #6 是 pinned 且文本与 #1 几乎一致
    const r = await recall({ query: q, store, source, embedder, resultTopK: 8 });
    assertEq(r.hits.some((h) => h.id === 6), false, 'pinned 条不得出现');
    assertEq(r.stats.pinnedExcluded, 1, '已排除 1 条 pinned');
    assert(r.hits.length > 0, '仍有非 pinned 命中');
    assert(r.hits.every((h) => h.id !== 6), '所有命中都不是 pinned');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('pinned 变化实时生效：把某条改成 pinned 后立即从召回中消失', async () => {
  const { t, store, source, embedder } = setup();
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const q = ROWS[2].text;
    const before = await recall({ query: q, store, source, embedder, resultTopK: 3 });
    assertEq(before.hits[0].id, 3, '未 pinned 时可召回');
    source.close();
    setPinned(t.paths.memoryDb, 3, 1);
    const source2 = openMemorySource(t.paths.memoryDb);
    const after = await recall({ query: q, store, source: source2, embedder, resultTopK: 3 });
    assertEq(after.hits.some((h) => h.id === 3), false, '改成 pinned 后不再召回（无需重编码）');
    source2.close();
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('FTS 补位：英文 token 命中 tags/正文，且与向量路 RRF 融合', async () => {
  const { t, store, source, embedder } = setup();
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const r = await recall({ query: '跨机同步 task-board', store, source, embedder, resultTopK: 8 });
    assertEq(r.stats.ftsTokens.join(','), 'task-board', '抽出英文 token');
    assert(r.stats.ftsMatched >= 1, `FTS 应命中（实际 ${r.stats.ftsMatched}）`);
    assert(r.hits.some((h) => h.sources.includes('fts')), '有命中来自 FTS 路');
    assert(
      r.hits.some((h) => h.sources.includes('fts') && h.sources.includes('vector')),
      '存在两路同时命中的条目（融合生效）',
    );
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('FTS 对中文不参与（A4 结论）：中文查询无 token ⇒ 只走向量路且不报错', async () => {
  const { t, store, source, embedder } = setup();
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const r = await recall({ query: '记忆库分词结论', store, source, embedder, resultTopK: 5 });
    assertEq(r.stats.ftsTokens.length, 0, '无英文 token');
    assertEq(r.stats.ftsMatchExpr, null, '不构造 MATCH');
    assert(r.hits.length > 0, '仍有向量命中');
    assert(r.hits.every((h) => h.sources.length === 1 && h.sources[0] === 'vector'), '全部来自向量路');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('不触发时短路：不编码、不检索、不抛错', async () => {
  const { t, store, source, embedder } = setup();
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const callsBefore = embedder.stats().encodeCount;
    const r = await recall({ query: '？', store, source, embedder });
    assertEq(r.triggered, false, '未触发');
    assertEq(r.hits.length, 0, '无命中');
    assertEq(embedder.stats().encodeCount, callsBefore, '未发生编码');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('余弦索引：query 与自身向量相似度为 1（归一化正确）', async () => {
  const { t, store, source, embedder } = setup();
  try {
    await runIncrementalSync({ source, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const index = buildVectorIndex(store.db, { source: 'memory' });
    const qvec = await embedder.encode(ROWS[0].text);
    const top = cosineTopK(index, qvec, 1);
    assertEq(top[0].id, 1, '自身排第一');
    assert(Math.abs(top[0].score - 1) < 1e-5, `自相似度应 ≈1，实际 ${top[0].score}`);
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});

test('空向量库：召回安全返回空而不抛错（fail-open 前置）', async () => {
  const { t, store, source, embedder } = setup();
  try {
    const r = await recall({ query: '跨机同步', store, source, embedder });
    assertEq(r.triggered, true, '仍判定触发');
    assertEq(r.hits.length, 0, '无向量 ⇒ 空结果');
    assertEq(r.stats.indexSize, 0, '索引为空');
  } finally {
    source.close();
    store.db.close();
    t.cleanup();
  }
});
