// 记忆引擎 v2 · 离线层 —— 坑库向量同步「标记 → 消费」钩子（方案 §A.2 第 10 行 · A 点）
//
// 要解决的问题：坑库（butler-pitfalls.json）变了之后，谁去触发 `source='pitfall'` 的增量编码？
//   方案选的是**松耦合信号**：`pitfall` job 末尾**只置一个标记**（不直接编码、不拖慢 job），
//   消费方（本模块，由 `memory-vectors` 档或手动 CLI 拉起）看到标记才跑一次坑源增量同步。
//
// ⚠️ 这是全方案**唯一"有意双写者"**的文件（方案 §A.4 · C5 2026-10-08 回修）：
//   ① 置标记方 = `pitfall` job  ── 原子写（临时文件 + rename），**必须写 `updatedAt`**
//   ② 清标记方 = 本模块消费者    ── **原子读改写**，且**只在标记 `updatedAt` 早于本次消费起点时才清**
//      （否则会把并发新写入的标记一起清掉 = 丢标记、下轮不编码、还无人告警）
//   两方**不共用同一把锁**（跨 job 共用会把握手串成串行）；靠 `updatedAt` stale 判定 + 原子 rename 兜住。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIncrementalSync } from './sync.mjs';

export const MARKER_SCHEMA = 1;
/** 标记文件默认名（登记见 `tools/dsh-butler/lib/state-files.mjs`） */
export const MARKER_FILENAME = 'butler-pitfall-vector-dirty.json';

/** 默认标记文件路径（DSH_HOME 口径；可注入） */
export function markerPathFor(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  return path.join(dshHome, MARKER_FILENAME);
}

function tmpName(p) {
  return `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Windows 上 `rename` 覆盖一个**正被另一个进程读/改名**的目标会概率性抛
 * `EPERM/EBUSY/EACCES/EEXIST`（无 flock 语义）⇒ 有限次重试（毫秒级，不改变原子性：
 * 仍是"临时文件 → rename"两步，读者永远看不到半截内容）。
 */
function renameWithRetry(from, to, { tries = 50, waitMs = 2 } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (e) {
      lastErr = e;
      if (!['EPERM', 'EBUSY', 'EACCES', 'EEXIST'].includes(e && e.code)) throw e;
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        /* 忙等几毫秒（同步 API，无法 await） */
      }
    }
  }
  throw lastErr;
}

/** 原子写 JSON（临时文件 + 同卷 rename；读者永远不会看到半截 JSON） */
export function atomicWriteJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = tmpName(p);
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  renameWithRetry(tmp, p);
  return p;
}

/**
 * 读标记。**永不抛错**（半截 JSON / 权限问题 ⇒ 返回 error，由调用方决定 fail-open 还是 fail-closed）。
 * @returns {{present:boolean, marker:object|null, error:string|null}}
 */
export function readMarker(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { present: false, marker: null, error: null };
    return { present: false, marker: null, error: String(e && e.message ? e.message : e) };
  }
  try {
    return { present: true, marker: JSON.parse(raw), error: null };
  } catch (e) {
    return { present: false, marker: null, error: `半截/非法 JSON：${String(e && e.message ? e.message : e)}` };
  }
}

/**
 * 置标记（**置标记方 API**；`pitfall` job 末尾一行调用）。
 * @param {string} p 标记文件路径
 * @param {{at?:number, reason?:string, by?:string, counters?:object}} [opts] `at` 必写（= 本次置标记时刻）
 */
export function markDirty(p, opts = {}) {
  const at = Number(opts.at ?? Date.now());
  atomicWriteJson(p, {
    schemaVersion: MARKER_SCHEMA,
    updatedAt: at,
    at: new Date(at).toISOString(),
    reason: opts.reason ?? null,
    by: opts.by ?? null,
    device: os.hostname(),
    counters: opts.counters ?? null,
  });
  return { ok: true, path: p, updatedAt: at };
}

/**
 * 清标记（**消费方 API**）：原子读改写 + stale 判定。
 *   · 标记缺失 ⇒ 什么都不做
 *   · `updatedAt >= consumeStart` ⇒ **保留**（并发新标记，不是这次要消费的那份）
 *   · `updatedAt < consumeStart` ⇒ 摘除（先写 `consumed` 落点，再 `rename` 摘除主文件；同卷 rename 是原子的）
 *   残余竞态窗：`复读` 与 `rename` 之间仍有极小窗口（Windows 无 flock 的文件级替代）；
 *   实跑频率差 ≥ 3 个数量级（生产置标记 30 分钟一次 / 消费秒级），实际不构成丢标记。
 * @returns {{cleared:boolean, reason:string, consumedUpdatedAt?:number, marker?:object}}
 */
export function clearMarkerIfStale(p, consumeStart) {
  const first = readMarker(p);
  if (!first.present) return { cleared: false, reason: first.error ? 'unreadable' : 'no-marker' };
  const at = Number(first.marker?.updatedAt || 0);
  if (!(at < Number(consumeStart))) return { cleared: false, reason: 'fresh-marker-kept', marker: first.marker };

  const consumed = `${p}.consumed`;
  atomicWriteJson(consumed, {
    schemaVersion: MARKER_SCHEMA,
    clearedAt: Date.now(),
    consumedUpdatedAt: at,
  });

  const second = readMarker(p);
  if (!second.present) {
    try {
      fs.rmSync(consumed, { force: true });
    } catch {
      /* ignore */
    }
    return { cleared: false, reason: 'already-gone' };
  }
  if (!(Number(second.marker?.updatedAt || 0) < Number(consumeStart))) {
    try {
      fs.rmSync(consumed, { force: true });
    } catch {
      /* ignore */
    }
    return { cleared: false, reason: 'fresh-marker-kept-on-recheck', marker: second.marker };
  }
  try {
    renameWithRetry(p, consumed);
  } catch (e) {
    try {
      fs.rmSync(consumed, { force: true });
    } catch {
      /* ignore */
    }
    return { cleared: false, reason: `rename-failed:${e && e.code ? e.code : String(e)}` };
  }
  try {
    fs.rmSync(consumed, { force: true });
  } catch {
    /* ignore */
  }
  return { cleared: true, reason: 'stale-marker-consumed', consumedUpdatedAt: at };
}

/**
 * 消费一轮：有标记 ⇒ 跑坑源增量同步 ⇒ 成功后清标记（失败**不清**，下轮重试）。
 * @param {object} p
 * @param {string} p.markerPath
 * @param {object} p.store / p.source / p.embedder / p.modelId / p.dim
 */
export async function runPitfallHook({
  markerPath,
  store,
  source,
  embedder,
  modelId,
  dim,
  batchSize = 50,
  full = false,
  dryRun = false,
  log = () => {},
  now = () => Date.now(),
}) {
  const consumeStart = now();
  // 🔴 fail-closed 守卫（2026-10-10 实测踩到过）：调用方若把**别的来源**当坑源传进来，
  //    本函数会一边按 pitfall 命名空间写向量、一边扫记忆行 ⇒ 静默把记忆行错标成坑向量。
  //    ⇒ 来源名不对就**拒跑**（宁可少跑一轮，绝不污染命名空间）。
  const srcName = source && source.sourceName ? String(source.sourceName) : null;
  if (srcName !== 'pitfall') {
    throw new Error(
      `runPitfallHook 只接受坑源（sourceName='pitfall'），收到 ${srcName ?? '(未知来源/无 sourceName)'}`
        + ' ⇒ 拒跑（否则会把该来源的行错标成 pitfall 向量）',
    );
  }
  const r = readMarker(markerPath);
  if (r.error) {
    log(`[tick-hook] 标记文件读不动（本轮跳过、不清除）：${r.error}`);
    return { ok: false, skipped: 'marker-unreadable', error: r.error, consumeStart };
  }
  if (!r.present) return { ok: true, skipped: 'no-marker', consumeStart };

  log(`[tick-hook] 标记在位（updatedAt=${r.marker?.updatedAt ?? '?'}，reason=${r.marker?.reason ?? '-'}）⇒ 跑坑源增量同步`);
  const stats = await runIncrementalSync({
    source,
    store,
    embedder,
    modelId,
    dim,
    sourceName: 'pitfall',
    batchSize,
    full,
    dryRun,
    log,
    now,
  });
  let cleared = { cleared: false, reason: 'not-attempted' };
  if (dryRun) cleared = { cleared: false, reason: 'dry-run' };
  else if (stats.error) {
    log(`[tick-hook] 同步失败 ⇒ **保留标记**下轮重试：${stats.error}`);
    cleared = { cleared: false, reason: 'sync-failed-keep-marker' };
  } else {
    cleared = clearMarkerIfStale(markerPath, consumeStart);
    log(`[tick-hook] 清标记：${JSON.stringify(cleared)}`);
  }
  return { ok: !stats.error, consumeStart, marker: r.marker, stats, cleared };
}
