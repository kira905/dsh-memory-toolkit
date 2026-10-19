/**
 * FORK-EDIT(2026-10-09): 冲刺600 M1《注入去重修复》单测 —— `visibleInjections()` 取事件面兼容性。
 *
 * 背景：主包 0.1.5-rc.2 的 `Session` 已删 `get events()`（只剩 `eventAt(seq)` / `snapshotEvents()`），
 * 老写法 `session.events[seq]` ⇒ `session.events` 恒 undefined ⇒ 该函数开头守卫直接 return {count:0}
 * ⇒ `maxPerSession` / `surface-same-payload` 两道去重永不触发（每回合都注入）。
 *
 * 覆盖（本卡验收判据 ②）：
 *   ① 新线：无 `session.events`、有 `eventAt` ⇒ 能数出注入过的 user 消息（count > 0 + lastText 正确）
 *   ② 老线回落：有 `session.events`、无 `eventAt` ⇒ 行为与改动前一致
 *   ③ 两者都不可用 ⇒ 安全返回 {count:0}（不抛错）
 *   ④ 回归断言：0.1.5-rc.2 形态下**不再恒 0**（本卡核心）
 *   ⑤ 真对照（可选，`M1_BEFORE_INJECTOR` 指向改动前快照）：改动前实现对同一老夹具逐字段一致、
 *      对 0.1.5 形态恒 0（复现缺陷）—— 拿不到快照即 skip，不计失败。
 *   ⑥ 主包真形态探针：直接 import `@deepseek-ai/dsh-session`，断言原型上有 `eventAt`、**没有** `events`
 *      getter（即缺陷成因的机器证据）；import 不到即 skip。
 *
 * 家规：一切路径来自 `fs.mkdtempSync(os.tmpdir())`，**不写生产 / 不写任何 DSH home**。
 * 跑法：node --test test/visible-injections.test.mjs
 *      （含真对照）M1_BEFORE_INJECTOR=<回滚点>\before\src\injector.mjs node --test test/visible-injections.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { visibleInjections, SOURCE_KIND } from '../src/injector.mjs';
import { EV } from '../src/host-adapter.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, '..');
const BEFORE_INJECTOR = process.env.M1_BEFORE_INJECTOR ?? null;

// ───────────────────────── 夹具（三种 session 形态） ─────────────────────────

/** 一条"本插件注入过"的 user 消息事件（形态与插件注入一致）。 */
function injectionEvent(text, ids = [], seq = 0) {
  return {
    seq,
    type: EV.USER_MESSAGE,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: SOURCE_KIND, version: 1, items: ids } },
  };
}

/** 一条"主人自己发"的 user 消息事件（无 source ⇒ 不该计入）。 */
function humanEvent(text, seq = 0) {
  return { seq, type: EV.USER_MESSAGE, data: { role: 'user', content: [{ type: 'text', text }] } };
}

/**
 * 老线形态（≤ 0.1.4）：`session.events` 是事件数组、**没有** `eventAt`。
 * 与既有夹具 `fixtures-s2b.mjs#fakeAgent` 同形（本文件不重复导出、也不改那份夹具）。
 */
function legacyAgent(events, nodes) {
  const list = events ?? [];
  return { id: 'legacy-session', session: { events: list, surface: { nodes: nodes ?? list.map((_, i) => i) } } };
}

/**
 * 新线形态（0.1.5-rc.2）：`eventAt(seq)` 是**原型方法**（照主包实现 `eventAt(seq) { return this.log[seq] }`），
 * 而 `session.events` **根本不存在**（类上不定义该 getter ⇒ `session.events === undefined`）。
 */
class ModernSession {
  constructor(log, nodes) {
    this._log = log ?? [];
    this.surface = { nodes: nodes ?? this._log.map((_, i) => i) };
  }
  get id() { return 'modern-session'; }
  get seq() { return this._log.length; }
  eventAt(seq) { return this._log[seq]; }
  snapshotEvents(fromSeq = 0, toSeqExclusive = this._log.length) { return this._log.slice(fromSeq, toSeqExclusive); }
}
function modernAgent(events, nodes) {
  return { id: 'modern-agent', session: new ModernSession(events, nodes) };
}

/** 只读探针：记录某 agent 上「哪些取事件面被真读过」。 */
function probeAgent(session) {
  return { id: 'probe-agent', session };
}

const THREE = [
  injectionEvent('旧指针 A', [1], 0),
  injectionEvent('旧指针 B', [2], 1),
  injectionEvent('旧指针 C', [3], 2),
];

const idsOf = (r) => [...r.ids].sort();

// ───────────────────────── ① 新线（0.1.5 形态） ─────────────────────────

test('新线/正例：无 session.events、有 eventAt ⇒ 数得出注入过的 user 消息', () => {
  const agent = modernAgent(THREE.map((e) => ({ ...e })));
  assert.equal(agent.session.events, undefined, '新线夹具必须没有 session.events（0.1.5 形态）');
  assert.equal(typeof agent.session.eventAt, 'function', '新线夹具必须有 eventAt(seq)');

  const r = visibleInjections(agent);
  assert.equal(r.count, 3, '三条可见注入应全部数出');
  assert.equal(r.lastText, '旧指针 C', 'lastText = 最后一条可见注入的正文');
  assert.deepEqual(idsOf(r), ['1', '2', '3'], 'ids 汇总所有可见注入的 items');
});

test('新线/反例：主人自己的消息（无 source）与其它 kind 不计入', () => {
  const log = [
    injectionEvent('旧指针 A', [1], 0),
    humanEvent('主人说话', 1),
    { seq: 2, type: EV.USER_MESSAGE, data: { role: 'user', content: [{ type: 'text', text: '别的插件' }], source: { kind: 'other-plugin', version: 1, items: [9] } } },
  ];
  const r = visibleInjections(modernAgent(log));
  assert.equal(r.count, 1);
  assert.equal(r.lastText, '旧指针 A');
  assert.deepEqual(idsOf(r), ['1'], '别的 kind 的 items 不得混入');
});

test('新线/反例：被压缩遮蔽（不在 surface.nodes 内）的注入不计入', () => {
  const log = THREE.map((e) => ({ ...e }));
  const r = visibleInjections(modernAgent(log, [2])); // 只有 seq=2 还在可见 surface
  assert.equal(r.count, 1, '遮蔽的注入不计入可见数（可见性口径）');
  assert.equal(r.lastText, '旧指针 C');
});

// ───────────────────────── ② 老线回落 ─────────────────────────

test('老线/正例：有 session.events、无 eventAt ⇒ 照 old 面取事件，行为不变', () => {
  const agent = legacyAgent(THREE.map((e) => ({ ...e })));
  assert.equal(typeof agent.session.eventAt, 'undefined', '老线夹具不得有 eventAt');
  const r = visibleInjections(agent);
  assert.equal(r.count, 3);
  assert.equal(r.lastText, '旧指针 C');
  assert.deepEqual(idsOf(r), ['1', '2', '3']);
});

test('老线/反例：老面为空数组 ⇒ 照旧走 events 分支（不因 eventAt 缺失早退）', () => {
  const r = visibleInjections(legacyAgent([]));
  assert.equal(r.count, 0);
  assert.equal(r.lastText, null);
  assert.deepEqual(idsOf(r), []);
});

// ───────────────────────── ③ 两面都不可用 ─────────────────────────

test('双缺/反例：既无 events 也无 eventAt ⇒ 安全返回 {count:0}（不抛错）', () => {
  const bare = { id: 'bare', session: { surface: { nodes: [0, 1, 2] } } };
  let r;
  assert.doesNotThrow(() => { r = visibleInjections(bare); });
  assert.equal(r.count, 0);
  assert.equal(r.lastText, null);
  assert.equal(r.ids.size, 0);
});

test('双缺/反例：session 缺失 / nodes 缺失 / agent 为 null ⇒ 一律 {count:0}，不抛错', () => {
  for (const bad of [null, undefined, {}, { session: null }, { session: {} }, { session: { surface: null } }, { session: { surface: { nodes: 'not-an-array' } } }]) {
    let r;
    assert.doesNotThrow(() => { r = visibleInjections(bad); }, `输入 ${JSON.stringify(bad)} 不得抛错`);
    assert.equal(r.count, 0);
    assert.equal(r.lastText, null);
    assert.equal(r.ids.size, 0);
  }
});

// ───────────────────────── ④ 回归断言（本卡核心） ─────────────────────────

test('回归/核心：0.1.5-rc.2 形态（events 缺失）下 visibleInjections 不再恒 0', () => {
  const agent = modernAgent(THREE.map((e) => ({ ...e })));
  const r = visibleInjections(agent);
  assert.ok(r.count > 0, `必须 > 0（改动前恒 0）；实际 ${r.count}`);
  assert.equal(r.count, 3);
  assert.notEqual(r.lastText, null, 'lastText 必须取到（surface-same-payload 去重依赖它）');
});

test('回归/核心：可由可见数触顶 maxPerSession=3 ⇒ 去重链真的能生效（decide 层联动）', async () => {
  // 直接断言「去重判据的输入」= 可见数 —— decide 层用它判 surface-visible-limit（见 injector.mjs:226-228）
  const seen = visibleInjections(modernAgent(THREE.map((e) => ({ ...e }))));
  assert.ok(seen.count >= 3, `maxPerSession=3 时该值应触顶；实际 ${seen.count}`);
});

// ───────────────────────── ⑤ 与改动前实现真对照 ─────────────────────────

test('对照/老线零回归 + 新线复现-修复（需 M1_BEFORE_INJECTOR）', { skip: BEFORE_INJECTOR ? false : '未提供 M1_BEFORE_INJECTOR（改动前快照路径）' }, async () => {
  assert.ok(fs.existsSync(BEFORE_INJECTOR), `快照不存在：${BEFORE_INJECTOR}`);
  // 把整份 src 拷到临时目录，再把改动前的 injector.mjs 覆盖回去 —— 让它照旧解析 ./recall.mjs 等同目录依赖
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-before-'));
  try {
    fs.cpSync(path.join(pkgRoot, 'src'), path.join(tmp, 'src'), { recursive: true });
    fs.copyFileSync(BEFORE_INJECTOR, path.join(tmp, 'src', 'injector.mjs'));
    const oldMod = await import(pathToFileURL(path.join(tmp, 'src', 'injector.mjs')).href);

    // (a) 老线：改动前 vs 改动后 —— 逐字段一致
    const legacy = legacyAgent(THREE.map((e) => ({ ...e })));
    const before = oldMod.visibleInjections(legacy);
    const after = visibleInjections(legacy);
    assert.deepEqual(
      { count: after.count, lastText: after.lastText, ids: idsOf(after) },
      { count: before.count, lastText: before.lastText, ids: idsOf(before) },
      '老线回落必须与改动前逐字段一致',
    );
    assert.equal(after.count, 3);

    // (b) 新线：改动前恒 0（复现缺陷）→ 改动后 3（修复）
    const modernBefore = oldMod.visibleInjections(modernAgent(THREE.map((e) => ({ ...e }))));
    const modernAfter = visibleInjections(modernAgent(THREE.map((e) => ({ ...e }))));
    assert.equal(modernBefore.count, 0, '改动前实现必须在 0.1.5 形态下恒 0（缺陷复现）');
    assert.equal(modernAfter.count, 3, '改动后必须数得出 3 条（缺陷修复）');
    console.log(`[对照] 老线 before=${before.count} after=${after.count}｜新线 before=${modernBefore.count} after=${modernAfter.count}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ───────────────────────── ⑥ 主包真形态探针 ─────────────────────────

test('主包探针：dsh-session 的 Session 原型有 eventAt、没有 events getter', { skip: process.env.M1_SKIP_MAINPKG_PROBE ? '显式跳过' : false }, async () => {
  const candidates = [
    process.env.M1_DSH_SESSION_ENTRY ?? null,
  ].filter(Boolean);
  const entry = candidates.find((p) => fs.existsSync(p));
  if (!entry) {
    console.log('[探针] 跳过：本机找不到 @deepseek-ai/dsh-session 入口（可用 M1_DSH_SESSION_ENTRY 指定）');
    return;
  }
  let mod;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (e) {
    console.log(`[探针] 跳过：import 失败（peer 依赖不在该位置可解析）—— ${String(e && e.message ? e.message : e).slice(0, 160)}`);
    return;
  }
  const Session = mod.Session ?? mod.default?.Session ?? mod.default;
  assert.ok(Session && typeof Session === 'function', '必须导出 Session 类');
  assert.equal(typeof Session.prototype.eventAt, 'function', 'Session 原型必须有 eventAt(seq)');
  const hasEventsGetter = Object.getOwnPropertyDescriptor(Session.prototype, 'events') !== undefined;
  assert.equal(hasEventsGetter, false, 'Session 原型不得再有 events getter（0.1.5-rc.2 已删）');
  // 顺带坐实 surface 仍是 { nodes } 形态的 getter
  const surfaceDesc = Object.getOwnPropertyDescriptor(Session.prototype, 'surface');
  assert.ok(surfaceDesc && typeof surfaceDesc.get === 'function', 'Session 原型必须有 get surface()');
  console.log(`[探针] ${entry}  ⇒ eventAt=function / events=getter? ${hasEventsGetter}`);
});
