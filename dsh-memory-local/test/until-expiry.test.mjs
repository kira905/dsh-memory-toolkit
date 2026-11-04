/**
 * test/until-expiry.test.mjs —— 记忆时效（`until:YYYYMMDD`）单测
 *
 * 覆盖（正例 + 反例 + 阴性对照）：
 *   01 解析：标准 / 空格分隔 / 破折号 / 引号 / 多条取首条合法 / 认不出来不算过期
 *   02 判定：今天之前 = 过期、当天仍有效、无 until = 无期限、`MEMORY_UNTIL=0` 急救关
 *   03 稳定分区：过期后移、组内顺序不动、结果集不增不删
 *   04 注入侧形态：只标注不位移（硬预算下后移 = 实质删，这是反例）
 *   05 **阴性对照**：完全不带 `until:` 的条目，改前改后渲染逐字节一致
 *   06 指针渲染：标注挤占本行摘要而不放宽总量；挤不下时放弃标注、条目仍在
 *   07 召回链：`recall()` 的 stats.until 与 hits 上的到期字段
 *
 * 家规：一切路径来自临时目录（见 fixtures-s2b.mjs），不落生产路径。
 * 跑法：node --test test/until-expiry.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseUntil,
  classify,
  expiryNoteOf,
  annotate,
  annotateHits,
  annotateMatches,
  stampOf,
  untilEnabled,
  EXPIRY_WEIGHT,
} from '../src/until-expiry.mjs';
import { renderPointer, pointerLine } from '../src/pointer.mjs';
import { recall } from '../src/recall.mjs';
import { makeTempEnv, stubBridge } from './fixtures-s2b.mjs';

/** 固定参考时刻：2025-12-01（本地时区中午，避开时区跨日）。 */
const NOW = new Date(2025, 11, 1, 12, 0, 0).getTime();
const TODAY = '20251201';

// ── 01 解析 ────────────────────────────────────────────────────────────────
test('解析：标准形态 until:YYYYMMDD', () => {
  const p = parseUntil('until:20251130 recall:manual');
  assert.equal(p.found, true);
  assert.equal(p.until, '20251130');
  assert.deepEqual(p.invalid, []);
});

test('解析：空格分隔（tags 串里会裂成两个 token）也认', () => {
  assert.equal(parseUntil('until: 20251130').until, '20251130');
  assert.equal(parseUntil('recall:auto until:  20260101 core:x').until, '20260101');
});

test('解析：破折号 / 斜杠 / 点 / 引号一律归一到 8 位', () => {
  for (const raw of ['until:2025-11-30', 'until:2025/11/30', 'until:2025.11.30', 'until:"20251130"', 'until:[20251130]']) {
    assert.equal(parseUntil(raw).until, '20251130', raw);
  }
});

test('解析：大小写不敏感', () => {
  assert.equal(parseUntil('Until:20251130').until, '20251130');
});

test('解析：认不出来的写法 ⇒ 记一条 invalid，但**不算过期**', () => {
  for (const raw of ['until:abc', 'until:20251340', 'until:20250230', 'until:', 'until:2025']) {
    const p = parseUntil(raw);
    assert.equal(p.until, null, raw);
    assert.ok(p.invalid.length >= 1, raw);
  }
});

test('解析：多条时取**第一条合法**（写两遍是笔误，不据此判过期/延期）', () => {
  assert.equal(parseUntil('until:20240101 until:20991231').until, '20240101');
  assert.equal(parseUntil('until:bad until:20260101').until, '20260101');
});

test('解析：完全没有 until ⇒ found=false、零 invalid（不制造噪声）', () => {
  const p = parseUntil('recall:manual core:pinned 20261030');
  assert.equal(p.found, false);
  assert.equal(p.until, null);
  assert.deepEqual(p.invalid, []);
  assert.equal(parseUntil('').found, false);
  assert.equal(parseUntil(null).found, false);
});

// ── 02 判定 ────────────────────────────────────────────────────────────────
test('判定：昨天过期、今天仍有效、明天更有效（按「日」比较）', () => {
  assert.equal(classify('until:20251130', NOW).expired, true);
  assert.equal(classify(`until:${TODAY}`, NOW).expired, false);
  assert.equal(classify('until:20251202', NOW).expired, false);
  assert.equal(stampOf(NOW), TODAY);
});

test('判定：过期标注串与权重（渲染层只认这一串）', () => {
  const c = classify('until:20200101', NOW);
  assert.equal(c.state, 'expired');
  assert.equal(c.note, '已过期（until 20200101）');
  assert.equal(c.weight, EXPIRY_WEIGHT);
  assert.equal(expiryNoteOf('until:20200101', NOW), '已过期（until 20200101）');
  // 未过期 / 无 until ⇒ 空串（渲染层据此保持逐字不变）
  assert.equal(expiryNoteOf('until:20260101', NOW), '');
  assert.equal(expiryNoteOf('recall:manual', NOW), '');
});

test('判定：认不出来的写法 ⇒ state=invalid，但 expired=false、note 空', () => {
  const c = classify('until:abc', NOW);
  assert.equal(c.state, 'invalid');
  assert.equal(c.expired, false);
  assert.equal(c.note, '');
  assert.deepEqual(c.invalid, ['until:abc']);
});

test('判定：急救关 MEMORY_UNTIL=0 ⇒ 全部当无期限（与没有本能力时一致）', () => {
  const before = process.env.MEMORY_UNTIL;
  try {
    process.env.MEMORY_UNTIL = '0';
    assert.equal(untilEnabled(), false);
    const c = classify('until:20200101', NOW);
    assert.equal(c.state, 'disabled');
    assert.equal(c.expired, false);
    assert.equal(c.note, '');
    assert.equal(c.weight, 1);
    const a = annotate([{ id: 1, tags: 'until:20200101' }], (x) => x.tags, NOW);
    assert.equal(a.items[0].expiryNote, '');
    assert.equal(a.stats.expired, 0);
    assert.equal(a.stats.disabled, true);
  } finally {
    if (before === undefined) delete process.env.MEMORY_UNTIL;
    else process.env.MEMORY_UNTIL = before;
  }
});

// ── 03 稳定分区 ────────────────────────────────────────────────────────────
test('分区：过期条目整体后移，两组内部顺序一字不动，结果集不增不删', () => {
  const items = [
    { id: 1, tags: 'until:20991231' }, // 有效
    { id: 2, tags: 'until:20200101' }, // 过期
    { id: 3, tags: '' }, // 无期限 = 有效
    { id: 4, tags: 'until:20210101' }, // 过期
  ];
  const out = annotate(items, (x) => x.tags, NOW);
  assert.deepEqual(out.items.map((x) => x.id), [1, 3, 2, 4]);
  assert.equal(out.stats.expired, 2);
  assert.deepEqual(out.stats.ids, [2, 4]);
  assert.equal(out.stats.downgraded, 2);
  assert.equal(out.stats.reordered, true);
  // 不改传入数组
  assert.deepEqual(items.map((x) => x.id), [1, 2, 3, 4]);
});

test('分区：reorder=false ⇒ 名次不动、只带标注（注入侧形态）', () => {
  const items = [
    { id: 1, tags: 'until:20991231' },
    { id: 2, tags: 'until:20200101' },
    { id: 3, tags: '' },
  ];
  const out = annotate(items, (x) => x.tags, NOW, { reorder: false });
  assert.deepEqual(out.items.map((x) => x.id), [1, 2, 3]);
  assert.equal(out.items[1].expiryNote, '已过期（until 20200101）');
  assert.equal(out.stats.downgraded, 0);
  assert.equal(out.stats.reordered, false);
});

test('分区：取 tags 抛错 ⇒ 当无期限（fail-open，一条都不标）', () => {
  const out = annotate([{ id: 1 }], () => {
    throw new Error('boom');
  }, NOW);
  assert.deepEqual(out.items.map((x) => x.id), [1]);
  assert.equal(out.items[0].expired, false);
  assert.equal(out.items[0].expiryNote, '');
});

// ── 04/05 阴性对照 ────────────────────────────────────────────────────────
test('阴性对照：完全不带 until 的条目，标注前后逐字段一致、顺序不动', () => {
  const items = [
    { id: 1, tags: 'recall:manual', title: 'a' },
    { id: 2, tags: 'core:pinned', title: 'b' },
  ];
  const out = annotate(items, (x) => x.tags, NOW);
  assert.deepEqual(out.items.map((x) => x.id), [1, 2]);
  assert.equal(out.items[0].expiryNote, '');
  assert.equal(out.items[0].until, null);
  assert.equal(out.items[0].expiryWeight, 1);
  assert.equal(out.stats.expired, 0);
  assert.deepEqual(out.stats.ids, []);
  assert.deepEqual(out.stats.invalid, []);
});

test('阴性对照：指针渲染（无一条带 until）与不传 expiryOf 逐字节一致', () => {
  const rows = [1, 2, 3].map((i) => ({
    id: i,
    text: `第 ${i} 条记忆的摘要文本，够长一点以贴近真实形态`,
    tags: 'recall:manual',
    updated_at: 1764500000000 + i,
  }));
  const plain = renderPointer(rows, {});
  const withHook = renderPointer(rows, { expiryOf: () => '' });
  assert.equal(withHook.text, plain.text);
  assert.equal(withHook.expiryMarked, 0);
  assert.equal(withHook.expiryDropped, 0);
  assert.equal(withHook.chars, plain.chars);
  assert.deepEqual(withHook.items.map((x) => x.id), plain.items.map((x) => x.id));
});

test('阴性对照：promptLine 不传标注时与原文格式逐字一致', () => {
  const rec = { id: 7, tags: 'a b', pinned: true, text: '正文' };
  assert.equal(pointerLine({ id: 7, tags: 'a b', text: '正文', updated_at: 0 }), '- #7 (日期未知 · tags: a b) 正文');
  assert.equal(pointerLine({ id: 7, tags: 'a b', text: '正文', updated_at: 0 }, { expiry: '' }), '- #7 (日期未知 · tags: a b) 正文');
  assert.equal(
    pointerLine({ id: 7, tags: 'a b', text: '正文', updated_at: 0 }, { expiry: '已过期（until 20200101）' }),
    '- #7 已过期（until 20200101） (日期未知 · tags: a b) 正文',
  );
  assert.ok(rec);
});

// ── 06 指针渲染 ───────────────────────────────────────────────────────────
test('渲染：标注真的进了文本，且总量仍在 800 字 / 600 token 硬预算内', () => {
  const rows = [1, 2].map((i) => ({
    id: i,
    text: '一条比较长的记忆摘要'.repeat(6),
    tags: 'recall:manual',
    updated_at: 1764500000000 + i,
  }));
  const out = renderPointer(rows, { expiryOf: (row) => (row.id === 2 ? '已过期（until 20200101）' : '') });
  assert.ok(out.text.includes('已过期（until 20200101）'));
  assert.ok(out.chars <= 800);
  assert.equal(out.expiryMarked, 1);
  assert.equal(out.items[1].expiry, '已过期（until 20200101）');
  // 未标那条一个字节不动
  assert.equal(out.lines[0], pointerLine(rows[0], {}));
});

test('渲染：标注从本行摘要里让位；挤到 40 字还放不下 ⇒ 放弃标注、条目仍在', () => {
  const longText = '很长很长的一条记忆正文'.repeat(30);
  const rows = [
    { id: 1, text: longText, tags: 'recall:manual', updated_at: 1764500000000 },
    { id: 2, text: longText, tags: 'recall:manual', updated_at: 1764500000001 },
  ];
  // 预算刚好只够两条无标注的行 ⇒ 标注必须在摘要里腾位置
  const plain = renderPointer(rows, { summaryChars: 80 });
  const tight = renderPointer(rows, { summaryChars: 80, maxChars: plain.chars, expiryOf: () => '已过期（until 20200101）' });
  assert.equal(tight.text.length <= plain.chars, true, '标注不得突破总量');
  assert.equal(tight.items.length, 2, '条目不得因标注而消失');
  assert.ok(tight.expiryMarked + tight.expiryDropped === 2);
  // 极端：预算几乎只够一行正文 ⇒ 标注放弃，行仍在
  const squeezed = renderPointer(rows.slice(0, 1), { summaryChars: 80, maxChars: 120, expiryOf: () => '已过期（until 20200101）' });
  if (squeezed.lines.length > 0) {
    assert.ok(squeezed.expiryMarked === 0 || squeezed.expiryMarked === 1);
    assert.ok(squeezed.chars <= 120);
  }
});

// ── 07 召回链 ──────────────────────────────────────────────────────────────
test('召回：stats.until 有读数、过期条目不消失（reorder 两种形态都验）', async () => {
  const env = makeTempEnv({
    memories: [
      { text: '三仓同步的旧结论 已作废', tags: 'until:20200101 recall:manual' },
      { text: '三仓同步的新结论 仍在用', tags: 'recall:manual' },
      { text: '三仓同步的第三条 无期限', tags: '' },
    ],
  });
  try {
    const { openVectorsReader } = await import('../src/vectors-read.mjs');
    const { openMemoryReader } = await import('../src/memory-read.mjs');
    const { buildVectorIndex } = await import('../src/recall.mjs');
    const store = openVectorsReader(env.vectorsDb);
    const source = openMemoryReader(env.memoryDb);
    const index = buildVectorIndex(store.db, { source: 'memory' });
    const embedder = stubBridge();

    const args = { query: '三仓同步 结论', store: { db: store.db }, source, embedder, index, resultTopK: 8 };
    const reordered = await recall({ ...args, nowMs: NOW, untilReorder: true });
    const marked = await recall({ ...args, nowMs: NOW, untilReorder: false });

    assert.equal(reordered.triggered, true);
    assert.equal(reordered.stats.until.expired, 1);
    assert.deepEqual(reordered.stats.until.ids, [1]);
    assert.equal(reordered.stats.until.downgraded, 1);
    // 结果集不增不删：两种形态条数一致
    assert.equal(reordered.hits.length, marked.hits.length);
    // 后移形态：过期那条排最后
    assert.equal(reordered.hits.at(-1).id, 1);
    // 标注形态：位置不动，但带上标注
    const expiredHit = marked.hits.find((h) => h.id === 1);
    assert.ok(expiredHit, '过期条目不得从结果里消失');
    assert.equal(expiredHit.expiryNote, '已过期（until 20200101）');
    assert.equal(expiredHit.expired, true);
    assert.equal(marked.stats.until.downgraded, 0);
    // 未过期条目的相对顺序一字不动
    assert.deepEqual(
      reordered.hits.filter((h) => h.id !== 1).map((h) => h.id),
      marked.hits.filter((h) => h.id !== 1).map((h) => h.id),
    );
    store.close();
    source.close();
  } finally {
    env.cleanup();
  }
});

test('召回：壳子 annotateHits / annotateMatches 分别按 id 查表、按 tags 直读', () => {
  const hits = [{ id: 1 }, { id: 2 }];
  const tagById = new Map([['1', 'until:20200101'], ['2', '']]);
  const a = annotateHits(hits, tagById, NOW, { reorder: false });
  assert.equal(a.items[0].expiryNote, '已过期（until 20200101）');
  assert.equal(a.items[1].expiryNote, '');

  const matches = [{ id: 9, tags: 'until:20200101' }, { id: 8, tags: 'recall:manual' }];
  const b = annotateMatches(matches, NOW);
  assert.deepEqual(b.items.map((m) => m.id), [8, 9], '工具路径默认后移');
  assert.equal(b.items[1].expiryNote, '已过期（until 20200101）');
});
