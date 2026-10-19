/**
 * FORK-EDIT(2026-09-21): 记忆引擎 v2 · S2b 单测 —— 四类各正例 + 反例
 *   ① 注入（渲染/预算/编排）  ② 召回（触发/融合/排除 pinned）
 *   ③ 去重（surface 可见性 / 回合一次性）  ④ 降级（fail-open / 模块门 / 超时）
 *
 * 家规：**测试一律可注入路径参数、默认落临时目录，不得写生产路径**（见 fixtures-s2b.mjs）。
 * 跑法：node --test test/s2b.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderPointer, estimateTokens, summarize, pointerLine, POINTER_HEADER_TEXT, compactTags, sliceSafe } from '../src/pointer.mjs';
import { createRecallInjector, lastUserText, visibleInjections, withTimeout, SOURCE_KIND } from '../src/injector.mjs';
import { shouldTrigger, extractFtsTokens, buildFtsMatch, recall } from '../src/recall.mjs';
import { createModuleGate } from '../src/module-gate.mjs';
import { createRecallLogger } from '../src/recall-log.mjs';
import { makeTempEnv, memoryLogger, stubBridge, fakeAgent, injectionEvent } from './fixtures-s2b.mjs';

function recallCfg(env, over = {}) {
  return {
    enabled: true,
    home: env.home,
    memoryDb: env.memoryDb,
    vectorsDb: env.vectorsDb,
    logsDir: env.logsDir,
    bridgeHost: '127.0.0.1',
    bridgePort: 8201,
    bridgePortScanMax: 10,
    timeoutMs: 300,
    encodeTimeoutMs: 250,
    maxItems: 8,
    maxChars: 800,
    maxTokens: 600,
    maxPerSession: 3,
    summaryChars: 80,
    queryMaxChars: 512,
    vectorTopK: 20,
    ftsTopK: 20,
    rrfK: 60,
    resultTopK: 8,
    indexTtlMs: 60000,
    ...over,
  };
}

const SAMPLE = [
  { text: '三仓同步的实测结论：仓1 dsh-core 用 -Sync 后 -Push，跨机交接走 Gitee 私有三仓', tags: '跨机同步 gitee', updated_at: 1757462400000 },
  { text: 'task-board 看板卡的 run 前必须绑定 butler-bind-card，否则验收无从判断', tags: 'task-board 看板', updated_at: 1757548800000 },
  { text: '编码桥只绑 127.0.0.1，端口 8201 被占则顺延，绝不给它改绑非回环', tags: 'memory 桥', updated_at: 1757635200000 },
  { text: '守护进程日志在临时目录下，另有旧版日志文件（排障时以新版为准）', tags: '守护鱼 排障', updated_at: 1757721600000 },
  { text: 'pinned 沙盒铁律：不许把 node.exe 或工作区根加进安全软件信任区', tags: '安全 360', pinned: true, updated_at: 1757808000000 },
];

// ───────────────────────── ① 注入 ─────────────────────────

test('注入/正例：指针渲染满足 条数≤8 · ≤800字 · ≤600token · 每条摘要≤80字', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: 100 + i,
    text: `第 ${i} 条记忆：${'内容'.repeat(60)}`,
    tags: 'a b c',
    updated_at: 1757462400000 + i * 1000,
  }));
  const r = renderPointer(rows);
  assert.ok(r.items.length <= 8, `items=${r.items.length}`);
  assert.ok(r.chars <= 800, `chars=${r.chars}`);
  assert.ok(r.estTokens <= 600, `tokens=${r.estTokens}`);
  assert.ok(r.dropped >= 4, `dropped=${r.dropped}`);
  for (const line of r.lines) {
    const summary = summarize(line.slice(line.indexOf(') ') + 2));
    assert.ok(summary.length <= 80, `summary=${summary.length}`);
  }
  assert.equal(r.text.split('\n')[0], POINTER_HEADER_TEXT);
});

test('注入/反例：超长正文与标签被摘要截断，仍不越预算', () => {
  const rows = [
    { id: 1, text: `超长正文${'字'.repeat(3000)}`, tags: 'x'.repeat(500), updated_at: 1757462400000 },
    { id: 2, text: '短记忆', tags: 'ok', updated_at: 1757462400001 },
  ];
  const r = renderPointer(rows);
  assert.ok(r.chars <= 800, `chars=${r.chars}`);
  assert.ok(r.estTokens <= 600, `tokens=${r.estTokens}`);
  assert.equal(r.items.length, 2);
  for (const line of r.lines) {
    assert.ok(!line.includes('字'.repeat(120)), '正文不得整段进指针行（摘要 ≤80 字）');
    const summary = line.slice(line.indexOf(') ') + 2);
    assert.ok(summary.length <= 80, `summary=${summary.length}`);
  }
  // 条数触顶时仍然只出 8 条
  const many = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, text: '短句', tags: '', updated_at: 1757462400000 }));
  assert.equal(renderPointer(many).items.length, 8);
});

test('注入/回归 2026-10-12：emoji 边界截断不得留孤立代理项（lone surrogate ⇒ 上游 HTTP 400）', () => {
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  // 事故复现形态：第 79 个码元正好是 emoji 的高代理项（原实现 slice(0,79) 会切在它后面）
  const text = `${'A'.repeat(78)}🐋尾巴还有很长很长的一段正文`;
  const s = summarize(text, 80);
  assert.ok(!LONE.test(s), `summarize 留了孤立代理项：${JSON.stringify(s.slice(-8))}`);
  const tags = `${'x'.repeat(38)}📦tail 还有很长的标签串`;
  const t = compactTags(tags, 40);
  assert.ok(!LONE.test(t), `compactTags 留了孤立代理项：${JSON.stringify(t.slice(-8))}`);
  // sliceSafe 逐长度穷举：任何截断长度都不得留孤立代理项
  const mixed = 'a🐋b📦c🐜d';
  for (let n = 0; n <= mixed.length + 1; n++) {
    assert.ok(!LONE.test(sliceSafe(mixed, n)), `sliceSafe(${n}) 留了孤立代理项`);
  }
  // 输入本身就带孤儿代理时也要剥掉
  assert.ok(!LONE.test(summarize('坏\ud83d字符', 80)));
  assert.ok(!LONE.test(compactTags('坏\udc0b标签')));
  // 端到端：整行指针文本必须干净（这条坏文本一旦进会话历史就永久 400）
  const r = renderPointer([{ id: 9, text, tags, updated_at: 1757462400000 }]);
  assert.ok(!LONE.test(r.text), '指针文本整体含孤立代理项');
});

test('注入/正例：编排端到端（stub 桥 + 临时库）产出可注入指针', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const logger = memoryLogger();
  const inj = createRecallInjector({
    config: recallCfg(env),
    logger,
    moduleGate: createModuleGate({ home: env.home }),
    bridge: stubBridge(),
    deps: { recall: await import('../src/recall.mjs') },
  });
  const out = await inj.decideWithTimeout({
    query: 'task-board 看板卡怎么验收',
    agent: fakeAgent([]),
    turn: 1,
    step: 1,
    sessionId: 's-test',
  });
  assert.equal(out.action, 'inject', JSON.stringify(out.meta));
  assert.ok(out.text.startsWith(POINTER_HEADER_TEXT));
  assert.ok(out.meta.chars <= 800);
  assert.ok(out.meta.estTokens <= 600);
  assert.equal(logger.find('inject').length, 1);
  inj.close();
  env.cleanup();
});

test('注入/反例：recallEnabled=false ⇒ 不注入（plugin-disabled）', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const logger = memoryLogger();
  const inj = createRecallInjector({
    config: recallCfg(env, { enabled: false }),
    logger,
    moduleGate: createModuleGate({ home: env.home }),
    bridge: stubBridge(),
  });
  const out = await inj.decideWithTimeout({ query: '随便问点啥', agent: fakeAgent([]), turn: 1, step: 1 });
  assert.equal(out.action, 'skip');
  assert.equal(out.reason, 'plugin-disabled');
  inj.close();
  env.cleanup();
});

test('注入/反例：step≠1 ⇒ 不注入（not-step-1）', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const inj = createRecallInjector({
    config: recallCfg(env),
    logger: memoryLogger(),
    bridge: stubBridge(),
  });
  const out = await inj.decide({ query: '第几个 step 了', agent: fakeAgent([]), turn: 1, step: 2 });
  assert.equal(out.reason, 'not-step-1');
  inj.close();
  env.cleanup();
});

test('注入/正例：lastUserText 取本轮最后一条 user 文本（含多段 content）', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: '在的' }] },
    { role: 'user', content: [{ type: 'text', text: '第一句' }, { type: 'text', text: '重点在这句' }] },
  ];
  assert.equal(lastUserText(messages), '第一句\n重点在这句');
  assert.equal(lastUserText([]), '');
  assert.equal(lastUserText([{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }]), '');
});

// ───────────────────────── ② 召回 ─────────────────────────

test('召回/正例：短暗号非空即触发（「退下吧」必须触发）', () => {
  assert.deepEqual(shouldTrigger('退下吧'), { trigger: true, reason: 'non-empty' });
  assert.equal(shouldTrigger('整夜干活').trigger, true);
  assert.equal(shouldTrigger('a1').trigger, true);
});

test('召回/反例：空 / 纯符号 / 单字不触发', () => {
  assert.deepEqual(shouldTrigger('   '), { trigger: false, reason: 'empty' });
  assert.deepEqual(shouldTrigger('！！！'), { trigger: false, reason: 'symbols-only' });
  assert.deepEqual(shouldTrigger('鱼'), { trigger: false, reason: 'single-char' });
});

test('召回/正例：FTS 补位只取英文/数字 token，中文连续串不参与', () => {
  assert.deepEqual(extractFtsTokens('task-board 3080 怎么看'), ['task-board', '3080']);
  assert.equal(buildFtsMatch(['task-board']), '"task-board"');
  assert.equal(extractFtsTokens('中文连续串没有关键词').length, 0);
  assert.equal(buildFtsMatch([]), null);
});

test('召回/正例：向量路命中 + pinned 被排除（方案 §3.3）', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const { openVectorsReader } = await import('../src/vectors-read.mjs');
  const { openMemoryReader } = await import('../src/memory-read.mjs');
  const { buildVectorIndex } = await import('../src/recall.mjs');
  const store = openVectorsReader(env.vectorsDb);
  const source = openMemoryReader(env.memoryDb);
  const index = buildVectorIndex(store.db, { source: 'memory' });
  const embedder = stubBridge();
  const hit = await recall({
    query: '三仓同步的实测结论',
    store: { db: store.db },
    source,
    embedder,
    index,
    resultTopK: 8,
  });
  assert.equal(hit.triggered, true);
  assert.ok(hit.hits.length > 0, 'stub 向量应至少命中自身');
  assert.equal(hit.hits[0].id, 1, `top1=${JSON.stringify(hit.hits[0])}`);
  const pinnedId = SAMPLE.findIndex((m) => m.pinned) + 1;
  assert.ok(!hit.hits.some((h) => h.id === pinnedId), 'pinned 条不得出现在召回结果里');
  assert.equal(hit.stats.pinnedExcluded, 1);
  store.close();
  source.close();
  env.cleanup();
});

test('召回/反例：空查询不触发（不编码、不检索）', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const { openVectorsReader } = await import('../src/vectors-read.mjs');
  const { openMemoryReader } = await import('../src/memory-read.mjs');
  const store = openVectorsReader(env.vectorsDb);
  const source = openMemoryReader(env.memoryDb);
  const bridge = stubBridge();
  const r = await recall({ query: '   ', store: { db: store.db }, source, embedder: bridge });
  assert.equal(r.triggered, false);
  assert.equal(bridge.calls.encode, 0, '不触发时不得调用编码桥');
  store.close();
  source.close();
  env.cleanup();
});

// ───────────────────────── ③ 去重 ─────────────────────────

test('去重/正例：surface 可见注入数达上限 ⇒ 不再注入', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const events = [
    injectionEvent('旧指针 A', [1], 0),
    injectionEvent('旧指针 B', [2], 1),
    injectionEvent('旧指针 C', [3], 2),
  ];
  const inj = createRecallInjector({
    config: recallCfg(env, { maxPerSession: 3 }),
    logger: memoryLogger(),
    bridge: stubBridge(),
  });
  const out = await inj.decide({ query: 'task-board 看板', agent: fakeAgent(events), turn: 9, step: 1 });
  assert.equal(out.reason, 'surface-visible-limit');
  assert.equal(out.meta.visible, 3);
  inj.close();
  env.cleanup();
});

test('去重/正例：同一回合第二次调用 ⇒ turn-already-injected（V4 口径）', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const inj = createRecallInjector({ config: recallCfg(env), logger: memoryLogger(), bridge: stubBridge() });
  const agent = fakeAgent([]);
  const first = await inj.decide({ query: 'task-board 看板卡怎么验收', agent, turn: 7, step: 1 });
  assert.equal(first.action, 'inject');
  const second = await inj.decide({ query: 'task-board 看板卡怎么验收', agent, turn: 7, step: 1 });
  assert.equal(second.reason, 'turn-already-injected');
  inj.close();
  env.cleanup();
});

test('去重/反例：被压缩遮蔽的注入不计入可见数（可见性口径而非累计次数）', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const three = [
    injectionEvent('旧指针 A', [1], 0),
    injectionEvent('旧指针 B', [2], 1),
    injectionEvent('旧指针 C', [3], 2),
  ];
  // 对照 1：三条全部可见 ⇒ 触顶不注入
  const visibleAll = fakeAgent(three.map((e) => ({ ...e })));
  assert.equal(visibleInjections(visibleAll).count, 3);
  const inj = createRecallInjector({
    config: recallCfg(env, { maxPerSession: 3 }),
    logger: memoryLogger(),
    bridge: stubBridge(),
  });
  const blocked = await inj.decide({ query: 'task-board 看板卡怎么验收', agent: visibleAll, turn: 3, step: 1 });
  assert.equal(blocked.reason, 'surface-visible-limit');

  // 对照 2：同样三条事件，但两条已被压缩遮蔽（不在 surface.nodes）⇒ 可见数 1 < 3 ⇒ 允许注入
  const shadowed = fakeAgent(three.map((e) => ({ ...e })));
  shadowed.session.surface.nodes = [2]; // 只有 seq=2 那条还在可见 surface 内
  assert.equal(visibleInjections(shadowed).count, 1, '遮蔽的注入不计入可见数');
  const out = await inj.decide({ query: 'task-board 看板卡怎么验收', agent: shadowed, turn: 4, step: 1 });
  assert.equal(out.action, 'inject', JSON.stringify(out.meta));
  assert.equal(out.meta.visibleBefore, 1);
  inj.close();
  env.cleanup();
});

test('去重/反例：完全相同的指针 payload 仍可见 ⇒ skip(surface-same-payload)', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const inj = createRecallInjector({ config: recallCfg(env), logger: memoryLogger(), bridge: stubBridge() });
  const first = await inj.decide({ query: 'task-board 看板卡怎么验收', agent: fakeAgent([]), turn: 1, step: 1 });
  assert.equal(first.action, 'inject');
  // 把这次注入原样放进可见 surface，再问同样的问题（新回合）
  const agent = fakeAgent([injectionEvent(first.text, first.meta.ids, 0)]);
  const second = await inj.decide({ query: 'task-board 看板卡怎么验收', agent, turn: 2, step: 1 });
  assert.equal(second.reason, 'surface-same-payload');
  inj.close();
  env.cleanup();
});

// ───────────────────────── ④ 降级（fail-open） ─────────────────────────

test('降级/正例：桥不在 ⇒ skip(bridge-unavailable)，不抛错', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const logger = memoryLogger();
  const inj = createRecallInjector({
    config: recallCfg(env),
    logger,
    moduleGate: createModuleGate({ home: env.home }),
    bridge: stubBridge({ ready: false }),
  });
  const out = await inj.decideWithTimeout({ query: 'task-board 看板', agent: fakeAgent([]), turn: 1, step: 1 });
  assert.equal(out.action, 'skip');
  assert.equal(out.reason, 'bridge-unavailable');
  assert.equal(logger.find('skip').length, 1);
  inj.close();
  env.cleanup();
});

test('降级/正例：桥慢于硬预算 ⇒ skip(timeout) 且在预算附近返回（不排队）', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const inj = createRecallInjector({
    config: recallCfg(env, { timeoutMs: 60, encodeTimeoutMs: 50 }),
    logger: memoryLogger(),
    bridge: stubBridge({ delayMs: 400 }),
  });
  const t0 = Date.now();
  const out = await inj.decideWithTimeout({ query: 'task-board 看板', agent: fakeAgent([]), turn: 1, step: 1 });
  const elapsed = Date.now() - t0;
  assert.equal(out.reason, 'timeout');
  assert.ok(elapsed < 350, `elapsed=${elapsed}ms 应接近预算而非等桥返回`);
  inj.close();
  env.cleanup();
});

test('降级/反例：召回内部抛异常 ⇒ skip(exception) 且不冒泡', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const logger = memoryLogger();
  const inj = createRecallInjector({
    config: recallCfg(env),
    logger,
    bridge: stubBridge(),
    deps: {
      recall: {
        shouldTrigger: () => ({ trigger: true, reason: 'non-empty' }),
        buildVectorIndex: () => ({}),
        recall: async () => {
          throw new Error('boom-from-recall');
        },
      },
    },
  });
  const out = await inj.decideWithTimeout({ query: '会炸的查询', agent: fakeAgent([]), turn: 1, step: 1 });
  assert.equal(out.action, 'skip');
  assert.equal(out.reason, 'exception');
  assert.ok(String(out.meta.error).includes('boom-from-recall'));
  assert.ok(logger.find('skip').some((l) => String(l.error).includes('boom')));
  inj.close();
  env.cleanup();
});

test('降级/正例：L2 模块位关闭 ⇒ 自我 drain；文件缺失 ⇒ fail-safe 判关', async () => {
  const env = makeTempEnv({ memories: SAMPLE, moduleEnabled: false });
  const inj = createRecallInjector({
    config: recallCfg(env),
    logger: memoryLogger(),
    moduleGate: createModuleGate({ home: env.home }),
    bridge: stubBridge(),
  });
  const out = await inj.decide({ query: 'task-board 看板', agent: fakeAgent([]), turn: 1, step: 1 });
  assert.equal(out.reason, 'module-drain:module-disabled');

  const env2 = makeTempEnv({ memories: SAMPLE, writeAutonomy: false });
  const inj2 = createRecallInjector({
    config: recallCfg(env2),
    logger: memoryLogger(),
    moduleGate: createModuleGate({ home: env2.home }),
    bridge: stubBridge(),
  });
  const out2 = await inj2.decide({ query: 'task-board 看板', agent: fakeAgent([]), turn: 1, step: 1 });
  assert.equal(out2.reason, 'module-drain:config-missing');
  inj.close();
  inj2.close();
  env.cleanup();
  env2.cleanup();
});

test('降级/正例：向量库不存在 ⇒ skip(datastore-unavailable)', async () => {
  const env = makeTempEnv({ memories: SAMPLE, makeVectors: false });
  const inj = createRecallInjector({
    config: recallCfg(env),
    logger: memoryLogger(),
    bridge: stubBridge(),
  });
  const out = await inj.decide({ query: 'task-board 看板', agent: fakeAgent([]), turn: 1, step: 1 });
  assert.equal(out.reason, 'datastore-unavailable');
  assert.ok(String(out.meta.error).includes('向量库不存在'));
  inj.close();
  env.cleanup();
});

test('降级/正例：日志写失败不得影响注入（fail-open 铁律）', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  // 把 logsDir 指到一个「文件」路径下 ⇒ mkdir/append 必失败
  const blocker = path.join(env.root, 'not-a-dir');
  fs.writeFileSync(blocker, 'x', 'utf8');
  const logger = createRecallLogger({ dir: path.join(blocker, 'logs') });
  const inj = createRecallInjector({
    config: recallCfg(env, { logsDir: path.join(blocker, 'logs') }),
    logger,
    bridge: stubBridge(),
  });
  const out = await inj.decideWithTimeout({ query: 'task-board 看板卡怎么验收', agent: fakeAgent([]), turn: 1, step: 1 });
  assert.equal(out.action, 'inject', '日志写不了也必须完成注入');
  assert.ok(logger.stats().errors > 0, '日志应记录了写失败');
  inj.close();
  env.cleanup();
});

test('降级/正例：withTimeout 把未决 promise 转成 timedOut（不改原 promise 语义）', async () => {
  const r = await withTimeout(new Promise((res) => setTimeout(() => res('late'), 200)), 30);
  assert.equal(r.timedOut, true);
  const ok = await withTimeout(Promise.resolve('now'), 200);
  assert.equal(ok, 'now');
  const err = await withTimeout(Promise.reject(new Error('nope')), 200);
  assert.ok(String(err.error).includes('nope'));
});

test('降级/正例：展开留痕可统计（memory_get 的 expand 行）', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const logger = memoryLogger();
  const inj = createRecallInjector({ config: recallCfg(env), logger, bridge: stubBridge() });
  inj.logExpand({ id: 1, chars: 120, truncated: false, sessionId: 's1' });
  inj.logExpand({ id: 2, chars: 2400, truncated: true, sessionId: 's1' });
  const expands = logger.find('expand');
  assert.equal(expands.length, 2);
  assert.equal(expands[1].truncated, true);
  const record = inj.getById(1);
  assert.equal(record.id, 1);
  assert.ok(record.text.includes('三仓同步'));
  inj.close();
  env.cleanup();
});

test('降级/正例：estimateTokens 口径（CJK 1.5 字/token，非 CJK 3.6 字/token）', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('中文九个字啊啊啊'), Math.ceil(9 / 1.5)); // 全 CJK
  assert.equal(estimateTokens('abcdefgh'), Math.ceil(8 / 3.6));
  // 800 字中文 ≤ 600 token（判据：本包裁剪同时约束两者）
  assert.ok(estimateTokens('字'.repeat(800)) <= 600);
});

test('降级/正例：硬超时后迟到完成的内层链不补写日志（一次超时 = 一行）', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const logger = memoryLogger();
  const inj = createRecallInjector({
    config: recallCfg(env, { timeoutMs: 60, encodeTimeoutMs: 50 }),
    logger,
    bridge: stubBridge({ delayMs: 300 }),
  });
  const out = await inj.decideWithTimeout({ query: 'task-board 看板卡怎么验收', agent: fakeAgent([]), turn: 1, step: 1 });
  assert.equal(out.reason, 'timeout');
  await new Promise((r) => setTimeout(r, 900)); // 等被放弃的内层链跑到终点
  const skips = logger.lines.filter((l) => l.event === 'skip');
  assert.equal(skips.filter((l) => l.reason === 'timeout').length, 1, JSON.stringify(skips.map((s) => s.reason)));
  assert.equal(skips.filter((l) => l.reason === 'exception').length, 0, '迟到链不得再写 exception 行');
  assert.equal(logger.lines.filter((l) => l.event === 'inject').length, 0, '迟到链不得写 inject 行');
  inj.close();
  env.cleanup();
});

test('降级/反例：事件循环被长同步段阻塞致定时器迟到 ⇒ 仍判超时、不注入', async () => {
  // 复现 2026-09-21 真机踩到的那次 524ms：setTimeout 回调被同步段推迟，
  // 若只看 timedOut 标志会把超预算的决策当成功 ⇒ 必须有「返回时 elapsed 复核」。
  const env = makeTempEnv({ memories: SAMPLE });
  const logger = memoryLogger();
  const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } };
  const inj = createRecallInjector({
    config: recallCfg(env, { timeoutMs: 50 }),
    logger,
    bridge: stubBridge(),
    deps: {
      recall: {
        shouldTrigger: () => ({ trigger: true, reason: 'non-empty' }),
        buildVectorIndex: () => ({ count: 1 }),
        recall: async () => {
          busy(150); // 同步阻塞 > 预算
          return { triggered: true, reason: 'non-empty', hits: [{ id: 1, sources: ['vector'] }], timings: {}, stats: { indexSize: 1 } };
        },
      },
    },
  });
  const out = await inj.decideWithTimeout({ query: '会阻塞的查询', agent: fakeAgent([]), turn: 1, step: 1 });
  assert.equal(out.reason, 'timeout');
  assert.equal(out.meta.lateTimer, true, '应标出「定时器迟到」而不是静默成功');
  assert.equal(logger.lines.filter((l) => l.event === 'inject').length, 0, '超预算不得注入');
  inj.close();
  env.cleanup();
});

test('降级/正例：warmup 预热向量矩阵与桥（禁用时不动任何资源）', async () => {
  const env = makeTempEnv({ memories: SAMPLE });
  const inj = createRecallInjector({ config: recallCfg(env), logger: memoryLogger(), bridge: stubBridge() });
  const w = await inj.warmup();
  assert.equal(w.ok, true, JSON.stringify(w));
  assert.ok(w.count > 0, `count=${w.count}`);
  assert.equal(inj.status().cache.index, SAMPLE.length);

  const off = createRecallInjector({ config: recallCfg(env, { enabled: false }), logger: memoryLogger() });
  const w2 = await off.warmup();
  assert.equal(w2.ok, false);
  assert.equal(w2.reason, 'disabled');
  inj.close();
  off.close();
  env.cleanup();
});

test('注入/正例：日志轮转（3 份 × 保留 30 天）与写失败容错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g24-s2b-log-'));
  const logger = createRecallLogger({ dir, maxBytes: 200, keepFiles: 3, keepDays: 30 });
  for (let i = 0; i < 40; i += 1) logger.log({ event: 'x', i, pad: 'p'.repeat(60) });
  logger.sweep();
  const files = fs.readdirSync(dir);
  const rotated = files.filter((f) => /^memory-recall\.\d{8}-\d{6}\.log$/.test(f));
  assert.ok(logger.stats().rotations >= 1, `rotations=${logger.stats().rotations}`);
  assert.ok(rotated.length >= 1 && rotated.length <= 3, `轮转文件数 ${rotated.length} 应在 1..keepFiles(3)`);
  assert.ok(files.includes('memory-recall.log'), '主文件应重建');
  // 30 天前的轮转文件被清掉
  const old = path.join(dir, 'memory-recall.20200101-000000.log');
  fs.writeFileSync(old, 'x', 'utf8');
  const past = (Date.now() - 40 * 86400000) / 1000;
  fs.utimesSync(old, past, past);
  logger.sweep();
  assert.equal(fs.existsSync(old), false, '超过 30 天的轮转文件应被清理');
  // 写失败（目录不可写）不影响调用方
  const blocked = createRecallLogger({ dir: path.join(dir, 'memory-recall.log', 'nope') });
  assert.equal(blocked.log({ event: 'y' }), false);
  assert.ok(blocked.stats().errors >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('注入/正例：SOURCE_KIND 形态固定为 memory-recall（不复用 form）', () => {
  assert.equal(SOURCE_KIND, 'memory-recall');
  const line = pointerLine({ id: 452, text: '三仓同步的实测结论与修复', tags: '跨机同步 gitee', updated_at: 1757462400000 });
  assert.match(line, /^- #452 \(\d{4}-\d{2}-\d{2} · tags: .+\) /);
});
