/**
 * test/test-wiring.mjs —— 接线夹具（`index.js` 的两处接线是否真接上）
 *
 * 为什么要静态断言：`regression.mjs` 对照的 fork 侧是**部署实体**，不是本仓 `src/lib`；
 * 所以它证明不了"仓内这份 index.js 已经把写侧/删侧接上线"。这个夹具补的正是那一格。
 *
 * 断言（W1–W6）：
 *   W1 `forget(id)` 走 `forgetWithLedger(`，不再是裸 DELETE
 *   W2 `forget(id)` 里不再出现 `DELETE FROM memories WHERE id = ?`（裸删已废止）
 *   W3 `memory_write` 落库后调 `fireLineageAnchor(`（写侧预埋）
 *   W4 `DSH_MEMORY_LINEAGE` 开关分支在位（off ⇒ 零动作）
 *   W5 接线三条硬约束的**结构**还在：fire-and-forget（`void fireLineageAnchor`）、懒加载、fail-open catch
 *   W6 阴性对照：把源码里的接线抹掉（字符串替换）⇒ 上面几条必须翻红
 *
 * 纯字符串检查、零依赖、不加载插件（加载它要 peer 依赖，源码目录没有）。
 * 跑法：node dsh-memory-local/test/test-wiring.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src', 'index.js');

let pass = 0;
let fail = 0;
const fails = [];

function check(label, cond) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(label);
  }
  console.log(`${cond ? '  ok   ' : '  FAULT'}  ${label}`);
}

/** 取 `forget(id) { ... }` 这一段（按大括号配平，够用：这一段没有嵌套函数字面量的花括号歧义）。 */
function forgetBodyOf(text) {
  const start = text.indexOf('\tforget(id) {');
  if (start < 0) return null;
  let i = text.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

/** 取 `memory_write` 那个工具的 execute 段（到 `return {` 之后一段为止，够判接线）。 */
function writeExecuteBodyOf(text) {
  const anchor = text.indexOf('async execute(args, exec)');
  if (anchor < 0) return null;
  const end = text.indexOf('name: "memory_search"', anchor);
  return text.slice(anchor, end > 0 ? end : anchor + 4000);
}

/** 跑一整套断言，返回「失败条数」（给阴性对照用）。 */
function runChecks(text, { label = '' } = {}) {
  const before = { pass, fail };
  pass = 0;
  fail = 0;
  const forgetBody = forgetBodyOf(text) ?? '';
  const writeBody = writeExecuteBodyOf(text) ?? '';

  check(`${label}W1 forget() 走 forgetWithLedger(`, forgetBody.includes('forgetWithLedger('));
  check(`${label}W2 forget() 里没有裸 DELETE`, !forgetBody.includes('DELETE FROM memories WHERE id = ?'));
  check(`${label}W3 memory_write 调 fireLineageAnchor(`, writeBody.includes('void fireLineageAnchor('));
  check(`${label}W4 DSH_MEMORY_LINEAGE 开关分支在位`, writeBody.includes('DSH_MEMORY_LINEAGE'));
  check(
    `${label}W5 三条硬约束结构在位（懒加载 / fail-open catch / 不 await）`,
    text.includes('async function loadLineageAuto()') &&
      text.includes('观察血缘预埋异常（已忽略，不影响写入）') &&
      !writeBody.includes('await fireLineageAnchor('),
  );
  check(`${label}W6 归档根解析走 resolveRemovedRoot + isFamilyDbPath`, forgetBody.includes('resolveRemovedRoot(') && forgetBody.includes('isFamilyDbPath('));

  const f = fail;
  pass = before.pass;
  fail = before.fail;
  return f;
}

const text = fs.readFileSync(SRC, 'utf8');
const faults = runChecks(text);
if (faults > 0) {
  fail += faults;
  fails.push(`接线断言有 ${faults} 条不成立`);
} else {
  pass += 6;
}

/* ---------------- 阴性对照：把接线抹掉，断言必须翻红 ---------------- */

const mutated = text
  .replace('forgetWithLedger({', 'deleteSomething({')
  .replace('void fireLineageAnchor(', 'void noopAnchor(')
  .replace('async function loadLineageAuto()', 'async function _gone()');
const mutatedFaults = runChecks(mutated, { label: '[阴性对照] ' });
if (mutatedFaults >= 2) {
  pass += 1;
  console.log(`  ok    阴性对照：抹掉接线后有 ${mutatedFaults} 条翻红（断言不是恒真）`);
} else {
  fail += 1;
  fails.push(`阴性对照只翻红 ${mutatedFaults} 条（断言可能恒真）`);
}

console.log('');
console.log(`接线夹具：${pass + fail} 条 · 绿 ${pass} · 红 ${fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of fails) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('全部通过（含阴性对照）');
}
