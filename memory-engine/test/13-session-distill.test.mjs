// 会话日志 → 记忆（K6）单测 —— 零依赖、不联网、夹具一律落系统临时区。
//
// 覆盖卡面要的几条：没配预算 ⇒ 零调用零写盘（阴性）· 给预算 ⇒ ≤5 条且带来源锚（阳性）·
// 超额预算 ⇒ 不跑 · `.zstd` 输入给明确提示 · `--apply` 前有快照 · 撤回整批走既有回滚器。
// 既有 12 个测试文件一行未改；本文件是新增的第 13 个。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test, section, assert, assertEq } from './harness.mjs';
import * as S from '../lib/session-source.mjs';
import * as D from '../lib/session-distill.mjs';
import * as R from '../lib/distill-rollback.mjs';

export const __section = 'K6 · 会话日志 → 记忆（抽句回指 / 预算闸 / 快照 / 整批撤回）';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'k6-session-distill-'));
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'cli', 'distill-sessions.mjs');
const NOW = Date.parse('2026-10-30T23:30:00+08:00');
let seq = 0;
const nextDir = (label) => {
  seq += 1;
  const dir = path.join(TMP, `${String(seq).padStart(2, '0')}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const ev = (o) => JSON.stringify(o);

/** 造一份"3 类结论 + 一堆噪音"的日志（每用例独立文件，避免互相污染）。 */
function writeSession(dir, lines) {
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

const baseEvents = (sessionId) => [
  ev({ type: 'session', version: 4, id: sessionId, createdAt: NOW - 60000 }),
  ev({ type: 'message', role: 'user', content: '你好呀，今天在吗？' }),
  ev({ type: 'message', role: 'user', content: '这条口径要不要再确认一下，是不是得先跟主人对一遍？' }),
  ev({ type: 'message', role: 'user', content: '以后提炼产物一律带 distilled 前缀标签，不带前缀的一律不算。' }),
  ev({ type: 'message', role: 'assistant', content: '好的。' }),
  ev({ type: 'message', role: 'user', content: '撤回就按整批走：一次运行一个来源键，撤回器整组删掉。' }),
  ev({ type: 'message', role: 'user', content: '我觉得大概是那样，可能没差。' }),
  ev({ type: 'message', role: 'user', content: '写库前必须先拍快照，没有快照就不许写。' }),
  ev({ type: 'message', role: 'tool', content: 'exit code 0' }),
];

/** 造夹具库（与生产同构 + owner 两列 + FTS 触发器）。 */
function makeDb(dir, { rows = [], withOwner = true } = {}) {
  const dbPath = path.join(dir, 'memory', 'memory.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ${withOwner ? ", owner_user TEXT NOT NULL DEFAULT 'local', visibility TEXT NOT NULL DEFAULT 'private_owner'" : ''}
);
CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, content='memories', content_rowid='id');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
END;
`);
  const ins = withOwner
    ? db.prepare('INSERT INTO memories (id, text, tags, pinned, created_at, updated_at, owner_user, visibility) VALUES (?,?,?,0,?,?,?,?)')
    : db.prepare('INSERT INTO memories (id, text, tags, pinned, created_at, updated_at) VALUES (?,?,?,0,?,?)');
  for (const row of rows) {
    if (withOwner) ins.run(row.id ?? null, row.text, row.tags ?? '', NOW, NOW, 'local', 'private_owner');
    else ins.run(row.id ?? null, row.text, row.tags ?? '', NOW, NOW);
  }
  db.close();
  return dbPath;
}

const allRows = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare('SELECT id, text, tags, owner_user FROM memories ORDER BY id').all(); } finally { db.close(); }
};
const distilledRows = (dbPath) => allRows(dbPath).filter((row) => String(row.tags).startsWith('distilled'));
const countRows = (dbPath) => allRows(dbPath).length;
const sha = (file) => (fs.existsSync(file) ? (() => {
  const buf = fs.readFileSync(file);
  return `${buf.length}:${buf.subarray(0, 16).toString('hex')}`;
})() : null);

/** 假模型：按候选编号合成 ≤limit 条结论；`calls` 记账，验证"零调用"就靠它。 */
function makeFakeFetch({ failOnce = false, empty = false, badRefs = false, usage = { prompt_tokens: 300, completion_tokens: 90 } } = {}) {
  let calls = 0;
  const seen = [];
  const fn = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const user = body.messages.find((m) => m.role === 'user').content;
    seen.push({ model: body.model, user, thinking: body.thinking, maxTokens: body.max_tokens });
    if (failOnce) return { ok: false, status: 500, text: async () => 'boom' };
    const refIds = [...user.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
    const items = empty ? [] : refIds.slice(0, 5).map((id, index) => ({
      refs: [badRefs ? 999 : id],
      conclusion: `合成结论 ${index + 1}：这条由候选 ${id} 支撑，用于单测断言，不超过一百二十字。`,
    }));
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }], usage }),
    };
  };
  fn.calls = () => calls;
  fn.seen = seen;
  return fn;
}

const commonRun = (dir, overrides = {}) => {
  const file = writeSession(dir, baseEvents(`session-k6-${seq}`));
  const dbPath = makeDb(path.join(dir, 'dbdir'), { rows: [{ id: 1, text: '真实记忆：重启 DSH 走 dsh-restart.ps1。', tags: 'dsh' }] });
  return {
    source: file, dbPath,
    stateFile: path.join(dir, 'state.json'),
    snapshotDir: path.join(dir, 'snapshots'),
    now: NOW, ...overrides,
  };
};

// ── 抽句：只抽能回指的结论条 ────────────────────────────────────────────────
section('抽句：抽什么 / 不抽什么（全部确定性规则）');
test('抽到的是决定/口径/修复句，寒暄与疑问被挡在门外', () => {
  const dir = nextDir('extract');
  const file = writeSession(dir, baseEvents('session-k6-x1'));
  const out = S.extractCandidates({ file });
  assertEq(out.sessionId, 'session-k6-x1', '来源 id 从 type=session 事件里取');
  assertEq(out.candidates.length, 3, '三条结论句');
  const kinds = out.candidates.map((c) => c.kind);
  assert(kinds.includes('rule') || kinds.includes('decision'), '至少命中规则/决定类');
  assert(out.skipped.question >= 1, '疑问句要计数挡下');
  assert(out.skipped['tool-event'] >= 1, '工具事件要计数挡下');
  assert(out.candidates.every((c) => !/^(你好|好的)/.test(c.text)), '寒暄不进候选');
});

test('每条候选都能逐字回指：行号对得上，anchor 是原文前缀', () => {
  const dir = nextDir('anchor');
  const file = writeSession(dir, baseEvents('session-k6-x2'));
  const out = S.extractCandidates({ file });
  const rawLines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const candidate of out.candidates) {
    const ref = candidate.sourceRef;
    assert(ref.sessionId === 'session-k6-x2', '带场次 id');
    assert(Number.isInteger(ref.line) && ref.line >= 1, '带行号');
    assert(Number.isInteger(ref.offset) && ref.offset >= 0, '带字节偏移');
    assert(ref.anchor.length > 0 && candidate.text.startsWith(ref.anchor), 'anchor 是原句前缀');
    assert(rawLines[ref.line - 1].includes(ref.anchor), `第 ${ref.line} 行里能逐字找到 anchor`);
    assert(rawLines[ref.line - 1].includes(candidate.text), '整句也在那一行里（不是拼出来的）');
  }
});

test('超过长度上限的整段转述被跳过并计数（不硬塞长文）', () => {
  const dir = nextDir('toolong');
  // 一句到底（只用顿号/逗号连），这样不会被句末标点切短 —— 才是真正的"整段转述"
  const long = `这条口径很长：${'一段用逗号连起来的长句，'.repeat(24)}就这么长。`;
  assert(long.length > 240, `夹具得真超长（${long.length} 字）`);
  const file = writeSession(dir, [ev({ type: 'message', role: 'user', content: long })]);
  const out = S.extractCandidates({ file, defaults: { maxChars: 240 } });
  assertEq(out.candidates.length, 0, '长句不抽');
  assert(out.skipped['too-long'] >= 1, '长句要计数');
});

test('推测句不抽（"我觉得/可能" 没有规则或决定词撑着）', () => {
  const verdict = S.judgeSentence('我觉得这个方案可能更好一点，大概吧。');
  assertEq(verdict.ok, false, '推测不抽');
  assertEq(verdict.reason, 'speculation');
  assertEq(S.judgeSentence('这个方案可能不划算，所以一律先做本地估算再调模型。').ok, true, '带"一律"的推测句仍按规则抽');
});

test('流水账不抽（先…然后…接着…最后），哪怕句尾撞上"决定"', () => {
  const verdict = S.judgeSentence('我先打开文件，然后逐行看，接着把每段读了一遍，最后才决定不下结论。');
  assertEq(verdict.ok, false, '过程叙述不抽');
  assertEq(verdict.reason, 'process');
});

test('同一句重复出现只算一条（duplicate 计数）', () => {
  const dir = nextDir('dup');
  const line = ev({ type: 'message', role: 'user', content: '默认一律走本地模型，不走云端。' });
  const file = writeSession(dir, [line, line, line]);
  const out = S.extractCandidates({ file });
  assertEq(out.candidates.length, 1, '只留一条');
  assertEq(out.skipped.duplicate, 2, '另外两条按重复计');
});

test('坏行整行跳过并报出来（不静默当正文）', () => {
  const dir = nextDir('badjson');
  const file = writeSession(dir, ['{ 这不是 JSON', ev({ type: 'message', role: 'user', content: '约定：夹具一律落系统临时区。' })]);
  const out = S.extractCandidates({ file });
  assertEq(out.skipped['bad-json'], 1);
  assertEq(out.candidates.length, 1);
  assert(out.warnings.some((w) => w.includes('不是合法 JSON')), '要有警告');
});

// ── zstd：能零依赖解就解，解不开给人话 ──────────────────────────────────────
section('.zstd 输入：多帧逐帧解 / 坏了给明确提示');
test('单帧与多帧 zstd 都解出与原文逐字节一致的文本', () => {
  const dir = nextDir('zstd');
  const file = writeSession(dir, baseEvents('session-k6-z'));
  const plain = fs.readFileSync(file);
  const single = path.join(dir, 'one.jsonl.zstd');
  fs.writeFileSync(single, zlib.zstdCompressSync(plain));
  const multi = path.join(dir, 'multi.jsonl.zstd');
  fs.writeFileSync(multi, Buffer.concat([zlib.zstdCompressSync(plain.subarray(0, 120)), zlib.zstdCompressSync(plain.subarray(120))]));

  const one = S.readSourceText(single);
  assertEq(one.compressed, true);
  assertEq(one.frames, 1);
  assertEq(one.text, plain.toString('utf8'), '单帧解压与原文一致（不多不少）');

  const many = S.readSourceText(multi);
  assertEq(many.frames, 2, '两帧都解了（不是只解第一帧）');
  assertEq(many.text, plain.toString('utf8'), '多帧拼起来与原文逐字节一致');
});

test('坏 zstd 抛带人话的错误（提示先解压），不静默返回半截数据', () => {
  const dir = nextDir('zstd-bad');
  const bad = path.join(dir, 'broken.jsonl.zstd');
  fs.writeFileSync(bad, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00, 0x00]));
  let caught = null;
  try { S.readSourceText(bad); } catch (failure) { caught = failure; }
  assert(caught, '必须抛错');
  assert(/zstd/.test(caught.message), '错误里点名 zstd');
  assert(caught.message.includes('先解压'), '错误里给"先解压"的人话提示');
  assertEq(caught.code, 'ZSTD_CORRUPT');
});

test('extractCandidates 认压缩输入并在 note 里说清做了什么', () => {
  const dir = nextDir('zstd-note');
  const file = writeSession(dir, baseEvents('session-k6-n'));
  const packed = path.join(dir, 'p.jsonl.zstd');
  fs.writeFileSync(packed, zlib.zstdCompressSync(fs.readFileSync(file)));
  const out = S.extractCandidates({ file: packed });
  assertEq(out.compressed, true);
  assert(out.note && out.note.includes('zstd'), 'note 讲清"这是 zstd 已解开"');
  assertEq(out.candidates.length, 3, '解压后照样抽得出结论句');
});

// ── 预算闸 ──────────────────────────────────────────────────────────────────
section('预算闸：没配就是没配（绝不回落到任何缺省额度）');
test('resolveBudget：CLI 优先 → 台账兜底 → 都没有就是 null', () => {
  const state = { cost: { date: '2026-10-30', calls: 0, promptTokens: 0, completionTokens: 0 }, budget: { tokensPerDay: null } };
  assertEq(D.resolveBudget({ flagTokens: null, state, now: NOW }).tokens, null, '两边都没有 ⇒ null');
  assertEq(D.resolveBudget({ flagTokens: 30000, state, now: NOW }).tokens, 30000, 'CLI 给了就用它');
  assertEq(D.resolveBudget({ flagTokens: null, state: { ...state, budget: { tokensPerDay: 12000 } }, now: NOW }).tokens, 12000, '台账兜底');
  assertEq(D.resolveBudget({ flagTokens: 5000, state: { ...state, budget: { tokensPerDay: 12000 } }, now: NOW }).tokens, 5000, 'CLI 覆盖台账');
  assertEq(D.resolveBudget({ flagTokens: 0, state, now: NOW }).tokens, null, '给 0 等于没给（不是"无限"）');
});

test('resolveBudget：当日已花 + 跨天清零 + exhausted', () => {
  const spent = { cost: { date: '2026-10-30', calls: 2, promptTokens: 9000, completionTokens: 1000 }, budget: { tokensPerDay: 10000 } };
  const hit = D.resolveBudget({ state: spent, now: NOW });
  assertEq(hit.spent, 10000, '同一天累计');
  assertEq(hit.exhausted, true, '花满即超');
  assertEq(hit.remaining, 0);
  const nextDay = D.resolveBudget({ state: spent, now: NOW + 86400000 });
  assertEq(nextDay.spent, 0, '换天清零（额度按本地日算）');
  assertEq(nextDay.exhausted, false);
});

test('阴性 · 没配预算 ⇒ 一次模型都不调、库与台账都不动', async () => {
  const dir = nextDir('nobudget');
  const opts = commonRun(dir, { apply: true, fetchImpl: makeFakeFetch(), apiKey: 'stub-key' });
  const before = sha(opts.dbPath);
  const result = await D.runSessionDistill(opts);
  assertEq(result.stopping, 'NO_BUDGET');
  assertEq(result.message, D.NO_BUDGET_MESSAGE, '打印的就是那句"这是故意的"');
  assertEq(opts.fetchImpl.calls(), 0, '零调用');
  assertEq(result.written, 0, '零写入');
  assertEq(sha(opts.dbPath), before, '库文件一个字节都没动');
  assertEq(fs.existsSync(opts.stateFile), false, '台账都没建');
  assertEq(result.exitCode, 0, 'rc=0（没配预算不是错误）');
});

test('阴性 · 台账里配了预算也算"配了"（不带 --max-tokens 也照跑）', async () => {
  const dir = nextDir('statebudget');
  const opts = commonRun(dir, { apply: true, fetchImpl: makeFakeFetch(), apiKey: 'stub-key' });
  fs.writeFileSync(opts.stateFile, `${JSON.stringify({ budget: { tokensPerDay: 20000 }, cost: { date: '2026-10-30', calls: 0, promptTokens: 0, completionTokens: 0 } }, null, 2)}\n`, 'utf8');
  const result = await D.runSessionDistill(opts);
  assertEq(result.budget.source, 'state', '预算来自台账');
  assertEq(result.written >= 1, true, '照跑并写回');
});

test('超预算 ⇒ 不跑（打印用量，零调用）', async () => {
  const dir = nextDir('overspent');
  const opts = commonRun(dir, { apply: true, fetchImpl: makeFakeFetch(), apiKey: 'stub-key', maxTokens: 5000 });
  fs.writeFileSync(opts.stateFile, `${JSON.stringify({ budget: { tokensPerDay: 5000 }, cost: { date: '2026-10-30', calls: 3, promptTokens: 4900, completionTokens: 200 } }, null, 2)}\n`, 'utf8');
  const result = await D.runSessionDistill(opts);
  assertEq(result.stopping, 'BUDGET_SPENT');
  assertEq(opts.fetchImpl.calls(), 0, '零调用');
  assert(result.message.includes('5100') && result.message.includes('5000'), '把已用/预算写出来');
  assertEq(result.written, 0);
});

test('估算就会超 ⇒ 也不跑（ESTIMATE_OVER，先算再花）', async () => {
  const dir = nextDir('estimate');
  const opts = commonRun(dir, { apply: true, fetchImpl: makeFakeFetch(), apiKey: 'stub-key', maxTokens: 400 });
  const result = await D.runSessionDistill(opts);
  assertEq(result.stopping, 'ESTIMATE_OVER');
  assertEq(opts.fetchImpl.calls(), 0, '估算超了就不调模型');
  assert(result.tokens.estimated > 400, '估算值照实报出来');
});

// ── 阳性：写回 + 回指 + 快照 ────────────────────────────────────────────────
section('阳性：给预算 ⇒ ≤5 条 · 带来源锚 · 写前有快照');
test('给预算跑一轮：≤5 条、每条带 distilled/run=/sess= 标签与合法回指', async () => {
  const dir = nextDir('happy');
  const opts = commonRun(dir, { apply: true, maxTokens: 30000, fetchImpl: makeFakeFetch(), apiKey: 'stub-key' });
  const result = await D.runSessionDistill(opts);
  assertEq(result.stopping, null, '正常跑完（没有 stopping）');
  assertEq(result.calls, 1, '只调一次模型');
  assert(result.written >= 1 && result.written <= 5, `写入条数在 1..5（实际 ${result.written}）`);

  const rows = distilledRows(opts.dbPath);
  assertEq(rows.length, result.written, '库里提炼条数 = 报告的写入数');
  for (const row of rows) {
    assert(row.tags.startsWith('distilled '), '标签以 distilled 开头（撤回器认这个前缀）');
    assert(row.tags.includes(`run=session:${result.runId}`), '带批次标识');
    assert(/src=[0-9a-f]+/.test(row.tags), '带来源键（撤回按它整批走）');
    assert(/sess=session-k6-/.test(row.tags), '带场次');
    assert(row.text.length <= 120, '结论正文 ≤120 字');
    assertEq(row.owner_user, 'local', '有 owner 列时按 local 落库（没给 --owner-user）');
  }
  // 每条计划项都能回指到原文的某一行
  const rawLines = fs.readFileSync(opts.source, 'utf8').split(/\r?\n/);
  for (const item of result.planned) {
    assert(item.anchors.length >= 1, '每条结论至少一个锚');
    for (const anchor of item.anchors) {
      assert(rawLines[anchor.line - 1].includes(anchor.anchor), `L${anchor.line} 能逐字找到锚`);
    }
  }
});

test('--limit 2 ⇒ 最多写 2 条（模型给多了也不超）', async () => {
  const dir = nextDir('limit');
  const opts = commonRun(dir, { apply: true, maxTokens: 30000, limit: 2, fetchImpl: makeFakeFetch(), apiKey: 'stub-key' });
  const result = await D.runSessionDistill(opts);
  assert(result.written <= 2, `写入 ${result.written} 条，不超过 limit`);
  assert(result.rejected?.some((entry) => entry.why === 'over-limit'), '多出来的要按 over-limit 剔掉');
});

test('写库前必拍快照，且快照是能打开的完整库（行数 = 写前）', async () => {
  const dir = nextDir('snapshot');
  const opts = commonRun(dir, { apply: true, maxTokens: 30000, fetchImpl: makeFakeFetch(), apiKey: 'stub-key' });
  const before = countRows(opts.dbPath);
  const result = await D.runSessionDistill(opts);
  assert(result.snapshot, '报告里要有快照路径');
  assertEq(fs.existsSync(result.snapshot), true, '快照文件存在');
  assertEq(countRows(result.snapshot), before, '快照是写前的库（行数对得上）');
  assert(result.snapshot.includes(result.runId), '快照文件名带批次（能对上是哪一轮）');
});

test('快照拍不成 ⇒ 按规矩不写库（fail-closed）', async () => {
  const dir = nextDir('snapshot-fail');
  const opts = commonRun(dir, { apply: true, maxTokens: 30000, fetchImpl: makeFakeFetch(), apiKey: 'stub-key' });
  // 让 snapshotDir 指向一个目录不可建的位置（用文件占位）
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'not a dir');
  opts.snapshotDir = path.join(blocked, 'snapshots');
  const before = countRows(opts.dbPath);
  const result = await D.runSessionDistill(opts);
  assertEq(result.stopping, 'SNAPSHOT_FAILED');
  assertEq(result.written, 0, '没快照就不写');
  assertEq(countRows(opts.dbPath), before, '库没变');
});

test('模型失败：不写库，但把花掉的 token 记进台账（不许装没发生）', async () => {
  const dir = nextDir('modelfail');
  const opts = commonRun(dir, { apply: true, maxTokens: 30000, fetchImpl: makeFakeFetch({ failOnce: true }), apiKey: 'stub-key' });
  const result = await D.runSessionDistill(opts);
  assertEq(result.stopping, 'MODEL_FAILED');
  assertEq(result.written, 0);
  assertEq(distilledRows(opts.dbPath).length, 0, '库里没有提炼条');
  const state = JSON.parse(fs.readFileSync(opts.stateFile, 'utf8'));
  assert(state.cost.promptTokens > 0 || state.cost.completionTokens > 0, '失败也记账');
});

test('模型给不出可用条目（空 items）⇒ 不写库', async () => {
  const dir = nextDir('empty');
  const opts = commonRun(dir, { apply: true, maxTokens: 30000, fetchImpl: makeFakeFetch({ empty: true }), apiKey: 'stub-key' });
  const result = await D.runSessionDistill(opts);
  assertEq(result.stopping, 'NOTHING_KEPT');
  assertEq(result.written, 0);
});

test('模型编出越界 refs ⇒ 一条都不写（回指不成立就不留）', async () => {
  const dir = nextDir('badrefs');
  const opts = commonRun(dir, { apply: true, maxTokens: 30000, fetchImpl: makeFakeFetch({ badRefs: true }), apiKey: 'stub-key' });
  const result = await D.runSessionDistill(opts);
  assertEq(result.stopping, 'NOTHING_KEPT');
  assert(result.rejected?.every((entry) => entry.why === 'no-valid-ref'), '理由要写清是 refs 不成立');
});

// ── 幂等与台账 ──────────────────────────────────────────────────────────────
section('幂等：同一批不重复写 / 同一句不重复花 token');
test('同 runId 再 apply ⇒ 0 写（按正文去重跳过）', async () => {
  const dir = nextDir('idempotent');
  const opts = commonRun(dir, { apply: true, maxTokens: 30000, fetchImpl: makeFakeFetch(), apiKey: 'stub-key', runId: 'fixed-run' });
  const first = await D.runSessionDistill(opts);
  const rowsAfterFirst = countRows(opts.dbPath);
  // 清掉台账（模拟"台账丢了"），让第二次真的走到模型，靠库里的正文去重兜住
  fs.rmSync(opts.stateFile, { force: true });
  const second = await D.runSessionDistill({ ...opts, fetchImpl: makeFakeFetch(), apiKey: 'stub-key' });
  assertEq(second.written, 0, '第二次一条都不写');
  assert(second.skippedExisting >= 1, '重复正文按"已存在"跳过');
  assertEq(countRows(opts.dbPath), rowsAfterFirst, '库行数没变');
  assertEq(first.written >= 1, true);
});

test('台账记过来源句 ⇒ 换个 runId 也不重复调模型（ALL_PROCESSED）', async () => {
  const dir = nextDir('processed');
  const opts = commonRun(dir, { apply: true, maxTokens: 30000, fetchImpl: makeFakeFetch(), apiKey: 'stub-key' });
  await D.runSessionDistill(opts);
  const secondFetch = makeFakeFetch();
  const second = await D.runSessionDistill({ ...opts, runId: 'another-run', fetchImpl: secondFetch, apiKey: 'stub-key' });
  assertEq(second.stopping, 'ALL_PROCESSED');
  assertEq(secondFetch.calls(), 0, '一句都不再送模型');
});

test('没抽到候选 ⇒ 不调模型（NO_CANDIDATES）', async () => {
  const dir = nextDir('nocandidates');
  const file = writeSession(dir, [ev({ type: 'message', role: 'user', content: '你好。' }), ev({ type: 'message', role: 'user', content: '好的。' })]);
  const dbPath = makeDb(path.join(dir, 'dbdir'));
  const fetchImpl = makeFakeFetch();
  const result = await D.runSessionDistill({ source: file, dbPath, stateFile: path.join(dir, 's.json'), apply: true, maxTokens: 30000, fetchImpl, apiKey: 'k', now: NOW });
  assertEq(result.stopping, 'NO_CANDIDATES');
  assertEq(fetchImpl.calls(), 0);
});

// ── 撤回：整批走既有回滚器 ──────────────────────────────────────────────────
section('撤回：一批一个键 ⇒ 既有回滚器整组删，真实记忆不误伤');
test('按批次键撤回：提炼条清零、真实行不动、内容摘要回到原状', async () => {
  const dir = nextDir('rollback');
  const opts = commonRun(dir, { apply: true, maxTokens: 30000, fetchImpl: makeFakeFetch(), apiKey: 'stub-key' });
  const beforeDigest = R.contentDigest(opts.dbPath).digest;
  const result = await D.runSessionDistill(opts);
  assert(result.written >= 1);
  assert(distilledRows(opts.dbPath).length >= 1, '先确认写进去了');

  const dry = R.rollbackDistilled({ dbPath: opts.dbPath, keys: [result.srcKey], apply: false });
  assertEq(dry.matched, result.written, 'dry-run 按键命中整批');
  assertEq(dry.deleted, 0, 'dry-run 不删');

  const wiped = R.rollbackDistilled({ dbPath: opts.dbPath, keys: [result.srcKey], apply: true, snapshotDir: path.join(dir, 'snapshots-rollback') });
  assertEq(wiped.deleted, result.written, '整批删掉');
  assertEq(distilledRows(opts.dbPath).length, 0, '库里没有提炼条了');
  assertEq(countRows(opts.dbPath), 1, '只剩那条真实记忆');
  assertEq(R.contentDigest(opts.dbPath).digest, beforeDigest, '内容摘要回到写之前的原状');
  assert(wiped.snapshot && fs.existsSync(wiped.snapshot), '撤回前也拍了快照');
});

test('批次键能反查出批次（run= 标签可解析）', async () => {
  const dir = nextDir('runs');
  const opts = commonRun(dir, { apply: true, maxTokens: 30000, fetchImpl: makeFakeFetch(), apiKey: 'stub-key', runId: 'run-readable' });
  const applied = await D.runSessionDistill(opts);
  const runs = D.listSessionRuns(opts.dbPath);
  assertEq(runs.length, 1, '只有一个批次');
  assertEq(runs[0].runId, 'run-readable');
  assertEq(runs[0].rows, applied.written, '行数对得上这一批写了几条');
  assertEq(distilledRows(opts.dbPath).length, applied.written, '库里这条批次的条数一致');
  const meta = D.tagsOfRun(`distilled src=abc srcids=1,2 date=20261030 sess=s1 run=session:run-readable`);
  assertEq(meta.runId, 'run-readable');
  assertEq(meta.sessionId, 's1');
  assertEq(D.tagsOfRun('task-board, 验收'), null, '不是提炼条就返回 null');
});

// ── 收口逻辑 ────────────────────────────────────────────────────────────────
section('收口：越界 refs / 空结论 / 太长 / 重复 / 超 limit 一律剔');
test('attachSourceRefs 逐条给出剔除理由', () => {
  const candidates = [
    { kind: 'rule', text: '甲', sourceRef: { sessionId: 's', line: 3, anchor: '甲' } },
    { kind: 'rule', text: '乙', sourceRef: { sessionId: 's', line: 4, anchor: '乙' } },
  ];
  const out = D.attachSourceRefs([
    { refs: [1], conclusion: '合法结论一条，长度够用。' },
    { refs: [999], conclusion: '引用越界的结论，长度也够。' },
    { refs: [1], conclusion: '' },
    { refs: [2], conclusion: '这条结论长得离谱，'.repeat(20) },
    { refs: [1], conclusion: '合法结论一条，长度够用。' },
  ], candidates, { limit: 5 });
  assertEq(out.items.length, 1, '只留下合法那条');
  const whys = out.rejected.map((entry) => entry.why).sort();
  assertEq(whys, ['duplicate', 'no-valid-ref', 'over-120-chars', 'too-short-or-empty']);
});

test('estimateSessionTokens 与实测同量级（保守但不出格）', () => {
  const chars = D.buildSessionSystemPrompt().length + D.buildSessionUserPrompt([{ kind: 'rule', text: '一条候选句，长度适中。' }], 5).length;
  const estimated = D.estimateSessionTokens(chars, 5);
  // 实测（deepseek-flash 三轮）prompt ≈ 350 token，估算按 1.4 字/token 再留输出余量 ⇒ 落在 0.5x~4x 字符数之间
  assert(estimated > chars / 2 && estimated < chars * 4, `估算 ${estimated} 与字符数 ${chars} 同量级`);
  assert(D.estimateSessionTokens(chars, 5) > D.estimateSessionTokens(chars, 1), 'limit 越大留的余量越大');
});

test('提示词里明确要求"只许用候选、必须报 refs、不要相对时间"', () => {
  const prompt = D.buildSessionSystemPrompt();
  assert(prompt.includes('refs'), '要求报 refs');
  assert(prompt.includes('不许补常识'), '禁止补常识');
  assert(prompt.includes('相对时间'), '禁止相对时间');
  const user = D.buildSessionUserPrompt([{ kind: 'rule', text: '甲句' }, { kind: 'fix', text: '乙句' }], 5);
  assert(user.includes('[1] (rule) 甲句') && user.includes('[2] (fix) 乙句'), '候选带编号与类别');
});

// ── CLI 层 ──────────────────────────────────────────────────────────────────
section('CLI：--help / 未知参数 fail-closed / --json 只落文件 / 无预算 rc=0');
const runCli = (args, extraEnv = {}) => {
  const home = nextDir('home');
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: TMP,
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: home, HOME: home, DSH_HOME: home, ...extraEnv },
    timeout: 60000,
  });
};

test('--help：退出码 0，正文里写清预算规则与撤回入口', () => {
  const out = runCli(['--help']);
  assertEq(out.status, 0, `rc=${out.status} :: ${out.stderr}`);
  assert(out.stdout.includes('没配') && out.stdout.includes('不跑'), 'help 里点明预算规则');
  assert(out.stdout.includes('distill-rollback.mjs'), 'help 里给撤回入口');
  assert(out.stdout.includes('不做摘要式写入'), 'help 里点明不做摘要');
});

test('未知参数 / 数值不合法 ⇒ rc=2 且点名是哪几个', () => {
  const unknown = runCli(['--source', 'x.jsonl', '--frobnicate', '1']);
  assertEq(unknown.status, 2);
  assert(unknown.stderr.includes('--frobnicate'), '点出未知开关');
  const bad = runCli(['--source', 'x.jsonl', '--limit', 'abc']);
  assertEq(bad.status, 2);
  assert(bad.stderr.includes('--limit'), '点出数值不合法');
  const rest = runCli(['--source', 'x.jsonl', 'oops']);
  assertEq(rest.status, 2, '多余位置参数也算用法错');
});

test('--apply 缺 --db / --json 缺 --out / 两个模式同时给 ⇒ rc=2', () => {
  const noDb = runCli(['--source', 'x.jsonl', '--apply']);
  assertEq(noDb.status, 2);
  assert(noDb.stderr.includes('--db'), '要求 --db');
  const noOut = runCli(['--source', 'x.jsonl', '--json']);
  assertEq(noOut.status, 2);
  assert(noOut.stderr.includes('--out'), '--json 必须配 --out');
  const both = runCli(['--source', 'x.jsonl', '--apply', '--dry-run']);
  assertEq(both.status, 2, '两种模式互斥');
});

test('CLI 无预算：rc=0、打印那句"这是故意的"、库与台账都没动', () => {
  const dir = nextDir('cli-nobudget');
  const file = writeSession(dir, baseEvents('session-k6-cli'));
  const dbPath = makeDb(path.join(dir, 'dbdir'), { rows: [{ id: 1, text: '真实记忆一条。', tags: 'dsh' }] });
  const stateFile = path.join(dir, 'state.json');
  const before = sha(dbPath);
  const out = runCli(['--source', file, '--db', dbPath, '--state', stateFile, '--apply', '--quiet']);
  assertEq(out.status, 0, `rc=${out.status} :: ${out.stderr}`);
  assert(out.stdout.includes(D.NO_BUDGET_MESSAGE), '打印的就是那句话');
  assertEq(sha(dbPath), before, '库一个字节没动');
  assertEq(fs.existsSync(stateFile), false, '台账没建');
});

test('CLI 有预算 dry-run：列出将写什么，但不写库、不建台账', () => {
  const dir = nextDir('cli-dryrun');
  const file = writeSession(dir, baseEvents('session-k6-cli2'));
  const dbPath = makeDb(path.join(dir, 'dbdir'));
  const stateFile = path.join(dir, 'state.json');
  const before = sha(dbPath);
  const out = runCli(['--source', file, '--db', dbPath, '--state', stateFile, '--max-tokens', '30000']);
  assertEq(out.status, 0, `rc=${out.status} :: ${out.stderr}`);
  assert(out.stdout.includes('dry-run'), '说明自己是干跑');
  assert(out.stdout.includes('将写'), '列出将写什么');
  assert(/L\d+/.test(out.stdout), '带行号（能看出从哪来）');
  assertEq(sha(dbPath), before, '库没动');
  assertEq(fs.existsSync(stateFile), false, 'dry-run 不写台账');
});

test('CLI --json：机器可读内容只落文件，不上 stdout', () => {
  const dir = nextDir('cli-json');
  const file = writeSession(dir, baseEvents('session-k6-cli3'));
  const dbPath = makeDb(path.join(dir, 'dbdir'));
  const outFile = path.join(dir, 'report.json');
  const out = runCli(['--source', file, '--db', dbPath, '--max-tokens', '30000', '--json', '--out', outFile]);
  assertEq(out.status, 0, `rc=${out.status} :: ${out.stderr}`);
  assert(fs.existsSync(outFile), '报告落盘了');
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assertEq(payload.stopping, null);
  assert(Array.isArray(payload.candidates) && payload.candidates.length >= 1, '报告里有候选');
  assertEq(out.stdout.includes('"stopping"'), false, 'stdout 上没有 JSON');
});

test('CLI 源文件不存在 ⇒ rc=3（环境不可用，不是用法错）', () => {
  const out = runCli(['--source', path.join(TMP, 'nonexistent.jsonl')]);
  assertEq(out.status, 3, `rc=${out.status}`);
  assert(out.stderr.includes('输入文件不存在') || out.stdout.includes('输入文件不存在'), '说清是文件不在');
});

test('CLI --run 指定批次 ⇒ 批次 id 可指定、批次键由它唯一决定（撤回要用它）', () => {
  const dir = nextDir('cli-run');
  const file = writeSession(dir, baseEvents('session-k6-cli4'));
  const dbPath = makeDb(path.join(dir, 'dbdir'));
  const out = runCli(['--source', file, '--db', dbPath, '--max-tokens', '30000', '--run', 'cli-run-1']);
  assertEq(out.status, 0, `rc=${out.status} :: ${out.stderr}`);
  assert(out.stdout.includes('cli-run-1'), '打出批次 id');
  // 真跑时打出来的键就是这个函数算出来的（同一个 runId 永远同一个键 ⇒ 撤回对得上）
  const key = D.runKeyOf('cli-run-1');
  assert(/^d[0-9a-f]{16}$/.test(key), `批次键形态正确：${key}`);
  assertEq(D.runKeyOf('cli-run-1'), key, '同一个批次 id 算出来的键稳定');
  assert(D.runKeyOf('cli-run-2') !== key, '不同批次不同键');
});

test('夹具收尾：临时根仍在系统临时区（没有写到任何真实路径）', () => {
  assert(TMP.includes(os.tmpdir()), '夹具根在系统临时区');
  assert(!TMP.toLowerCase().includes('dsh-oss'), '没落在仓里');
});
