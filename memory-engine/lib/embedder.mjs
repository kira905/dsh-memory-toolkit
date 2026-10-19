// 记忆引擎 v2 · 离线层 —— 编码器（可注入）
//
// 三种实现，接口一致（encode / encodeBatch / health / describe）：
//   1. createLocalEmbedder  —— 本地 ONNX（@huggingface/transformers + bge-small-zh-v1.5）
//   2. createHttpEmbedder   —— 走回环编码桥（serve.mjs，127.0.0.1:8201）
//   3. createStubEmbedder   —— 零依赖确定性哈希编码器：**仅供测试骨架**，无任何语义质量
//
// 设计要点：同步/召回核心一律依赖本接口，不直接 import 模型运行时
// ⇒ 模型拉不动时，骨架与单测仍可完整跑通（本卡 §二.6 的退路）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 确定性 stub：char n-gram 哈希到 dim 维 + L2 归一化（测试用，禁止用于生产召回） */
export function createStubEmbedder({ dim = 512, modelId = 'stub-ngram', sleepMs = 0 } = {}) {
  let encodeCount = 0;
  const encodeOne = (text) => {
    const v = new Float32Array(dim);
    const s = String(text ?? '').toLowerCase();
    const grams = [];
    for (let n = 1; n <= 3; n += 1) {
      for (let i = 0; i + n <= s.length; i += 1) grams.push(s.slice(i, i + n));
    }
    for (const g of grams) {
      const h = crypto.createHash('md5').update(g).digest();
      const idx = ((h[0] << 8) | h[1]) % dim;
      const sign = h[2] % 2 === 0 ? 1 : -1;
      v[idx] += sign;
    }
    let norm = 0;
    for (let i = 0; i < dim; i += 1) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i += 1) v[i] /= norm;
    return v;
  };
  return {
    kind: 'stub',
    modelId,
    dim,
    describe: () => ({ kind: 'stub', modelId, dim, note: '确定性哈希编码器，仅用于骨架自测' }),
    async health() {
      return { ready: true, modelLoading: false, model: modelId, dim };
    },
    async encode(text) {
      if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
      encodeCount += 1;
      return encodeOne(text);
    },
    async encodeBatch(texts) {
      const out = [];
      for (const t of texts) {
        if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
        encodeCount += 1;
        out.push(encodeOne(t));
      }
      return out;
    },
    stats: () => ({ encodeCount }),
  };
}

/** 回环编码桥客户端（插件侧 / CLI 侧共用；方案 §3.1 编码通道契约：超时 250ms） */
export function createHttpEmbedder({
  host = '127.0.0.1',
  port = 8201,
  timeoutMs = 250,
  modelId = null,
  dim = null,
} = {}) {
  const base = `http://${host}:${port}`;
  let healthCache = null;
  const fetchJson = async (url, init = {}, ms = timeoutMs) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  };
  return {
    kind: 'http',
    get modelId() {
      return modelId || (healthCache && healthCache.model) || 'unknown';
    },
    get dim() {
      return dim || (healthCache && healthCache.dim) || 0;
    },
    describe: () => ({ kind: 'http', base, modelId, dim, timeoutMs }),
    async health() {
      try {
        healthCache = await fetchJson(`${base}/health`, {}, 2000);
        return { ...healthCache, bridge: base };
      } catch (e) {
        return { ready: false, modelLoading: false, error: String(e && e.message ? e.message : e), bridge: base };
      }
    },
    async encode(text) {
      const out = await fetchJson(
        `${base}/encode`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ texts: [String(text ?? '')] }),
        },
        timeoutMs,
      );
      return Float32Array.from(out.vectors[0]);
    },
    async encodeBatch(texts) {
      if (!texts.length) return [];
      const out = await fetchJson(
        `${base}/encode`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ texts: texts.map((t) => String(t ?? '')) }),
        },
        Math.max(timeoutMs, 30000),
      );
      return out.vectors.map((v) => Float32Array.from(v));
    },
    stats: () => ({ encodeCount: -1 }),
  };
}

/**
 * 本地 ONNX 编码器（bge-small-zh-v1.5，512 维，CPU）。
 * 动态 import 模型运行时 ⇒ 未安装依赖时本模块仍可被 import（骨架/单测不受影响）。
 */
export async function createLocalEmbedder({
  modelDir,
  modelId = 'bge-small-zh-v1.5',
  dim = 512,
  quantized = false,
  dtype = null,
  maxLength = 512,
  pooling = 'cls',
  queryPrefix = '',
} = {}) {
  const mod = await import('@huggingface/transformers');
  const { env, AutoTokenizer, AutoModel } = mod;
  // 布局自适应：transformers.js 的 env.localModelPath 是「模型根目录」（其下按 modelId 建子目录），
  // 而本项目的 modelDir 语义是「直接放 config.json 的权重目录」⇒ 两种布局都支持。
  let localRoot = modelDir;
  let localId = modelId;
  if (fs.existsSync(path.join(modelDir, 'config.json'))) {
    localRoot = path.dirname(modelDir);
    localId = path.basename(modelDir);
  }
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = localRoot;
  env.useBrowserCache = false;

  const loadOpts = dtype
    ? { dtype }
    : quantized
      ? { dtype: 'q8' }
      : {};
  const tokenizer = await AutoTokenizer.from_pretrained(localId, { local_files_only: true });
  const model = await AutoModel.from_pretrained(localId, { local_files_only: true, ...loadOpts });

  const encodeOne = async (text) => {
    const input = String(text ?? '');
    const inputs = await tokenizer(input, { padding: true, truncation: true, max_length: maxLength });
    const out = await model(inputs);
    const hidden = out.last_hidden_state ?? out[Object.keys(out)[0]];
    const [, seq, d] = hidden.dims;
    const data = hidden.data;
    const v = new Float32Array(d);
    if (pooling === 'cls') {
      for (let i = 0; i < d; i += 1) v[i] = data[i];
    } else {
      // mean pooling（按 attention_mask 加权）
      const mask = inputs.attention_mask?.data;
      let n = 0;
      for (let t = 0; t < seq; t += 1) {
        const m = mask ? Number(mask[t]) : 1;
        if (!m) continue;
        n += 1;
        for (let i = 0; i < d; i += 1) v[i] += data[t * d + i];
      }
      n = n || 1;
      for (let i = 0; i < d; i += 1) v[i] /= n;
    }
    let norm = 0;
    for (let i = 0; i < d; i += 1) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < d; i += 1) v[i] /= norm;
    return v;
  };

  const actualDim = await (async () => {
    const probe = await encodeOne('维度自检');
    return probe.length;
  })();

  return {
    kind: 'local',
    modelId,
    dim: actualDim,
    configuredDim: dim,
    describe: () => ({
      kind: 'local',
      modelId,
      modelDir,
      dim: actualDim,
      pooling,
      quantized,
      dtype: dtype || (quantized ? 'q8' : 'fp32'),
      queryPrefix,
    }),
    async health() {
      return {
        ready: true,
        modelLoading: false,
        model: modelId,
        dim: actualDim,
        modelDir,
      };
    },
    async encode(text) {
      return encodeOne(String(queryPrefix || '') + String(text ?? ''));
    },
    async encodeBatch(texts) {
      const out = [];
      for (const t of texts) out.push(await encodeOne(t));
      return out;
    },
    stats: () => ({ encodeCount: -1 }),
  };
}

/** 按配置挑一个可用编码器（桥优先 → 本地 → 报错） */
export async function createAutoEmbedder({ prefer = 'local', ...opts } = {}) {
  if (prefer === 'http') return createHttpEmbedder(opts);
  return createLocalEmbedder(opts);
}
