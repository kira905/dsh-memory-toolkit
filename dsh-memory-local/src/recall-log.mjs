/**
 * FORK-EDIT(2026-09-21): 注入可观测日志（方案 §3.4 可观测 / §6.1 ⑤ 失败环 / §8.2 展开率）
 *
 * 落点：`<DSH_HOME>/logs/memory-recall.log`（JSON 行：时间/条数/耗时/命中来源/预估字符数/是否被展开）
 * 轮转：**3 份 × 保留 30 天**（方案 §3.4 Z18）；**不含记忆正文**（只记 id/长度/摘要长度）。
 * 铁律：**写日志失败不得影响注入**（全部 try/catch 吞掉，返回值只用于自测）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LOG_FILE = 'memory-recall.log';

export function createRecallLogger({
  dir,
  file = DEFAULT_LOG_FILE,
  maxBytes = 1024 * 1024,
  keepFiles = 3,
  keepDays = 30,
  fsImpl = fs,
  now = () => Date.now(),
  echo = null,
} = {}) {
  if (!dir) throw new Error('recall-log: 必须给 dir（日志目录）');
  const main = path.join(dir, file);
  const stats = { written: 0, errors: 0, rotations: 0, swept: 0 };
  let sizeCache = null;

  const stamp = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  const rotateIfNeeded = () => {
    let size = 0;
    try {
      size = fsImpl.existsSync(main) ? fsImpl.statSync(main).size : 0;
    } catch {
      size = 0;
    }
    if (size <= maxBytes) return;
    const target = path.join(dir, `memory-recall.${stamp(now())}.log`);
    if (fsImpl.existsSync(target)) return; // 同秒重名 → 跳过（不覆盖）
    fsImpl.renameSync(main, target);
    sizeCache = 0;
    stats.rotations += 1;
  };

  /** 清理：删超过 keepDays 的轮转文件 + 轮转文件数超过 keepFiles 删最旧。 */
  const sweep = () => {
    let names = [];
    try {
      names = fsImpl
        .readdirSync(dir)
        .filter((n) => /^memory-recall\..+\.log$/.test(n))
        .map((n) => {
          const full = path.join(dir, n);
          let mtime = 0;
          try {
            mtime = fsImpl.statSync(full).mtimeMs;
          } catch {
            mtime = 0;
          }
          return { full, n, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return;
    }
    const cutoff = now() - keepDays * 86400000;
    const kept = [];
    for (const f of names) {
      if (f.mtime && f.mtime < cutoff) {
        try {
          fsImpl.rmSync(f.full, { force: true });
          stats.swept += 1;
        } catch {
          /* ignore */
        }
        continue;
      }
      kept.push(f);
    }
    for (const f of kept.slice(keepFiles)) {
      try {
        fsImpl.rmSync(f.full, { force: true });
        stats.swept += 1;
      } catch {
        /* ignore */
      }
    }
  };

  /** 写一行 JSON。永不抛错。 */
  const log = (obj) => {
    try {
      const line = JSON.stringify({ t: new Date(now()).toISOString(), ...obj });
      if (echo) {
        try {
          echo(line);
        } catch {
          /* ignore */
        }
      }
      fsImpl.mkdirSync(dir, { recursive: true });
      rotateIfNeeded();
      fsImpl.appendFileSync(main, `${line}\n`, 'utf8');
      stats.written += 1;
      if (stats.written % 200 === 0) sweep();
      return true;
    } catch {
      stats.errors += 1;
      return false;
    }
  };

  return { log, sweep, path: main, stats: () => ({ ...stats }) };
}
