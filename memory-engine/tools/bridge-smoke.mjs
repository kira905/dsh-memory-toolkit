// 记忆引擎 v2 · 离线层 —— 编码桥实测（方案 §3.1 编码通道契约）
//
// 同进程内起桥 → 打 /health 与 /encode → 校验端口顺延 → 关桥。
// 为什么不走 ssh 后台进程：SSH 会话结束会带走 detached 进程（跨机技能坑 3），
// 起与测必须同一条命令；本脚本把「起 + 测 + 关」放进同一个 node 进程，最省事也最可靠。
import { startBridge } from '../serve.mjs';
import { parseArgs, isMainEntry } from '../lib/cli-util.mjs';

async function waitReady(port, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
      if (h.ready) return h;
      if (h.lastError) throw new Error(`模型加载失败：${h.lastError}`);
    } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw e;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('等待模型就绪超时');
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  const { flags } = parseArgs();
  const modelDir = flags['model-dir'];
  const wantPort = Number(flags.port || 8201);
  const logs = [];
  const log = (m) => {
    logs.push(m);
    console.log(m);
  };

  console.log('=== 编码桥实测（仅回环） ===');
  const b1 = await startBridge({ flags: { 'model-dir': modelDir, port: String(wantPort) }, log });
  const b2 = await startBridge({ flags: { 'model-dir': modelDir, port: String(wantPort), warm: false }, log });
  console.log(`端口顺延检查：首个=${b1.port}，第二个=${b2.port}${b2.port === b1.port + 1 ? ' ✅' : ' ❌'}`);

  const health0 = await fetch(`http://127.0.0.1:${b1.port}/health`).then((r) => r.json());
  console.log(`/health（加载中）：${JSON.stringify({ ready: health0.ready, modelLoading: health0.modelLoading, model: health0.model, dim: health0.dim })}`);

  const ready = await waitReady(b1.port);
  console.log(`/health（就绪）：${JSON.stringify({ ready: ready.ready, model: ready.model, dim: ready.dim, port: ready.port })}`);

  const t0 = performance.now();
  const enc = await fetch(`http://127.0.0.1:${b1.port}/encode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts: ['跨机同步的挡推裁决', '整夜干活'] }),
  }).then((r) => r.json());
  const ms = performance.now() - t0;
  console.log(`/encode 2 条：${ms.toFixed(1)}ms · model=${enc.model} dim=${enc.dim} · 首向量前 5 维 ${enc.vectors[0].slice(0, 5).map((x) => x.toFixed(4)).join(', ')}`);
  const norm = Math.sqrt(enc.vectors[0].reduce((s, x) => s + x * x, 0));
  console.log(`首向量 L2 范数：${norm.toFixed(6)}（契约要求归一化 ⇒ 应 ≈1）`);

  const bad = await fetch(`http://127.0.0.1:${b1.port}/encode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nope: 1 }),
  }).then((r) => ({ status: r.status, body: r.json() }));
  const badRes = await bad.body;
  console.log(`坏请求处理：HTTP ${bad.status} ${JSON.stringify(badRes)}`);

  const nonLoop = await (async () => {
    try {
      await startBridge({ flags: { 'model-dir': modelDir, bind: '0.0.0.0' }, log: () => {} });
      return '未拦截 ❌';
    } catch (e) {
      return `已拦截 ✅（${String(e.message).slice(0, 40)}…）`;
    }
  })();
  console.log(`非回环绑定拦截：${nonLoop}`);

  await b2.close();
  await b1.close();
  console.log('桥已关闭');
  process.exitCode = 0;
}

if (isMainEntry(import.meta.url)) await main();
