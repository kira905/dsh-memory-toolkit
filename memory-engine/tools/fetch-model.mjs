// 记忆引擎 · 离线层 —— 模型权重获取器（纯 Node，不依赖 curl）
//
// 为什么不用 curl：Windows 自带的 curl.exe 走 schannel 做 TLS，而 Hub 上的大文件
// 会 302 到 Xet CAS 桥（cas-bridge.xethub.hf.co）；部分 Windows 主机对这个域名的
// 握手直接失败（curl: (35) SEC_E_ILLEGAL_MESSAGE），反倒是直连下发的小文件没事。
// Node 自带独立 TLS 栈，能绕开 schannel 这条路。
//
// 用法：
//   node tools/fetch-model.mjs --out <模型目录> [--base https://hf-mirror.com]
//        [--repo Xenova/bge-small-zh-v1.5] [--variant fp32|int8|fp16] [--force]
// 幂等：本地文件的字节数与服务端 content-length 相同就不动它；--force 要求重下。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseArgs, isMainEntry } from '../lib/cli-util.mjs';

const MIB = 1024 * 1024;

/** 所有变体都要的配套文件，按这个顺序取。 */
const SHARED_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
];

/** 变体名 → 仓内的权重文件（键顺序会出现在报错文案里，别乱动）。 */
const WEIGHTS = {
  fp32: 'onnx/model.onnx',
  int8: 'onnx/model_quantized.onnx',
  fp16: 'onnx/model_fp16.onnx',
};

/** 命令行没给时的兜底值。 */
const BAREFALLS = {
  base: 'https://hf-mirror.com',
  repo: 'Xenova/bge-small-zh-v1.5',
  variant: 'fp32',
};

const USAGE =
  '用法: node tools/fetch-model.mjs --out <dir> [--base <url>] [--repo <owner/name>] [--variant fp32|int8|fp16] [--force]';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** sha256 前 32 位 hex：够人对一眼，又不至于刷出 64 位。 */
const shortDigest = (filePath) => createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 32);

const asMegabytes = (bytes) => (bytes / MIB).toFixed(1);

/** 每跨过 10 % 才打一行进度，免得刷屏。 */
function announce(name, received, total, cursor, say) {
  if (!total) return;
  const percent = Math.floor((received / total) * 100);
  if (percent < cursor.last + 10) return;
  cursor.last = percent;
  say(`    ${name}: ${percent}%（${asMegabytes(received)}/${asMegabytes(total)} MB）`);
}

/** 把一块 Uint8Array 全写进去；短写就接着写剩下的。 */
async function writeAll(handle, chunk) {
  let written = 0;
  while (written < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, written, chunk.byteLength - written);
    if (!bytesWritten) throw new Error('写入中断（0 字节）');
    written += bytesWritten;
  }
}

/**
 * 把响应体逐块落到临时文件里，每块都 await ⇒ 套接字永远不会跑到磁盘前面。
 * 落完怎么处理（改名 / 丢弃）由调用方决定。
 */
async function spoolTo(partialPath, body, expected, name, say) {
  if (!body) throw new Error(`${name}：响应没有正文`);
  const reader = body.getReader();
  const handle = await open(partialPath, 'w');
  const cursor = { last: -1 };
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await writeAll(handle, value);
      received += value.byteLength;
      announce(name, received, expected, cursor, say);
    }
  } finally {
    await handle.close();
  }
}

/**
 * 取一个远端路径到 destination。
 * 返回 {file,status:'skip'|'fetched',size,sha}；传输层出问题就抛。
 */
async function pullFile({ url, destination, overwrite, say }) {
  const response = await fetch(url, { method: 'GET', redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} (${url})`);

  const expected = Number(response.headers.get('content-length') || 0);
  const name = basename(destination);
  const localSize = existsSync(destination) ? statSync(destination).size : -1;

  if (!overwrite && expected > 0 && localSize === expected) {
    await response.body?.cancel?.();
    return { file: name, status: 'skip', size: expected, sha: shortDigest(destination) };
  }

  mkdirSync(dirname(destination), { recursive: true });
  const partialPath = `${destination}.part`;
  await spoolTo(partialPath, response.body, expected, name, say);

  const landed = statSync(partialPath).size;
  if (expected && landed !== expected) throw new Error(`${name} 大小不符：期望 ${expected}，实际 ${landed}`);
  renameSync(partialPath, destination);
  return { file: name, status: 'fetched', size: statSync(destination).size, sha: shortDigest(destination) };
}

/**
 * 一个远端路径 + 重试预算。
 * 调用方把 retries 设成 0 时返回 null（一条记录都不写，保持原语义）。
 */
async function attemptFile({ url, destination, force, log, retries, name }) {
  let failure = null;
  for (let round = 1; round <= retries; round += 1) {
    log(`  → ${name}${round > 1 ? `（第 ${round} 次尝试）` : ''}`);
    try {
      return await pullFile({ url, destination, overwrite: force, say: log });
    } catch (err) {
      failure = err;
      log(`    ⚠ ${String(err && err.message ? err.message : err)}`);
      await pause(1500 * round);
    }
  }
  if (!failure) return null;
  return { file: name, status: 'FAILED', error: String(failure.message || failure) };
}

/** 逐条打结果，并定进程退出码。 */
function summarize(results) {
  console.log('\n=== 结果 ===');
  let failed = 0;
  for (const item of results) {
    if (item.status === 'FAILED') {
      failed += 1;
      console.log(`❌ ${item.file}：${item.error}`);
      continue;
    }
    const mark = item.status === 'skip' ? '⏭️ ' : '✅';
    console.log(`${mark} ${item.file.padEnd(28)} ${(item.size / MIB).toFixed(2)} MB  sha256=${item.sha}`);
  }
  console.log(failed ? `\n❌ ${failed} 个文件失败` : '\n✅ 全部就绪');
  process.exitCode = failed ? 1 : 0;
}

/**
 * 把某个变体需要的文件全取到 out 里。
 * 普通下载失败不会让本函数 reject —— 那些都变成 FAILED 记录。
 */
export async function fetchModel({ out, base, repo, variant, force, log, retries = 3 }) {
  const remotePaths = [...SHARED_FILES, WEIGHTS[variant]];
  const results = [];
  for (const remotePath of remotePaths) {
    const settled = await attemptFile({
      url: `${base}/${repo}/resolve/main/${remotePath}`,
      destination: join(out, remotePath.replace(/\//g, sep)),
      force,
      log,
      retries,
      name: remotePath,
    });
    if (settled) results.push(settled);
  }
  return results;
}

async function main() {
  const { flags } = parseArgs();
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const requestedOut = flags.out || process.env.MEMORY_ENGINE_MODEL_DIR;
  if (!requestedOut) throw new Error('必须指定 --out（模型落盘目录）');

  const settings = {
    out: resolve(requestedOut),
    base: flags.base || BAREFALLS.base,
    repo: flags.repo || BAREFALLS.repo,
    variant: flags.variant || BAREFALLS.variant,
    force: Boolean(flags.force),
  };
  console.log(`模型获取器：${settings.repo}（${settings.variant}）`);
  console.log(`镜像      ：${settings.base}`);
  console.log(`目标目录  ：${settings.out}`);

  if (!WEIGHTS[settings.variant]) {
    throw new Error(`未知 variant=${settings.variant}（可选 ${Object.keys(WEIGHTS).join('/')}）`);
  }

  summarize(await fetchModel({ ...settings, log: (message) => console.log(message) }));
}

if (isMainEntry(import.meta.url)) await main();
