// 记忆引擎 v2 · S3b —— 域标签补齐单测（零依赖；夹具在系统临时区，不碰任何真实库）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, section, assert, assertEq } from './harness.mjs';
import * as D from '../lib/domain-tags.mjs';

export const __section = 'S3b · 域标签补齐（幂等 / 判重 / 成本闸 / 续跑 / 不碰 updated_at）';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's3b-domaintags-'));

/** 造一个 8 列的临时库（含 owner_user/visibility），rows = [{id,text,tags,pinned,owner,visibility}] */
function makeDb(name, rows, { withOwner = true } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  const p = path.join(dir, 'memory', 'memory.db');
  const db = new DatabaseSync(p);
  db.exec(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ${withOwner ? ", owner_user TEXT NOT NULL DEFAULT 'LiJianXiao', visibility TEXT NOT NULL DEFAULT 'private_owner'" : ''}
  )`);
  const sql = withOwner
    ? 'INSERT INTO memories (id, text, tags, pinned, created_at, updated_at, owner_user, visibility) VALUES (?,?,?,?,?,?,?,?)'
    : 'INSERT INTO memories (id, text, tags, pinned, created_at, updated_at) VALUES (?,?,?,?,?,?)';
  const ins = db.prepare(sql);
  for (const r of rows) {
    const base = [r.id, r.text, r.tags ?? '', r.pinned ?? 0, r.created_at ?? 1700000000000, r.updated_at ?? 1700000000000];
    if (withOwner) ins.run(...base, r.owner ?? 'LiJianXiao', r.visibility ?? 'private_owner');
    else ins.run(...base);
  }
  db.close();
  return { dir, dbPath: p, home: dir };
}

// ── 01 追加标签：幂等 + 判重 ────────────────────────────────────────────────
section('01 追加域标签（幂等 + token 级判重）');
test('appendDomainTags：追加不覆盖原标签', () => {
  const r = D.appendDomainTags('project dsh tools', ['技术', 'DSH生态']);
  assertEq(r.tags, 'project dsh tools 技术 dsh生态', '追加到尾部且保持原 token 顺序');
  assertEq(r.added, ['技术', 'dsh生态'], 'added 记录实际新增');
});
test('appendDomainTags：同输入跑两次 ⇒ 第二次零新增（写前逐标签判重）', () => {
  const once = D.appendDomainTags('项目 工作rog', ['工作']);
  const twice = D.appendDomainTags(once.tags, ['工作']);
  assertEq(once.tags, '项目 工作rog 工作', '第一次追加');
  assertEq(twice.added, [], '第二次零新增');
  assertEq(twice.tags, once.tags, '第二次不改内容');
  const tokens = D.tokensOf(twice.tags);
  assertEq(tokens.length, new Set(tokens).size, '无重复 token');
});
test('appendDomainTags：**token 级**判重（`工作rog` ≠ `工作`）', () => {
  const r = D.appendDomainTags('工作rog', ['工作']);
  assertEq(r.added, ['工作'], '`工作rog` 不算已含 `工作`');
  assert(r.tags.split(/\s+/).includes('工作'), '新 token 独立存在');
});
test('appendDomainTags：集合外的标签被丢弃（模型自创词不落库）', () => {
  const r = D.appendDomainTags('', ['技术', '编程', '学习']);
  assertEq(r.wanted, ['技术'], '只认固定集合');
  assertEq(r.tags, '技术', '自创词不写库');
});
test('appendDomainTags：标签集为空 ⇒ 一个字都不动', () => {
  const r = D.appendDomainTags('a b', []);
  assertEq(r.tags, 'a b', 'tags 原样');
  assertEq(r.added, [], '零新增');
});
test('domainTokensIn：只认域标签 token', () => {
  assertEq(D.domainTokensIn('技术 dsh生态 工作rog'), ['技术', 'dsh生态'], 'token 级识别');
  assertEq(D.domainTokensIn(''), [], '空 tags');
});
test('tagSetHash：与顺序无关、与重复无关、不同集不同哈希', () => {
  assertEq(D.tagSetHash(['工作', '技术']), D.tagSetHash(['技术', '工作', '技术']), '顺序/重复不敏感');
  assert(D.tagSetHash(['工作']) !== D.tagSetHash(['技术']), '不同集合不同哈希');
});

// ── 02 库层：写回 + 幂等 + 不动 updated_at ──────────────────────────────────
section('02 库层写回（幂等 / 事务 / 不动 updated_at）');
test('applyResults：写回并追加（事务内）', async () => {
  const { dbPath } = makeDb('apply1', [{ id: 1, text: 'a', tags: 'x' }, { id: 2, text: 'b', tags: '' }]);
  const db = D.openDb(dbPath, { write: true });
  const r = await D.applyResults(db, [{ id: 1, domains: ['技术'] }, { id: 2, domains: ['家庭', '工作'] }]);
  const rows = db.prepare('SELECT id, tags FROM memories ORDER BY id').all();
  db.close();
  assert(r.ok, '写回成功');
  assertEq(r.written, 2, '写 2 条');
  assertEq(rows[0].tags, 'x 技术', '第 1 条追加');
  assertEq(rows[1].tags, '家庭 工作', '第 2 条写入');
});
test('applyResults：同一批跑两次 ⇒ 第二次零写入、无重复 token（§3.6 验收）', async () => {
  const { dbPath } = makeDb('apply2', [{ id: 1, text: 'a', tags: 'project' }]);
  const results = [{ id: 1, domains: ['技术', 'DSH生态'] }];
  const db = D.openDb(dbPath, { write: true });
  const first = await D.applyResults(db, results);
  const before = db.prepare('SELECT tags FROM memories WHERE id=1').get().tags;
  const second = await D.applyResults(db, results);
  const after = db.prepare('SELECT tags FROM memories WHERE id=1').get().tags;
  db.close();
  assertEq(first.written, 1, '第一次写 1 条');
  assertEq(second.written, 0, '第二次零写入');
  assertEq(second.unchanged, 1, '第二次判为 already');
  assertEq(after, before, 'tags 逐字不变');
  const tokens = D.tokensOf(after);
  assertEq(tokens.length, new Set(tokens).size, '没有重复 token');
});
test('applyResults：**不动 updated_at**（防顶进 recall 段 / 误入提炼窗口）', async () => {
  const { dbPath } = makeDb('apply3', [{ id: 1, text: 'a', tags: '', updated_at: 1234567 }]);
  const db = D.openDb(dbPath, { write: true });
  await D.applyResults(db, [{ id: 1, domains: ['技术'] }]);
  const row = db.prepare('SELECT tags, updated_at, created_at FROM memories WHERE id=1').get();
  db.close();
  assertEq(row.updated_at, 1234567, 'updated_at 未被改动');
  assertEq(row.created_at, 1700000000000, 'created_at 未被改动');
  assertEq(row.tags, '技术', '只改了 tags');
});
test('applyResults：模型给不存在的 id ⇒ 记为 missing，不误写', async () => {
  const { dbPath } = makeDb('apply4', [{ id: 1, text: 'a', tags: '' }]);
  const db = D.openDb(dbPath, { write: true });
  const r = await D.applyResults(db, [{ id: 999, domains: ['技术'] }]);
  db.close();
  assertEq(r.written, 0, '零写入');
  assertEq(r.details[0].action, 'missing', '如实记 missing');
});

// ── 03 取样与 owner 过滤 ────────────────────────────────────────────────────
section('03 取样（owner 列有无都支持）');
test('readCandidates：8 列库带上 owner；6 列库标记 ownerColumn=false', () => {
  const a = makeDb('cand-a', [{ id: 1, text: 'x'.repeat(400), tags: '技术', owner: 'Wife_1' }]);
  const ra = D.readCandidates(a.dbPath, { maxCharsPerItem: 100 });
  assertEq(ra.ownerColumn, true, '检测到 owner_user 列');
  assertEq(ra.items[0].ownerUser, 'Wife_1', '读出 owner');
  assertEq(ra.items[0].textForModel.length, 100, '正文按 maxCharsPerItem 截断');
  assertEq(ra.items[0].textTruncated, true, '标记被截断');
  assertEq(ra.items[0].existingDomains, ['技术'], '识别已有域标签');
  const b = makeDb('cand-b', [{ id: 1, text: 'y', tags: '' }], { withOwner: false });
  const rb = D.readCandidates(b.dbPath);
  assertEq(rb.ownerColumn, false, '6 列库如实标记');
  assertEq(rb.items[0].ownerUser, null, '无 owner 列 ⇒ null（由调用方按本机 owner 处理）');
});

// ── 04 成本闸 ───────────────────────────────────────────────────────────────
section('04 成本闸（≤20 次/日、≤150K token/日，超限即停）');
test('costGate：次数用尽 ⇒ 拒绝', () => {
  const st = D.defaultState('x', '2026-09-21T00:00:00Z');
  st.cost.calls = 20;
  const g = D.costGate(st, 1000);
  assertEq(g.ok, false, '拒绝');
  assert(/上限 20 次/.test(g.reason), '原因点名次数上限');
});
test('costGate：token 用尽 ⇒ 拒绝', () => {
  const st = D.defaultState('x', '2026-09-21T00:00:00Z');
  st.cost.promptTokens = 140000;
  st.cost.completionTokens = 9000;
  const g = D.costGate(st, 2000);
  assertEq(g.ok, false, '拒绝');
  assert(/上限|超过/.test(g.reason), `原因值得：${g.reason}`);
});
test('costGate：余量够 ⇒ 放行', () => {
  const st = D.defaultState('x', '2026-09-21T00:00:00Z');
  st.cost.calls = 19;
  st.cost.promptTokens = 1000;
  assertEq(D.costGate(st, 5000).ok, true, '放行');
});
test('readState：跨日 ⇒ 当日成本归零（每日口径）', () => {
  const f = path.join(TMP, 'state-crossday.json');
  fs.writeFileSync(f, JSON.stringify({ ...D.defaultState('x', '2026-09-20T00:00:00Z'), cost: { date: '2026-09-20', calls: 20, promptTokens: 99999, completionTokens: 1 } }), 'utf8');
  const st = D.readState(f, 'x', '2026-09-21T10:00:00.000Z');
  assertEq(st.cost.date, '2026-09-21', '日期切到当天');
  assertEq(st.cost.calls, 0, '调用数归零');
  assertEq(st.cost.promptTokens, 0, 'prompt token 归零');
});
test('readState/writeState：落盘可读、坏文件回落默认', () => {
  const f = path.join(TMP, 'state-rw.json');
  const st = D.defaultState('x', '2026-09-21T00:00:00Z');
  st.processed['7'] = D.tagSetHash(['技术']);
  D.writeState(f, st);
  const back = D.readState(f, 'x', '2026-09-21T01:00:00Z');
  assertEq(back.processed['7'], D.tagSetHash(['技术']), '台账往返一致');
  fs.writeFileSync(f, '{ 坏 json', 'utf8');
  assertEq(D.readState(f, 'x', '2026-09-21T01:00:00Z').processed, {}, '坏文件回落默认（不抛）');
});

// ── 05 并发保护 ─────────────────────────────────────────────────────────────
section('05 并发保护（busy_timeout + 重试 3 次 / 退避上限 60s）');
test('withBusyRetry：busy 两次后成功 ⇒ attempts=3', async () => {
  let n = 0;
  const db = { exec: (sql) => { if (sql === 'BEGIN IMMEDIATE') { n += 1; if (n < 3) { const e = new Error('database is locked'); throw e; } } } };
  const r = await D.withBusyRetry(db, () => 'done', { sleep: async () => {} });
  assert(r.ok, '最终成功');
  assertEq(r.attempts, 3, '重试到第 3 次');
  assertEq(r.value, 'done', '返回值透传');
});
test('withBusyRetry：持续 busy ⇒ 停止重试并给原因（不无限等）', async () => {
  const db = { exec: () => { throw new Error('database is locked'); } };
  const r = await D.withBusyRetry(db, () => 'x', { sleep: async () => {} });
  assertEq(r.ok, false, '失败');
  assertEq(r.attempts, 3, '最多 3 次');
  assert(/locked/.test(r.error), '错误里带原始信息');
});
test('withBusyRetry：非 busy 错误 ⇒ 立即抛（不重试）', async () => {
  let calls = 0;
  const db = { exec: (sql) => { if (sql === 'BEGIN IMMEDIATE') { calls += 1; throw new Error('no such table: memories'); } } };
  const r = await D.withBusyRetry(db, () => 'x', { sleep: async () => {} });
  assertEq(r.ok, false, '失败');
  assertEq(calls, 1, '只试了 1 次');
});
test('withBusyRetry：退避将超 60s 上限 ⇒ 不等待，直接停', async () => {
  const slept = [];
  const db = { exec: (sql) => { if (sql === 'BEGIN IMMEDIATE') throw new Error('database is locked'); } };
  const r = await D.withBusyRetry(db, () => 'x', { sleep: async (ms) => { slept.push(ms); } });
  assertEq(r.ok, false, '失败');
  assert(slept.length <= 3, `退避次数受控（实测 ${slept.length}）`);
  assert(slept.reduce((a, b) => a + b, 0) <= D.RETRY.totalCapMs, '累计退避不超上限');
});

// ── 06 模型输出解析 ─────────────────────────────────────────────────────────
section('06 模型输出解析（容忍围栏/废话/坏 JSON）');
test('extractJson：裸 JSON / 代码围栏 / 前后废话都能抠出来', () => {
  const want = { items: [{ id: 1, domains: ['技术'] }] };
  assertEq(D.extractJson(JSON.stringify(want)), want, '裸 JSON');
  assertEq(D.extractJson(`\`\`\`json\n${JSON.stringify(want)}\n\`\`\``), want, '代码围栏');
  assertEq(D.extractJson(`好的，结果如下：\n${JSON.stringify(want)}\n以上。`), want, '前后废话');
  assertEq(D.extractJson('不是 JSON'), null, '无 JSON ⇒ null');
  assertEq(D.extractJson('{ 坏'), null, '坏 JSON ⇒ null');
});
test('callClassifier：注入 fetch ⇒ 只从固定集合认标签、模型漏答不误写', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ items: [{ id: 1, domains: ['技术', '自创词'] }, { id: 999, domains: ['工作'] }] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }),
  });
  const items = [{ id: 1, textForModel: 'a' }, { id: 2, textForModel: 'b' }];
  const r = await D.callClassifier({ items, apiKey: 'k', fetchImpl });
  assert(r.ok, '调用成功');
  assertEq(r.items.length, 2, '返回 2 条（含越界 id）');
  assertEq(r.usage.prompt_tokens, 100, 'usage 透传');
});
test('呼叫体：thinking disabled + 无 developer role（DeepSeek 口径）', async () => {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }], usage: {} }) };
  };
  await D.callClassifier({ items: [{ id: 1, textForModel: 'a' }], apiKey: 'k', fetchImpl });
  assertEq(body.thinking, { type: 'disabled' }, 'thinking disabled');
  assertEq(body.messages.map((m) => m.role), ['system', 'user'], '只用 system/user（不用 developer）');
  assertEq(body.stream, false, '非流式');
  assertEq(body.model, D.DEFAULT_LLM.model, '模型默认档');
});

// ── 07 快照 ─────────────────────────────────────────────────────────────────
section('07 快照（VACUUM INTO）');
test('vacuumInto：快照可读且条数一致', () => {
  const { dbPath } = makeDb('snap', [{ id: 1, text: 'a' }, { id: 2, text: 'b' }]);
  const dest = path.join(TMP, 'snap', 'memory.db');
  const file = D.vacuumInto(dbPath, dest);
  const db = new DatabaseSync(file, { readOnly: true });
  const n = db.prepare('SELECT COUNT(*) n FROM memories').get().n;
  const cols = db.prepare('PRAGMA table_info(memories)').all().map((r) => r.cols ?? r.name);
  db.close();
  assertEq(n, 2, '条数一致');
  assertEq(cols.length, 8, '列数一致（含两列）');
});

// ── 08 日报行 ───────────────────────────────────────────────────────────────
section('08 日报一行（幂等段替换）');
test('updateDailySection：首次追加段、再次替换同一段（不重复堆叠）', () => {
  const f = path.join(TMP, 'daily.md');
  fs.writeFileSync(f, '# 日报\n\n## 别的段\n> 内容\n', 'utf8');
  D.updateDailySection({ file: f, line: 'A 行' });
  const t1 = fs.readFileSync(f, 'utf8');
  assert(t1.includes(D.DAILY_SECTION_TITLE) && t1.includes('A 行'), '段已追加');
  D.updateDailySection({ file: f, line: 'B 行' });
  const t2 = fs.readFileSync(f, 'utf8');
  assertEq(t2.split(D.DAILY_SECTION_TITLE).length - 1, 1, '段只有一个（替换而非堆叠）');
  assert(t2.includes('B 行') && !t2.includes('A 行'), '内容被替换');
  assert(t2.includes('## 别的段'), '别的段未被破坏');
});
test('updateDailySection：日报不存在 ⇒ 不新建（同 doc-index 口径）', () => {
  const f = path.join(TMP, 'no-such-daily.md');
  const r = D.updateDailySection({ file: f, line: 'x' });
  assertEq(r.ok, false, '如实报不 ok');
  assertEq(fs.existsSync(f), false, '没有新建文件');
});
test('renderDailyLine：含成本与停机原因', () => {
  const line = D.renderDailyLine({
    mode: 'apply',
    stats: { batches: 3, tagged: 60, noTag: 5, skippedOwner: 2 },
    cost: { calls: 3, promptTokens: 1000, completionTokens: 200 },
    state: { processedCount: 67 },
    stoppedReason: '当日调用数已达上限 20 次',
  });
  for (const kw of ['批次 3', '新增标签条数 60', '当日调用 3/20', '当日 token 1200/150000', '停机原因']) {
    assert(line.includes(kw), `日报行含「${kw}」：${line}`);
  }
});
