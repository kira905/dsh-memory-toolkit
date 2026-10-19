// 记忆引擎 v2 · 离线层 —— 编码桥（方案 §3.1 编码通道契约）
//
// 契约：
//   · 仅绑 127.0.0.1（禁任何非回环绑定）；端口 8201，被占则 +1 顺延并落日志
//   · POST /encode {"texts":[…]} → {"vectors":[[…]],"model":…,"dim":512}
//   · GET  /health → {ready, modelLoading, model, dim, port}
//   · 模型懒加载；桥不在 / 加载中 / 异常 ⇒ 调用方 fail-open（本进程不崩对话）
import http from 'node:http';
import { resolveConfig } from './lib/config.mjs';
import { createLocalEmbedder } from './lib/embedder.mjs';
import { parseArgs, num, isMainEntry } from './lib/cli-util.mjs';

const MAX_PORT_TRIES = 10;
const MAX_BODY = 4 * 1024 * 1024;

export async function startBridge({ flags = {}, log = (m) => process.stdout.write(m + '\n') } = {}) {
  const config = resolveConfig({
    modelDir: flags['model-dir'] || undefined,
    modelId: flags.model || undefined,
    dim: flags.dim ? Number(flags.dim) : undefined,
    bridgeHost: flags.host || undefined,
    bridgePort: flags.port ? Number(flags.port) : undefined,
  });
  const host = flags.bind || config.bridgeHost;
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(String(host))) {
    throw new Error(`只允许回环绑定（方案 §3.1：禁止任何非回环绑定），收到 ${host}`);
  }

  const state = {
    modelLoading: false,
    modelReady: false,
    embedder: null,
    error: null,
    encodeCalls: 0,
    encodedTexts: 0,
    lastErrorAt: null,
    port: null,
    startedAt: Date.now(),
  };

  const ensureModel = async () => {
    if (state.modelReady || state.modelLoading) return;
    state.modelLoading = true;
    const t0 = Date.now();
    try {
      state.embedder = await createLocalEmbedder({
        modelDir: config.modelDir,
        modelId: config.modelId,
        dim: config.dim,
        quantized: Boolean(flags.quantized),
        dtype: flags.dtype || null,
      });
      state.modelReady = true;
      log(`[bridge] 模型就绪 ${config.modelId} dim=${state.embedder.dim} 加载 ${Date.now() - t0}ms dir=${config.modelDir}`);
    } catch (e) {
      state.error = String(e && e.message ? e.message : e);
      state.lastErrorAt = Date.now();
      log(`[bridge] 模型加载失败：${state.error}`);
    } finally {
      state.modelLoading = false;
    }
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let n = 0;
      const chunks = [];
      req.on('data', (c) => {
        n += c.length;
        if (n > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        send(200, {
          ready: state.modelReady,
          modelLoading: state.modelLoading,
          model: config.modelId,
          dim: state.embedder ? state.embedder.dim : config.dim,
          port: state.port,
          host,
          pid: process.pid,
          uptimeMs: Date.now() - state.startedAt,
          encodeCalls: state.encodeCalls,
          encodedTexts: state.encodedTexts,
          modelDir: config.modelDir,
          lastError: state.error && state.lastErrorAt && Date.now() - state.lastErrorAt < 60000 ? state.error : null,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/encode') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const texts = Array.isArray(body.texts) ? body.texts.map((t) => String(t ?? '')) : null;
        if (!texts) return send(400, { error: 'body.texts 必须是字符串数组' });
        if (!state.modelReady) {
          if (!state.modelLoading) void ensureModel();
          return send(503, { error: state.error || 'model loading', modelLoading: true, model: config.modelId });
        }
        state.encodeCalls += 1;
        state.encodedTexts += texts.length;
        const vectors = await state.embedder.encodeBatch(texts);
        return send(200, { vectors: vectors.map((v) => Array.from(v)), model: config.modelId, dim: vectors[0] ? vectors[0].length : config.dim });
      }
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        send(200, { ok: true });
        // 铁律：不发 process.exit() 强退（undici 句柄未收尾会概率性 0xC0000409）⇒ 关服务自然退出
        setTimeout(() => {
          server.close();
          process.exitCode = 0;
        }, 50);
        return;
      }
      send(404, { error: 'not found', routes: ['GET /health', 'POST /encode'] });
    } catch (e) {
      state.error = String(e && e.message ? e.message : e);
      state.lastErrorAt = Date.now();
      send(500, { error: state.error });
    }
  });

  // 端口占用 → +1 顺延（最多 10 次）
  const listen = (port, tries = 0) =>
    new Promise((resolve, reject) => {
      const onError = (e) => {
        if (e.code === 'EADDRINUSE' && tries < MAX_PORT_TRIES) {
          log(`[bridge] 端口 ${port} 被占，顺延到 ${port + 1}`);
          server.removeListener('error', onError);
          resolve(listen(port + 1, tries + 1));
        } else {
          reject(e);
        }
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        state.port = port;
        resolve(port);
      });
    });

  const port = await listen(config.bridgePort);
  log(`[bridge] 监听 http://${host}:${port}（仅回环）model=${config.modelId} dir=${config.modelDir}`);
  if (flags.warm !== false) void ensureModel();
  return { server, port, state, config, close: () => new Promise((r) => server.close(r)) };
}

if (isMainEntry(import.meta.url)) {
  const { flags } = parseArgs();
  const bridge = await startBridge({ flags });
  const shutdown = async () => {
    await bridge.close();
    process.exitCode = 0;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
