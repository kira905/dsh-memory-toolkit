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

/**
 * 状态名存在性优先解析（与外部 `state-paths.mjs` 同源读序；本包部署在 node_modules ⇒ 不跨树 import）。
 *
 * FORK-EDIT(2026-11-06 · 装包链「读序漂移」显式表态 = **改**):
 * 旧实现是**单边**判据 `新名存在 → 新名，否则旧名`，与真源 `resolveStatePath` 的读序有两处漂移：
 *   ① **两边都有**时真源取 **mtime 新者**（同毫秒按新名优先）并置 `conflict=true`；旧实现无条件取新名 ⇒
 *      状态名迁移期（dual）里若旧名那份更新，本门读到的是**过期开关**：外面关了 `memory-recall`、
 *      插件这边照旧当"开"，表现为「关不掉」（反向则是"该开的开不了"）。这条对本线尤其致命 —— 它管的正是记忆注入。
 *   ② 都不存在时真源按 `mode` 决定返回哪个（legacy 期给旧名）；旧实现恒给旧名。**行为等价**（missing ⇒ 下面一律
 *      fail-safe 判关），故保留旧兜底，不引入 mode 依赖（本包不跨树 import，也不读迁移元数据）。
 * 现在只补 ①：`existsSync` 换成 `statSync().mtimeMs` 双取 + 平手按新名。**新旧名只有一份时行为不变**。
 */
const statMsOrNull = (p, io) => { try { return io.statSync(p).mtimeMs; } catch { return null; } };
const resolveStateFile = (home, name, io = fs) => {
  try {
    const nw = name.startsWith('butler-') ? 'ops-' + name.slice(7) : name;
    const pNew = path.join(home, nw);
    const pOld = path.join(home, name);
    const sNew = statMsOrNull(pNew, io);
    const sOld = statMsOrNull(pOld, io);
    if (sNew !== null && sOld !== null) return sNew >= sOld ? pNew : pOld;
    if (sNew !== null) return pNew;
    return pOld;
  } catch { return path.join(home, name); }
};

export function createModuleGate({
  home,
  file = AUTONOMY_FILE,
  moduleId = MODULE_ID,
  ttlMs = 5000,
  now = () => Date.now(),
  fsImpl = fs,
} = {}) {
  if (!home) throw new Error('module-gate: 必须给 home（DSH_HOME）');
  const target = resolveStateFile(home, file, fsImpl);
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
