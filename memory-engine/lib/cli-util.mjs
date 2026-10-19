// 记忆引擎 v2 · 离线层 —— CLI 公共工具
//
// 入口守卫（铁律）：工作区下可能存在目录 junction，`import.meta.url` 会解析为物理路径而
// `process.argv[1]` 是逻辑路径 ⇒ 必须 realpath 双方再比，否则 main 入口永不触发、脚本静默退出 0。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from './config.mjs';
import { openVectorsStore } from './vectors-store.mjs';
import { openMemorySource } from './memory-source.mjs';
import { openPitfallSource } from './pitfall-source.mjs';
import { openPolicySource, scanPolicySources } from './policy-source.mjs';
import { createStubEmbedder, createHttpEmbedder, createLocalEmbedder } from './embedder.mjs';

/** 已实现的向量来源（值 = `vectors.source` 的取值） */
export const KNOWN_SOURCES = ['memory', 'pitfall', 'policy'];

/** `--source` 取值（默认 memory；缺省不改任何现有行为） */
export function resolveSourceName(flags = {}, dflt = 'memory') {
  const s = flags.source;
  if (s === undefined || s === true || s === '') return dflt;
  return String(s);
}

/**
 * 按来源选数据源（方案 §A.2 第 11 行 I-1：**运行时选源单例**）。
 * ⚠️ 不改这里 ⇒ 即使 sync/sweep/recall 全参数化，命令行也**选不到**坑源。
 */
export function openDataSource(name, config) {
  const n = String(name);
  if (n === 'memory') return openMemorySource(config.memoryDb);
  if (n === 'pitfall') return openPitfallSource(config.pitfallsFile);
  // 【2026-10-10 · 补坑库联动BCD】policy 源 = **每次现扫**（语料是文件，不是库）：
  //   段清单由 `scanPolicySources()` 只读扫描得到 ⇒ 无需另建状态文件；增量同步靠 (refId, textHash) 幂等。
  if (n === 'policy') {
    return openPolicySource({
      segments: scanPolicySources({
        personaDir: config.policyPersonaDir,
        skillsRoot: config.policySkillsRoot,
        docsPaths: config.policyDocsPaths,
      }),
    });
  }
  throw new Error(`未知来源: ${n}（现支持 memory / pitfall / policy）`);
}

export function isMainEntry(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    const a = fs.realpathSync(fileURLToPath(importMetaUrl));
    const b = fs.realpathSync(argv1);
    return a === b;
  } catch {
    return false;
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[i + 1];
        i += 1;
      } else {
        flags[body] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

/** --json 时日志只上 stderr（机器只读 stdout 的 JSON） */
export function makeLogger({ json = false, quiet = false, prefix = '' } = {}) {
  const write = (s) => {
    if (quiet) return;
    if (json) process.stderr.write(s + '\n');
    else process.stdout.write(s + '\n');
  };
  return (msg) => write(prefix ? `${prefix} ${msg}` : String(msg));
}

export function num(v, dflt) {
  if (v === undefined || v === null || v === true) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 打开运行时（配置 / 向量库 / 记忆库只读 / 编码器）。
 * 一切路径可注入；CLI 未传时落默认（≈ `~/.dsh`）。
 */
export async function openRuntime(flags = {}, { withSource = true, withEmbedder = true } = {}) {
  const config = resolveConfig({
    memoryDb: flags['memory-db'] || undefined,
    vectorsDb: flags['vectors-db'] || undefined,
    vectorsDir: flags['vectors-dir'] || undefined,
    stateFile: flags['state-file'] || undefined,
    pitfallsFile: flags['pitfalls-file'] || undefined,
    pitfallVectorDirtyFile: flags['pitfall-dirty-file'] || undefined,
    // 【2026-10-10 · 补坑库联动BCD】policy 语料面（隔离建库时用：向量库落隔离 home、
    //   语料仍指生产只读路径 ⇒ 既不动生产库，又能编出真语料）
    policyPersonaDir: flags['policy-persona-dir'] || undefined,
    policySkillsRoot: flags['policy-skills-root'] || undefined,
    policyDocsPaths: flags['policy-docs']
      ? String(flags['policy-docs']).split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    modelDir: flags['model-dir'] || undefined,
    modelId: flags.model || undefined,
    dim: flags.dim ? Number(flags.dim) : undefined,
    hostId: flags.host || undefined,
    batchSize: flags.batch ? Number(flags.batch) : undefined,
    bridgePort: flags['bridge-port'] ? Number(flags['bridge-port']) : undefined,
    dshHome: flags['dsh-home'] || undefined,
  });

  const store = openVectorsStore(config.vectorsDb, { create: true });
  store.hostId = config.hostId;

  // 数据源按名字缓存（多来源召回要同时开 memory + pitfall；同一来源只开一次）
  const cache = new Map();
  const openSource = (name) => {
    const n = String(name);
    if (!cache.has(n)) cache.set(n, openDataSource(n, config));
    return cache.get(n);
  };
  const sourceName = resolveSourceName(flags);
  let source = null;
  if (withSource) source = openSource(sourceName);

  let embedder = null;
  if (!withEmbedder) {
    embedder = null;
  } else if (flags['stub-embedder']) {
    embedder = createStubEmbedder({ dim: config.dim, modelId: `${config.modelId}-stub` });
  } else if (flags['http-embedder']) {
    embedder = createHttpEmbedder({
      host: config.bridgeHost,
      port: config.bridgePort,
      timeoutMs: num(flags['bridge-timeout'], 250),
      modelId: config.modelId,
      dim: config.dim,
    });
  } else {
    embedder = await createLocalEmbedder({
      modelDir: config.modelDir,
      modelId: config.modelId,
      dim: config.dim,
      quantized: Boolean(flags.quantized),
      dtype: flags.dtype || null,
    });
  }

  return {
    config,
    store,
    source,
    sourceName,
    openSource,
    embedder,
    close() {
      for (const s of cache.values()) {
        try {
          if (s) s.close();
        } catch {
          /* ignore */
        }
      }
      cache.clear();
      try {
        store.db.close();
      } catch {
        /* ignore */
      }
    },
  };
}

export function relForLog(p) {
  try {
    return path.relative(process.cwd(), p) || p;
  } catch {
    return p;
  }
}

export function fmtMs(v) {
  return `${Number(v).toFixed(1)}ms`;
}
