// 命令行公共件：参数解析、入口守卫、日志出口、运行时装配。
//
// 入口守卫这条是铁律：工作区里可能挂着目录链接，`import.meta.url` 会被解析成物理路径，
// 而 `process.argv[1]` 仍是调用方给的那条逻辑路径 ⇒ 两边都 realpath 之后再比；
// 否则 main 永远不触发，脚本一声不响地以 0 退出。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.mjs';
import { openVectorsStore } from './vectors-store.mjs';
import { openMemorySource } from './memory-source.mjs';
import { openPitfallSource } from './pitfall-source.mjs';
import { openPolicySource, scanPolicySources } from './policy-source.mjs';
import { createStubEmbedder, createHttpEmbedder, createLocalEmbedder } from './embedder.mjs';

/** 已实现的向量来源（取值即 `vectors.source` 里的字符串）。 */
export const KNOWN_SOURCES = ['memory', 'pitfall', 'policy'];

// `--source` 的默认值：没给、给了空值、给了裸开关，一律当"没给" ⇒ 仍是 memory。
export function resolveSourceName(flags = {}, dflt = 'memory') {
  const given = flags.source;
  const missing = given === undefined || given === true || given === '';
  return missing ? dflt : String(given);
}

/**
 * 按名字挑数据源 —— 运行时选源的唯一分发点。
 * 下游就算全参数化了，命令行也只从这里才拿得到坑源与规则源。
 */
export function openDataSource(name, config) {
  const which = String(name);
  if (which === 'memory') return openMemorySource(config.memoryDb);
  if (which === 'pitfall') return openPitfallSource(config.pitfallsFile);
  if (which === 'policy') {
    // 规则源没有库：语料本身就是文件，每次现扫一份段清单喂进去
    // （增量靠 refId + textHash 幂等，不需要另建状态文件）。
    const segments = scanPolicySources({ personaDir: config.policyPersonaDir, skillsRoot: config.policySkillsRoot, docsPaths: config.policyDocsPaths });
    return openPolicySource({ segments });
  }
  throw new Error(`未知来源: ${which}（现支持 memory / pitfall / policy）`);
}

// 两边都取物理路径再比；取不到（文件不在 / 权限不够）就当"不是入口"，不抛错。
export function isMainEntry(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(importMetaUrl));
    return self === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}

// 长开关的正则：`--name` 或 `--name=value` 两种形态一把抓（值里允许再出现等号）。
const LONG_OPTION = /^--([^=]*)(?:=([\s\S]*))?$/;

/**
 * 极简参数解析：`--k=v`、`--k v`、`--k`（布尔）三种写法都认，其余进 rest。
 * 不认识的开关不做校验 —— 交给各命令自己决定要不要报错。
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const rest = [];
  let at = 0;
  while (at < argv.length) {
    const token = argv[at];
    const hit = LONG_OPTION.exec(token);
    if (!hit) {
      rest.push(token);
      at += 1;
      continue;
    }
    const [, name, inlineValue] = hit;
    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      at += 1;
      continue;
    }
    const next = argv[at + 1];
    // 下一个词本身还是开关 ⇒ 当前这个只能当布尔开关
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      at += 2;
      continue;
    }
    flags[name] = true;
    at += 1;
  }
  return { flags, rest };
}

/** `--json` 时人话日志一律走 stderr —— 机器只解析 stdout 上那一份 JSON。 */
export function makeLogger({ json = false, quiet = false, prefix = '' } = {}) {
  const emit = (line) => {
    if (!quiet) {
      const sink = json ? process.stderr : process.stdout;
      sink.write(`${line}\n`);
    }
  };
  return (msg) => emit(prefix ? `${prefix} ${msg}` : String(msg));
}

// 数值兜底：没给 / null / 裸开关都回默认值；转不成有限数字也回默认值。
export function num(v, dflt) {
  const absent = v === undefined || v === null || v === true;
  if (absent) return dflt;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : dflt;
}

// 纯字符串型开关 → 配置字段（给了就带过去；空串与裸开关算没给）。
const STRING_FLAGS = [
  ['memoryDb', 'memory-db'],
  ['vectorsDb', 'vectors-db'],
  ['vectorsDir', 'vectors-dir'],
  ['stateFile', 'state-file'],
  ['pitfallsFile', 'pitfalls-file'],
  ['pitfallVectorDirtyFile', 'pitfall-dirty-file'],
  ['policyPersonaDir', 'policy-persona-dir'],
  ['policySkillsRoot', 'policy-skills-root'],
  ['modelDir', 'model-dir'],
  ['modelId', 'model'],
  ['hostId', 'host'],
  ['dshHome', 'dsh-home'],
];

// 数值型开关 → 配置字段（裸开关按 Number(true) = 1 算，与历史口径一致）。
const NUMBER_FLAGS = [
  ['dim', 'dim'],
  ['batchSize', 'batch'],
  ['bridgePort', 'bridge-port'],
];

const wasGiven = (raw) => raw !== undefined && raw !== '' && raw !== false;

// 命令行 → 覆盖项。只带真给了的那几项，剩下的留给环境变量与默认值。
function configOverrides(flags) {
  const overrides = {};
  for (const [field, flag] of STRING_FLAGS) {
    if (wasGiven(flags[flag])) overrides[field] = flags[flag];
  }
  for (const [field, flag] of NUMBER_FLAGS) {
    if (wasGiven(flags[flag])) overrides[field] = Number(flags[flag]);
  }
  const docs = flags['policy-docs'];
  if (docs) {
    overrides.policyDocsPaths = String(docs).split(',').map((piece) => piece.trim()).filter(Boolean);
  }
  return overrides;
}

// 三种编码器按开关挑：stub（骨架）> http（回环桥）> local（默认）。
function buildEmbedder(flags, config) {
  if (flags['stub-embedder']) {
    return createStubEmbedder({ dim: config.dim, modelId: `${config.modelId}-stub` });
  }
  if (flags['http-embedder']) {
    const bridge = { host: config.bridgeHost, port: config.bridgePort, modelId: config.modelId, dim: config.dim };
    return createHttpEmbedder({ ...bridge, timeoutMs: num(flags['bridge-timeout'], 250) });
  }
  return createLocalEmbedder({ modelDir: config.modelDir, modelId: config.modelId, dim: config.dim, quantized: Boolean(flags.quantized), dtype: flags.dtype || null });
}

/**
 * 装配一次运行时：配置 + 向量库 + 数据源 + 编码器。
 * 所有路径都能注入；命令行没给时落默认（≈ 用户主目录下的引擎根）。
 */
export async function openRuntime(flags = {}, { withSource = true, withEmbedder = true } = {}) {
  const config = resolveConfig(configOverrides(flags));
  const vault = openVectorsStore(config.vectorsDb, { create: true });
  vault.hostId = config.hostId;

  // 数据源按名字缓存：多来源召回会同时开 memory 与 pitfall，同一个名字只开一次、收尾一次关掉。
  const opened = new Map();
  const sourceFor = (name) => {
    const key = String(name);
    if (!opened.has(key)) opened.set(key, openDataSource(key, config));
    return opened.get(key);
  };
  const chosen = resolveSourceName(flags);
  const source = withSource ? sourceFor(chosen) : null;
  const embedder = withEmbedder ? await buildEmbedder(flags, config) : null;

  return {
    config, store: vault, source, sourceName: chosen, openSource: sourceFor, embedder,
    close() {
      for (const handle of opened.values()) {
        try {
          if (handle) handle.close();
        } catch {
          // 关不掉不算错
        }
      }
      opened.clear();
      try {
        vault.db.close();
      } catch {
        // 同上
      }
    },
  };
}

// 日志里尽量给相对路径（短、好读）；算不出来就原样回。
export function relForLog(p) {
  try {
    const rel = path.relative(process.cwd(), p);
    return rel || p;
  } catch {
    return p;
  }
}

// 毫秒读数统一保留一位小数，后缀写死。
export function fmtMs(v) {
  const fixed = Number(v).toFixed(1);
  return `${fixed}ms`;
}
