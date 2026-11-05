/**
 * _test/test-mem-conflict.mjs —— 「硬矛盾」判据夹具
 *
 * 覆盖：
 *   C1–C11 判据本职（日期/数值/枚举三个取值域 + 未命中档）
 *   C12     tag 幂等 + 只读单边
 *   P1–P5   解析器守门（防判据被弱化成"猜"）
 *   N1–N3   **阴性对照**：把「相交」退化成「等值」的变异体，必须让 C1/C4/C7 翻红
 *   R1–R3   判词表外置的验证：换一份词表 ⇒ 判据跟着变（证明判据不在代码里）
 *
 * 纯函数、零 IO（只读自己的 lib 与词表）、不碰库。
 * 用法：node memory-db-tools/_test/test-mem-conflict.mjs [--all]
 *   --all 追加接线层 §A 的取值抽取断言（X1–X8）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  judge, parseTimeRange, parseNumber, addTag, contradictsOf,
  norm, ENUM_SLOTS, R_HARD, R_NONE, R_UNKNOWN,
  factKeyOf, valueOf, slotOf, compareWithSlot, loadRules, RULES,
} from '../lib-mem-conflict.mjs';

const WITH_EXTRACT = process.argv.includes('--all') || process.argv.includes('--extract');

let pass = 0, fail = 0;
const fails = [];

function eq(label, got, want) {
  const ok = got === want;
  if (ok) pass++;
  else { fail++; fails.push(`${label}  期望 ${want} · 实得 ${got}`); }
  console.log(`${ok ? '  ok   ' : '  FAULT'}  ${label}  → ${got}`);
}

/* ---------------- C1–C11：判据本职 ---------------- */

const C = [
  ['C1  粒度升格后相交',         'person.birthday', '1990年3月', '1990-03-15', R_NONE],
  ['C2  年度不相交',             'person.birthday', '1990年3月', '1991年3月', R_HARD],
  ['C3  一侧无年份',             'person.birthday', '3月15日', '1990-03-15', R_UNKNOWN],
  ['C4  点落在区间内',           'person.weight', '72 kg', '70~74 kg', R_NONE],
  ['C5  两点不相交',             'person.weight', '72 kg', '78 kg', R_HARD],
  ['C6  单位不同不换算',         'person.weight', '72 kg', '158 斤', R_UNKNOWN],
  ['C7  点落在区间内（同谓词）',  'service.pinned', '12~20 条', '18 条', R_NONE],
  ['C7b 上限与现值不可比',       'service.pinned', '≤12 条', '12 条', R_UNKNOWN],
  ['C8  谓词不同不可比',         'service.recall', '现值 5 条', '上限 20 条', R_UNKNOWN],
  ['C9  枚举互斥',               'person.gender', '男', '女', R_HARD],
  ['C10 自由文本不进白名单',      'person.taste', '不吃香菜', '讨厌香菜', R_UNKNOWN],
  ['C11 无 factKey',             '', '任意', '任意', R_UNKNOWN],
];
for (const [label, key, a, b, want] of C) {
  eq(label, judge({ factKey: key, value: a }, { factKey: key, value: b }), want);
}

/* ---------------- C12：tag 幂等 + 只读单边 ---------------- */

{
  let tags = 'recall:manual fact:person.birthday';
  tags = addTag(tags, 'contradicts:1000001');
  tags = addTag(tags, 'contradicts:1000001');
  eq('C12 追加 tag 不重复', tags.split(/\s+/).filter((t) => t === 'contradicts:1000001').length, 1);

  const onlyForward = contradictsOf('contradicts:1000001 contradicted-by:1000002 supersedes:1');
  eq('C12b 判定只读 contradicts:', onlyForward.length, 1);
}

/* ---------------- 解析器守门 ---------------- */

eq('P1 日期区间写法', !!parseTimeRange('1990-03~1990-05'), true);
eq('P2 数字带单位', parseNumber('12 条')?.vhi, 12);
eq('P3 无单位不判', parseNumber('12') === null, true);
eq('P4 全角归一', norm('１９９０年３月'), '1990年3月');
eq('P5 枚举白名单有条目', Object.keys(ENUM_SLOTS).length >= 2, true);

/* ---------------- 阴性对照：等值变异体必须让 C1/C4/C7 翻红 ---------------- */

// 变异体：日期与数值都用「等值」代替「相交」（正是判据禁的那种退化）
function judgeEqualityMutant(a, b) {
  const ka = norm(a?.factKey), kb = norm(b?.factKey);
  if (!ka || !kb || ka !== kb) return R_UNKNOWN;
  const va = norm(a?.value), vb = norm(b?.value);
  if (!va || !vb) return R_UNKNOWN;
  const ta = parseTimeRange(va), tb = parseTimeRange(vb);
  if (ta && tb) return va === vb ? R_NONE : R_HARD;
  const na = parseNumber(va), nb = parseNumber(vb);
  if (na && nb) {
    if (na.unit !== nb.unit || na.predicate !== nb.predicate) return R_UNKNOWN;
    return na.vlo === nb.vlo && na.vhi === nb.vhi ? R_NONE : R_HARD;
  }
  return judge(a, b);
}

const control = [
  ['N1 C1 变异后应翻红', 'person.birthday', '1990年3月', '1990-03-15', R_HARD],
  ['N2 C4 变异后应翻红', 'person.weight', '72 kg', '70~74 kg', R_HARD],
  ['N3 C7 变异后应翻红', 'service.pinned', '12~20 条', '18 条', R_HARD],
];
let controlRed = 0;
for (const [label, key, a, b, wantRed] of control) {
  const got = judgeEqualityMutant({ factKey: key, value: a }, { factKey: key, value: b });
  const isRed = got !== judge({ factKey: key, value: a }, { factKey: key, value: b });
  if (isRed && got === wantRed) { controlRed++; console.log(`  ok    ${label}  → ${got}（翻红成功）`); }
  else console.log(`  FAULT ${label}  → ${got}（没翻红 ⇒ 判据可能被放松）`);
}
if (controlRed === control.length) pass++;
else { fail++; fails.push(`阴性对照只翻红 ${controlRed}/${control.length}`); }

/* ---------------- 判词表外置的验证 ---------------- */

{
  // R1：随包词表能被解析，且判据所需字段齐全（机制在代码、判词在表里）
  eq('R1 词表可解析且有 units', Array.isArray(RULES.units) && RULES.units.length > 0, true);
  eq('R1b 词表可解析且有 enumSlots', typeof RULES.enumSlots === 'object' && Object.keys(RULES.enumSlots).length > 0, true);

  // R2：换一份词表 ⇒ 判据跟着变（把枚举白名单里的槽删掉，同一个判定就从 hard 变 unknown）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-conflict-rules-'));
  const custom = path.join(tmp, 'rules.json');
  const base = JSON.parse(fs.readFileSync(new URL('../mem-conflict-rules.json', import.meta.url), 'utf8'));
  const stripped = JSON.parse(JSON.stringify(base));
  stripped.enumSlots = {};
  fs.writeFileSync(custom, JSON.stringify(stripped), 'utf8');
  try {
    const alt = loadRules(custom);
    const g = judge({ factKey: 'person.gender', value: '男' }, { factKey: 'person.gender', value: '女' }, alt);
    eq('R2 自定义词表：删掉枚举槽后同一判定 → unknown', g, R_UNKNOWN);
    // 机制没变的部分仍然工作（说明变的是"判词"，不是"判据被关掉"）
    eq('R2b 自定义词表：日期判据仍工作',
      judge({ factKey: 'k', value: '2026-01-01' }, { factKey: 'k', value: '2026-06-01' }, alt), R_HARD);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // R3：词表缺字段时必须抛（静默变成"什么都不能判"是更坏的结果）
  const bad = path.join(os.tmpdir(), `mem-conflict-bad-${process.pid}.json`);
  fs.writeFileSync(bad, JSON.stringify({ verdicts: {} }), 'utf8');
  let threw = false;
  try { loadRules(bad); } catch { threw = true; }
  finally { fs.rmSync(bad, { force: true }); }
  eq('R3 词表缺字段 ⇒ 抛错不静默', threw, true);
}

/* ---------------- §A 接线层：取值抽取（--all 才跑） ---------------- */

if (WITH_EXTRACT) {
  console.log('\n── 接线层 §A（取值抽取 · 零猜测） ──');
  eq('X1 一个 fact: ⇒ 取到槽', factKeyOf('recall:manual fact:person.birthday'), 'person.birthday');
  eq('X2 两个 fact: ⇒ 不猜', factKeyOf('fact:person.birthday fact:person.weight'), null);
  eq('X3 无 fact: ⇒ null', factKeyOf('recall:manual'), null);
  eq('X4 val: tag 优先', valueOf('fact:person.birthday val:1990年3月', '随便写的正文'), '1990年3月');
  eq('X5 正文带空格 ⇒ 不抠子串', valueOf('fact:person.birthday', '生日是 1990年3月'), null);
  eq('X6 正文单 token ⇒ 可作取值', valueOf('fact:person.birthday', '1990年3月'), '1990年3月');
  eq('X7 两个 val: ⇒ 不猜', valueOf('fact:person.birthday val:1990年3月 val:1991年3月', 'x'), null);
  {
    const fresh = { id: 3, tags: 'fact:person.birthday val:1990-03-15', text: '生日' };
    const older = { id: 2, tags: 'fact:person.birthday val:1990年3月', text: '生日' };
    const miss = { id: 4, tags: 'fact:person.birthday val:1991年3月', text: '生日' };
    eq('X8a 同槽+相交 ⇒ 不命中', compareWithSlot(fresh, [older]).verdict, R_NONE);
    eq('X8b 同槽+不相交 ⇒ 命中', compareWithSlot(fresh, [miss]).verdict, R_HARD);
    eq('X8c 取不出槽 ⇒ unknown', compareWithSlot({ id: 5, tags: '', text: '随便' }, [older]).verdict, R_UNKNOWN);
  }
}

/* ---------------- 汇总 ---------------- */

console.log('');
console.log(`夹具：${pass + fail} 条 · 绿 ${pass} · 红 ${fail}${WITH_EXTRACT ? '（含接线层 §A）' : ''}`);
if (fail) {
  console.log('失败项：');
  for (const f of fails) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('全部通过（含阴性对照 3/3 翻红）');
}
