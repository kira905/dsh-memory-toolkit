// 记忆引擎 v2 · S3c —— 夜间提炼单测（零依赖；夹具一律在系统临时区，**不碰任何真实库/不联网**）
//
// 覆盖卡面验收的可离线部分：
//   ① 内容级去重（跨机改 id 仍不重复）② 不自我指涉 ③ 成本闸超限即停 ④ dry-run 零写入
//   ⑤ 标签/owner/visibility 落库形态 ⑥ memories_dirty 台账（补 A7 盲区）⑦ 回滚（内容摘要回到原状）
//   ⑧ D2 从严（family / 非本机 owner / 缺列归属不可判定 ⇒ 0 调用）⑨ 日报行字段
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test, section, assert, assertEq } from './harness.mjs';
import * as D from '../lib/distill.mjs';
import * as L from '../lib/dirty-ledger.mjs';
import * as R from '../lib/distill-rollback.mjs';
import { openVectorsStore, upsertVectors } from '../lib/vectors-store.mjs';

export const __section = 'S3c · 夜间提炼（内容级去重 / 不自我指涉 / 成本闸 / 台账 / 回滚 / D2 从严）';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 's3c-distill-'));
const OWNER = 'LiJianXiao';
const DIM = 8;
const NOW = Date.parse('2026-09-21T04:10:00+08:00');

/** 造 8 列临时库（含 owner_user/visibility）。 */
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
    const base = [r.id ?? null, r.text, r.tags ?? '', r.pinned ?? 0, r.created_at ?? r.updated_at ?? NOW, r.updated_at ?? NOW];
    if (withOwner) ins.run(...base, r.owner ?? OWNER, r.visibility ?? 'private_owner');
    else ins.run(...base);
  }
  db.close();
  return { dir, dbPath: p, home: dir, vectorsDb: path.join(dir, 'memory-vectors', 'vectors.db'), stateFile: path.join(dir, 'butler-distill-state.json') };
}

/** 写向量（unit 向量便于控制余弦相似度）。 */
function writeVectors(vectorsDb, entries) {
  const store = openVectorsStore(vectorsDb, { create: true });
  const items = entries.map(([refId, vec, text]) => ({
    source: 'memory', refId, model: 'bge-small-zh-v1.5', dim: vec.length,
    vec: Float32Array.from(vec), textHash: crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex'),
    updatedAt: NOW,
  }));
  upsertVectors(store.db, items);
  store.db.close();
  return vectorsDb;
}

/** 假模型：从 prompt 里抠组编号并逐组回结论（**不联网**）。 */
function makeFakeFetch({ promptTokens = 120, completionTokens = 40, conclusion = (key) => `长期结论 ${key}：这条提炼结论用于单测断言，不超过二十字。`, failTimes = 0, emptyFor = () => false } = {}) {
  let calls = 0;
  const seen = [];
  const fn = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const user = body.messages.find((m) => m.role === 'user').content;
    seen.push({ model: body.model, user, thinking: body.thinking });
    if (calls <= failTimes) return { ok: false, status: 500, text: async () => 'boom' };
    const keys = [...user.matchAll(/【组 ([0-9a-f]+)】/g)].map((m) => m[1]);
    const items = keys.map((k) => ({ key: k, conclusion: emptyFor(k) ? '' : conclusion(k) }));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } }),
    };
  };
  fn.calls = () => calls;
  fn.seen = seen;
  return fn;
}

/** 读库里某条。 */
function row(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare('SELECT * FROM memories WHERE id = ?').get(Number(id)); } finally { db.close(); }
}
function allDistilled(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare("SELECT id, text, tags, owner_user, visibility, pinned FROM memories WHERE tags LIKE 'distilled%' ORDER BY id").all(); } finally { db.close(); }
}
function countRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return Number(db.prepare('SELECT COUNT(*) n FROM memories').get().n); } finally { db.close(); }
}

const sampleRows = (baseTs, n = 4) => Array.from({ length: n }, (_, i) => ({
  id: i + 1,
  text: `样本 ${i + 1}：本地生图栈的启动脚本与模型切换口径、参考图一致性配方与排障入口（第 ${i + 1} 版，正文留够长度以便聚类与提炼）`,
  tags: '技术 生图',
  updated_at: baseTs - i * 1000,
}));

/** 够长的正文（默认 `minClusterChars: 120` 之下会被判"太短不提炼"⇒ 需要真调模型的用例要够长）。 */
const long = (head) => `${head}：${'本条正文用于撑够最小提炼长度并让聚类有区分度，包含条件、做法与阈值等可长期复用的信息。'.repeat(5)}`;

// ── 01 内容级去重键 ─────────────────────────────────────────────────────────
section('01 去重键 = 源正文哈希集合（**与 id 无关**）');
test('srcKeyOf：同正文、**换 id** ⇒ 键不变（跨机合并灌高位 id 也挡得住）', () => {
  const a = [{ id: 6, text: '甲' }, { id: 7, text: '乙' }];
  const b = [{ id: 5001, text: '乙' }, { id: 5002, text: '甲' }];
  assertEq(D.srcKeyOf(a), D.srcKeyOf(b), 'id 变、正文同 ⇒ 同一键');
  assertEq(D.srcKeyOf(a), D.srcKeyOf([...a].reverse()), '顺序无关（内部排序）');
});
test('srcKeyOf：正文变一个字 ⇒ 键变（该重提炼就得重提炼）', () => {
  assert(D.srcKeyOf([{ id: 1, text: '甲' }]) !== D.srcKeyOf([{ id: 1, text: '甲。' }]), '正文不同 ⇒ 键不同');
});
test('distilledTagOf / srcKeyInTags：标签形态可往返解析', () => {
  const tags = D.distilledTagOf({ srcKey: 'd0123456789abcdef', srcIds: [9, 3], now: NOW });
  assert(tags.startsWith('distilled '), '必须**以 distilled 开头**（回滚/排除自我指涉的判据）');
  assert(tags.includes('src=d0123456789abcdef'), '带 src 键');
  assert(tags.includes('srcids=3,9'), '带源 id 清单（升序）');
  assert(/\sdate=\d{8}$/.test(tags), '带日期');
  assertEq(D.srcKeyInTags(tags), 'd0123456789abcdef', '能解析回来');
  assertEq(D.srcKeyInTags('技术 工作rog'), null, '普通标签解析为 null');
});

// ── 02 输入挑选：窗口 ∪ 台账 + 不自我指涉 + D2 从严 ─────────────────────────
section('02 输入挑选（窗口 + 台账 ∪；排除 distilled；D2 从严）');
test('窗口内条被选入；窗口外且不在台账的条被排除', () => {
  const f = makeDb('in-window', [
    { id: 1, text: '窗口内', updated_at: NOW - 3600_000 },
    { id: 2, text: '窗口外', updated_at: NOW - 30 * 3600_000 },
  ]);
  const sel = D.selectInputs({ dbPath: f.dbPath, now: NOW, windowHours: 24, localOwner: OWNER });
  assertEq(sel.accepted.map((x) => x.id), [1], '只选窗口内的');
  assertEq(sel.stats.windowRows, 1, '窗口行数');
});
test('台账里的 id 即使 updated_at 很老也被并进输入（治 A7 盲区）', () => {
  const f = makeDb('dirty-in', [{ id: 7, text: '被外部改过 text 但没动 updated_at', updated_at: NOW - 100 * 3600_000 }]);
  const sel = D.selectInputs({ dbPath: f.dbPath, now: NOW, windowHours: 24, dirtyIds: [7], localOwner: OWNER });
  assertEq(sel.accepted.map((x) => x.id), [7], '台账是补充输入源');
  assertEq(sel.accepted[0].source, 'dirty-ledger', '标注来源可追溯');
});
test('**不自我指涉**：`tags LIKE distilled%` 的条永不进输入', () => {
  const f = makeDb('self-ref', [
    { id: 1, text: '普通条', updated_at: NOW - 1000 },
    { id: 2, text: '提炼条', tags: D.distilledTagOf({ srcKey: 'd0123456789abcdef', srcIds: [1], now: NOW }), updated_at: NOW - 1000 },
  ]);
  const sel = D.selectInputs({ dbPath: f.dbPath, now: NOW, windowHours: 24, localOwner: OWNER });
  assertEq(sel.accepted.map((x) => x.id), [1], '提炼条被排除');
  assertEq(sel.stats.distilledExcluded, 1, '记账：排除 1 条 distilled');
});
test('D2 从严：visibility=family 的条**不进输入**（不送第三方）', () => {
  const f = makeDb('family', [
    { id: 1, text: '主人条', updated_at: NOW - 1000 },
    { id: 2, text: '家人投喂的私事', visibility: 'family', updated_at: NOW - 1000 },
  ]);
  const sel = D.selectInputs({ dbPath: f.dbPath, now: NOW, windowHours: 24, localOwner: OWNER });
  assertEq(sel.accepted.map((x) => x.id), [1], 'family 被排除');
  assertEq(sel.family.map((x) => x.id), [2], '记账在 family 清单');
  assertEq(sel.stats.skippedFamily, 1, '统计可见');
});
test('D2 从严：**非本机 owner** 的条不进输入', () => {
  const f = makeDb('other-owner', [
    { id: 1, text: '主人条', updated_at: NOW - 1000 },
    { id: 2, text: '别人投喂的条', owner: 'SomeoneElse', updated_at: NOW - 1000 },
  ]);
  const sel = D.selectInputs({ dbPath: f.dbPath, now: NOW, windowHours: 24, localOwner: OWNER });
  assertEq(sel.accepted.map((x) => x.id), [1], '非本机 owner 排除');
  assertEq(sel.unknownOwner.map((x) => x.id), [2], '记账');
});
test('D2 从严：**库无 owner 列** ⇒ 归属不可判定 ⇒ 一条都不送（宁可漏）', () => {
  const f = makeDb('no-owner-col', [{ id: 1, text: '老库形态的条', updated_at: NOW - 1000 }], { withOwner: false });
  const sel = D.selectInputs({ dbPath: f.dbPath, now: NOW, windowHours: 24, localOwner: OWNER });
  assertEq(sel.accepted.length, 0, '缺列 ⇒ 0 条可送');
  assertEq(sel.unknownOwner.length, 1, '记账：归属不可判定');
});
test('D2 从严：**本机 owner 未解析出来** ⇒ 也不送（不猜）', () => {
  const f = makeDb('no-owner-resolved', [{ id: 1, text: '条', updated_at: NOW - 1000 }]);
  const sel = D.selectInputs({ dbPath: f.dbPath, now: NOW, windowHours: 24, localOwner: null });
  assertEq(sel.accepted.length, 0, '未解析 owner ⇒ 不送');
  assertEq(sel.unknownOwner.length, 1, '记账');
});

// ── 03 语义聚类 ─────────────────────────────────────────────────────────────
section('03 语义向量聚类（不用 tags）');
test('同向量的两条聚成一组；正交的另起一组；无向量的自成一组', () => {
  const f = makeDb('cluster', [
    { id: 1, text: 'A1 生图栈', updated_at: NOW - 1000 },
    { id: 2, text: 'A2 生图栈', updated_at: NOW - 1000 },
    { id: 3, text: 'B1 同步仓', updated_at: NOW - 1000 },
    { id: 4, text: 'C1 尚未编码的条', updated_at: NOW - 1000 },
  ]);
  writeVectors(f.vectorsDb, [
    [1, [1, 0, 0, 0, 0, 0, 0, 0], 'A1 生图栈'],
    [2, [0.99, 0.05, 0, 0, 0, 0, 0, 0], 'A2 生图栈'],
    [3, [0, 1, 0, 0, 0, 0, 0, 0], 'B1 同步仓'],
  ]);
  const sel = D.selectInputs({ dbPath: f.dbPath, now: NOW, windowHours: 24, localOwner: OWNER });
  const cl = D.clusterRows(sel.accepted, { vectorsDbPath: f.vectorsDb, simThreshold: 0.6 });
  assertEq(cl.stats.clusters, 3, 'A(2 条) + B(1) + 无向量(1) = 3 组');
  const sizes = cl.clusters.map((c) => c.members.length).sort();
  assertEq(sizes, [1, 1, 2], '组大小分布符合预期');
  assertEq(cl.stats.noVector, 1, '无向量计数可见（不按 tags 兜底猜）');
});
test('聚类键 = 组内容的 srcKey（与组内 id 无关）', () => {
  const rows = [{ id: 3, text: 'x' }, { id: 4, text: 'y' }];
  const cl = D.clusterRows(rows.map((r) => ({ ...r, textForModel: r.text })), { vectorsDbPath: null });
  assertEq(cl.clusters.length, 2, '无向量 ⇒ 各自成组');
  assertEq(cl.clusters[0].key, D.srcKeyOf([rows[0]]), '单条组的键 = 该条正文的键');
  assertEq(cl.clusters[1].key, D.srcKeyOf([rows[1]]), '第二条同理');
});

// ── 04 台账（memories_dirty）────────────────────────────────────────────────
section('04 memories_dirty 台账（兜底轮转的产物，补 A7 盲区）');
test('recordDirty：首次入账 open；重复扫到 hits+1 但**不清 consumed_at**', () => {
  const f = makeDb('ledger', [{ id: 1, text: 'v1', updated_at: NOW }]);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], 'v1']]);
  const db = new DatabaseSync(f.vectorsDb);
  try {
    L.recordDirty(db, [{ refId: 1, kind: 'mismatch', oldHash: 'a', newHash: 'b' }], { now: NOW });
    L.markConsumed(db, [1], { now: NOW });
    // 同一差异被再扫到（hash 没变）⇒ 不得复活
    L.recordDirty(db, [{ refId: 1, kind: 'mismatch', oldHash: 'a', newHash: 'b' }], { now: NOW + 1000 });
    const rows = L.listDirty(db, { includeConsumed: true });
    assertEq(rows.length, 1, '同一 ref_id 只有一行');
    assertEq(rows[0].hits, 2, 'hits 累加');
    assert(rows[0].consumedAt != null, '重复扫到**不复活**（否则每轮轮转都会重新消费一遍）');
  } finally { db.close(); }
});
test('recordDirty：正文**又变了** ⇒ consumed_at 清空（重新待消费）', () => {
  const f = makeDb('ledger2', [{ id: 1, text: 'v1', updated_at: NOW }]);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], 'v1']]);
  const db = new DatabaseSync(f.vectorsDb);
  try {
    L.recordDirty(db, [{ refId: 1, oldHash: 'a', newHash: 'b' }], { now: NOW });
    L.markConsumed(db, [1], { now: NOW });
    const r = L.recordDirty(db, [{ refId: 1, oldHash: 'b', newHash: 'c' }], { now: NOW + 1 });
    assertEq(r.reopened, 1, '复活 1 条');
    assertEq(L.listDirty(db, { openOnly: true }).length, 1, '重新变成待消费');
  } finally { db.close(); }
});
test('detectDirty：**改 text 不动 updated_at** 能被抓出来并落台账（A7 复刻）', () => {
  const f = makeDb('detect-dirty', [{ id: 1, text: '原始正文', updated_at: NOW - 10 * 3600_000 }]);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], '原始正文']]);
  // 复刻 apply-pinned-refine.mjs:110：只改 text
  const db = new DatabaseSync(f.dbPath);
  db.prepare('UPDATE memories SET text = ? WHERE id = ?').run('被外部勘误后的正文', 1);
  db.close();
  const d = D.detectDirty({ dbPath: f.dbPath, vectorsDbPath: f.vectorsDb, record: true, now: NOW });
  assertEq(d.mismatched, [1], '抓到差异');
  const led = D.readDirtyIds(f.vectorsDb);
  assertEq(led.ids, [1], '台账里出现该条 ⇒ 提炼 job 日后会补上它');
});
test('markConsumed 幂等（第二次调用不再改 consumed_at）', () => {
  const f = makeDb('ledger3', [{ id: 1, text: 'x', updated_at: NOW }]);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], 'x']]);
  const db = new DatabaseSync(f.vectorsDb);
  try {
    L.recordDirty(db, [{ refId: 1, oldHash: 'a', newHash: 'b' }], { now: NOW });
    assertEq(L.markConsumed(db, [1], { now: NOW }), 1, '第一次标记成功');
    assertEq(L.markConsumed(db, [1], { now: NOW + 5 }), 0, '第二次 0 变更（幂等）');
  } finally { db.close(); }
});

// ── 05 dry-run 零写入 ──────────────────────────────────────────────────────
section('05 dry-run：不调模型、不写库、不写 state');
test('dry-run：库文件 sha 不变 + 不产生 state 文件 + 假模型 0 调用', async () => {
  const rows = [
    { id: 1, text: long('样本一：跨机同步的挡推裁决口径'), tags: '技术 同步', updated_at: NOW },
    { id: 2, text: long('样本二：跨机同步的挡推裁决口径'), tags: '技术 同步', updated_at: NOW - 1000 },
  ];
  const f = makeDb('dryrun', rows);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], rows[0].text]]);
  const shaBefore = crypto.createHash('sha256').update(fs.readFileSync(f.dbPath)).digest('hex');
  const fake = makeFakeFetch();
  const r = await D.runDistill({
    memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW,
    apply: false, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake,
  });
  const shaAfter = crypto.createHash('sha256').update(fs.readFileSync(f.dbPath)).digest('hex');
  assertEq(shaAfter, shaBefore, '库字节未变');
  assertEq(fake.calls(), 0, 'dry-run 不调模型');
  assertEq(fs.existsSync(f.stateFile), false, 'dry-run 不写 state');
  assert(r.planned.some((x) => x.action === 'call'), '但要**看得见**本来会调几次');
});

// ── 05b 单条组默认不提炼（护住 memory:recall 段） ─────────────────────────────
section('05b 单条组默认不提炼（minClusterSize=2）');
test('默认 minClusterSize=2：单条成组的条被跳过，多条组照常提炼', async () => {
  const rows = [
    { id: 1, text: long('同题甲一'), updated_at: NOW },
    { id: 2, text: long('同题甲二'), updated_at: NOW - 1000 },
    { id: 3, text: long('孤条丙丙'), updated_at: NOW - 2000 },
  ];
  const f = makeDb('min-cluster-size', rows);
  writeVectors(f.vectorsDb, [
    [1, [1, 0, 0, 0, 0, 0, 0, 0], rows[0].text],
    [2, [0.99, 0.02, 0, 0, 0, 0, 0, 0], rows[1].text],
    [3, [0, 1, 0, 0, 0, 0, 0, 0], rows[2].text],
  ]);
  const fake = makeFakeFetch();
  const r = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, fetchImpl: fake });
  assertEq(fake.calls(), 1, '只对"多条组"调 1 次（单条组不调）');
  assertEq(r.written, 1, '只写 1 条');
  const singleton = r.planned.find((x) => x.ids.length === 1);
  assertEq(singleton.action, 'skip-singleton', '单条组标注跳过原因');
  assert(singleton.reason.includes('minClusterSize'), '原因写明判据');
});
test('默认值就是 2（不许悄悄改回 1 —— 它直接决定每天往主库塞几条、进而挤占 recall 段）', () => {
  assertEq(D.CLUSTER_DEFAULTS.minClusterSize, 2, 'minClusterSize 默认 2');
});

// ── 06 执行：写库形态 + 幂等 + 跨机改 id ────────────────────────────────────
section('06 执行（写库形态 / 幂等 / 跨机改 id 不重复）');
test('apply：写入 N 条 distilled（标签前缀 + srcids + date + owner/visibility + pinned=0）', async () => {
  const rows = sampleRows(NOW, 6);
  const f = makeDb('apply', rows);
  writeVectors(f.vectorsDb, rows.map((r, i) => [r.id, [1, i * 0.001, 0, 0, 0, 0, 0, 0], r.text]));
  const fake = makeFakeFetch();
  const before = countRows(f.dbPath);
  const r = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake });
  assert(r.written >= 1, `至少写 1 条（实得 ${r.written}）`);
  assertEq(countRows(f.dbPath), before + r.written, '库条数 = 原条数 + 新写条数');
  for (const d of allDistilled(f.dbPath)) {
    assert(String(d.tags).startsWith('distilled '), '标签以 distilled 开头');
    assert(/src=d[0-9a-f]{16}/.test(d.tags), '带 src 键');
    assert(/srcids=\d/.test(d.tags), '带源 id 清单');
    assert(/\sdate=\d{8}/.test(d.tags), '带日期');
    assertEq(d.pinned, 0, 'pinned=0（方案 §5.1：不挤占 pinned 段）');
    assertEq(d.owner_user, OWNER, 'owner_user = 本机 owner');
    assertEq(d.visibility, 'private_owner', 'visibility 默认私有');
    assert(d.text.length > 0 && d.text.length <= 400, '结论非空且不超长');
  }
  assert(fs.existsSync(f.stateFile), 'apply 写 state');
  const st = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assertEq(st.schemaVersion, D.STATE_SCHEMA, 'state 带 schemaVersion');
  assert(st.cost.calls === fake.calls(), 'state 记账 = 实际调用数');
  assert(st.lastDailyLine.includes('提炼条数'), 'state 存日报行');
});
test('**幂等**：同日重跑 ⇒ 0 次新调用、0 条新写入（内容哈希去重生效）', async () => {
  const rows = sampleRows(NOW, 4);
  const f = makeDb('idempotent', rows);
  writeVectors(f.vectorsDb, rows.map((r) => [r.id, [1, 0, 0, 0, 0, 0, 0, 0], r.text]));
  const fake1 = makeFakeFetch();
  const r1 = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake1 });
  const fake2 = makeFakeFetch();
  const r2 = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake2 });
  assertEq(fake2.calls(), 0, '第二次 0 次模型调用');
  assertEq(r2.written, 0, '第二次 0 条写入');
  assertEq(r2.planned.every((x) => x.action !== 'call'), true, '全部走跳过分支');
  assertEq(countRows(f.dbPath), rows.length + r1.written, '库条数不变');
});
test('**跨机改 id 后重跑仍不重复**：同正文换新 id（模拟 merge-memory 灌高位段）⇒ 0 次调用', async () => {
  const rows = sampleRows(NOW, 3);
  const f = makeDb('xhost-a', rows);
  writeVectors(f.vectorsDb, rows.map((r) => [r.id, [1, 0, 0, 0, 0, 0, 0, 0], r.text]));
  const fake1 = makeFakeFetch();
  await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake1 });
  const written = allDistilled(f.dbPath);
  assert(written.length >= 1, '先有一批提炼条');

  // 模拟跨机合并：**同样的正文**、**全新的高位 id**，老 id 全部不在（内容哈希主键口径）
  const f2 = makeDb('xhost-b', rows.map((r, i) => ({ ...r, id: 9001 + i, tags: r.tags })));
  for (const d of written) {
    const meta = R.parseDistilledTags(d.tags);
    const db = new DatabaseSync(f2.dbPath);
    db.prepare(`INSERT INTO memories (text, tags, pinned, created_at, updated_at, owner_user, visibility) VALUES (?,?,0,?,?,?,?)`)
      .run(d.text, `distilled src=${meta.srcKey} srcids=${meta.srcIds.join(',')} date=${meta.date}`, NOW, NOW, OWNER, 'private_owner');
    db.close();
  }
  const fake2 = makeFakeFetch();
  const r2 = await D.runDistill({ memoryDb: f2.dbPath, vectorsDb: f2.vectorsDb, stateFile: f2.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake2 });
  assertEq(fake2.calls(), 0, 'id 变了但**内容键不变** ⇒ 不再调模型');
  assertEq(r2.written, 0, '不产出重复条');
  assertEq(countRows(f2.dbPath), rows.length + written.length, '库条数不变');
});
test('state 丢失也能挡（去重的 durable 源 = 库里的 src= 标签）', async () => {
  const rows = sampleRows(NOW, 3);
  const f = makeDb('durable-dedup', rows);
  writeVectors(f.vectorsDb, rows.map((r) => [r.id, [1, 0, 0, 0, 0, 0, 0, 0], r.text]));
  const fake1 = makeFakeFetch();
  await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake1 });
  fs.rmSync(f.stateFile, { force: true }); // 台账丢了
  const fake2 = makeFakeFetch();
  const r2 = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake2 });
  assertEq(fake2.calls(), 0, '靠库里的 src= 标签挡住（state 不是唯一防线）');
  assertEq(r2.written, 0, '不重复写');
});
test('同一组内 id 全换但正文同 ⇒ 仍只产出一次（第二次 run 的 planned 全非 call）', async () => {
  const f = makeDb('same-content', [{ id: 11, text: long('同一条正文'), updated_at: NOW }]);
  writeVectors(f.vectorsDb, [[11, [1, 0, 0, 0, 0, 0, 0, 0], long('同一条正文')]]);
  const fake = makeFakeFetch();
  const r1 = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake });
  assertEq(r1.written, 1, '先产出 1 条');
  const db = new DatabaseSync(f.dbPath); // 换 id 再来一条同正文
  db.prepare('INSERT INTO memories (id, text, tags, pinned, created_at, updated_at, owner_user, visibility) VALUES (?,?,?,0,?,?,?,?)')
    .run(4242, long('同一条正文'), '', NOW, NOW, OWNER, 'private_owner');
  db.close();
  const fake2 = makeFakeFetch();
  const r2 = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake2 });
  assertEq(fake2.calls(), 0, '内容级去重挡住（不是 id 级）');
  assertEq(r2.written, 0, '无新增');
});

// ── 07 不自我指涉：连续三天 ────────────────────────────────────────────────
section('07 不自我指涉（模拟连续三天）');
test('三天连跑：第 2/3 天的输入里**永远不出现 distilled 条**，且不出现"源自 distilled"的键', async () => {
  const f = makeDb('three-days', [{ id: 1, text: long('第一天的内容：提炼面 A'), updated_at: NOW }]);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], long('第一天的内容：提炼面 A')]]);
  const days = [NOW, NOW + 86400_000, NOW + 2 * 86400_000];
  const perDay = [];
  for (let d = 0; d < days.length; d += 1) {
    const t = days[d];
    // 每天造一条当天"新写"的记忆（模拟正常使用）
    const db = new DatabaseSync(f.dbPath);
    db.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at, owner_user, visibility) VALUES (?,?,0,?,?,?,?)')
      .run(long(`第 ${d + 1} 天的内容：提炼面 ${d + 1}`), '', t, t, OWNER, 'private_owner');
    db.close();
    const fake = makeFakeFetch();
    // 先算当天输入（= 当天提炼真正看到的东西），再跑
    const sel = D.selectInputs({ dbPath: f.dbPath, now: t, windowHours: 24, localOwner: OWNER });
    // 硬不变量：当天输入里**绝不能混进 distilled 条**（逐日现算，不靠计数自证）
    const distilledIdsBefore = new Set(allDistilled(f.dbPath).map((x) => x.id));
    for (const id of sel.accepted.map((x) => x.id)) assert(!distilledIdsBefore.has(id), `第 ${d + 1} 天输入里混进了 distilled 条 #${id}`);
    const r = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: t, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake, dirtyProbe: false });
    perDay.push({ day: d + 1, calls: fake.calls(), written: r.written, inputIds: sel.accepted.map((x) => x.id), distilledExcluded: sel.stats.distilledExcluded });
    // 每天都核对：所有 distilled 条的 tags 里，src 键必须来自**真实条**（不能来自 distilled 条）
    const distilledRows = allDistilled(f.dbPath);
    for (const drow of distilledRows) {
      const meta = R.parseDistilledTags(drow.tags);
      for (const sid of meta.srcIds) {
        const src = row(f.dbPath, sid);
        assert(src, `源 id ${sid} 必须存在`);
        assert(!String(src.tags).startsWith('distilled'), `源条 ${sid} 不得是 distilled 条（自我指涉）`);
      }
    }
  }
  assertEq(perDay[0].distilledExcluded, 0, '第 1 天输入里没有 distilled 可排');
  assert(perDay[1].distilledExcluded >= 1, '第 2 天：第 1 天的产物被显式排除');
  assert(perDay[2].distilledExcluded >= 1, '第 3 天：前几天的产物仍被排除（不叠摘要）');
  assert(perDay.every((x) => x.inputIds.length > 0), '每天仍有真实内容可提炼');
});

// ── 08 成本闸 ──────────────────────────────────────────────────────────────
section('08 成本闸（≤N 次/日 · ≤M token/日 · 超限即停 · 不重试）');
test('调用数上限：3 组但上限 1 ⇒ 只调 1 次 + 记停机原因', async () => {
  const rows = [
    { id: 1, text: long('A 主题内容甲甲甲甲'), updated_at: NOW },
    { id: 2, text: long('B 主题内容乙乙乙乙'), updated_at: NOW },
    { id: 3, text: long('C 主题内容丙丙丙丙'), updated_at: NOW },
  ];
  const f = makeDb('gate-calls', rows);
  writeVectors(f.vectorsDb, [
    [1, [1, 0, 0, 0, 0, 0, 0, 0], rows[0].text],
    [2, [0, 1, 0, 0, 0, 0, 0, 0], rows[1].text],
    [3, [0, 0, 1, 0, 0, 0, 0, 0], rows[2].text],
  ]);
  const fake = makeFakeFetch();
  const r = await D.runDistill({
    memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true,
    localOwner: OWNER, minClusterSize: 1, fetchImpl: fake, limits: { callsPerDay: 1, tokensPerDay: 150000 },
  });
  assertEq(fake.calls(), 1, '只调 1 次');
  assert(r.stopping && r.stopping.includes('调用数已达上限'), `停机原因写明上限（实得 ${r.stopping}）`);
  const st = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assertEq(st.cost.calls, 1, 'state 记账 1 次');
});
test('token 上限：预估超限 ⇒ 一次都不调', async () => {
  const rows = [{ id: 1, text: '内容'.repeat(300), updated_at: NOW }];
  const f = makeDb('gate-tokens', rows);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], rows[0].text]]);
  const fake = makeFakeFetch();
  const r = await D.runDistill({
    memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true,
    localOwner: OWNER, minClusterSize: 1, fetchImpl: fake, limits: { callsPerDay: 20, tokensPerDay: 50 },
  });
  assertEq(fake.calls(), 0, 'token 上限挡住');
  assert(r.stopping && r.stopping.includes('token'), `停机原因写明 token（实得 ${r.stopping}）`);
});
test('**不重试**：模型 500 ⇒ 该组只调一次、记 skipped、本轮继续（不重复调用）', async () => {
  const rows = [
    { id: 1, text: long('主题甲甲甲甲甲甲甲甲'), updated_at: NOW },
    { id: 2, text: long('主题乙乙乙乙乙乙乙乙'), updated_at: NOW },
  ];
  const f = makeDb('no-retry', rows);
  writeVectors(f.vectorsDb, [
    [1, [1, 0, 0, 0, 0, 0, 0, 0], rows[0].text],
    [2, [0, 1, 0, 0, 0, 0, 0, 0], rows[1].text],
  ]);
  const fake = makeFakeFetch({ failTimes: 1 });
  const r = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake });
  assertEq(fake.calls(), 2, '两组共 2 次调用（失败的那组没有重试）');
  const st = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert(Object.values(st.skipped).some((s) => String(s.reason).startsWith('model-error')), '失败组落 skipped 台账');
});
test('当日调用已满（跨轮）⇒ 本轮 0 调用', async () => {
  const rows = [{ id: 1, text: long('内容内容内容内容'), updated_at: NOW }];
  const f = makeDb('gate-cross-run', rows);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], rows[0].text]]);
  fs.writeFileSync(f.stateFile, JSON.stringify({
    schemaVersion: 1, cost: { date: D.localDateIso(NOW), calls: 20, promptTokens: 1000, completionTokens: 500 },
    processed: {}, skipped: {}, history: [], stats: {},
  }), 'utf8');
  const fake = makeFakeFetch();
  const r = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake });
  assertEq(fake.calls(), 0, '当日额度已满 ⇒ 不再调用');
  assert(r.stopping.includes('上限'), '停机原因');
});
test('同日失败过的组**不再重试**（跨轮也不重试）；换日才给第二次机会', async () => {
  const rows = [{ id: 1, text: long('主题甲甲甲甲甲甲'), updated_at: NOW }];
  const f = makeDb('no-retry-same-day', rows);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], rows[0].text]]);
  const failFake = makeFakeFetch({ failTimes: 1 });
  const r1 = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: failFake });
  assertEq(failFake.calls(), 1, '第一次调用失败（不重试）');
  assertEq(r1.calls[0].ok, false, '记录失败');
  // 同一天再跑 ⇒ 不再试（保护额度）
  const again = makeFakeFetch();
  const r2 = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW + 3600_000, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: again });
  assertEq(again.calls(), 0, '同日不重试');
  assertEq(r2.planned[0].action, 'skip-failed-today', '计划里写明同日不再试');
  // 换一天 ⇒ 允许再试一次（否则一次 429 会永久丢掉这一组）
  const nextDay = makeFakeFetch();
  const r3 = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW + 86400_000, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: nextDay });
  assertEq(nextDay.calls(), 1, '换日允许再试一次');
  assertEq(r3.written, 1, '这次成功写入');
});
test('单轮组数上限：计划 N 组但上限 1 ⇒ 只处理 1 组，且日报行写明"本轮处理 1/N 组"', async () => {
  const rows = [
    { id: 1, text: long('甲甲甲'), updated_at: NOW },
    { id: 2, text: long('乙乙乙'), updated_at: NOW },
    { id: 3, text: long('丙丙丙'), updated_at: NOW },
  ];
  const f = makeDb('capped', rows);
  writeVectors(f.vectorsDb, [
    [1, [1, 0, 0, 0, 0, 0, 0, 0], rows[0].text],
    [2, [0, 1, 0, 0, 0, 0, 0, 0], rows[1].text],
    [3, [0, 0, 1, 0, 0, 0, 0, 0], rows[2].text],
  ]);
  const fake = makeFakeFetch();
  const r = await D.runDistill({
    memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true,
    localOwner: OWNER, minClusterSize: 1, fetchImpl: fake, maxClustersPerRun: 1,
  });
  assertEq(fake.calls(), 1, '只处理上限内的组');
  assertEq(r.capped.plannedCalls, 3, '计划组数可见');
  assertEq(r.capped.processed, 1, '本轮处理数可见');
  assertEq(r.capped.capped, true, '标出被截断');
  assert(r.dailyLine.includes('本轮处理 1/3 组'), `日报行写明截断（实得 ${r.dailyLine}）`);
});

// ── 09 模型档与提示词 ──────────────────────────────────────────────────────
section('09 模型档（deepseek-flash · 本鱼链）与调用形态');
test('默认模型档 = deepseek-flash（**2026-09-21 主人拍板：记忆线一律走本鱼链**）', () => {
  assertEq(D.DEFAULT_LLM.model, 'deepseek-flash', '模型档');
  assertEq(D.DEFAULT_LLM.baseUrl, 'https://api.deepseek.com', 'DeepSeek 官方端点');
  assertEq(D.DEFAULT_LLM.credentialKey, 'DEEPSEEK_API_KEY', '凭证键名');
  assertEq(D.COST_LIMITS, { callsPerDay: 20, tokensPerDay: 150000 }, '成本闸现值（三项上限未变）');
});
test('请求体：关思考（deepseek-flash 默认开思考，会白烧 token）+ 带 key 回传（供匹配）', async () => {
  const rows = [{ id: 1, text: long('内容内容内容内容'), updated_at: NOW }];
  const f = makeDb('req-shape', rows);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], rows[0].text]]);
  const fake = makeFakeFetch();
  await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake });
  const seen = fake.seen[0];
  assertEq(seen.model, 'deepseek-flash', '实际请求模型');
  assertEq(seen.thinking, { type: 'disabled' }, '显式关思考');
  assert(seen.user.includes('【组 '), '提示词含组编号');
});
test('结论为空 ⇒ 不写库（宁缺勿滥），并记 skipped', async () => {
  const rows = [{ id: 1, text: long('流水账内容内容内容内容'), updated_at: NOW }];
  const f = makeDb('empty-conclusion', rows);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], rows[0].text]]);
  const fake = makeFakeFetch({ emptyFor: () => true });
  const r = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake });
  assertEq(r.written, 0, '空结论不写库');
  const st = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assert(Object.values(st.skipped).some((s) => s.reason.includes('无可提炼')), '记 skipped 可追溯');
});

// ── 10 回滚 ────────────────────────────────────────────────────────────────
section('10 回滚（按 tag 批量删除 + 快照 + 内容摘要回原状）');
test('回滚演练：写 N 条 ⇒ 列表 ⇒ dry-run 不删 ⇒ apply 删除后**内容摘要回到写入前**', async () => {
  const rows = sampleRows(NOW, 5);
  const f = makeDb('rollback', rows);
  writeVectors(f.vectorsDb, rows.map((r) => [r.id, [1, 0, 0, 0, 0, 0, 0, 0], r.text]));
  const beforeWrite = R.contentDigest(f.dbPath);
  const fake = makeFakeFetch();
  const r = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake });
  assert(r.written >= 1, '先写出一批提炼条');
  const afterWrite = R.contentDigest(f.dbPath);
  assertEq(afterWrite.allCount, beforeWrite.allCount + r.written, '全表条数 = 原条数 + 新写条数');
  assertEq(R.contentDigest(f.dbPath, { excludeTagsLike: 'distilled%' }).digest, beforeWrite.digest, '**真实（非派生）条一个字节都没被动**');
  assertEq(countRows(f.dbPath), rows.length + r.written, '全表条数增加了');

  const listed = R.listDistilled({ dbPath: f.dbPath });
  assertEq(listed.length, r.written, '能按 tag 全部列出来');

  const dry = R.rollbackDistilled({ dbPath: f.dbPath, apply: false });
  assertEq(dry.deleted, 0, 'dry-run 不删');
  assertEq(countRows(f.dbPath), rows.length + r.written, 'dry-run 后条数不变');

  const snapDir = path.join(f.dir, 'snapshots');
  const done = R.rollbackDistilled({ dbPath: f.dbPath, apply: true, snapshotDir: snapDir, now: NOW });
  assertEq(done.deleted, r.written, '删掉全部提炼条');
  assert(fs.existsSync(done.snapshot), '删除前 VACUUM INTO 快照存在');
  assert(fs.existsSync(done.rollbackFile), '生成一键恢复脚本');
  assertEq(countRows(f.dbPath), rows.length, '全表条数回到写入前');
  assertEq(R.contentDigest(f.dbPath).digest, beforeWrite.digest, '**内容摘要与写入前完全一致**（回到原状）');
  assertEq(allDistilled(f.dbPath).length, 0, '提炼条清空');
});
test('回滚只删带 distilled 前缀的条（按 key 定向回滚时不会误删真实记忆）', async () => {
  const rows = sampleRows(NOW, 4);
  const f = makeDb('rollback-scoped', rows);
  writeVectors(f.vectorsDb, rows.map((r) => [r.id, [1, 0, 0, 0, 0, 0, 0, 0], r.text]));
  const fake = makeFakeFetch();
  await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake });
  const listed = R.listDistilled({ dbPath: f.dbPath });
  const key = listed[0].srcKey;
  const r = R.rollbackDistilled({ dbPath: f.dbPath, apply: true, keys: [key], snapshotDir: path.join(f.dir, 'snap') });
  assertEq(r.deleted, 1, '只删指定 src 键那一条');
  assertEq(countRows(f.dbPath), rows.length + listed.length - 1, '其余提炼条与真实条都在');
  // 传一个"瞎编的 id"（真实记忆的 id）也必须删不动
  const r2 = R.rollbackDistilled({ dbPath: f.dbPath, apply: true, ids: [1], snapshotDir: path.join(f.dir, 'snap2') });
  assertEq(r2.deleted, 0, '非 distilled 条即使被点名也**删不动**（DELETE 恒带 tag 条件）');
  assertEq(countRows(f.dbPath), rows.length + listed.length - 1, '真实记忆条数不变');
});

// ── 11 日报行 ──────────────────────────────────────────────────────────────
section('11 日报行（条数 + 首行样本 + 当日调用数与 token）');
test('renderDailyLine：字段齐全', () => {
  const line = D.renderDailyLine({
    mode: 'apply',
    run: { inputs: 60, clustersPlanned: 7, written: 3, skippedDuplicate: 4, skippedOwner: 1, skippedFamily: 2, firstSample: '仓2 会话仓的恢复路径与配额口径' },
    cost: { calls: 3, promptTokens: 3000, completionTokens: 600 },
    limits: D.COST_LIMITS,
    stopping: null,
  });
  assert(line.includes('提炼条数 3'), '条数');
  assert(line.includes('首行样本'), '首行样本');
  assert(line.includes('当日调用 3/20'), '当日调用数/上限');
  assert(line.includes('当日 token 3600/150000'), '当日 token/上限');
});
test('renderDailyLine：有停机原因时显式写明', () => {
  const line = D.renderDailyLine({ mode: 'apply', run: {}, cost: { calls: 20 }, limits: D.COST_LIMITS, stopping: '当日调用数已达上限 20 次' });
  assert(line.includes('停机原因：当日调用数已达上限 20 次'), '超限必须在日报里留痕');
});
test('updateDailySection：段级替换幂等（同段重写不重复堆叠）', () => {
  const file = path.join(TMP, 'report-fixture.md');
  fs.writeFileSync(file, '# 日报\n\n## 摘要\n\n- x\n', 'utf8');
  D.updateDailySection({ file, line: '第一版' });
  D.updateDailySection({ file, line: '第二版' });
  const text = fs.readFileSync(file, 'utf8');
  assertEq((text.match(/## 🧪 记忆提炼/g) ?? []).length, 1, '段落唯一');
  assert(text.includes('第二版') && !text.includes('第一版'), '内容被子替换');
});

// ── 12 端到端：台账 + 写库 + 回滚 ─────────────────────────────────────────
section('12 端到端（台账补充输入 → 提炼 → 消费台账 → 回滚）');
test('A7 场景全链路：改 text 不动 updated_at ⇒ 提炼补上 ⇒ 台账被消费', async () => {
  const f = makeDb('e2e-dirty', [{ id: 1, text: long('原始正文：跨机同步口径'), updated_at: NOW - 72 * 3600_000 }]);
  writeVectors(f.vectorsDb, [[1, [1, 0, 0, 0, 0, 0, 0, 0], long('原始正文：跨机同步口径')]]);
  const db = new DatabaseSync(f.dbPath);
  db.prepare('UPDATE memories SET text = ? WHERE id = ?').run(long('被勘误后的正文：跨机同步口径与挡推处置'), 1);
  db.close();
  // 该条 updated_at 是 3 天前 ⇒ 增量窗口抓不到，只有台账能补
  const win = D.selectInputs({ dbPath: f.dbPath, now: NOW, windowHours: 24, localOwner: OWNER });
  assertEq(win.accepted.length, 0, '增量窗口确实抓不到（A7 盲区复现）');
  const fake = makeFakeFetch();
  const r = await D.runDistill({ memoryDb: f.dbPath, vectorsDb: f.vectorsDb, stateFile: f.stateFile, now: NOW, apply: true, localOwner: OWNER, minClusterSize: 1, fetchImpl: fake });
  assertEq(fake.calls(), 1, '台账把这条补进输入 ⇒ 调了 1 次');
  assertEq(r.written, 1, '产出 1 条提炼');
  const led = D.readDirtyIds(f.vectorsDb);
  assertEq(led.ids, [], '台账已消费（open=0）');
  const st = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  assertEq(st.cost.calls, 1, '成本台账记账');
  // 回滚
  const roll = R.rollbackDistilled({ dbPath: f.dbPath, apply: true, snapshotDir: path.join(f.dir, 'snap') });
  assertEq(roll.deleted, 1, '回滚掉提炼条');
  assertEq(countRows(f.dbPath), 1, '真实条不受影响');
});
