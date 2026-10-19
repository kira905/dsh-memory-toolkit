// 记忆引擎 v2 · 离线层 —— policy 来源（方案 §4 B 点）单测
//
// 覆盖：① persona 块标量抽取；② 段化规则（【…】/`- 【…】`/`##`、≤400 字硬上限、超长按句切）；
//   ③ 段身份锚（refId 稳定 / 唯一 / 与正文无关 ⇒ 改正文是"同一条换 text_hash"）；
//   ④ 与 memory-source 同形状（sync/sweep 会按方法名硬调用）；⑤ `sync --source policy` 端到端 + 幂等；
//   ⑥ **默认行为不变**（不传 --source 仍走 memory）。
import fs from 'node:fs';
import path from 'node:path';
import { test, assert, assertEq, section } from './harness.mjs';
import { makeTempRoot, makeMemoryDb, sampleRows } from './fixtures.mjs';
import {
  POLICY_MAX_CHARS,
  extractPersonaText,
  segmentText,
  scanPolicySources,
  openPolicySource,
  policyRefId,
  normalizeDocPath,
} from '../lib/policy-source.mjs';
import { openDataSource, KNOWN_SOURCES } from '../lib/cli-util.mjs';
import { openVectorsStore, countVectors, getMetaFor, META_KEYS } from '../lib/vectors-store.mjs';
import { runIncrementalSync } from '../lib/sync.mjs';
import { createStubEmbedder } from '../lib/embedder.mjs';
import { openMemorySource } from '../lib/memory-source.mjs';
import { openPitfallSource } from '../lib/pitfall-source.mjs';

export const __section = 'B 点 · policy 段源（抽取 / 段化 / 契约 / sync 端到端）';

const TMP = makeTempRoot('memv2-policy-');

/** 造一棵隔离语料树（persona + skills），返回 { personaDir, skillsRoot } */
function makeCorpus(name) {
  const root = path.join(TMP.root, name);
  const personaDir = path.join(root, '.agent-presets', 'demo');
  const skillsRoot = path.join(root, 'skills');
  fs.mkdirSync(personaDir, { recursive: true });
  fs.mkdirSync(path.join(skillsRoot, 'demo-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(personaDir, 'agent.cordis.yml'),
    [
      '# 注释行（不进 persona）',
      '- id: persona',
      '  config:',
      '    prefix: |-',
      '      你是本鱼。',
      '',
      '      【身份】软萌鲸鱼娘。',
      '',
      '      【协作偏好】',
      '      - 【规矩甲】甲甲甲。',
      '      - 【规矩乙】乙乙乙。',
      '',
      '      【能力】能干活。',
      '    suffix: |-',
      '      不该被抽进来。',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(skillsRoot, 'demo-skill', 'SKILL.md'),
    ['---', 'name: demo-skill', '---', '# demo', '', '## 一、第一段', '内容内容。', '', '## 二、第二段', '更多内容。'].join('\n'),
    'utf8',
  );
  return { root, personaDir, skillsRoot };
}

section('① persona 块标量抽取（extractPersonaText）');
test('抽 prefix: |- 的块内容，遇到去缩进行即停（suffix 不进）', () => {
  const { personaDir } = makeCorpus('c1');
  const raw = fs.readFileSync(path.join(personaDir, 'agent.cordis.yml'), 'utf8');
  const t = extractPersonaText(raw);
  assert(t.includes('你是本鱼。'), '应含首行');
  assert(t.includes('【身份】'), '应含 【身份】');
  assert(t.includes('【规矩甲】'), '应含列表式 【规矩甲】');
  assert(!t.includes('不该被抽进来'), 'suffix 块不得混入');
  assert(!t.includes('# 注释行'), '块外注释不得混入');
});
test('抽不到块标量 ⇒ 退回整份文本（不抛错、不断链）', () => {
  const t = extractPersonaText('随便一段文本\n没有块标量');
  assertEq(t, '随便一段文本\n没有块标量');
});

section('② 段化规则');
test('persona：行首 【…】 与 `- 【…】` 都算段起点', () => {
  const text = '你是本鱼。\n\n【身份】甲。\n\n【偏好】\n- 【规矩甲】甲甲。\n- 【规矩乙】乙乙。\n';
  const segs = segmentText(text, { kind: 'persona' });
  const labels = segs.map((s) => s.section);
  assert(labels.some((x) => x.includes('【身份】')), `应有 【身份】段：${labels.join(' | ')}`);
  assert(labels.some((x) => x.includes('【规矩甲】')), `应有 【规矩甲】段：${labels.join(' | ')}`);
  assert(labels.some((x) => x.includes('【规矩乙】')), `应有 【规矩乙】段：${labels.join(' | ')}`);
});
test('markdown：按 ## / ### 切小节', () => {
  const segs = segmentText('前言\n\n## 甲\n甲甲\n\n### 乙\n乙乙\n', { kind: 'markdown' });
  assert(segs.some((s) => s.section.startsWith('## 甲')), '应有 ## 甲');
  assert(segs.some((s) => s.section.startsWith('### 乙')), '应有 ### 乙');
});
test('≤400 字硬上限：长段按句切，且无一段超上限', () => {
  const long = `## 长段\n${'这是一句很长的话。'.repeat(80)}`;
  const segs = segmentText(long, { kind: 'markdown' });
  assert(segs.length > 1, `应被切成多段，实际 ${segs.length}`);
  for (const s of segs) assert(s.text.length <= POLICY_MAX_CHARS, `段超上限：${s.text.length}`);
});
test('超长无标点块：硬切到上限内', () => {
  const segs = segmentText('## 硬切\n' + 'x'.repeat(1000), { kind: 'markdown' });
  assert(segs.length >= 3, `应硬切多段，实际 ${segs.length}`);
  for (const s of segs) assert(s.text.length <= POLICY_MAX_CHARS, `段超上限：${s.text.length}`);
});

section('③ 段身份锚（refId）');
test('refId 稳定：同输入两次扫描逐条相同', () => {
  const { personaDir, skillsRoot } = makeCorpus('c3');
  const a = scanPolicySources({ personaDir, skillsRoot });
  const b = scanPolicySources({ personaDir, skillsRoot });
  assertEq(a.map((x) => x.refId), b.map((x) => x.refId), 'refId 序列应逐条相同');
  assert(a.length > 0, '应有段');
});
test('refId 唯一（同文件同名小节重复出现也不撞）', () => {
  const { personaDir, skillsRoot } = makeCorpus('c3b');
  const segs = scanPolicySources({ personaDir, skillsRoot });
  const set = new Set(segs.map((s) => s.refId));
  assertEq(set.size, segs.length, `refId 应唯一：${segs.length} 段 / ${set.size} 唯一`);
});
test('refId 只由「文件+段锚+分片号」决定 ⇒ 改正文不动 refId（增量重编码而非产生孤儿）', () => {
  const id1 = policyRefId('/x/a.md', '## 甲#1', 1);
  const id2 = policyRefId('/x/a.md', '## 甲#1', 1);
  const id3 = policyRefId('/x/a.md', '## 甲#1', 2);
  assertEq(id1, id2, '同参应同 id');
  assert(id1 !== id3, '不同分片号应不同 id');
  assertEq(id1.length, 16, '应为 16 位 hex');
  assert(/^[0-9a-f]{16}$/.test(id1), '应为 hex');
});
test('normalizeDocPath：反斜杠转正斜杠 + 盘符小写', () => {
  const winPath = path.win32.join('Q:', 'A', 'b', 'C.MD');
  const expected = path.win32.join('q:', 'A', 'b', 'C.MD').replace(/\\/g, '/');
  assertEq(normalizeDocPath(winPath), expected);
});

section('④ 契约：与 memory-source / pitfall-source 同形状');
test('policy 源具备 sync/sweep/recall 硬调用的全部方法', () => {
  const { personaDir, skillsRoot } = makeCorpus('c4');
  const src = openPolicySource({ segments: scanPolicySources({ personaDir, skillsRoot }) });
  for (const m of ['count', 'maxUpdatedAt', 'idRange', 'pinnedIds', 'incrementalPage', 'segment', 'getById', 'allTexts', 'allTags', 'ftsSearch', 'close']) {
    assert(typeof src[m] === 'function', `缺方法 ${m}`);
  }
  assertEq(src.sourceName, 'policy');
  assertEq(src.pinnedIds(), []);
  assertEq(src.ftsSearch(), { error: 'policy 段源无 FTS5（policy source 无 FTS 补位路）' });
  const r = src.idRange();
  assert(r.n === src.count(), 'idRange.n 应等于 count()');
});
test('segment / incrementalPage 返回行必含 id/text/updated_at（缺 updated_at 会写 undefined 进向量）', () => {
  const { personaDir, skillsRoot } = makeCorpus('c4b');
  const src = openPolicySource({ segments: scanPolicySources({ personaDir, skillsRoot }) });
  const rng = src.idRange();
  const rows = src.segment(rng.lo, Math.min(rng.hi, rng.lo + 1)).concat(src.incrementalPage(0, null, 3));
  assert(rows.length > 0, '应有行');
  for (const r of rows) {
    assert(r.id !== undefined && r.text !== undefined && r.updated_at !== undefined, `行字段缺失：${JSON.stringify(Object.keys(r))}`);
    assert(typeof r.updated_at === 'number' && Number.isFinite(r.updated_at), 'updated_at 应为有限数字');
  }
});
test('KNOWN_SOURCES 含 policy；openDataSource("policy") 可开、未知来源仍抛错', () => {
  assert(KNOWN_SOURCES.includes('policy'), 'KNOWN_SOURCES 应含 policy');
  const { personaDir, skillsRoot } = makeCorpus('c4c');
  const src = openDataSource('policy', { policyPersonaDir: personaDir, policySkillsRoot: skillsRoot });
  assert(src.sourceName === 'policy' && src.count() > 0, '应开出非空 policy 源');
  let threw = false;
  try { openDataSource('nope', {}); } catch { threw = true; }
  assert(threw, '未知来源应抛错');
});

section('⑤ sync --source policy 端到端 + 幂等 + 不串味');
test('sync policy：写入 source=policy，条数 = 段数；重跑同哈希跳过', async () => {
  const { personaDir, skillsRoot } = makeCorpus('c5');
  const segs = scanPolicySources({ personaDir, skillsRoot });
  const store = openVectorsStore(path.join(TMP.root, 'c5', 'v.db'), { create: true });
  const embedder = createStubEmbedder({ dim: 64, modelId: 'stub' });
  const src = openPolicySource({ segments: segs });
  const r1 = await runIncrementalSync({ source: src, store, embedder, modelId: 'stub', dim: 64, sourceName: 'policy' });
  assertEq(r1.encoded, segs.length, '首次应全量编码');
  assertEq(countVectors(store.db, 'policy'), segs.length, '应写入同条数向量');
  assertEq(countVectors(store.db, 'memory'), 0, '不得写到 memory 源');
  const r2 = await runIncrementalSync({ source: openPolicySource({ segments: segs }), store, embedder, modelId: 'stub', dim: 64, sourceName: 'policy' });
  assertEq(r2.encoded, 0, '重跑应同哈希跳过（幂等，零重编码）');
  assertEq(r2.vectorsAfter, segs.length, '向量条数应保持不变（无新增/重复）');
  assertEq(r2.skippedSameHash, r2.scanned, '本轮扫到的应全部同哈希跳过');
  // ⚠️ 语义说明（实测口径，别写成"每轮都全表重扫"）：水位 = `max(updated_at)`，而 policy 段的
  //    `updated_at` = **文件 mtime** ⇒ 同文件的多段共享同一时间戳，水位一推进就把整个文件带过去了
  //    ⇒ 第二轮只重扫「mtime 最新的那一批」（可能少于全量）。这是**设计内**行为（与 memory 源同款
  //    watermark 语义），不变量是「不重编码、条数不变」；漏改由 `sweep --source policy` 按 text_hash 兜底。
  assert(r2.scanned <= segs.length, `本轮扫描数不应超过全量：${r2.scanned} vs ${segs.length}`);
  store.db.close();
});
test('跨源不串味：跑完 policy 后 memory 侧四类水位键不受影响', async () => {
  const { personaDir, skillsRoot } = makeCorpus('c5b');
  const vpath = path.join(TMP.root, 'c5b', 'v.db');
  const mdb = makeMemoryDb(path.join(TMP.root, 'c5b', 'memory.db'), sampleRows(6));
  const store = openVectorsStore(vpath, { create: true });
  const embedder = createStubEmbedder({ dim: 32, modelId: 'stub' });
  const mem = openMemorySource(mdb);
  await runIncrementalSync({ source: mem, store, embedder, modelId: 'stub', dim: 32, sourceName: 'memory' });
  const before = ['modelId', 'dim', 'lastIncrementalSyncAt', 'hashSweepCursor'].map((k) => getMetaFor(store.db, META_KEYS[k], 'memory'));
  await runIncrementalSync({ source: openPolicySource({ segments: scanPolicySources({ personaDir, skillsRoot }) }), store, embedder, modelId: 'stub', dim: 32, sourceName: 'policy' });
  const after = ['modelId', 'dim', 'lastIncrementalSyncAt', 'hashSweepCursor'].map((k) => getMetaFor(store.db, META_KEYS[k], 'memory'));
  assertEq(after, before, '记忆侧四类水位键应逐字节不变');
  assert(countVectors(store.db, 'policy') > 0, 'policy 应有向量');
  store.db.close();
});

section('⑥ 默认行为不变（不传 --source 仍走 memory）');
test('openDataSource("memory") 仍是记忆源、pitfall 仍是坑源', () => {
  const mdb = makeMemoryDb(path.join(TMP.root, 'c6', 'memory.db'), sampleRows(4));
  const msrc = openDataSource('memory', { memoryDb: mdb });
  assertEq(msrc.sourceName, undefined, 'memory-source 无 sourceName 字段（旧形状不变）');
  assertEq(msrc.count(), 4);
  const pjson = path.join(TMP.root, 'c6', 'pitfalls.json');
  fs.mkdirSync(path.dirname(pjson), { recursive: true });
  fs.writeFileSync(pjson, JSON.stringify({ schemaVersion: 1, pitfalls: [{ id: 'a'.repeat(16), normText: 'x', lastSeen: 1 }] }), 'utf8');
  const psrc = openDataSource('pitfall', { pitfallsFile: pjson });
  assertEq(psrc.sourceName, 'pitfall');
  assertEq(psrc.count(), 1);
  const okP = openPitfallSource(pjson);
  assertEq(typeof okP.count, 'function');
});
