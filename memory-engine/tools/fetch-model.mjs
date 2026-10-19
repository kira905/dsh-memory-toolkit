// 记忆引擎 v2 · 离线层 —— 模型权重获取器（node 版，不用 curl）
//
// 为什么要有这个脚本（Windows + schannel 环境实测坑）：
//   Windows 自带 curl.exe 走 schannel；HF 的 LFS 大文件会 302 到 Xet CAS 桥
//   （cas-bridge.xethub.hf.co），部分 Windows 主机上 schannel 对该域名 TLS 握手直接失败
//   （curl: (35) SEC_E_ILLEGAL_MESSAGE），而小文件（走 hf-mirror 直连）没问题。
//   node 自带 TLS 栈不受 schannel 影响 ⇒ 用本脚本取权重。
//
// 用法：
//   node tools/fetch-model.mjs --out <模型目录> [--base https://hf-mirror.com]
//        [--repo Xenova/bge-small-zh-v1.5] [--variant fp32|int8] [--force]
// 幂等：已存在且大小与远端一致 → 跳过（--force 强制重下）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs, isMainEntry } from '../lib/cli-util.mjs';

const COMMON = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.txt',
];
const VARIANTS = {
  fp32: 'onnx/model.onnx',
  int8: 'onnx/model_quantized.onnx',
  fp16: 'onnx/model_fp16.onnx',
};

async function fetchOne({ url, dest, force, log }) {
  const head = await fetch(url, { method: 'GET', redirect: 'follow' });
  if (!head.ok) throw new Error(`HTTP ${head.status} ${head.statusText} (${url})`);
  const total = Number(head.headers.get('content-length') || 0);
  const name = path.basename(dest);
  if (!force && fs.existsSync(dest) && total > 0 && fs.statSync(dest).size === total) {
    await head.body?.cancel?.();
    return { file: name, status: 'skip', size: total, sha: shortSha(dest) };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let got = 0;
  let lastPct = -1;
  const src = Readable.fromWeb(head.body);
  src.on('data', (c) => {
    got += c.length;
    if (total) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        log(`    ${name}: ${pct}%（${(got / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB）`);
      }
    }
  });
  await pipeline(src, fs.createWriteStream(part));
  if (total && fs.statSync(part).size !== total) {
    throw new Error(`${name} 大小不符：期望 ${total}，实际 ${fs.statSync(part).size}`);
  }
  fs.renameSync(part, dest);
  return { file: name, status: 'fetched', size: fs.statSync(dest).size, sha: shortSha(dest) };
}

function shortSha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 32);
}

export async function fetchModel({ out, base, repo, variant, force, log, retries = 3 }) {
  const files = [...COMMON, VARIANTS[variant]];
  const results = [];
  for (const f of files) {
    const url = `${base}/${repo}/resolve/main/${f}`;
    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        log(`  → ${f}${attempt > 1 ? `（第 ${attempt} 次尝试）` : ''}`);
        results.push(await fetchOne({ url, dest: path.join(out, f.replace(/\//g, path.sep)), force, log }));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        log(`    ⚠ ${String(e && e.message ? e.message : e)}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (lastErr) {
      results.push({ file: f, status: 'FAILED', error: String(lastErr.message || lastErr) });
    }
  }
  return results;
}

async function main() {
  const { flags } = parseArgs();
  if (flags.help) {
    console.log(`用法: node tools/fetch-model.mjs --out <dir> [--base <url>] [--repo <owner/name>] [--variant fp32|int8|fp16] [--force]`);
    return;
  }
  const out = flags.out || process.env.MEMORY_ENGINE_MODEL_DIR;
  if (!out) throw new Error('必须指定 --out（模型落盘目录）');
  const opts = {
    out: path.resolve(out),
    base: flags.base || 'https://hf-mirror.com',
    repo: flags.repo || 'Xenova/bge-small-zh-v1.5',
    variant: flags.variant || 'fp32',
    force: Boolean(flags.force),
  };
  console.log(`模型获取器：${opts.repo}（${opts.variant}）`);
  console.log(`镜像      ：${opts.base}`);
  console.log(`目标目录  ：${opts.out}`);
  if (!VARIANTS[opts.variant]) throw new Error(`未知 variant=${opts.variant}（可选 ${Object.keys(VARIANTS).join('/')}）`);
  const results = await fetchModel({ ...opts, log: (m) => console.log(m) });
  console.log('\n=== 结果 ===');
  let failed = 0;
  for (const r of results) {
    if (r.status === 'FAILED') {
      failed += 1;
      console.log(`❌ ${r.file}：${r.error}`);
    } else {
      console.log(`${r.status === 'skip' ? '⏭️ ' : '✅'} ${r.file.padEnd(28)} ${(r.size / 1048576).toFixed(2)} MB  sha256=${r.sha}`);
    }
  }
  console.log(failed ? `\n❌ ${failed} 个文件失败` : '\n✅ 全部就绪');
  process.exitCode = failed ? 1 : 0;
}

if (isMainEntry(import.meta.url)) await main();
