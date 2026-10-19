/**
 * FORK-EDIT(2026-09-21): 回环编码桥客户端（方案 §3.1 编码通道契约 / §3.4 fail-open）
 *
 * 契约（S1 已实测，见 S1 交付 §3.7）：
 *   · 桥只绑 127.0.0.1，端口从 8201 起、被占则 +1 顺延（serve.mjs，最多 10 次）
 *   · GET  /health → { ready, modelLoading, model, dim, port, ... }
 *   · POST /encode {"texts":[…]} → { vectors: [[…]], model, dim }
 *
 * 本模块的铁律：
 *   ① 桥不在 / 未就绪 / 超时 / 任何异常 ⇒ 抛错，由调用方 fail-open（绝不阻塞对话）；
 *   ② **超时不排队**（方案 §3.4：发出即设 250 ms 超时并放弃，桥侧不做补偿）——
 *      单飞守卫：上一发未回则本轮直接跳过，不堆叠请求；
 *   ③ 只允许回环地址（非 127.0.0.1 / localhost / ::1 一律拒，绝不给桥改绑非回环的机会）；
 *   ④ 探活结果（含**失败**）按 TTL 缓存 ⇒ 桥不在时不会每轮都连打 10 个端口。
 */
const LOOPBACK = /^(127\.0\.0\.1|localhost|::1)$/;

export function createBridgeClient({
  host = '127.0.0.1',
  port = 8201,
  portScanMax = 10,
  encodeTimeoutMs = 250,
  healthTimeoutMs = 120,
  healthTtlMs = 10000,
} = {}) {
  if (!LOOPBACK.test(String(host))) {
    throw new Error(`编码桥只允许回环地址（方案 §3.1），收到 host=${host}`);
  }

  let cache = null; // { ok, port, dim, model, at, error }
  let inFlight = false;
  let encodeCalls = 0;

  const fetchJson = async (url, init, ms) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  };

  /** 探活：从 port 起顺延，找第一个 ready 的桥；成功与失败都缓存 TTL。 */
  const probe = async (force = false) => {
    const now = Date.now();
    if (!force && cache && now - cache.at < healthTtlMs) return cache;
    let lastErr = 'unknown';
    for (let p = port; p <= port + portScanMax; p += 1) {
      try {
        const h = await fetchJson(`http://${host}:${p}/health`, {}, healthTimeoutMs);
        cache = {
          ok: Boolean(h && h.ready),
          port: p,
          dim: Number(h && h.dim) || 0,
          model: (h && h.model) || null,
          modelLoading: Boolean(h && h.modelLoading),
          at: Date.now(),
          error: h && h.ready ? null : 'model-not-ready',
        };
        return cache;
      } catch (e) {
        lastErr = String(e && e.message ? e.message : e);
      }
    }
    cache = { ok: false, port: null, dim: 0, model: null, at: Date.now(), error: lastErr };
    return cache;
  };

  const encode = async (text) => {
    const h = await probe();
    if (!h || !h.ok) throw new Error(`编码桥不可用：${(h && h.error) || 'not ready'}`);
    if (inFlight) throw new Error('编码桥上一发未返回（超时不排队，本轮跳过）');
    inFlight = true;
    try {
      encodeCalls += 1;
      const out = await fetchJson(
        `http://${host}:${h.port}/encode`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ texts: [String(text ?? '')] }),
        },
        encodeTimeoutMs,
      );
      const vec = out && out.vectors && out.vectors[0];
      if (!vec) throw new Error('编码桥返回空向量');
      return Float32Array.from(vec);
    } finally {
      inFlight = false;
    }
  };

  return {
    kind: 'bridge',
    host,
    port,
    describe: () => ({ kind: 'bridge', host, port, encodeTimeoutMs, healthTtlMs, encodeCalls }),
    probe,
    health: () => probe(),
    stats: () => ({ encodeCalls, inFlight }),
    get dim() {
      return cache ? cache.dim : 0;
    },
    get modelId() {
      return cache ? cache.model : null;
    },
    encode,
    // 桥一次一条（召回只需 1 条查询向量）
    encodeBatch: async (texts) => Promise.all(texts.map((t) => encode(t))),
  };
}
