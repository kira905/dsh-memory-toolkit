// 编码桥「幂等启动器」
//
// 一句话：调用方想用桥，就喊本脚本；桥在就跑个探活收工，桥不在才拉起来，拉完等到就绪为止。
//
// 行为约定：
//   · 幂等 —— 权威判据是 `GET /health`（不是 pid 文件、不是端口台账）。已在跑就 exit 0，只把端口报出来，
//     绝不重复拉起、不抢端口；
//   · 冷启 —— spawn `serve.mjs`（detached：本进程退出后桥照样活），然后轮询 `/health` 到 `ready:true`
//     （默认最多等 30s）；
//   · 端口顺延 —— `serve.mjs` 自己 +1 找空位（最多 10 次）。启动器按**子进程 pid** 在 [port, port+10]
//     里认领真实端口，并把结果落到端口台账，下游照着台账也能找到；
//   · 不做无限重试 —— 崩了/模型还在加载就当这轮失败，下一轮 tick 会再幂等调一次；
//   · 只许回环 —— `--bind` 给非回环一律拒（和 serve.mjs 同一条铁律，双层防呆）。
//
// 退出码：0 = 已在跑或拉起成功且就绪 / 1 = 拉起失败（超时、spawn 失败、非回环）
//         3 = `--no-start` 且桥不在（纯探活模式，调用方据此让路）/ 2 = 用法错
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

/** 与 serve.mjs 的 MAX_PORT_TRIES 同值：顺延窗 = 它 +1 搜索范围的镜像。 */
export const MAX_PORT_TRIES = 10;

const TIMEOUT_PROBE_MS = 1200;
const TIMEOUT_WAIT_MS = 400;
const POLL_GAP_MS = 500;
const WAIT_BUDGET_MS = 30_000;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;
const LEDGER_SCHEMA = 1;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NOT_RUNNING: 3 };

/** 这条 `/health` 响应到底是不是本编码桥？（3080 那类路人服务也占端口，不能见到 200 就认） */
export function isBridgeHealth(body) {
  const isObj = Boolean(body) && typeof body === 'object';
  if (!isObj) return false;
  const flagsOk = typeof body.ready === 'boolean' && typeof body.modelLoading === 'boolean';
  const identityOk = typeof body.model === 'string' || typeof body.dim === 'number';
  return flagsOk && identityOk;
}

/** 探一个端口：活着且是桥 → {ok:true, port, body}；否则 {ok:false, port, error}（**不抛**）。 */
export async function probeHealth(port, { host = '127.0.0.1', timeoutMs = TIMEOUT_PROBE_MS } = {}) {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, port, error: `HTTP ${res.status}` };
    const body = await res.json();
    return isBridgeHealth(body) ? { ok: true, port, body } : { ok: false, port, error: 'not-a-bridge' };
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, port, error: timedOut ? 'timeout' : String(e?.message ?? e) };
  }
}

/** 读端口台账：台账是派生物，读不到 / 坏 JSON 一律当没有，绝不因此阻断启动。 */
export function readPortFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 写端口台账：先写同目录临时件再 rename，读者永远看不到半截 JSON。失败返回 false（不致命）。 */
export function writePortFile(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时件都删不掉也无所谓，反正别把异常漏出去 */
    }
    return false;
  }
}

/** 候选端口：显式端口 → 台账记的端口 → 顺延窗；去重保序，非法值直接丢。 */
export function candidatePorts(basePort, recorded = null) {
  const wanted = [basePort, recorded];
  const base = Number(basePort);
  for (let step = 1; step <= MAX_PORT_TRIES; step += 1) wanted.push(base + step);
  const seen = new Set();
  for (const raw of wanted) {
    const port = Number(raw);
    const legal = Number.isInteger(port) && port > 0 && port <= 65535;
    if (legal) seen.add(port);
  }
  return [...seen];
}

/** 在候选端口里找已经在跑的桥（顺延之后也照样能认出来）。 */
export async function findRunningBridge({ host = '127.0.0.1', ports = [], timeoutMs = TIMEOUT_PROBE_MS } = {}) {
  for (const port of ports) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await probeHealth(port, { host, timeoutMs });
    if (hit.ok) return hit;
  }
  return null;
}

/** 日志文件太大就先清空，免得它无限长。 */
function capLog(file) {
  try {
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.writeFileSync(file, '', 'utf8');
  } catch {
    /* 清不动就算了 */
  }
}

/** 一轮把候选端口全扫一遍：既拿到「最后见到的自家 pid」，也拿到「第一个就绪的」。 */
async function sweepPorts({ ports, host, pid }) {
  let seen = null;
  for (const port of ports) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await probeHealth(port, { host, timeoutMs: TIMEOUT_WAIT_MS });
    if (!hit.ok || hit.body.pid !== pid) continue; // 端口上有东西但不是我们拉的那只 ⇒ 不认
    if (hit.body.ready === true) return { ready: { ...hit, port }, seen };
    seen = { ...hit, port };
  }
  return { ready: null, seen };
}

/** 解析本次要用的入口/端口/台账/日志四件套。 */
function planTargets(flags) {
  const config = resolveConfig({
    modelDir: flags['model-dir'] || undefined,
    modelId: flags.model || undefined,
    dim: flags.dim ? Number(flags.dim) : undefined,
    bridgeHost: flags.host || undefined,
    bridgePort: flags.port ? Number(flags.port) : undefined,
  });
  const host = flags.bind || config.bridgeHost;
  const portFile = flags['port-file']
    ? path.resolve(String(flags['port-file']))
    : path.join(config.vectorsDir, 'bridge-port.json');
  return {
    config,
    host,
    basePort: Number(flags.port || config.bridgePort),
    portFile,
    logFile: flags.log ? path.resolve(String(flags.log)) : path.join(path.dirname(portFile), 'bridge.log'),
  };
}

/**
 * 幂等确保桥在跑 —— job 与人工都走这一个口。
 * @param {{flags?:object, log?:(msg:string)=>void}} opts
 * @returns {Promise<{ok:boolean, started:boolean, port:number|null, pid:number|null, ready:boolean,
 *                    skippedReason?:string, error?:string, portFile:string, health?:object}>}
 */
export async function ensureBridge({ flags = {}, log = (m) => process.stdout.write(`${m}\n`) } = {}) {
  const target = planTargets(flags);
  const { config, host, basePort, portFile, logFile } = target;

  if (!LOOPBACK_HOSTS.has(String(host))) {
    return {
      ok: false, started: false, port: null, pid: null, ready: false, portFile: '',
      error: `只允许回环绑定（收到 ${host}）`,
    };
  }

  const ledger = readPortFile(portFile);
  const ports = candidatePorts(basePort, ledger?.port ?? null);

  // ① 先探活：已经在跑就收工（幂等点就在这一句里）
  const alive = await findRunningBridge({ host, ports });
  if (alive) {
    const h = alive.body;
    writePortFile(portFile, {
      schemaVersion: LEDGER_SCHEMA,
      host,
      port: alive.port,
      pid: h.pid ?? null,
      modelId: h.model ?? config.modelId,
      modelDir: h.modelDir ?? config.modelDir,
      ready: h.ready === true,
      modelLoading: h.modelLoading === true,
      startedAt: h.uptimeMs ? new Date(Date.now() - Number(h.uptimeMs)).toISOString() : null,
      checkedAt: new Date().toISOString(),
      via: 'serve-start(probe)',
    });
    log(`[serve-start] 已在跑，跳过拉起：http://${host}:${alive.port} pid=${h.pid ?? '?'} ready=${h.ready} model=${h.model ?? '?'}（台账 ${portFile}）`);
    return { ok: true, started: false, port: alive.port, pid: h.pid ?? null, ready: h.ready === true, portFile, health: h };
  }

  if (flags['no-start']) {
    log(`[serve-start] 桥不在跑（探了 ${ports.length} 个端口），--no-start ⇒ 不拉起`);
    return { ok: false, started: false, port: null, pid: null, ready: false, portFile, skippedReason: 'not-running' };
  }

  // ② 拉起：detached 运行，stdout/stderr 全进日志文件，绝不污染调用方的输出
  const child = launchBridge({ target, host, basePort });
  if (child.error) {
    return { ok: false, started: false, port: null, pid: null, ready: false, portFile, error: child.error };
  }
  const pid = child.pid;

  // ③ 等就绪：顺延之后真实端口靠 pid 认领
  const waitMs = num(flags['wait-ms'], WAIT_BUDGET_MS);
  const giveUpAt = Date.now() + waitMs;
  let lastSeen = null;
  while (Date.now() < giveUpAt) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((done) => setTimeout(done, POLL_GAP_MS));
    // eslint-disable-next-line no-await-in-loop
    const round = await sweepPorts({ ports, host, pid });
    if (round.seen) lastSeen = round.seen;
    if (round.ready) {
      const hit = round.ready;
      const nowIso = new Date().toISOString();
      writePortFile(portFile, {
        schemaVersion: LEDGER_SCHEMA,
        host,
        port: hit.port,
        pid,
        modelId: hit.body.model ?? config.modelId,
        modelDir: hit.body.modelDir ?? config.modelDir,
        ready: true,
        modelLoading: false,
        startedAt: nowIso,
        readyAt: nowIso,
        checkedAt: nowIso,
        via: 'serve-start(spawn)',
        logFile,
      });
      const shiftNote = hit.port !== basePort ? `（端口 ${basePort} 被占，顺延到 ${hit.port}）` : '';
      log(`[serve-start] 已拉起并就绪：http://${host}:${hit.port} pid=${pid} model=${hit.body.model ?? '?'}${shiftNote} 日志 ${logFile}`);
      return { ok: true, started: true, port: hit.port, pid, ready: true, portFile, health: hit.body };
    }
  }

  writePortFile(portFile, {
    schemaVersion: LEDGER_SCHEMA,
    host,
    port: lastSeen?.port ?? basePort,
    pid,
    modelId: lastSeen?.body?.model ?? config.modelId,
    modelDir: config.modelDir,
    ready: false,
    modelLoading: lastSeen?.body?.modelLoading ?? null,
    startedAt: new Date().toISOString(),
    checkedAt: new Date().toISOString(),
    via: 'serve-start(spawn)',
    logFile,
    error: 'not-ready-in-wait-window',
  });
  const why = lastSeen ? `（pid 已探到，modelLoading=${lastSeen.body.modelLoading}）` : '（未探到 pid）';
  return {
    ok: false, started: true, port: lastSeen?.port ?? null, pid, ready: false, portFile,
    error: `拉起后 ${waitMs}ms 内未就绪${why}；日志 ${logFile}`,
  };
}

/** 真正 spawn 子进程（返回 pid 或 error，不外抛）。 */
function launchBridge({ target, host, basePort }) {
  const serveScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'serve.mjs');
  const { config, logFile } = target;
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    capLog(logFile);
    fd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [
      serveScript,
      '--model-dir', config.modelDir,
      '--port', String(basePort),
      '--bind', host,
    ], { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    child.unref();
    return { pid: child.pid };
  } catch (e) {
    return { error: `spawn 失败：${e?.message ?? e}` };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

const USAGE_PARTS = [
  '用法：node cli/serve-start.mjs',
  '[--port N]', '[--bind 127.0.0.1]', '[--model-dir P]', '[--port-file P]',
  '[--log P]', '[--wait-ms N]', '[--no-start]', '[--json]',
];

async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = (m) => {
    if (!json) process.stdout.write(`${m}\n`);
  };
  if (flags.help) {
    process.stdout.write(`${USAGE_PARTS.join(' ')}\n`);
    return EXIT.OK;
  }
  const r = await ensureBridge({ flags, log });
  if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  if (r.ok) return EXIT.OK;
  // 失败一定要说人话，否则 `--bind 0.0.0.0` 这类用法错只会换来一个闷声 exit 1
  if (r.error) log(`[serve-start] 失败：${r.error}`);
  return r.skippedReason === 'not-running' ? EXIT.NOT_RUNNING : EXIT.FAIL;
}

if (isMainEntry(import.meta.url)) process.exitCode = await main();
