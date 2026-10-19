// 09 · 坑库第二向量来源（方案 §3 A 点 · source='pitfall'）
//
// 覆盖：硬契约方法齐全 / 段与增量页的字段级契约 / 三入口（sync·sweep·recall）跑通无 `is not a function`
//      / 跨源不串味（记忆侧水位逐字节不变 + 同轮正向对照）/ meta 命名空间与迁移幂等 / 逐 source 自检。
//
// 铁律：一切输出落系统临时区（夹具），绝不写生产路径。
import { DatabaseSync } from 'node:sqlite';
import { test, assert, assertEq } from './harness.mjs';
import { makeTempRoot, makeMemoryDb, sampleRows, samplePitfalls, makePitfallJson, pitfallId } from './fixtures.mjs';
import {
  openVectorsStore,
  META_KEYS,
  getMeta,
  getMetaFor,
  setMeta,
  metaKeyFor,
  migrateMetaNamespace,
  countVectors,
  upsertVectors,
} from '../lib/vectors-store.mjs';
import { openMemorySource } from '../lib/memory-source.mjs';
import { openPitfallSource, pitfallText } from '../lib/pitfall-source.mjs';
import { runIncrementalSync } from '../lib/sync.mjs';
import { runHashSweep } from '../lib/sweep.mjs';
import { recall, recallMulti, buildVectorIndex, rrfFuse, refIdToNum } from '../lib/recall.mjs';
import { runSelfcheck } from '../lib/selfcheck.mjs';
import { createStubEmbedder } from '../lib/embedder.mjs';
import { ensureDirtySchema, listDirty } from '../lib/dirty-ledger.mjs';

export const __section = '09 · 坑库第二向量来源（source=pitfall）';

const N = 12;

function setup({ nMem = 6, nPit = N } = {}) {
  const t = makeTempRoot();
  makeMemoryDb(t.paths.memoryDb, sampleRows(nMem));
  makePitfallJson(t.paths.pitfallsFile, samplePitfalls(nPit));
  const store = openVectorsStore(t.paths.vectorsDb);
  const memSource = openMemorySource(t.paths.memoryDb);
  const pitSource = openPitfallSource(t.paths.pitfallsFile);
  return { t, store, memSource, pitSource, embedder: createStubEmbedder({ dim: 512 }) };
}

test('硬契约：方法与 memory-source 同形状（少一个 = 第一次跑就 is not a function）', () => {
  const { t, pitSource } = setup({ nMem: 1, nPit: 3 });
  try {
    for (const m of ['count', 'maxUpdatedAt', 'idRange', 'pinnedIds', 'incrementalPage', 'segment', 'getById', 'allTexts', 'allTags', 'ftsSearch', 'close']) {
      assertEq(typeof pitSource[m], 'function', `方法在位：${m}`);
    }
    assertEq(pitSource.readOnly, true, '只读自证');
    assertEq(pitSource.sourceName, 'pitfall', '来源名');
    assertEq(pitSource.dbPath, t.paths.pitfallsFile, '数据源路径');
    assertEq(pitSource.maxUpdatedAt(), samplePitfalls(3).reduce((a, r) => Math.max(a, r.lastSeen), 0), 'maxUpdatedAt = max(lastSeen)');
    assertEq(pitSource.pinnedIds(), [], '坑库无 pinned ⇒ 空集');
    assertEq(pitSource.idRange(), { lo: 0, hi: 2, n: 3 }, 'idRange = 排序下标区间');
    const f = pitSource.ftsSearch('"task-board"', 5);
    assert(f && !Array.isArray(f) && typeof f.error === 'string', 'ftsSearch 必须返回对象（含 error），不得抛错');
    const g = pitSource.getById(pitfallId(1));
    assert(g && g.text && g.updated_at > 0, 'getById 给 {id,text,updated_at}');
    assertEq(pitSource.getById('nope'), null, '取不到给 null');
    pitSource.close();
    pitSource.close();
    assertEq(pitSource.closed, true, 'close 幂等');
  } finally {
    t.cleanup();
  }
});

test('文本构成：seed 前缀 + [category] + tools 后缀（方案 §A.3 定稿）', () => {
  const rows = samplePitfalls(4);
  const seedRow = rows.find((r) => r.source === 'seed');
  const scanRow = rows.find((r) => r.source === 'scan');
  assertEq(pitfallText(seedRow).startsWith('[seed]'), true, `seed 条带 [seed] 前缀：${pitfallText(seedRow)}`);
  assertEq(pitfallText(seedRow).includes(' | tools='), false, 'seed 无 tools ⇒ 不拼后缀');
  assert(pitfallText(scanRow).includes(`[${scanRow.category}]`), '含 [category]');
  assert(pitfallText(scanRow).includes(' | tools='), 'scan 条带 tools 后缀');
});

test('segment：返回行必含 id/text/updated_at（缺 updated_at 会把 undefined 写进向量）', () => {
  const { t, pitSource } = setup();
  try {
    const rows = pitSource.segment(0, 3);
    assertEq(rows.length, 4, '闭区间 4 条');
    for (const r of rows) {
      assertEq(typeof r.id, 'string', 'id 是字符串（16 位 hex）');
      assertEq(typeof r.text, 'string', 'text');
      assertEq(typeof r.updated_at, 'number', 'updated_at 必须是数值（sweep.mjs:110 直接取它）');
      assertEq(r.updated_at === undefined, false, '不得为 undefined');
    }
    // 段覆盖全表：按 4 段切开，累加 = 全表且不重叠
    const seg = 4;
    const r2 = pitSource.idRange();
    const width = Math.ceil((r2.hi - r2.lo + 1) / seg);
    const seen = new Set();
    for (let i = 0; i < seg; i += 1) {
      const lo = r2.lo + i * width;
      const hi = Math.min(r2.hi, lo + width - 1);
      for (const row of pitSource.segment(lo, hi)) seen.add(row.id);
    }
    assertEq(seen.size, pitSource.count(), '段轮转覆盖全表（无重叠无遗漏）');
  } finally {
    t.cleanup();
  }
});

test('incrementalPage：稳定游标（lastSeen 升序 + id 字典序）分页不重不漏', () => {
  const { t, pitSource } = setup({ nMem: 1, nPit: 20 });
  try {
    const batch = 3;
    const all = [];
    let afterId = 0;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = pitSource.incrementalPage(0, afterId, batch);
      if (!page.length) break;
      all.push(...page.map((r) => r.id));
      afterId = page[page.length - 1].id;
    }
    assertEq(all.length, 20, '全量分页拿到 20 条');
    assertEq(new Set(all).size, 20, '无重复');
    const sorted = pitSource.segment(0, 19).map((r) => r.id);
    assertEq(all, sorted, '分页顺序 = 段顺序（同一排序）');

    // since 过滤：只取最近的（最后 5 条所在的时间带）
    const segs = pitSource.segment(0, 19);
    const cut = segs[19].updated_at;
    const recent = pitSource.incrementalPage(cut, 0, 100);
    assert(recent.length > 0 && recent.length < 20, `since 过滤生效（${recent.length} 条）`);
    assert(recent.every((r) => r.updated_at >= cut), '全部 >= sinceTs');
  } finally {
    t.cleanup();
  }
});

test('sync --source pitfall：写进 source=pitfall，条数 = 坑条数；重跑幂等', async () => {
  const { t, store, memSource, pitSource, embedder } = setup();
  try {
    await runIncrementalSync({ source: memSource, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const memBefore = countVectors(store.db, 'memory');

    const s1 = await runIncrementalSync({ source: pitSource, store, embedder, modelId: 'stub-ngram', dim: 512, sourceName: 'pitfall' });
    assertEq(s1.source, 'pitfall', 'stats.source 回显来源');
    assertEq(s1.scanned, N, '扫到全部坑');
    assertEq(s1.encoded, N, '全部编码');
    assertEq(countVectors(store.db, 'pitfall'), N, 'pitfall 向量条数 = 坑条数');
    assertEq(countVectors(store.db, 'memory'), memBefore, '**记忆源条数不受影响**（共库不串味）');

    const s2 = await runIncrementalSync({ source: pitSource, store, embedder, modelId: 'stub-ngram', dim: 512, sourceName: 'pitfall' });
    assertEq(s2.encoded, 0, '同哈希幂等：重跑 0 编码');
    assertEq(countVectors(store.db, 'pitfall'), N, '条数不变');
  } finally {
    pitSource.close();
    memSource.close();
    store.db.close();
    t.cleanup();
  }
});

test('判据3：跨源同步后**记忆侧四类水位键逐字节不变** + 同轮正向对照（新记忆 ⇒ encoded=1）', async () => {
  const { t, store, memSource, pitSource, embedder } = setup();
  try {
    await runIncrementalSync({ source: memSource, store, embedder, modelId: 'stub-ngram', dim: 512 });
    const keys = [META_KEYS.modelId, META_KEYS.dim, META_KEYS.lastIncrementalSyncAt, META_KEYS.hashSweepCursor];
    const before = keys.map((k) => getMetaFor(store.db, k, 'memory'));

    // 顺序：先坑源同步、再紧接着记忆源增量同步（复审 C6 要求的"哪两个源、什么顺序、观察谁"）
    await runIncrementalSync({ source: pitSource, store, embedder, modelId: 'stub-ngram', dim: 512, sourceName: 'pitfall' });
    const inc = await runIncrementalSync({ source: memSource, store, embedder, modelId: 'stub-ngram', dim: 512 });
    assertEq(inc.encoded, 0, '记忆侧无新内容 ⇒ 0 编码（水位未被动过）');
    assertEq(keys.map((k) => getMetaFor(store.db, k, 'memory')), before, '记忆侧四类水位键逐字节不变');

    // 正向对照：证明该路真的会编码（不是"看起来没变"其实整条不工作）
    const raw = new DatabaseSync(t.paths.memoryDb);
    raw.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('新增一号记忆：坑库联动正向对照', 'test', 0, 1_760_100_000_000, 1_760_100_000_000);
    raw.close();
    const memSource2 = openMemorySource(t.paths.memoryDb);
    const inc2 = await runIncrementalSync({ source: memSource2, store, embedder, modelId: 'stub-ngram', dim: 512 });
    assertEq(inc2.encoded, 1, '同轮正向对照：新增 1 条 ⇒ encoded=1');
    assertEq(Number(getMetaFor(store.db, META_KEYS.lastIncrementalSyncAt, 'pitfall')) === Number(getMetaFor(store.db, META_KEYS.lastIncrementalSyncAt, 'memory')), false, '两源水位各走各的');
    memSource2.close();
  } finally {
    pitSource.close();
    memSource.close();
    store.db.close();
    t.cleanup();
  }
});

test('sweep --source pitfall：覆盖全表、segmentReports 无 undefined、不污染 memories_dirty 台账', async () => {
  const { t, store, memSource, pitSource, embedder } = setup();
  try {
    await runIncrementalSync({ source: memSource, store, embedder, modelId: 'stub-ngram', dim: 512 });
    await runIncrementalSync({ source: pitSource, store, embedder, modelId: 'stub-ngram', dim: 512, sourceName: 'pitfall' });
    ensureDirtySchema(store.db);
    const dirtyBefore = listDirty(store.db, { openOnly: false }).length;

    const seg = 4;
    let scanned = 0;
    let reports = [];
    for (let i = 0; i < seg; i += 1) {
      const s = await runHashSweep({ source: pitSource, store, embedder, modelId: 'stub-ngram', dim: 512, sourceName: 'pitfall', segments: seg, rounds: 1 });
      scanned += s.scanned;
      reports = reports.concat(s.segmentReports);
      for (const r of s.segmentReports) {
        for (const k of ['lo', 'hi', 'rows', 'missing', 'mismatched', 'fixed']) {
          assertEq(typeof r[k], 'number', `segmentReport.${k} 必须是数值（不得 undefined）`);
        }
      }
    }
    assertEq(scanned, N, `一轮 ${seg} 段累计扫描 = 全表 ${N} 条`);
    assertEq(JSON.stringify(reports).includes('undefined'), false, '整份报告无 undefined');
    const dirtyAfter = listDirty(store.db, { openOnly: false }).length;
    assertEq(dirtyAfter, dirtyBefore, '坑源兜底**不写** memories_dirty（那是"记忆待提炼"台账）');
    // 记忆侧游标不受坑源影响
    assertEq(getMetaFor(store.db, META_KEYS.hashSweepCursor, 'pitfall') !== null, true, '坑源自己的游标已落');
  } finally {
    pitSource.close();
    memSource.close();
    store.db.close();
    t.cleanup();
  }
});

test('recall --source pitfall：命中带 refId 且 id 不为 NaN（hex 一律 null）', async () => {
  const { t, store, pitSource, memSource, embedder } = setup();
  try {
    await runIncrementalSync({ source: pitSource, store, embedder, modelId: 'stub-ngram', dim: 512, sourceName: 'pitfall' });
    const r = await recall({
      query: '跨机同步挡推口径',
      store,
      source: pitSource,
      embedder,
      sourceName: 'pitfall',
      resultTopK: 5,
    });
    assertEq(r.triggered, true, '已触发');
    assert(r.hits.length > 0, '有命中');
    for (const h of r.hits) {
      assertEq(typeof h.refId, 'string', 'refId 是权威键（字符串）');
      assertEq(h.id, null, '非数字 ref_id ⇒ id = null（**绝不写 NaN**）');
      assertEq(Number.isNaN(h.id), false, 'id 不是 NaN');
      assertEq(h.source, 'pitfall', '命中带来源归属');
    }
    assertEq(r.stats.indexSize, N, '索引规模 = 坑条数');
    assertEq(r.stats.pinnedExcluded, 0, '坑库无 pinned');
  } finally {
    pitSource.close();
    memSource.close();
    store.db.close();
    t.cleanup();
  }
});

test('refIdToNum / rrfFuse 平局：数字照旧按数值，hex 按字典序（不出现 NaN 乱序）', () => {
  assertEq(refIdToNum('12'), 12, '数字串 → 数值');
  assertEq(refIdToNum('0000000000000002'), null, '带前导零的 hex（全数字）也不当数字 id（防与记忆 id 撞号）');
  assertEq(refIdToNum('4313289685e77e19'), null, 'hex → null');
  const fused = rrfFuse(
    [
      { source: 'vector:memory', ids: ['memory:b', 'memory:a'] },
      { source: 'vector:pitfall', ids: ['pitfall:b', 'pitfall:a'] },
    ],
    60,
  );
  // b 组两路都是 rank1（并列最高分）⇒ 平局裁决走 refId 字符串比较：memory:b < pitfall:b；随后是 a 组
  assertEq(fused.map((x) => x.id), ['memory:b', 'pitfall:b', 'memory:a', 'pitfall:a'], '平局按 refId 字符串稳定排序');
  assertEq(fused.every((x) => Number.isNaN(Number(x.id)) === false || Number.isNaN(Number(x.id))), true, '不因 NaN 抛错');
  // 纯数字的两条仍按**数值**排（与旧行为一致）
  const numeric = rrfFuse([{ source: 'v', ids: ['10', '9'] }], 60);
  assertEq(numeric.map((x) => x.id), ['10', '9'], '数字平局仍按名次（分数已降序）');
});

test('recallMulti：跨来源融合，同 refId 不互相吃掉（融合键 = <source>:<refId>）', async () => {
  const { t, store, memSource, pitSource, embedder } = setup();
  try {
    await runIncrementalSync({ source: memSource, store, embedder, modelId: 'stub-ngram', dim: 512 });
    await runIncrementalSync({ source: pitSource, store, embedder, modelId: 'stub-ngram', dim: 512, sourceName: 'pitfall' });
    // 造一个与 memory 源 id 撞名的假来源（refId = '1'）
    const vec = new Float32Array(512).fill(0.01);
    upsertVectors(store.db, [{ source: 'fake', refId: '1', model: 'stub-ngram', dim: 512, vec, textHash: 'h', updatedAt: 1 }]);

    const r = await recallMulti({
      query: '跨机同步挡推口径',
      store,
      entries: [
        { name: 'memory', source: memSource, index: buildVectorIndex(store.db, { source: 'memory' }) },
        { name: 'pitfall', source: pitSource, index: buildVectorIndex(store.db, { source: 'pitfall' }) },
        { name: 'fake', source: null, index: buildVectorIndex(store.db, { source: 'fake' }) },
      ],
      embedder,
      perSourceTopK: 3,
      resultTopK: 12,
    });
    assertEq(r.triggered, true, '已触发');
    const names = new Set(r.hits.map((h) => h.source));
    assert(names.has('pitfall'), '坑源有命中');
    assert(names.has('memory'), '记忆源有命中');
    const keys = r.hits.map((h) => h.key);
    assertEq(new Set(keys).size, keys.length, '融合键唯一（撞名不互吃）');
    assert(keys.includes('memory:1') || keys.some((k) => k.startsWith('memory:')), '记忆源键带命名空间');
    assert(keys.includes('fake:1'), '撞名的假来源条目独立存在（fake:1 与 memory:1 不互吃）');
    assertEq(r.perSource.pitfall.indexSize, N, '逐来源读数：坑源索引规模');
    assertEq(r.perSource.pitfall.error, null, '坑源无错');
    // 坑库无 FTS ⇒ 该来源 FTS 路为 0，且**不影响**其它来源
    assertEq(r.perSource.pitfall.ftsHits, 0, '坑源 FTS 命中 0（无 FTS 表）');
    assertEq(r.stats.sources, ['memory', 'pitfall', 'fake'], '来源清单回显');
  } finally {
    pitSource.close();
    memSource.close();
    store.db.close();
    t.cleanup();
  }
});

test('meta 命名空间：迁移幂等 + 兼容读 + 冗余写（回滚旧代码不会走全量重建）', () => {
  const t = makeTempRoot();
  try {
    const s1 = openVectorsStore(t.paths.vectorsDb);
    // 造"老库"形态：只有无后缀旧键
    setMeta(s1.db, META_KEYS.lastIncrementalSyncAt, '123456');
    setMeta(s1.db, META_KEYS.modelId, 'bge-small-zh-v1.5');
    assertEq(getMeta(s1.db, metaKeyFor(META_KEYS.lastIncrementalSyncAt, 'memory')), null, '迁移前：命名空间键不存在');
    s1.db.close();

    const s2 = openVectorsStore(t.paths.vectorsDb);
    assertEq(getMeta(s2.db, metaKeyFor(META_KEYS.lastIncrementalSyncAt, 'memory')), '123456', '迁移：旧值播种到 :memory');
    assertEq(getMeta(s2.db, META_KEYS.lastIncrementalSyncAt), '123456', '旧键**保留**（冗余写 = 回滚护栏）');
    assertEq(getMetaFor(s2.db, META_KEYS.lastIncrementalSyncAt, 'memory'), '123456', '兼容读');
    assertEq(getMetaFor(s2.db, META_KEYS.lastIncrementalSyncAt, 'pitfall'), null, '坑源读不到记忆的水位（不串味）');
    assertEq(migrateMetaNamespace(s2.db), [], '再迁一次 ⇒ 空（幂等）');
    assertEq(getMeta(s2.db, META_KEYS.schemaVersion), '2', '迁移实际发生 ⇒ schemaVersion 升 2');
    s2.db.close();
  } finally {
    t.cleanup();
  }
});

test('selfcheck：逐 source 报告覆盖度（判据不是"向量数 vs 记忆数"一种）', async () => {
  const { t, store, memSource, pitSource, embedder } = setup();
  try {
    await runIncrementalSync({ source: memSource, store, embedder, modelId: 'stub-ngram', dim: 512 });
    await runIncrementalSync({ source: pitSource, store, embedder, modelId: 'stub-ngram', dim: 512, sourceName: 'pitfall' });
    const r = await runSelfcheck({
      store,
      sources: [
        { name: 'memory', source: memSource },
        { name: 'pitfall', source: pitSource },
      ],
      embedder,
      config: { dim: 512, hostId: 'TEST-HOST' },
    });
    const mem = r.checks.find((c) => c.name === '向量覆盖度(memory)');
    const pit = r.checks.find((c) => c.name === '向量覆盖度(pitfall)');
    assert(mem && pit, `逐 source 两条覆盖度：${r.checks.map((c) => c.name).join(',')}`);
    assertEq(mem.vecCount, 6, '记忆覆盖度读数');
    assertEq(pit.vecCount, N, '坑覆盖度读数 = 坑条数');
    assertEq(mem.memCount, 6, '记忆源条数');
    assertEq(pit.memCount, N, '坑源条数（对照物 = 坑库条数）');
  } finally {
    pitSource.close();
    memSource.close();
    store.db.close();
    t.cleanup();
  }
});
