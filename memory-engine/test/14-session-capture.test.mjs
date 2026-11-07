// 14-session-capture.test.mjs —— 会话提炼记忆 T1（提取层）+ T2（账本）离线单测
// 2026-10-26 建 · 用例覆盖 J1/J2/J6/J7
//
// 口径：**零生产接触**（不读 ~/.dsh、不写库、不联网）。夹具根默认落在系统临时区
//   `<tmp>/dsh-capture-unit`，可用 env `CAPTURE_FIXTURE_ROOT` 改道。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, assert, assertEq } from './harness.mjs';
import {
  WHITELIST_EVENT_TYPES, INJECTION_SOURCE_KINDS, DEFAULT_LIMITS, TRUNCATED_MARK,
  extractWhitelist, classifySourceKind, truncateText, contentHashOfRange, judgeExtracted, selfTest,
} from '../lib/session-capture.mjs';
import {
  LEDGER_SCHEMA_VERSION, costDay, emptyLedger, normalizeLedger, readLedger, writeLedger,
  textHashOf, isSeen, markSeen, filterUnseen, advanceCursor, shouldSkipRange,
  bumpCost, appendRun, pruneLedger, ledgerSummary, ledgerPath,
} from '../lib/capture-ledger.mjs';

export const __section = '会话提炼记忆（T1 提取 + T2 账本）';

// ── 夹具根 ──────────────────────────────────────────────────────────────────
const FIXTURE_ROOT = (() => {
  const want = process.env.CAPTURE_FIXTURE_ROOT || path.join(os.tmpdir(), 'dsh-capture-unit');
  try { fs.mkdirSync(want, { recursive: true }); return want; } catch {
    const fb = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-capture-unit-'));
    console.log(`  （夹具根回落系统临时区：${fb}）`);
    return fb;
  }
})();

const user = (text, kind = 'user', seq = 1) => ({ type: 'user/message', seq, time: 1761400000000 + seq, data: { content: text, source: { kind } } });
const asst = (text, seq = 2) => ({ type: 'assistant/message', seq, time: 1761400000000 + seq, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } });

// ═══════════════════════════════════════════════════════════════════════════
// T1 · 白名单提取
// ═══════════════════════════════════════════════════════════════════════════

test('T1 · 模块自测（10 项纯函数夹具）全过', () => {
  const st = selfTest();
  const bad = st.results.filter((r) => !r.pass).map((r) => `${r.name}: ${r.detail}`);
  assertEq(st.failed, 0, `自测失败项：${bad.join(' | ')}`);
  assertEq(st.total, 10);
});

test('T1 · I3：user 正文在 data.content（写 data.message.content 会 0 候选）', () => {
  const ok = extractWhitelist([user('这是真人说的一句话，长度足够')]);
  assertEq(ok.messages.length, 1);
  assertEq(ok.messages[0].text, '这是真人说的一句话，长度足够');
  // 反证：把正文塞到 data.message.content ⇒ 提取层一个字都取不到（这正是过审踩过的坑）
  const wrong = { type: 'user/message', seq: 1, data: { message: { content: '这条塞错位置了' }, source: { kind: 'user' } } };
  assertEq(extractWhitelist([wrong]).messages.length, 0);
  assertEq(extractWhitelist([wrong]).stats.byReason.empty, 1);
});

test('T1 · I2：7 种注入 kind 逐条被剔（且 reason 分得清是哪一种）', () => {
  const recs = INJECTION_SOURCE_KINDS.map((k, i) => user(`注入块正文第 ${i} 条，长度足够长到能当候选`, k, 10 + i));
  const { messages, stats } = extractWhitelist(recs);
  assertEq(messages.length, 0, '注入一条都不该留');
  assertEq(INJECTION_SOURCE_KINDS.length, 7, '注入 kind 清单条数');
  for (const k of INJECTION_SOURCE_KINDS) assertEq(stats.byReason[`inject:${k}`], 1, k);
});

test('T1 · I2 反证：同一批文本换个 kind 就能进（证明闸在 kind 上、不是靠文本猜）', () => {
  const text = '拍板：以后一律按这个走，别再问我第二遍';
  const asInjection = extractWhitelist([user(text, 'time-context')]);
  const asUser = extractWhitelist([user(text, 'user')]);
  assertEq(asInjection.messages.length, 0);
  assertEq(asUser.messages.length, 1);
});

test('T1 · 白名单事件类型：只有 user/message + assistant/message，其它 20 种 type 全不进', () => {
  const recs = [
    { type: 'system/message', seq: 1, data: { content: '系统提示，很长的' } },
    { type: 'tool/result', seq: 2, data: { content: '工具输出，很长的' } },
    { type: 'request/header', seq: 3, data: {} },
    user('真人的一句话，长度足够长'),
    asst('本鱼的一句话，长度也够'),
  ];
  const { messages, stats } = extractWhitelist(recs);
  assertEq(messages.map((m) => m.type), [...WHITELIST_EVENT_TYPES]);
  assertEq(stats.byReason['type:system/message'], 1);
  assertEq(stats.byReason['type:tool/result'], 1);
});

test('T1 · classifySourceKind：assistant / user / 缺 kind=null', () => {
  assertEq(classifySourceKind(asst('x')), 'assistant');
  assertEq(classifySourceKind(user('x')), 'user');
  assertEq(classifySourceKind({ type: 'user/message', data: {} }), null);
});

test('T1 · 末 N 轮：只保留最后 N 轮（前面的轮次记 old-turn）', () => {
  const recs = [];
  let seq = 1;
  for (let turn = 1; turn <= 5; turn++) {
    recs.push({ type: 'turn/start', seq: seq++ });
    recs.push(user(`第 ${turn} 轮真人说的话，长度足够`, 'user', seq++));
    recs.push(asst(`第 ${turn} 轮本鱼的答复，长度也够`, seq++));
    recs.push({ type: 'turn/end', seq: seq++ });
  }
  const { messages, stats } = extractWhitelist(recs, { lastTurns: 2 });
  assertEq(stats.turnsTotal, 5);
  assertEq(messages.map((m) => m.turn), [4, 4, 5, 5]);
  assertEq(stats.byReason['old-turn'], 6);
});

test('T1 · 三道上限：单条截断留标记 / assistant 合计丢最旧 / 超限有计数', () => {
  const one = extractWhitelist([user('b'.repeat(30))], { singleChars: 10 });
  assertEq(one.stats.truncatedSingle, 1);
  assert(one.messages[0].text.endsWith(TRUNCATED_MARK), '缺 [truncated] 标记');
  const two = extractWhitelist([asst('X'.repeat(40), 1), asst('Y'.repeat(40), 2)], { assistantCharsPerSession: 50 });
  assertEq(two.stats.droppedAssistantOverflow, 1);
  assert(two.messages[0].text.startsWith('Y'), '应保留最新的那条');
});

test('T1 · 截断后的正文确实进了判定（不是只截显示）', () => {
  const long = `拍板：以后一律按这个走。${'补充说明。'.repeat(40)}`;
  const { messages } = extractWhitelist([user(long)], { singleChars: 20 });
  assertEq(messages[0].text.length, 20 + TRUNCATED_MARK.length);
  assertEq(extractWhitelist([user(long)], { singleChars: 20 }).messages[0].record.data.content.length, 20 + TRUNCATED_MARK.length);
});

test('T1 · 端到端：注入不进候选，真 user 能出候选（J2 的判据内核）', () => {
  const recs = [
    ...INJECTION_SOURCE_KINDS.map((k, i) => user(`拍板：以后一律按这个走（第 ${i} 条注入）`, k, 10 + i)),
    user('拍板：以后一律按这个走，别再问我第二遍', 'user', 30),
    asst('记下了。这件事的根因是配置文件里少了一个键，实测 rc 0 之后才好的。', 31),
  ];
  const ex = extractWhitelist(recs);
  const jd = judgeExtracted(ex.messages, { sessionId: 'fixture' });
  assertEq(ex.messages.length, 2, '白名单应只留 1 user + 1 assistant');
  assert(jd.candidates.length <= 2, `候选应 ≤2，实际 ${jd.candidates.length}`);
  for (const c of jd.candidates) {
    assert(!INJECTION_SOURCE_KINDS.includes(c.sourceKind), `候选里出现注入 kind：${c.sourceKind}`);
  }
});

test('T1 · contentHashOfRange：同 seq 区间内容变了 ⇒ 哈希必须变（游标第二判据的地基）', () => {
  const a = [{ type: 'user/message', seq: 1, data: { content: '原文' } }];
  const b = [{ type: 'user/message', seq: 1, data: { content: '补写后的原文' } }];
  assert(contentHashOfRange(a) !== contentHashOfRange(b), '内容变了哈希却一样 ⇒ 游标会误判"判过了"');
  assertEq(contentHashOfRange(a), contentHashOfRange([{ type: 'user/message', seq: 1, data: { content: '原文' } }]));
});

// ═══════════════════════════════════════════════════════════════════════════
// T2 · 账本
// ═══════════════════════════════════════════════════════════════════════════

test('T2 · 空账本形状（schemaVersion / cost / runs 齐全）', () => {
  const l = emptyLedger(1761440400000);
  assertEq(l.schemaVersion, LEDGER_SCHEMA_VERSION);
  assertEq(l.cursor, {});
  assertEq(l.seen, {});
  assertEq(l.cost.day, costDay(1761440400000));
  assertEq(l.runs, []);
});

test('T2 · textHashOf：空白折叠后同文同哈希（跨会话 twin 才挡得住）', () => {
  const a = textHashOf('落点是  https://x/y', '原文片段 A');
  const b = textHashOf('落点是\n\nhttps://x/y  ', '原文片段   A');
  assertEq(a, b);
  assert(a.startsWith('sha256:'));
  assert(textHashOf('甲', '乙') !== textHashOf('甲', '丙'));
});

test('T2 · J7 游标只前进：改小后推进 ⇒ 取最大值；再传小值不回退', () => {
  const l = emptyLedger();
  advanceCursor(l, 's1', { throughSeq: 851, contentHash: 'sha256:aa', state: 'done' });
  assertEq(l.cursor.s1.throughSeq, 851);
  // 手工把 throughSeq 改小（J7 的做法）
  l.cursor.s1.throughSeq = 3;
  const r = advanceCursor(l, 's1', { throughSeq: 851, contentHash: 'sha256:bb', state: 'done' });
  assertEq(r.entry.throughSeq, 851, '改小后再跑必须追回 ≥ 原最大值');
  assert(r.advanced === true);
  // 再传一个更小的值：不许回退
  const r2 = advanceCursor(l, 's1', { throughSeq: 10, contentHash: 'sha256:cc' });
  assertEq(r2.entry.throughSeq, 851);
  assertEq(r2.advanced, false);
  assertEq(r2.entry.contentHash, 'sha256:bb', '没前进就不许把已判区间的哈希改掉');
});

test('T2 · 游标 state：partial 能被 done 清掉，done 不会被无参数覆盖成 partial', () => {
  const l = emptyLedger();
  advanceCursor(l, 's', { throughSeq: 10, contentHash: 'h1', state: 'partial' });
  assertEq(l.cursor.s.state, 'partial');
  advanceCursor(l, 's', { throughSeq: 10, contentHash: 'h1' });
  assertEq(l.cursor.s.state, 'partial', '没显式 done 时 partial 应保留');
  advanceCursor(l, 's', { throughSeq: 20, contentHash: 'h2', state: 'done' });
  assertEq(l.cursor.s.state, 'done');
  advanceCursor(l, 's', { throughSeq: 30, contentHash: 'h3' });
  assertEq(l.cursor.s.state, 'done', 'done 不该被无参数调用打回 partial');
});

test('T2 · shouldSkipRange：seq 够 + 哈希同 才跳；哈希不同不跳', () => {
  const l = emptyLedger();
  advanceCursor(l, 's', { throughSeq: 100, contentHash: 'sha256:aa' });
  assertEq(shouldSkipRange(l, 's', { throughSeq: 90, contentHash: 'sha256:aa' }), true);
  assertEq(shouldSkipRange(l, 's', { throughSeq: 100, contentHash: 'sha256:bb' }), false, '内容变了还跳 = 丢知识');
  assertEq(shouldSkipRange(l, 's', { throughSeq: 101, contentHash: 'sha256:aa' }), false);
  assertEq(shouldSkipRange(l, 'nope', { throughSeq: 1 }), false);
});

test('T2 · J6 幂等：第一轮全 fresh、第二轮全命中 seen（written=0 的判据内核）', () => {
  const l = emptyLedger();
  const batch = [
    { claim: '口径 A', quote: '原文 A' },
    { claim: '口径 B', quote: '原文 B' },
    { claim: '弃掉的那条', quote: '原文 C' },
  ];
  const r1 = filterUnseen(l, batch);
  assertEq(r1.fresh.length, 3);
  assertEq(r1.seen.length, 0);
  markSeen(l, r1.fresh[0].textHash, { verdict: '记', memoryId: 1000836, runId: 'r1', textHead: '口径 A' });
  markSeen(l, r1.fresh[1].textHash, { verdict: '记', memoryId: 1000837, runId: 'r1', textHead: '口径 B' });
  markSeen(l, r1.fresh[2].textHash, { verdict: '弃', memoryId: null, runId: 'r1', textHead: '弃掉' });
  const r2 = filterUnseen(l, batch);
  assertEq(r2.fresh.length, 0, '第二轮不该有新候选');
  assertEq(r2.seen.length, 3, '弃掉的也必须命中（否则下轮还会重判）');
  assertEq(l.seen[r1.fresh[0].textHash].memoryId, 1000836);
  assertEq(l.seen[r1.fresh[2].textHash].memoryId, null);
  assertEq(Object.keys(l.seen).length, 3);
});

test('T2 · seen 只存头部（≤60 字，不存全文）', () => {
  const l = emptyLedger();
  const h = textHashOf('长概括', '原文');
  markSeen(l, h, { verdict: '记', memoryId: 1, textHead: 'X'.repeat(500) });
  assertEq(l.seen[h].textHead.length, 60);
});

test('T2 · bumpCost：同日累加、跨天归零', () => {
  const l = emptyLedger(Date.parse('2026-10-26T10:00:00Z'));
  bumpCost(l, { day: '2026-10-26', calls: 3, tokens: 1000 });
  bumpCost(l, { day: '2026-10-26', calls: 5, tokens: 2000 });
  assertEq(l.cost, { day: '2026-10-26', calls: 8, tokens: 3000 });
  bumpCost(l, { day: '2026-10-27', calls: 1, tokens: 10 });
  assertEq(l.cost, { day: '2026-10-27', calls: 1, tokens: 10 });
});

test('T2 · appendRun：字段齐（含 E1 的 writtenIds / failed），runs 超 90 天被裁', () => {
  const l = emptyLedger();
  const now = Date.parse('2026-10-26T04:10:00Z');
  appendRun(l, { runId: 'old', at: '2026-01-01T00:00:00Z', written: 1 });
  const row = appendRun(l, {
    runId: '2026-10-26-0410', sessions: 40, candidates: 156, judged: { 记: 10, 弃: 146 },
    calls: 8, tokens: 52000, written: 2, writtenIds: [1000846, 1000847],
    failed: [{ seq: 5, reason: 'write-timeout' }], stopping: null, ms: 53000,
  }, { nowMs: now });
  assertEq(row.writtenIds, [1000846, 1000847]);
  assertEq(row.failed.length, 1);
  assertEq(row.judged, { 记: 10, 弃: 146 });
  assertEq(l.runs.length, 1, '90 天前那轮应被裁掉');
  assertEq(l.runs[0].runId, '2026-10-26-0410');
});

test('T2 · pruneLedger：不传 liveSessionIds 时游标一条不删（归档 ≠ 删除）', () => {
  const l = emptyLedger();
  advanceCursor(l, 'archived-one', { throughSeq: 5 });
  advanceCursor(l, 'live-one', { throughSeq: 6 });
  const r1 = pruneLedger(l, { nowMs: Date.now() });
  assertEq(r1.removedCursors, 0);
  assertEq(Object.keys(l.cursor).length, 2);
  const r2 = pruneLedger(l, { nowMs: Date.now(), liveSessionIds: new Set(['live-one']) });
  assertEq(r2.removedCursors, 1);
  assertEq(Object.keys(l.cursor), ['live-one']);
});

test('T2 · 读写环：原子写 → 读回一致；写第二次留 .bak', () => {
  const dir = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'ledger-'));
  const file = path.join(dir, 'memory-capture', 'ledger.json');
  const l = emptyLedger();
  markSeen(l, textHashOf('a', 'b'), { verdict: '记', memoryId: 7, runId: 'r', textHead: 'head' });
  advanceCursor(l, 's', { throughSeq: 42, contentHash: 'h' });
  writeLedger(file, l, { nowMs: 1761440400000 });
  const got = readLedger(file);
  assertEq(got.status, 'ok');
  assertEq(got.ledger.seen[textHashOf('a', 'b')].memoryId, 7);
  assertEq(got.ledger.cursor.s.throughSeq, 42);
  // 第二次写：旧内容应进 .bak
  const l2 = { ...got.ledger };
  advanceCursor(l2, 's', { throughSeq: 99 });
  writeLedger(file, l2, { nowMs: 1761440500000 });
  assert(fs.existsSync(file + '.bak'), '.bak 没生成');
  const bak = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
  assertEq(bak.cursor.s.throughSeq, 42, '.bak 应是**上一版**（42），不是当前版');
  assertEq(readLedger(file).ledger.cursor.s.throughSeq, 99);
});

test('T2 · 坏账本：主坏 .bak 好 ⇒ recovered-bak；两边都坏 ⇒ corrupt（fail-closed，不返回空账本）', () => {
  const dir = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'broken-'));
  const file = path.join(dir, 'ledger.json');
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  const r1 = readLedger(file);
  assertEq(r1.status, 'corrupt');
  assertEq(r1.ledger, null, 'corrupt 时**不能**给一个空账本（那会变成"全量重判"）');
  const good = emptyLedger();
  advanceCursor(good, 's', { throughSeq: 5 });
  fs.writeFileSync(file + '.bak', JSON.stringify(good), 'utf8');
  const r2 = readLedger(file);
  assertEq(r2.status, 'recovered-bak');
  assertEq(r2.ledger.cursor.s.throughSeq, 5);
});

test('T2 · schemaVersion 比本件新 ⇒ schema-newer（拒读，不猜）', () => {
  const dir = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'newer-'));
  const file = path.join(dir, 'ledger.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, cursor: {}, seen: {}, runs: [] }), 'utf8');
  const r = readLedger(file);
  assertEq(r.status, 'schema-newer');
  assertEq(r.ledger, null);
});

test('T2 · 缺账本 ⇒ missing + 空账本（首次运行唯一的"合法空白"）', () => {
  const dir = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'missing-'));
  const r = readLedger(path.join(dir, 'nope', 'ledger.json'));
  assertEq(r.status, 'missing');
  assertEq(r.ledger.schemaVersion, LEDGER_SCHEMA_VERSION);
});

test('T2 · normalizeLedger 兜底：缺段补齐、多余键保留', () => {
  const n = normalizeLedger({ cursor: { s: { throughSeq: 1 } }, weird: 'keep-me' });
  assertEq(n.schemaVersion, LEDGER_SCHEMA_VERSION);
  assertEq(n.seen, {});
  assertEq(n.runs, []);
  assertEq(n.weird, 'keep-me');
  assertEq(n.cost.calls, 0);
});

test('T2 · ledgerPath 落在 <home>\\memory-capture\\ledger.json（不硬编码 ~/.dsh）', () => {
  const faux = path.join(os.tmpdir(), 'faux-home');
  assertEq(ledgerPath(faux), path.join(faux, 'memory-capture', 'ledger.json'));
});

test('T2 · ledgerSummary 出一行（日报要用）', () => {
  const l = emptyLedger();
  appendRun(l, { runId: 'r1', written: 2, writtenIds: [1, 2], failed: [], stopping: null });
  const s = ledgerSummary(l);
  assertEq(s.runs, 1);
  assertEq(s.lastRun.runId, 'r1');
  assertEq(s.lastRun.writtenIds, 2);
});
