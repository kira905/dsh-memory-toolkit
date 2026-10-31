// memory-db-tools/lib/known-devices.mjs — 「已知设备名」的唯一出处
//
// 为什么有这个文件：体检工具要靠「设备标里的这个名字认不认识」把记忆分成
// 已知设备 / 未知设备（OTHER）。这份名单**每台机器都不一样**，所以它绝不属于代码：
//   ① 随包发布一份配置（memory-engine/config/audit-devices.json）—— 换机器改那一份；
//   ② 环境变量 MEMORY_DB_AUDIT_DEVICES 可在不改文件的情况下覆盖（逗号或空白分隔）；
//   ③ 两者都没有时退回**中性示例名** alpha / beta —— 只是让工具装完能跑，不代表任何真实机器。
//
// 匹配口径（与旧实现同形，别改）：
//   · 只看设备标里冒号后那一段名字，拿名单里的每个名字做**大小写敏感**的子串匹配；
//   · 一条里有两个设备标 ⇒ 那是 DOUBLE，不参与本判据（由调用方先判）；
//   · 名单为空的配置视为无效（会让所有设备标都变成 OTHER），退回缺省并给一句警告。
//
// 本模块纯读：只读一个 JSON 文件，不写、不联网、不起子进程。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 内置缺省：中性示例名（不是机器名）。装完就能跑，换机器请改配置或设环境变量。 */
export const BUILTIN_DEVICES = Object.freeze(['alpha', 'beta']);

/** 环境变量名（覆盖配置）。 */
export const ENV_DEVICES = 'MEMORY_DB_AUDIT_DEVICES';

/** 统计结果里固定跟着的三个键，不能被设备名占用。 */
export const RESERVED_KEYS = Object.freeze(['NONE', 'OTHER', 'DOUBLE']);

/** 设备名的合法形态：字母数字下划线连字符，1~32 字符（要能当 JSON 的键用）。 */
export const DEVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** 设备标在正文里的形态（与各探针一致；只用于从一条命中里取出 X 段）。 */
export const DEVICE_TAG_RE = /【设备[：:]\s*([^】]*)】/g;

/** 配置文件的绝对位置：`memory-engine/config/audit-devices.json`（随包发布）。 */
export function configPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'memory-engine', 'config', 'audit-devices.json');
}

/** 逗号 / 空白分隔的名单串（环境变量与配置文件里的字符串共用）。 */
export function splitNames(text) {
  return String(text ?? '')
    .split(/[\s,，]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 把任意来源的名字串收敛成合法名单：去重（大小写敏感）、剔掉保留键与非法形态。
 * 返回 { devices, rejected }，rejected 里每项带原因（自检与警告要用）。
 */
export function normalizeDevices(names) {
  const rejected = [];
  const seen = new Set();
  const devices = [];
  for (const raw of names) {
    const name = String(raw);
    if (RESERVED_KEYS.includes(name)) {
      rejected.push({ name, reason: '与统计结果里的固定键重名（NONE / OTHER / DOUBLE）' });
      continue;
    }
    if (!DEVICE_NAME_RE.test(name)) {
      rejected.push({ name, reason: '形态不合法（只允许字母数字下划线连字符，1~32 字符）' });
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    devices.push(name);
  }
  return { devices, rejected };
}

/**
 * 解析「已知设备名」。优先级：环境变量 > 配置文件 > 内置缺省。
 * @param {{ env?: Record<string,string>, file?: string, config?: object }} [opts]
 * @returns {{ devices: string[], source: 'env'|'config'|'builtin', file: string, warnings: string[] }}
 */
export function loadKnownDevices(opts = {}) {
  const env = opts.env || process.env;
  const file = opts.file || configPath();
  const warnings = [];

  // ① 环境变量（显式给了就用它，哪怕配置文件也在）
  const fromEnv = normalizeDevices(splitNames(env[ENV_DEVICES]));
  if (fromEnv.devices.length) {
    for (const r of fromEnv.rejected) warnings.push(`${ENV_DEVICES} 里的 ${JSON.stringify(r.name)} 被忽略：${r.reason}`);
    return { devices: fromEnv.devices, source: 'env', file, warnings };
  }
  if (String(env[ENV_DEVICES] ?? '').trim()) {
    warnings.push(`${ENV_DEVICES} 给了但一个合法名字都没有 ⇒ 退回配置文件 / 内置缺省`);
  }

  // ② 配置文件
  const cfg = opts.config !== undefined ? { ok: true, value: opts.config } : readJsonFile(file);
  if (cfg.ok) {
    const raw = cfg.value && cfg.value.devices;
    if (Array.isArray(raw)) {
      const norm = normalizeDevices(raw.map((x) => (typeof x === 'string' ? x : String(x))));
      for (const r of norm.rejected) warnings.push(`${file} 里的 ${JSON.stringify(r.name)} 被忽略：${r.reason}`);
      if (norm.devices.length) return { devices: norm.devices, source: 'config', file, warnings };
      warnings.push(`${file} 的 devices 为空或全不合法 ⇒ 退回内置缺省`);
    } else {
      warnings.push(`${file} 里没有 devices 数组 ⇒ 退回内置缺省`);
    }
  } else if (cfg.reason !== 'missing') {
    warnings.push(`读不了 ${file}（${cfg.reason}）⇒ 退回内置缺省`);
  }

  // ③ 内置缺省
  return { devices: [...BUILTIN_DEVICES], source: 'builtin', file, warnings };
}

function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: `解不开：${e && e.message}` };
  }
}

/**
 * 一个设备标（形如 `【设备：X】`）落在名单里的哪个名字上；都不落在就是 null（⇒ OTHER）。
 * 找不到 X 段时退回整串匹配，保证与旧实现「直接测整串」同形。
 */
export function knownDeviceKey(tag, devices) {
  if (!devices || !devices.length) return null;
  const m = /【设备[：:]\s*([^】]*)】/.exec(String(tag));
  const subject = m ? m[1] : String(tag);
  for (const name of devices) if (subject.includes(name)) return name;
  return null;
}

/** 与 knownDeviceKey 同义，给「认不认识」这种问法用。 */
export function isKnownDeviceTag(tag, devices) {
  return knownDeviceKey(tag, devices) !== null;
}
