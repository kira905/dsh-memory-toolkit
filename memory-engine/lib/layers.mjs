// 分层口径的唯一出处：层名集合 / 缺省层 / 列名 / 行指纹 / 配置文件位置。
//
// 三条硬口径（本文件就是它们的实现）：
//   ① 层名**不写死**：缺省的 core / recall / archival 只是随仓发布的配置里的值，
//      换一套层名只改 config/layers.json（或环境变量），代码里没有任何一处 switch 层名；
//   ② 缺省层只决定「存量行回填成什么」，**绝不等于删除或隐藏**：回填不改正文、不改行数；
//   ③ 行指纹是跨命令的唯一比对口径（迁移前后 / 搬出搬回 / 快照对拍都用它），
//      算法 = 定序数组的 JSON + sha256，字段顺序与分隔方式写死，换版本不许改。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.mjs';

/** 层名白名单：只允许字母数字下划线连字符，1~32 字符。给 SQL 与表名留安全边界。 */
export const LAYER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** 内置兜底（配置缺失时用它，保证「装完就能跑」）。 */
export const BUILTIN_LAYERS = Object.freeze({
  column: 'layer',
  layers: Object.freeze(['core', 'recall', 'archival']),
  defaultLayer: 'recall',
});

const ENV = Object.freeze({
  layers: 'MEMORY_ENGINE_LAYERS',
  defaultLayer: 'MEMORY_ENGINE_DEFAULT_LAYER',
  column: 'MEMORY_ENGINE_LAYER_COLUMN',
});

/** `memory-engine/config/` 的绝对位置（随包发布）。 */
export function configDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config');
}

export function defaultLayerConfigPath() {
  return path.join(configDir(), 'layers.json');
}

export function defaultBandsConfigPath() {
  return path.join(configDir(), 'bands.json');
}

/** 读一份 JSON 配置文件：不存在就返回 ok:false（不是异常），解不开才算错。 */
export function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, value: JSON.parse(text), file };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: 'missing', file };
    return { ok: false, reason: `解不开：${e && e.message}`, file };
  }
}

/** 解析逗号/空白分隔的层名串（环境变量与命令行共用）。 */
export function splitNames(text) {
  return String(text ?? '')
    .split(/[\s,，]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function assertNames(layers, where) {
  if (!Array.isArray(layers) || layers.length === 0) {
    throw new Error(`${where} 的层名集合为空 —— 至少要有一个层名`);
  }
  const seen = new Set();
  for (const name of layers) {
    if (!LAYER_NAME.test(String(name))) {
      throw new Error(`${where} 的层名不合法：${JSON.stringify(name)}（只允许字母数字下划线连字符，1~32 字符）`);
    }
    const key = String(name).toLowerCase();
    if (seen.has(key)) throw new Error(`${where} 的层名重复：${name}（大小写不敏感地重了）`);
    seen.add(key);
  }
  return layers.map(String);
}

/**
 * 折出一份层配置。优先级：显式入参 > 环境变量 > 配置文件 > 内置兜底。
 * @returns {{column:string, layers:string[], defaultLayer:string, source:object, warnings:string[]}}
 */
export function loadLayerConfig({ file = null, layers = null, defaultLayer = null, column = null, env = process.env } = {}) {
  const warnings = [];
  const cfgPath = file ? path.resolve(file) : defaultLayerConfigPath();
  const disk = readJsonFile(cfgPath);
  if (!disk.ok && disk.reason !== 'missing') throw new Error(`层配置读不了（${cfgPath}）：${disk.reason}`);
  if (!disk.ok) warnings.push(`层配置不在（${cfgPath}）⇒ 用内置层名 ${BUILTIN_LAYERS.layers.join('/')}`);

  const fromDisk = disk.ok && disk.value && typeof disk.value === 'object' ? disk.value : {};

  const envLayers = splitNames(env[ENV.layers]);
  const explicitLayers = Array.isArray(layers) ? layers : splitNames(layers);

  const picked = explicitLayers.length ? explicitLayers : envLayers.length ? envLayers : fromDisk.layers;
  const names = assertNames(picked && picked.length ? picked : [...BUILTIN_LAYERS.layers], '层配置');

  const col =
    String(column || env[ENV.column] || fromDisk.column || BUILTIN_LAYERS.column).trim();
  if (!LAYER_NAME.test(col)) throw new Error(`层列名不合法：${col}`);

  const dflt = String(defaultLayer || env[ENV.defaultLayer] || fromDisk.default || BUILTIN_LAYERS.defaultLayer).trim();
  if (!names.some((n) => n.toLowerCase() === dflt.toLowerCase())) {
    throw new Error(`缺省层「${dflt}」不在层名集合 [${names.join(', ')}] 里 —— 回填会写进一个不存在的层`);
  }
  const defaultResolved = names.find((n) => n.toLowerCase() === dflt.toLowerCase());

  const source = {
    file: cfgPath,
    fileUsed: disk.ok,
    layers: explicitLayers.length ? 'cli' : envLayers.length ? 'env' : disk.ok ? 'file' : 'builtin',
    defaultLayer: defaultLayer ? 'cli' : env[ENV.defaultLayer] ? 'env' : disk.ok && fromDisk.default ? 'file' : 'builtin',
    column: column ? 'cli' : env[ENV.column] ? 'env' : disk.ok && fromDisk.column ? 'file' : 'builtin',
  };
  return { column: col, layers: names, defaultLayer: defaultResolved, source, warnings };
}

/** 层在集合里的位次（越靠后越"深"）；不在集合里回 -1。 */
export function layerRank(cfg, name) {
  const key = String(name ?? '').toLowerCase();
  return cfg.layers.findIndex((n) => n.toLowerCase() === key);
}

/** 该名字是否属于配置里的层（大小写不敏感），返回规范写法或 null。 */
export function canonicalLayerName(cfg, name) {
  const rank = layerRank(cfg, name);
  return rank < 0 ? null : cfg.layers[rank];
}

/** 行指纹的定序字段：顺序改动即破坏跨版本可比性。 */
export function digestFields(cfg) {
  return ['id', 'text', 'tags', 'pinned', 'created_at', 'updated_at', cfg.column];
}

/** 一行的规范化部分（数组形态，便于逐字段比对差异）。 */
export function canonicalParts(row, cfg) {
  return [
    Number(row?.id ?? 0),
    String(row?.text ?? ''),
    String(row?.tags ?? ''),
    Number(row?.pinned ?? 0),
    Number(row?.created_at ?? 0),
    Number(row?.updated_at ?? 0),
    String(row?.[cfg.column] ?? ''),
  ];
}

/** 行指纹 = sha256(JSON(定序数组))。 */
export function rowDigest(row, cfg) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalParts(row, cfg)), 'utf8').digest('hex');
}

/** 一批行 → Map<id, digest>。 */
export function digestRows(rows, cfg) {
  const out = new Map();
  for (const row of rows) out.set(Number(row.id), rowDigest(row, cfg));
  return out;
}

/** 两批指纹比对：返回缺失 / 多出 / 内容不符三类，空数组即一致。 */
export function compareDigests(before, after) {
  const missing = [];
  const extra = [];
  const changed = [];
  for (const [id, d] of before) {
    if (!after.has(id)) missing.push(id);
    else if (after.get(id) !== d) changed.push(id);
  }
  for (const id of after.keys()) if (!before.has(id)) extra.push(id);
  const sortNum = (a, b) => a - b;
  return { missing: missing.sort(sortNum), extra: extra.sort(sortNum), changed: changed.sort(sortNum) };
}

/** 记忆库路径的缺省来源（与引擎其余部分共用一份配置解析）。 */
export function defaultMemoryDbPath(env = process.env) {
  return resolveConfig({ env }).memoryDb;
}

/** 人话描述这层配置从哪来（报告与 --help 里用）。 */
export function describeConfig(cfg) {
  const bits = [`列名 ${cfg.column}`, `层名 ${cfg.layers.join(' / ')}`, `缺省层 ${cfg.defaultLayer}`];
  const src = cfg.source;
  const where = {
    cli: '命令行',
    env: '环境变量',
    file: path.basename(src.file),
    builtin: '内置兜底',
  };
  return `${bits.join(' · ')}（来源：层名=${where[src.layers] ?? src.layers}、缺省层=${where[src.defaultLayer] ?? src.defaultLayer}）`;
}
