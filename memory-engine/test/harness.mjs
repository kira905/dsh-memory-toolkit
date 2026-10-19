// 记忆引擎 v2 · 离线层 —— 零依赖测试 runner
const cases = [];
let passed = 0;
let failed = 0;
const failures = [];

export function test(name, fn) {
  cases.push({ name, fn });
}

export function skip(name, why = '') {
  cases.push({ name, fn: null, why });
}

export async function runAll() {
  for (const c of cases) {
    if (!c.fn) {
      console.log(`  ⏭️  ${c.name}${c.why ? `（跳过：${c.why}）` : ''}`);
      continue;
    }
    const t0 = Date.now();
    try {
      await c.fn();
      passed += 1;
      console.log(`  ✅ ${c.name}  (${Date.now() - t0}ms)`);
    } catch (e) {
      failed += 1;
      const msg = String(e && e.stack ? e.stack : e);
      failures.push({ name: c.name, msg });
      console.log(`  ❌ ${c.name}`);
      console.log(`     ${msg.split('\n').slice(0, 6).join('\n     ')}`);
    }
  }
  console.log('');
  console.log(`—— 合计 ${passed + failed} 项：通过 ${passed} / 失败 ${failed} ——`);
  return { passed, failed, failures };
}

export function assert(cond, msg = '断言失败') {
  if (!cond) throw new Error(msg);
}

export function assertEq(actual, expected, msg = '') {
  // 数组/对象按 JSON 深度比较（否则 [0,1,0] !== [0,1,0] 会假红）
  const deep = (actual !== null && typeof actual === 'object') || (expected !== null && typeof expected === 'object');
  const same = deep ? JSON.stringify(actual) === JSON.stringify(expected) : actual === expected;
  if (!same) {
    throw new Error(`${msg ? msg + '：' : ''}期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

export function assertDeepEq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg ? msg + '：' : ''}期望 ${b}，实际 ${a}`);
}

export async function assertThrows(fn, msg = '期望抛错但未抛') {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) throw new Error(msg);
  return threw;
}

export function section(title) {
  console.log(`\n▶ ${title}`);
}

export { passed, failed, failures };
