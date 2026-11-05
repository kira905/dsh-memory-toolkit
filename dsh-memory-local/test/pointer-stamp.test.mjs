/**
 * test/pointer-stamp.test.mjs —— 指针行时间戳「近 7 天带时分、更老只留日期」（半衰）单测
 *
 * 覆盖（正例 + 反例 + 阴性对照）：
 *   01 半衰边界：6.99 天 ⇒ 带 `HH:MM`；正好 7 天 / 7 天多一点 ⇒ 只留日期（跨 7 天边界）
 *   02 时区：一律**本地**分量，绝不用 UTC（`toISOString()` 会差若干小时 ⇒ 把「昨晚」说成「几天前」）
 *   03 env 覆盖：合法值生效；`0` / 负数 / 非数字 / 空串 / 非有限 ⇒ 回落默认 7 天（fail-open）
 *   04 非法时间戳：0 / 负数 / NaN / undefined ⇒ `日期未知`，不崩不抛
 *   05 指针渲染：多出来的 6 字从**本行摘要**让位 —— 800 字 / 600 token 硬预算一个字不放宽
 *   06 **阴性对照**：全部条目都 ≥7 天 ⇒ 渲染结果与「不带时分」逐字节一致（老数据零变化）
 *   07 同一次渲染两遍共用同一个 now（过期标注那一遍不会重算出不同的时间戳）
 *
 * 跑法：node --test test/pointer-stamp.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDate,
  formatStamp,
  pointerLine,
  renderPointer,
  estimateTokens,
  RECENT_FULL_TIME_DAYS,
  RECENT_FULL_TIME_MS,
  RECENT_FULL_TIME_ENV,
  recentFullTimeMs,
  POINTER_HEADER_TEXT,
} from '../src/pointer.mjs';

const DAY = 24 * 60 * 60 * 1000;

/** 固定参考时刻：本地 2026-05-02 04:30（**本地分量**构造，跨机跑都成立）。 */
const NOW = new Date(2026, 4, 2, 4, 30, 0).getTime();

/** 造一条记忆行。 */
const row = (id, updatedAt, text = '记忆正文示例', tags = '') => ({ id, text, tags, updated_at: updatedAt });

// ── 01 半衰边界 ────────────────────────────────────────────────────────────
test('半衰：6.99 天仍带 HH:MM，正好 7 天起只留日期', () => {
  assert.equal(RECENT_FULL_TIME_DAYS, 7);
  assert.equal(RECENT_FULL_TIME_MS, 7 * DAY);

  // 6.99 天 ⇒ 带时分
  assert.equal(formatStamp(NOW - 7 * DAY + 1000, NOW), '2026-04-25 04:30');
  // 正好 7 天 ⇒ age >= limit ⇒ 只日期
  assert.equal(formatStamp(NOW - 7 * DAY, NOW), '2026-04-25');
  // 7 天多一点 ⇒ 只日期
  assert.equal(formatStamp(NOW - 7 * DAY - 1, NOW), '2026-04-25');
  // 8 天 ⇒ 只日期
  assert.equal(formatStamp(NOW - 8 * DAY, NOW), '2026-04-24');
});

test('半衰：刚写入的时刻带当前时分', () => {
  const out = formatStamp(NOW, NOW);
  assert.equal(out, '2026-05-02 04:30');
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('半衰：跨日边界的小时分钟补齐两位（不出现 4:05 这种）', () => {
  const t = new Date(2026, 4, 2, 4, 5, 0).getTime();
  assert.equal(formatStamp(t, NOW), '2026-05-02 04:05');
});

// ── 02 时区 ────────────────────────────────────────────────────────────────
test('时区：用的是本地分量，不是 UTC', () => {
  // new Date(y, m, d, h, min) 一律按**本地**解释 ⇒ 断言本地分量原样出现在输出里。
  const local = new Date(2026, 0, 15, 23, 45, 0).getTime(); // 本地 2026-01-15 23:45
  const out = formatStamp(local, local + 1000);
  assert.equal(out, '2026-01-15 23:45');

  // 只有本机偏移 ≠ 0 时，才能拿「UTC 表示」做对照：挑一个本地时刻，让它对应的 UTC 落到**相邻日**。
  const offsetMin = new Date().getTimezoneOffset(); // 分钟：UTC+8 ⇒ -480
  if (offsetMin !== 0) {
    const hour = offsetMin < 0 ? 0 : 23; // 东时区取凌晨、西时区取深夜 ⇒ UTC 必然跨到另一天
    const minute = offsetMin < 0 ? 1 : 59;
    const t = new Date(2026, 0, 16, hour, minute, 0).getTime();
    const stamp = formatStamp(t, t + 1000);
    const utc = new Date(t).toISOString();
    assert.equal(stamp, `2026-01-16 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    assert.notEqual(stamp.slice(0, 10), utc.slice(0, 10), '日期不得取 UTC 日');
    assert.notEqual(stamp.slice(11), utc.slice(11, 16), '时分不得取 UTC 值');
  }
});

test('时区：大于 7 天只留日期，且日期仍是本地日', () => {
  const local = new Date(2026, 0, 15, 23, 45, 0).getTime();
  const out = formatStamp(local, local + 30 * DAY);
  assert.equal(out, '2026-01-15');
  assert.equal(out, formatDate(local));
});

// ── 03 env 覆盖（fail-open） ───────────────────────────────────────────────
test('env 覆盖：合法值生效，非法值一律回落 7 天', () => {
  assert.equal(recentFullTimeMs({ [RECENT_FULL_TIME_ENV]: '3' }), 3 * DAY);
  assert.equal(recentFullTimeMs({ [RECENT_FULL_TIME_ENV]: '1.5' }), 1.5 * DAY);
  for (const bad of ['0', '-1', 'abc', '', '   ', 'Infinity', 'NaN', undefined, null]) {
    assert.equal(recentFullTimeMs({ [RECENT_FULL_TIME_ENV]: bad }), RECENT_FULL_TIME_MS, `bad=${String(bad)}`);
  }
  assert.equal(recentFullTimeMs(undefined), RECENT_FULL_TIME_MS);
  assert.equal(recentFullTimeMs({}), RECENT_FULL_TIME_MS);
});

test('env 覆盖：阈值可传入，缩到 1 天后 2 天前就只留日期', () => {
  assert.equal(formatStamp(NOW - 2 * DAY, NOW, 1 * DAY), '2026-04-30');
  assert.equal(formatStamp(NOW - 2 * DAY, NOW, 30 * DAY), '2026-04-30 04:30');
});

// ── 04 非法时间戳 ──────────────────────────────────────────────────────────
test('非法时间戳：0 / 负数 / NaN / undefined ⇒ 日期未知，不抛', () => {
  for (const bad of [0, -1, NaN, undefined, null, 'abc']) {
    assert.equal(formatStamp(bad, NOW), '日期未知', `bad=${String(bad)}`);
  }
});

// ── 05 指针渲染：让位不放宽预算 ────────────────────────────────────────────
test('渲染：近 7 天的行比老行多 6 字，且 800 字硬预算一个字不放宽', () => {
  const fresh = row(1, NOW - 3600 * 1000, '甲'.repeat(200));
  const old = row(2, NOW - 30 * DAY, '甲'.repeat(200));
  const one = renderPointer([fresh], { now: NOW });
  const two = renderPointer([old], { now: NOW });
  assert.equal(one.chars - two.chars, 6, '差的就是 ` HH:MM` 六个字符');
  assert.ok(one.chars <= 800 && estimateTokens(one.text) <= 600);
  assert.ok(two.chars <= 800 && estimateTokens(two.text) <= 600);
});

test('渲染：贴预算时靠缩摘要吸收时分的 6 字，条数不减', () => {
  // 8 条 × 70 字摘要：全套老数据是 8×88+50 = 754 字（放得下）；近 7 天每条多 6 字 ⇒ 802 字（超）
  // ⇒ 必须缩摘要让位，让第 8 条仍然进得来。
  const mk = (ms) => Array.from({ length: 8 }, (_, i) => row(i + 1, ms, '乙'.repeat(70)));
  const fresh = renderPointer(mk(NOW - 3600 * 1000), { now: NOW });
  const old = renderPointer(mk(NOW - 30 * DAY), { now: NOW });
  assert.equal(old.lines.length, 8, '老数据 8 条全进');
  assert.equal(fresh.lines.length, 8, '近数据也要 8 条全进（时分靠缩摘要吸收）');
  assert.ok(fresh.chars <= 800, `chars=${fresh.chars}`);
  assert.ok(fresh.estTokens <= 600, `tokens=${fresh.estTokens}`);
  assert.ok(
    fresh.items.some((it) => it.summaryChars < 70),
    '至少一条的摘要被缩过（证明是让位而不是放宽预算）',
  );
  assert.ok(fresh.items.every((it) => it.summaryChars >= 40), '摘要让位下限 40 字');
});

test('渲染：极端预算下宁可丢条，也不越 800 字', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(i + 1, NOW - 3600 * 1000, '丙'.repeat(300)));
  const out = renderPointer(rows, { now: NOW });
  assert.ok(out.chars <= 800, `chars=${out.chars}`);
  assert.ok(out.dropped > 0);
});

// ── 06 阴性对照 ────────────────────────────────────────────────────────────
test('阴性对照：全部条目 ≥7 天时，渲染与「不带时分」逐字节一致', () => {
  const rows = [1, 2, 3, 4, 5].map((i) => row(i, NOW - (8 + i) * DAY, `旧记忆 ${i}`));
  const out = renderPointer(rows, { now: NOW });
  const expected = [
    POINTER_HEADER_TEXT,
    ...rows.map((r) => `- #${r.id} (${formatDate(r.updated_at)}) ${r.text}`),
  ].join('\n');
  assert.equal(out.text, expected);
});

test('阴性对照：pointerLine 带不带 now 都不改老数据的输出', () => {
  const r = row(9, NOW - 30 * DAY, '很旧的一条');
  assert.equal(pointerLine(r, { now: NOW }), pointerLine(r, { now: NOW + 100 * DAY }));
  assert.equal(pointerLine(r, { now: NOW }), `- #9 (${formatDate(r.updated_at)}) 很旧的一条`);
});

// ── 07 两遍共用同一个 now ──────────────────────────────────────────────────
test('过期标注那一遍也带同一个 now（不会重算出别的时间）', () => {
  const r = row(7, NOW - 3600 * 1000, '带 until 的近记忆');
  const out = renderPointer([r], { now: NOW, expiryOf: () => '已过期（until 20200101）' });
  assert.equal(out.expiryMarked, 1);
  assert.match(out.lines[0], /2026-05-02 03:30/, '时间戳与第一遍一致（1 小时前 = 03:30）');
  assert.match(out.lines[0], /已过期（until 20200101）/);
  assert.ok(out.chars <= 800);
});
