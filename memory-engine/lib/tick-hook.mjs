// 坑库向量同步的「置标记 → 消费」钩子（方案 §A.2 第 10 行 · A 点）
//
// 要解决的问题：坑库文件变了以后，谁去触发 `source='pitfall'` 的增量编码？
//   这里选的是**松耦合信号**：坑库 job 跑完只落一个标记（不直接编码、不拖慢 job），
//   消费方（本模块）看到标记才跑一次坑源增量同步。
//
// ⚠ 全方案唯一"有意双写者"的一处：置标记方与清标记方各写各的，**不共用同一把锁**
//   （跨进程共用锁会把握手串成串行）。正确性靠三件事兜住：
//     ① 置标记方：临时文件 + rename 原子落盘，且**必写 `updatedAt`**；
//     ② 清标记方：原子读改写，且**只在标记 `updatedAt` 早于本次消费起点时才清**；
//     ③ 并发插进新标记时宁可这轮不清（留待下次），绝不丢标记。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runIncrementalSync } from './sync.mjs';

export const MARKER_SCHEMA = 1;
// 标记文件默认名（已登记在管家的状态文件清单里）
export const MARKER_FILENAME = 'butler-pitfall-vector-dirty.json';

// 默认落点：<DSH_HOME>/<标记文件名>（可注入，方便夹具与 CLI 指到别处）
export function markerPathFor(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  return path.join(dshHome, MARKER_FILENAME);
}

// Windows 上覆盖一个正被别人读/改名的目标会概率性抛这几个码（没有 flock 语义，只能重试）
const RENAME_RACE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);

// 同步 API 里没法 await：只能空转，毫秒级，代价可忽略
function sleepSync(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { /* 空转 */ }
}

// 有限次重试的 rename。原子性不变：仍是"临时文件 → rename"两步，
// 读者要么看到旧内容、要么看到新内容，永远看不到半截。
function renameSyncWithRetry(from, to, { tries = 50, waitMs = 2 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (err) {
      lastError = err;
      if (!RENAME_RACE_CODES.has(err && err.code)) throw err;
      sleepSync(waitMs);
    }
  }
  throw lastError;
}

// 标记体公共前缀：所有落盘形状都从这里长出来，字段顺序保持一致
function stampPayload(fields) {
  return { schemaVersion: MARKER_SCHEMA, ...fields };
}

// 原子写 JSON（临时文件 + 同卷 rename；读者不会看到半截 JSON）
export function atomicWriteJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const staged = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(staged, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  renameSyncWithRetry(staged, p);
  return p;
}

// 统一的"没读到"形状（三处出口共用，字段顺序稳定）
function absent(error) {
  return { present: false, marker: null, error };
}

// 读标记。**永不抛错**：半截 JSON / 权限问题一律转成 error，由调用方决定 fail-open 还是 fail-closed。
export function readMarker(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return absent(null);
    return absent(String(err && err.message ? err.message : err));
  }
  try {
    return { present: true, marker: JSON.parse(raw), error: null };
  } catch (err) {
    return absent(`半截/非法 JSON：${String(err && err.message ? err.message : err)}`);
  }
}

// 置标记（置标记方 API，坑库 job 末尾一行调用）；`at` 必写 = 本次置标记时刻
export function markDirty(p, opts = {}) {
  const at = Number(opts.at ?? Date.now());
  const fields = {
    updatedAt: at,
    at: new Date(at).toISOString(),
    reason: opts.reason ?? null,
    by: opts.by ?? null,
    device: os.hostname(),
    counters: opts.counters ?? null,
  };
  atomicWriteJson(p, stampPayload(fields));
  return { ok: true, path: p, updatedAt: at };
}

// 删中间痕迹（失败也不影响判定结果）
function dropQuietly(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
}

/**
 * 清标记（消费方 API）：原子读改写 + stale 判定。
 *   · 标记缺失 ⇒ 什么都不做
 *   · updatedAt >= consumeStart ⇒ 保留（那是并发新写的，不是这轮要消费的那份）
 *   · updatedAt < consumeStart ⇒ 摘除：先写 consumed 落点，再把主文件 rename 过去（同卷 rename 原子）
 * 残余竞态窗：复读与 rename 之间仍有极小窗口（Windows 上没有 flock 可替代）；
 * 两边实际频率差三个数量级以上（生产置标记 30 分钟一次 / 消费秒级），实际不构成丢标记。
 */
export function clearMarkerIfStale(p, consumeStart) {
  const head = readMarker(p);
  if (!head.present) return { cleared: false, reason: head.error ? 'unreadable' : 'no-marker' };

  const seenAt = Number(head.marker?.updatedAt || 0);
  if (!(seenAt < Number(consumeStart))) {
    return { cleared: false, reason: 'fresh-marker-kept', marker: head.marker };
  }

  const consumedFile = `${p}.consumed`;
  atomicWriteJson(consumedFile, stampPayload({ clearedAt: Date.now(), consumedUpdatedAt: seenAt }));

  // 复读一次：这中间可能有人又置了新标记
  const recheck = readMarker(p);
  if (!recheck.present) {
    dropQuietly(consumedFile);
    return { cleared: false, reason: 'already-gone' };
  }
  if (!(Number(recheck.marker?.updatedAt || 0) < Number(consumeStart))) {
    dropQuietly(consumedFile);
    return { cleared: false, reason: 'fresh-marker-kept-on-recheck', marker: recheck.marker };
  }
  try {
    renameSyncWithRetry(p, consumedFile);
  } catch (err) {
    dropQuietly(consumedFile);
    return { cleared: false, reason: `rename-failed:${err && err.code ? err.code : String(err)}` };
  }
  dropQuietly(consumedFile);
  return { cleared: true, reason: 'stale-marker-consumed', consumedUpdatedAt: seenAt };
}

// 来源守卫：只认坑源。若被别的来源调进来，本函数会一边按 pitfall 命名空间写向量、
// 一边扫别人的行 ⇒ 静默污染命名空间。所以来源名不对就**拒跑**（宁可少跑一轮，也不脏库）。
function assertPitfallSource(source) {
  const name = source && source.sourceName ? String(source.sourceName) : null;
  if (name === 'pitfall') return name;
  throw new Error(
    `runPitfallHook 只接受坑源（sourceName='pitfall'），收到 ${name ?? '(未知来源/无 sourceName)'}`
      + ' ⇒ 拒跑（否则会把该来源的行错标成 pitfall 向量）',
  );
}

// 按本轮结果决定标记去留：dry-run 不动；同步失败保留；成功才清
function settleMarker({ markerPath, consumeStart, dryRun, stats, log }) {
  if (dryRun) return { cleared: false, reason: 'dry-run' };
  if (stats.error) {
    log(`[tick-hook] 同步失败 ⇒ **保留标记**下轮重试：${stats.error}`);
    return { cleared: false, reason: 'sync-failed-keep-marker' };
  }
  const outcome = clearMarkerIfStale(markerPath, consumeStart);
  log(`[tick-hook] 清标记：${JSON.stringify(outcome)}`);
  return outcome;
}

// 消费一轮：有标记 ⇒ 跑坑源增量同步 ⇒ 成功才清标记（失败保留，下轮重试）
export async function runPitfallHook({
  markerPath, store, source, embedder, modelId, dim,
  batchSize = 50, full = false, dryRun = false,
  log = () => {}, now = () => Date.now(),
}) {
  const consumeStart = now();
  assertPitfallSource(source);

  const marker = readMarker(markerPath);
  if (marker.error) {
    log(`[tick-hook] 标记文件读不动（本轮跳过、不清除）：${marker.error}`);
    return { ok: false, skipped: 'marker-unreadable', error: marker.error, consumeStart };
  }
  if (!marker.present) return { ok: true, skipped: 'no-marker', consumeStart };

  log(`[tick-hook] 标记在位（updatedAt=${marker.marker?.updatedAt ?? '?'}，reason=${marker.marker?.reason ?? '-'}）⇒ 跑坑源增量同步`);
  const stats = await runIncrementalSync({
    source, store, embedder, modelId, dim,
    sourceName: 'pitfall', batchSize, full, dryRun, log, now,
  });
  const cleared = settleMarker({ markerPath, consumeStart, dryRun, stats, log });
  return { ok: !stats.error, consumeStart, marker: marker.marker, stats, cleared };
}
