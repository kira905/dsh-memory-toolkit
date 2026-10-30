// 配置解析层：所有落盘位置、模型参数、同步与召回阈值都从这一处成形，别处不再自己拼路径。
//
// 取值优先级是固定的三段：显式入参 > 环境变量 > 内置默认。
// 只有三段都没给，才退回用户主目录下的默认根；因此同一份代码换台机器只需换环境变量。
// 这里不写死任何机器名/主机名；测试必须自带临时目录，不许落默认位置。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 向量库的结构版本：只有键位/表结构真的改了才动它。
// 文档索引库是另一只库，版本号各算各的，别跟着这里一起抬。
export const SCHEMA_VERSION = '2';
export const DOC_INDEX_SCHEMA_VERSION = '1';
export const DEFAULT_MODEL_ID = 'bge-small-zh-v1.5';
export const DEFAULT_DIM = 512;

// 权重目录的三个候选，按优先级排：环境变量 > 用户目录 > 本地缓存目录。
export function defaultModelDirCandidates() {
  const home = os.homedir();
  return [
    process.env.MEMORY_ENGINE_MODEL_DIR,
    path.join(home, '.dsh', 'memory-engine', 'models'),
    path.join(home, '.cache', 'dsh-memory-engine', 'models'),
  ].filter(Boolean);
}

// 取第一个真实存在的候选；一个都不在就返回末位那个（调用方负责去创建）。
export function defaultModelDir() {
  const dirs = defaultModelDirCandidates();
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      // 探测失败当作"不存在"，继续看下一个
    }
  }
  return dirs[dirs.length - 1];
}

// 字符串字段：入参 > 环境变量 > 兜底。用 || 是故意的 —— 空串同样算"没给"。
const pick = (value, envValue, fallback) => value || envValue || fallback;

// 路径字段：兜底值由 dshHome 拼出来，换根目录时整棵树跟着搬。
const pickPath = (dshHome, value, envValue, segments) =>
  pick(value, envValue, path.join(dshHome, ...segments));

// 数值字段：只做一次 Number，非数字怎么处理交给上层（保持既有口径，不在这里纠偏）。
const pickNumber = (value, envValue, fallback) => Number(pick(value, envValue, fallback));

/**
 * 把三层来源折成一份配置。
 * 关键位置（记忆库 / 向量库 / 状态文件 / 模型目录）测试可以全部覆盖。
 */
export function resolveConfig(overrides = {}) {
  const env = overrides.env || process.env;
  const dshHome = pick(overrides.dshHome, env.DSH_HOME, path.join(os.homedir(), '.dsh'));
  const vectorsDir = pick(
    overrides.vectorsDir,
    env.MEMORY_ENGINE_VECTORS_DIR,
    path.join(dshHome, 'memory-vectors'),
  );

  return {
    dshHome,
    memoryDb: pickPath(dshHome, overrides.memoryDb, env.MEMORY_ENGINE_MEMORY_DB, ['memory', 'memory.db']),
    vectorsDir,
    vectorsDb: pick(overrides.vectorsDb, env.MEMORY_ENGINE_VECTORS_DB, path.join(vectorsDir, 'vectors.db')),
    stateFile: pickPath(dshHome, overrides.stateFile, env.MEMORY_ENGINE_STATE, [
      'butler-memory-vectors-state.json',
    ]),

    // 坑库这条来源的两个文件：一个只读输入，一个置/清标记用（都不由本层写）。
    pitfallsFile: pickPath(dshHome, overrides.pitfallsFile, env.MEMORY_ENGINE_PITFALLS_FILE, [
      'butler-pitfalls.json',
    ]),
    pitfallVectorDirtyFile: pickPath(
      dshHome,
      overrides.pitfallVectorDirtyFile,
      env.MEMORY_ENGINE_PITFALL_DIRTY,
      ['butler-pitfall-vector-dirty.json'],
    ),

    // 规则/技能语料面：persona 与技能目录各一处；文档面默认关（要扫时由调用方显式给）。
    // 这三处只读，且只在产生它的那台机器上有意义，不跟着任何同步走。
    policyPersonaDir: pickPath(dshHome, overrides.policyPersonaDir, env.MEMORY_ENGINE_POLICY_PERSONA_DIR, [
      '.agent-presets',
    ]),
    policySkillsRoot: pickPath(dshHome, overrides.policySkillsRoot, env.MEMORY_ENGINE_POLICY_SKILLS_ROOT, [
      'skills',
    ]),
    policyDocsPaths: overrides.policyDocsPaths || null,

    // 文档索引是独立库：库文件和运行状态都与向量库分开摆。
    docIndexDb: pick(overrides.docIndexDb, env.DOC_INDEX_DB, path.join(vectorsDir, 'doc-index.db')),
    docIndexState: pickPath(dshHome, overrides.docIndexState, env.DOC_INDEX_STATE, [
      'butler-doc-index-state.json',
    ]),
    docsRoot: pick(overrides.docsRoot, env.DOC_INDEX_DOCS_ROOT, path.join(process.cwd(), 'docs')),
    dshRoot: pick(overrides.dshRoot, env.DOC_INDEX_DSH_ROOT, process.cwd()),

    modelDir: overrides.modelDir || defaultModelDir(),
    modelId: pick(overrides.modelId, env.MEMORY_ENGINE_MODEL_ID, DEFAULT_MODEL_ID),
    dim: pickNumber(overrides.dim, env.MEMORY_ENGINE_DIM, DEFAULT_DIM),

    // 同步：一批多少条；兜底轮转把全表切几段。
    batchSize: pickNumber(overrides.batchSize, env.MEMORY_ENGINE_BATCH, 50),
    sweepSegments: pickNumber(overrides.sweepSegments, env.MEMORY_ENGINE_SWEEP_SEGMENTS, 20),

    // 召回：向量候选数 / 关键词候选数 / 融合常数 / 最终条数。
    vectorTopK: pickNumber(overrides.vectorTopK, env.MEMORY_ENGINE_VEC_TOPK, 20),
    ftsTopK: pickNumber(overrides.ftsTopK, env.MEMORY_ENGINE_FTS_TOPK, 20),
    rrfK: pickNumber(overrides.rrfK, env.MEMORY_ENGINE_RRF_K, 60),
    resultTopK: pickNumber(overrides.resultTopK, env.MEMORY_ENGINE_RESULT_TOPK, 8),

    // 编码桥只走回环地址，端口默认 8201。
    bridgeHost: pick(overrides.bridgeHost, env.MEMORY_ENGINE_BRIDGE_HOST, '127.0.0.1'),
    bridgePort: pickNumber(overrides.bridgePort, env.MEMORY_ENGINE_BRIDGE_PORT, 8201),

    hostId: pick(overrides.hostId, env.MEMORY_ENGINE_HOST_ID, os.hostname()),
  };
}
