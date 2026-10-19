/**
 * FORK-EDIT(2026-09-21): L2 模块门（自我 drain） —— 方案 §3.5-4 / §5.1（召回开关载体）
 *
 * 口径（S2a 已在 `tools\dsh-butler\lib\autonomy-modules.mjs` 的 MODULE_IDS 登记 `memory-recall`）：
 *   · butler 无法热关 DSH 进程内的插件 ⇒ **插件自己每轮读该段并自我 drain**
 *   · `butler-autonomy.json` 的 `modules['memory-recall'].enabled === true` 才放行
 *   · **fail-safe：读不到配置 / 解析失败 / 段缺失 / 值非 true ⇒ 判关（drain）**
 * 缓存：按文件 mtime + TTL（默认 5 s）缓存，避免每轮读盘；读失败也缓存（避免异常时每轮重读）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const MODULE_ID = 'memory-recall';
export const AUTONOMY_FILE = 'butler-autonomy.json';

export function createModuleGate({
  home,
  file = AUTONOMY_FILE,
  moduleId = MODULE_ID,
  ttlMs = 5000,
  now = () => Date.now(),
  fsImpl = fs,
} = {}) {
  if (!home) throw new Error('module-gate: 必须给 home（DSH_HOME）');
  const target = path.join(home, file);
  let cache = null; // { enabled, reason, at, mtimeMs }

  const read = (force) => {
    const nowMs = now();
    let mtimeMs = -1;
    try {
      mtimeMs = fsImpl.existsSync(target) ? fsImpl.statSync(target).mtimeMs : -1;
    } catch {
      mtimeMs = -1;
    }
    if (!force && cache && cache.mtimeMs === mtimeMs && nowMs - cache.at < ttlMs) return cache;

    let enabled = false;
    let reason = 'ok';
    if (mtimeMs < 0) {
      reason = 'config-missing'; // fail-safe：读不到配置判关
    } else {
      try {
        const raw = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
        const mod = raw && raw.modules ? raw.modules[moduleId] : undefined;
        if (!mod) reason = 'module-not-registered';
        else if (mod.enabled !== true) reason = 'module-disabled';
        else {
          enabled = true;
          reason = 'enabled';
        }
      } catch (e) {
        reason = `config-unreadable:${String(e && e.message ? e.message : e)}`;
      }
    }
    cache = { enabled, reason, at: nowMs, mtimeMs, file: target };
    return cache;
  };

  return {
    file: target,
    check: (force = false) => {
      const r = read(force);
      return { enabled: r.enabled, reason: r.reason, file: r.file, at: r.at, mtimeMs: r.mtimeMs };
    },
    peek: () => cache,
  };
}
