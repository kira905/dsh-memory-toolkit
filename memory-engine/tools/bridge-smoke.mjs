// 记忆引擎 · 离线层 —— 编码桥联调（编码通道契约）
//
// 一个进程管全流程：起桥 → 轮询 /health 直到模型就绪 → 打两个 /encode →
// 确认第二个实例顺延到下一个端口 → 确认非回环绑定被拒 → 关桥。
// 为什么不起后台进程：SSH 会话一结束会把 detached 进程一起带走（跨机踩过的坑），
// 「起 + 测 + 关」必须落在同一条命令里 —— 本脚本就是那条命令。
import { startBridge } from '../serve.mjs';
import { parseArgs, isMainEntry } from '../lib/cli-util.mjs';

const FALLBACK_PORT = 8201;
const POLL_MS = 400;
const LOAD_BUDGET_MS = 60000;
const LOOPBACK = '127.0.0.1';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/** 按要打印的键投影一份快照，保持声明顺序。 */
const pick = (snapshot, keys) => Object.fromEntries(keys.map((key) => [key, snapshot[key]]));

const meanSquare = (vector) => vector.reduce((sum, value) => sum + value * value, 0);

async function callJson(port, route, init) {
  const response = await fetch(`http://${LOOPBACK}:${port}${route}`, init);
  return response.json();
}

const healthOf = (port) => callJson(port, '/health');

/** 正常请求的 /encode；只有传输层或 JSON 坏掉才会抛。 */
const encodeTexts = (port, texts) =>
  callJson(port, '/encode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts }),
  });

/** 故意打坏请求的 /encode；状态码先取下来再解析正文。 */
async function encodeBroken(port, payload) {
  const response = await fetch(`http://${LOOPBACK}:${port}/encode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * 轮询 /health 直到模型就绪。
 * 桥报了加载错误也只等到预算耗尽才抛 —— 与桥的懒加载行为对齐，期间的加载失败
 * 不算终局（模型可能重试后起来）。
 */
async function awaitReady(port, budget = LOAD_BUDGET_MS) {
  const startedAt = Date.now();
  const overdue = () => Date.now() - startedAt > budget;
  for (;;) {
    try {
      const snapshot = await healthOf(port);
      if (snapshot.ready) return snapshot;
      if (snapshot.lastError) throw new Error(`模型加载失败：${snapshot.lastError}`);
    } catch (err) {
      if (overdue()) throw err;
    }
    if (overdue()) throw new Error('等待模型就绪超时');
    await delay(POLL_MS);
  }
}

function reportPortShift(first, second) {
  const verdict = second.port === first.port + 1 ? ' ✅' : ' ❌';
  console.log(`端口顺延检查：首个=${first.port}，第二个=${second.port}${verdict}`);
}

/** 除了回环，桥不许绑任何地址。 */
async function probeLoopbackGuard(modelDir) {
  try {
    await startBridge({ flags: { 'model-dir': modelDir, bind: '0.0.0.0' }, log: () => {} });
    return '未拦截 ❌';
  } catch (err) {
    return `已拦截 ✅（${String(err.message).slice(0, 40)}…）`;
  }
}

async function main() {
  const { flags } = parseArgs();
  const modelDir = flags['model-dir'];
  const wantPort = Number(flags.port || FALLBACK_PORT);
  const log = (message) => console.log(message);

  console.log('=== 编码桥实测（仅回环） ===');
  const primary = await startBridge({ flags: { 'model-dir': modelDir, port: String(wantPort) }, log });
  const secondary = await startBridge({ flags: { 'model-dir': modelDir, port: String(wantPort), warm: false }, log });
  reportPortShift(primary, secondary);

  const whileLoading = await healthOf(primary.port);
  console.log(`/health（加载中）：${JSON.stringify(pick(whileLoading, ['ready', 'modelLoading', 'model', 'dim']))}`);

  const ready = await awaitReady(primary.port);
  console.log(`/health（就绪）：${JSON.stringify(pick(ready, ['ready', 'model', 'dim', 'port']))}`);

  const startedAt = performance.now();
  const encoded = await encodeTexts(primary.port, ['跨机同步的挡推裁决', '整夜干活']);
  const elapsed = performance.now() - startedAt;
  const firstVector = encoded.vectors[0];
  const headDims = firstVector.slice(0, 5).map((value) => value.toFixed(4)).join(', ');
  console.log(`/encode 2 条：${elapsed.toFixed(1)}ms · model=${encoded.model} dim=${encoded.dim} · 首向量前 5 维 ${headDims}`);
  console.log(`首向量 L2 范数：${Math.sqrt(meanSquare(firstVector)).toFixed(6)}（契约要求归一化 ⇒ 应 ≈1）`);

  const broken = await encodeBroken(primary.port, { nope: 1 });
  console.log(`坏请求处理：HTTP ${broken.status} ${JSON.stringify(broken.body)}`);

  console.log(`非回环绑定拦截：${await probeLoopbackGuard(modelDir)}`);

  await secondary.close();
  await primary.close();
  console.log('桥已关闭');
  process.exitCode = 0;
}

if (isMainEntry(import.meta.url)) await main();
