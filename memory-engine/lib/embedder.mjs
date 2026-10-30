// 编码器层：同一个接口的三种实现，调用方只认 encode / encodeBatch / health / describe。
//   · stub  —— 确定性哈希，零依赖，只给骨架与单测用（没有半点语义质量）
//   · http  —— 回环编码桥的客户端（超时默认 250ms）
//   · local —— 本地 ONNX 推理（bge 小模型，CPU 上跑）
// 模型运行时只在 local 里动态 import ⇒ 权重拉不下来时，其余实现与测试照样能跑。

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STUB_MAX_N = 3;
const HEALTH_TIMEOUT_MS = 2000;
const BATCH_TIMEOUT_FLOOR_MS = 30000;
const LOCAL_PROBE_TEXT = '维度自检';

const errorText = (e) => (e && e.message ? e.message : String(e));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// 原地单位化；零向量按长度 1 处理，免得除零把整条变成 NaN。
function unitize(vec) {
  let squareSum = 0;
  for (let i = 0; i < vec.length; i += 1) squareSum += vec[i] * vec[i];
  const length = Math.sqrt(squareSum) || 1;
  for (let i = 0; i < vec.length; i += 1) vec[i] /= length;
  return vec;
}

// 连着的 n 元切片，n = 1..maxN；先统一小写再切。
function ngramsOf(text, maxN) {
  const body = text.toLowerCase();
  const grams = [];
  for (let n = 1; n <= maxN; n += 1) {
    for (let at = 0; at + n <= body.length; at += 1) grams.push(body.slice(at, at + n));
  }
  return grams;
}

/** 测试骨架用的确定性编码器：每个 n 元算一次 md5，头两字节定槽位、第三字节定正负。 */
export function createStubEmbedder({ dim = 512, sleepMs = 0, modelId = 'stub-ngram' } = {}) {
  let encodeCount = 0;

  const hashToVector = (text) => {
    const vec = new Float32Array(dim);
    for (const gram of ngramsOf(String(text ?? ''), STUB_MAX_N)) {
      const digest = createHash('md5').update(gram).digest();
      const slot = ((digest[0] << 8) | digest[1]) % dim;
      vec[slot] += digest[2] % 2 === 0 ? 1 : -1;
    }
    return unitize(vec);
  };

  // 每次编码都过这里：模拟耗时 + 计数（两者都是测试要观测的）
  const encodeOnce = async (text) => {
    if (sleepMs) await sleep(sleepMs);
    encodeCount = encodeCount + 1;
    return hashToVector(text);
  };

  return {
    kind: 'stub', modelId, dim,
    describe: () => ({
      kind: 'stub',
      modelId,
      dim,
      note: '确定性哈希编码器，仅用于骨架自测',
    }),
    health: async () => ({ ready: true, modelLoading: false, model: modelId, dim }),
    encode: (text) => encodeOnce(text),
    encodeBatch: async (texts) => {
      const vectors = [];
      for (const text of texts) vectors.push(await encodeOnce(text));
      return vectors;
    },
    stats() {
      return { encodeCount };
    },
  };
}

/** 回环编码桥的客户端：只发 JSON，一切都带超时，桥不在就如实报错而不是挂着。 */
export function createHttpEmbedder({ host = '127.0.0.1', port = 8201, timeoutMs = 250, modelId = null, dim = null } = {}) {
  const base = `http://${host}:${port}`;
  let lastHealth = null;

  // payload 为 null ⇒ 走 GET；否则按 JSON POST 发出去。
  const callJson = async (url, payload, ms) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const init = payload
        ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          }
        : { signal: controller.signal };
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    kind: 'http',
    // 显式给了就用手上的；没给就跟着最近一次探活的结果走（读那一瞬才算）
    get modelId() { return modelId || (lastHealth && lastHealth.model) || 'unknown'; },
    get dim() { return dim || (lastHealth && lastHealth.dim) || 0; },
    describe: () => ({ kind: 'http', base, modelId, dim, timeoutMs }),
    health: async () => {
      try {
        lastHealth = await callJson(`${base}/health`, null, HEALTH_TIMEOUT_MS);
        return { ...lastHealth, bridge: base };
      } catch (e) {
        return { ready: false, modelLoading: false, error: errorText(e), bridge: base };
      }
    },
    encode: async (text) => {
      const answer = await callJson(`${base}/encode`, { texts: [String(text ?? '')] }, timeoutMs);
      return Float32Array.from(answer.vectors[0]);
    },
    encodeBatch: async (texts) => {
      if (!texts.length) {
        return [];
      }
      const answer = await callJson(
        `${base}/encode`,
        { texts: texts.map((text) => String(text ?? '')) },
        Math.max(timeoutMs, BATCH_TIMEOUT_FLOOR_MS),
      );
      return answer.vectors.map((row) => Float32Array.from(row));
    },
    stats() {
      return { encodeCount: -1 };
    },
  };
}

// 权重目录有两种摆法：要么 config.json 就在这一层，要么下面还套一层以模型名命名的子目录。
// 推理库要的是"根目录 + 子目录名"，所以先探一下再决定怎么喂。
function resolveWeightLayout(modelDir, modelId) {
  if (!fs.existsSync(path.join(modelDir, 'config.json'))) {
    return { root: modelDir, id: modelId };
  }
  return { root: path.dirname(modelDir), id: path.basename(modelDir) };
}

/**
 * 本地 ONNX 编码器：默认取 cls 位做向量，也可以按注意力掩码做均值池化。
 * 维度以**实测**为准（模型真吐几维就是几维），配置里那个数只作比对。
 */
export async function createLocalEmbedder({ modelDir, modelId = 'bge-small-zh-v1.5', dim = 512, quantized = false, dtype = null, maxLength = 512, pooling = 'cls', queryPrefix = '' } = {}) {
  const runtime = await import('@huggingface/transformers');
  const { env, AutoTokenizer, AutoModel } = runtime;
  const layout = resolveWeightLayout(modelDir, modelId);

  // 全离线：只认本地目录，不碰远端、不占浏览器缓存
  Object.assign(env, {
    allowRemoteModels: false,
    allowLocalModels: true,
    localModelPath: layout.root,
    useBrowserCache: false,
  });

  const loadOptions = { local_files_only: true };
  if (dtype) loadOptions.dtype = dtype;
  else if (quantized) loadOptions.dtype = 'q8';
  const tokenizer = await AutoTokenizer.from_pretrained(layout.id, { local_files_only: true });
  const model = await AutoModel.from_pretrained(layout.id, loadOptions);

  const embedOnce = async (text) => {
    const inputs = await tokenizer(String(text ?? ''), {
      padding: true,
      truncation: true,
      max_length: maxLength,
    });
    const output = await model(inputs);
    const hidden = output.last_hidden_state ?? output[Object.keys(output)[0]];
    const [, tokenCount, width] = hidden.dims;
    const vec = new Float32Array(width);
    if (pooling === 'cls') {
      vec.set(hidden.data.subarray(0, width));
      return unitize(vec);
    }
    // 均值池化：被掩码盖掉的位不参与平均
    const mask = inputs.attention_mask?.data;
    let kept = 0;
    for (let token = 0; token < tokenCount; token += 1) {
      if (mask && !Number(mask[token])) continue;
      kept += 1;
      for (let i = 0; i < width; i += 1) vec[i] += hidden.data[token * width + i];
    }
    const divisor = kept || 1;
    for (let i = 0; i < width; i += 1) vec[i] /= divisor;
    return unitize(vec);
  };

  // 用一句固定探针量真维度（此时不加查询前缀）
  const measuredDim = (await embedOnce(LOCAL_PROBE_TEXT)).length;

  return {
    kind: 'local', modelId, dim: measuredDim, configuredDim: dim,
    describe: () => ({ kind: 'local', modelId, modelDir, dim: measuredDim, pooling, quantized, dtype: dtype || (quantized ? 'q8' : 'fp32'), queryPrefix }),
    health: async () => ({ ready: true, modelLoading: false, model: modelId, dim: measuredDim, modelDir }),
    encode: (text) => embedOnce(String(queryPrefix || '') + String(text ?? '')),
    encodeBatch: async (texts) => {
      const vectors = [];
      for (const text of texts) vectors.push(await embedOnce(text));
      return vectors;
    },
    stats() {
      return { encodeCount: -1 };
    },
  };
}

/** 按偏好挑一个：要 http 就走桥，其余一律走本地。 */
export async function createAutoEmbedder({ prefer = 'local', ...opts } = {}) {
  const build = prefer === 'http' ? createHttpEmbedder : createLocalEmbedder;
  return build(opts);
}
