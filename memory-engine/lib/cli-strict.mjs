// 严格命令行层：复用 `parseArgs`，但把「没声明过的开关」当成错误。
//
// 为什么另外包一层：仓库里的 `parseArgs` 有意不做白名单（它给各命令留自由），
// 而这一批命令都要「未知参数 fail-closed」——拼错一个字母不许静默跑成默认行为。
// 这里只做三件事：白名单校验、类型收口、以及 JSON 只落文件的统一出口。

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './cli-util.mjs';

/** 通用退出码（与既有 CLI 同口径，个别命令另有扩展）。 */
export const EXIT = Object.freeze({
  OK: 0,
  FAIL: 1,
  USAGE: 2,
  UNREADABLE: 3,
});

/** 声明式开关表：值取 'string' | 'bool' | 'number'。`help` / `h` 自动带上。 */
export function parseCli(argv, spec) {
  const table = { help: 'bool', h: 'bool', ...spec };
  const { flags: raw, rest } = parseArgs(argv);

  const unknown = [];
  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(table, key)) unknown.push(key);
  }

  const flags = Object.create(null);
  const invalid = [];
  for (const [key, kind] of Object.entries(table)) {
    const v = raw[key];
    if (kind === 'bool') {
      // 显式 `--flag=false` 也认（parseArgs 会把它当字符串）
      flags[key] = v !== undefined && v !== 'false' && v !== false;
      continue;
    }
    if (v === undefined || v === true) {
      flags[key] = undefined;
      continue;
    }
    if (kind === 'number') {
      const n = Number(v);
      flags[key] = Number.isFinite(n) ? n : NaN;
      if (!Number.isFinite(n)) invalid.push(key);
      continue;
    }
    flags[key] = String(v);
  }

  return {
    flags,
    rest,
    unknown,
    invalid,
    help: Boolean(flags.help || flags.h),
  };
}

/** 用法错：写到 stderr，退出码 2（不抛栈，卡会话里看见的是人话）。 */
export function usageError(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
  process.stderr.write(`${text}\n`);
  process.exitCode = EXIT.USAGE;
}

/** 一次性把参数问题全报出来（未知开关 / 数值不合法 / 多余位置参数）。 */
export function rejectBadArgs(parsed, { allowRest = false } = {}) {
  const bad = [];
  if (parsed.unknown.length) bad.push(`未知参数：${parsed.unknown.map((k) => `--${k}`).join('、')}（--help 看可用开关）`);
  if (parsed.invalid.length) bad.push(`数值不合法：${parsed.invalid.map((k) => `--${k}`).join('、')}`);
  if (!allowRest && parsed.rest.length) bad.push(`多余的位置参数：${parsed.rest.join(' ')}`);
  return bad;
}

/** 目录先建好再写（原子性靠同目录 rename，跨盘一律 copy + 校验）。 */
export function writeTextFile(file, text) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  return abs;
}

/**
 * `--json` 的统一出口：**机器可读内容只落文件，不上 stdout**。
 * 返回写到的绝对路径；没给 `--json` 就返回 null（调用方只打人话）。
 */
export function emitJsonReport({ json, out, payload }) {
  if (!json) return null;
  if (!out) {
    throw new UsageError('`--json` 要配 `--out <file>`：JSON 只落文件，不上 stdout');
  }
  return writeTextFile(out, `${JSON.stringify(payload, null, 2)}\n`);
}

/** 用法错的自定义异常 —— 由各命令的 main 统一转成 rc=2。 */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** 保护性拒跑（比如「这一搬会把主表搬空」）：rc=1，只打人话，不打栈。 */
export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardError';
  }
}

/** 把未知异常与用法错分别落到 rc（别的异常就是 rc=1）。 */
export function settle(err, { prefix = '' } = {}) {
  const head = prefix ? `${prefix} ` : '';
  if (err instanceof UsageError) {
    process.stderr.write(`${head}❌ ${err.message}\n`);
    process.exitCode = EXIT.USAGE;
    return;
  }
  if (err instanceof GuardError || (err && err.name === 'GuardError')) {
    process.stderr.write(`${head}❌ ${err.message}\n`);
    process.exitCode = EXIT.FAIL;
    return;
  }
  const detail = err && err.stack ? err.stack : String(err);
  process.stderr.write(`${head}❌ ${detail}\n`);
  process.exitCode = EXIT.FAIL;
}
