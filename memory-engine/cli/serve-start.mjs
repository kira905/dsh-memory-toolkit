// 记忆引擎 v2 · S2c —— 编码桥**幂等启动器**（方案 §3.1「谁起」+ §3.5 第 5 条）
//
// 契约（照方案原文，本文件是它的落地件）：
//   · 幂等：先 `GET /health` 探活；**已在跑 → 直接退出 0 并打印端口**（不重复拉起、不抢端口）；
//   · 不在跑 → 拉起 `serve.mjs`（detached），轮询 `/health` 直到 `ready:true`（默认 30s 上限）；
//   · 端口顺延：`serve.mjs` 自己 +1 顺延（最多 10 次）；启动器**按子进程 pid 在
//     [port, port+10] 里定位真实端口**，顺势落 `bridge-port.json` ⇒ 顺延后调用方仍查得到；
//   · 崩溃 / 冷启：桥不在 / 模型仍在加载 / 返回异常 ⇒ **调用方 fail-open**（S2b 已做），
//     启动器**只负责把桥拉起来**，不做无限重试（每轮 tick 幂等重启，靠 job 节奏兜底）；
//   · 仅绑回环：`--bind` 非回环一律拒绝（与 serve.mjs 同款铁律，双层防呆）。
//
// 退出码：0 = 已在跑（跳过）或拉起成功且 ready / 1 = 拉起失败（超时 / spawn 失败 / 非回环）
//         3 = `--no-start` 且桥不在（只探活模式，供调用方判让路）/ 2 = 用法错
//
// 用法：
//   node cli/serve-start.mjs                        # 幂等确保 127.0.0.1:8201 在跑
//   node cli/serve-start.mjs --json                 # 机器可读
//   node cli/serve-start.mjs --no-start             # 只探活，不拉起
//   node cli/serve-start.mjs --port-file <path>     # 覆盖端口台账落点（默认 <DSH_HOME>/memory-vectors/bridge-port.json）
//   node cli/serve-start.mjs --port 18201 --wait-ms 20000 --log <file>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../lib/config.mjs';
import { parseArgs, num, isMainEntry } from '../lib/cli-util.mjs';

export const SERVE_START_VERSION = '0.1.0';

/** 与 serve.mjs 的 MAX_PORT_TRIES 保持一致（顺延搜索范围 = 同款 +1 逻辑的镜像）。 */
export const MAX_PORT_TRIES = 10;
const PROBE_TIMEOUT_MS = 1200;
const PROBE_TIMEOUT_FAST_MS = 400;
const POLL_INTERVAL_MS = 500;
const DEFAULT_WAIT_MS = 30_000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const PORT_FILE_SCHEMA = 1;

export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NOT_RUNNING: 3 };

const LOOPBACK_RE = /^(127\.0\.0\.1|localhost|::1)$/;

/** `/health` 响应是否为**本编码桥**（而不是恰好占着端口的路人服务，如 3080 的 web）。 */
export function isBridgeHealth(body) {
  return Boolean(body) && typeof body === 'object'
    && typeof body.ready === 'boolean' && typeof body.modelLoading === 'boolean'
    && (typeof body.model === 'string' || typeof body.dim === 'number');
}

/** 单端口探活：命中返回 { ok:true, port, body }；否则 { ok:false, port, error }。 */
export async function probeHealth(port, { host = '127.0.0.1', timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: ac.signal });
    if (!res.ok) return { ok: false, port, error: `HTTP ${res.status}` };
    const body = await res.json();
    if (!isBridgeHealth(body)) return { ok: false, port, error: 'not-a-bridge' };
    return { ok: true, port, body };
  } catch (e) {
    const name = e && e.name;
    return { ok: false, port, error: name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : String(e?.message ?? e) };
  } finally {
    clearTimeout(t);
  }
}

/** 端口台账（bridge-port.json）读取：读不到/坏 JSON 一律 null（台账是派生物，不阻断）。 */
export function readPortFile(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(txt);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/** 原子写端口台账（同目录 tmp → rename；失败不致命）。 */
export function writePortFile(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 候选端口（去重、保序）：显式 `--port` / 台账记录 / 顺延窗。 */
export function candidatePorts(basePort, recorded = null) {
  const out = [];
  const push = (p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) return;
    if (!out.includes(n)) out.push(n);
  };
  push(basePort);
  push(recorded);
  for (let i = 1; i <= MAX_PORT_TRIES; i += 1) push(Number(basePort) + i);
  return out;
}

/** 在候选端口里找**已在跑的桥**（顺延后仍能查到）。 */
export async function findRunningBridge({ host = '127.0.0.1', ports = [], timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  for (const port of ports) {
    // eslint-disable-next-line no-await-in-loop
    const r = await probeHealth(port, { host, timeoutMs });
    if (r.ok) return r;
  }
  return null;
}

function truncateLog(file) {
  try {
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > LOG_MAX_BYTES) fs.writeFileSync(file, '', 'utf8');
  } catch { /* 忽略 */ }
}

/**
 * 幂等确保桥在跑（job / 人工都走这一个入口）。
 * @param {{flags?:object, log?:(msg:string)=>void}} opts
 * @returns {Promise<{ok:boolean, started:boolean, port:number|null, pid:number|null, ready:boolean,
 *                    skippedReason?:string, error?:string, portFile:string, bypass?:string}>}
 */
export async function ensureBridge({ flags = {}, log = (m) => process.stdout.write(m + '\n') } = {}) {
  const config = resolveConfig({
    modelDir: flags['model-dir'] || undefined,
    modelId: flags.model || undefined,
    dim: flags.dim ? Number(flags.dim) : undefined,
    bridgeHost: flags.host || undefined,
    bridgePort: flags.port ? Number(flags.port) : undefined,
  });
  const host = flags.bind || config.bridgeHost;
  if (!LOOPBACK_RE.test(String(host))) {
    return { ok: false, started: false, port: null, pid: null, ready: false, portFile: '', error: `只允许回环绑定（方案 §3.1），收到 ${host}` };
  }
  const basePort = Number(flags.port || config.bridgePort);
  const portFile = flags['port-file']
    ? path.resolve(String(flags['port-file']))
    : path.join(config.vectorsDir, 'bridge-port.json');
  const logFile = flags.log ? path.resolve(String(flags.log)) : path.join(path.dirname(portFile), 'bridge.log');
  const recorded = readPortFile(portFile);
  const ports = candidatePorts(basePort, recorded?.port ?? null);

  // ① 探活：已在跑 → 幂等跳过（唯一权威判据 = /health，不是 pid 文件）
  const found = await findRunningBridge({ host, ports });
  if (found) {
    const b = found.body;
    writePortFile(portFile, {
      schemaVersion: PORT_FILE_SCHEMA, host, port: found.port, pid: b.pid ?? null,
      modelId: b.model ?? config.modelId, modelDir: b.modelDir ?? config.modelDir,
      ready: b.ready === true, modelLoading: b.modelLoading === true,
      startedAt: b.uptimeMs ? new Date(Date.now() - Number(b.uptimeMs)).toISOString() : null,
      checkedAt: new Date().toISOString(), via: 'serve-start(probe)',
    });
    log(`[serve-start] 已在跑，跳过拉起：http://${host}:${found.port} pid=${b.pid ?? '?'} ready=${b.ready} model=${b.model ?? '?'}（台账 ${portFile}）`);
    return { ok: true, started: false, port: found.port, pid: b.pid ?? null, ready: b.ready === true, portFile, health: b };
  }

  if (flags['no-start']) {
    log(`[serve-start] 桥不在跑（探了 ${ports.length} 个端口），--no-start ⇒ 不拉起`);
    return { ok: false, started: false, port: null, pid: null, ready: false, portFile, skippedReason: 'not-running' };
  }

  // ② 拉起（detached：本进程退出后桥继续活着；日志走文件，不污染调用方 stdout）
  const serveScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'serve.mjs');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  truncateLog(logFile);
  const fd = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(process.execPath, [
      serveScript,
      '--model-dir', config.modelDir,
      '--port', String(basePort),
      '--bind', host,
    ], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* 忽略 */ }
    return { ok: false, started: false, port: null, pid: null, ready: false, portFile, error: `spawn 失败：${e?.message ?? e}` };
  }
  child.unref();
  try { fs.closeSync(fd); } catch { /* 忽略 */ }

  // ③ 等 ready：按 pid 在顺延窗里定位真实端口
  const waitMs = num(flags['wait-ms'], DEFAULT_WAIT_MS);
  const deadline = Date.now() + waitMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    for (const port of ports) {
      // eslint-disable-next-line no-await-in-loop
      const r = await probeHealth(port, { host, timeoutMs: PROBE_TIMEOUT_FAST_MS });
      if (!r.ok) continue;
      if (r.body.pid !== child.pid) continue;   // 别人占着这个端口 → 不是我们拉的那只
      lastSeen = r;
      if (r.body.ready === true) {
        writePortFile(portFile, {
          schemaVersion: PORT_FILE_SCHEMA, host, port, pid: child.pid,
          modelId: r.body.model ?? config.modelId, modelDir: r.body.modelDir ?? config.modelDir,
          ready: true, modelLoading: false,
          startedAt: new Date().toISOString(), readyAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
          via: 'serve-start(spawn)', logFile,
        });
        log(`[serve-start] 已拉起并就绪：http://${host}:${port} pid=${child.pid} model=${r.body.model ?? '?'}`
          + `${port !== basePort ? `（端口 ${basePort} 被占，顺延到 ${port}）` : ''} 日志 ${logFile}`);
        return { ok: true, started: true, port, pid: child.pid, ready: true, portFile, health: r.body };
      }
    }
  }

  writePortFile(portFile, {
    schemaVersion: PORT_FILE_SCHEMA, host, port: lastSeen?.port ?? basePort, pid: child.pid,
    modelId: lastSeen?.body?.model ?? config.modelId, modelDir: config.modelDir,
    ready: false, modelLoading: lastSeen?.body?.modelLoading ?? null,
    startedAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
    via: 'serve-start(spawn)', logFile, error: 'not-ready-in-wait-window',
  });
  return {
    ok: false, started: true, port: lastSeen?.port ?? null, pid: child.pid, ready: false, portFile,
    error: `拉起后 ${waitMs}ms 内未就绪${lastSeen ? `（pid 已探到，modelLoading=${lastSeen.body.modelLoading}）` : '（未探到 pid）'}；日志 ${logFile}`,
  };
}

async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = (m) => { if (!json) process.stdout.write(m + '\n'); };
  if (flags.help) {
    process.stdout.write('用法：node cli/serve-start.mjs [--port N] [--bind 127.0.0.1] [--model-dir P] '
      + '[--port-file P] [--log P] [--wait-ms N] [--no-start] [--json]\n');
    return EXIT.OK;
  }
  const r = await ensureBridge({ flags, log });
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  if (r.ok) return EXIT.OK;
  // 失败原因必须说人话（否则 `--bind 0.0.0.0` 这类用法错只会得到一个静默的 exit 1）
  if (r.error) log(`[serve-start] 失败：${r.error}`);
  return r.skippedReason === 'not-running' ? EXIT.NOT_RUNNING : EXIT.FAIL;
}

if (isMainEntry(import.meta.url)) process.exitCode = await main();
