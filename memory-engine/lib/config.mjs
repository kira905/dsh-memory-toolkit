// 记忆引擎 v2 · 离线层 —— 配置与路径解析
//
// 铁律（方案 §4 宿主迁移契约 / 本卡「测试不得写生产路径」）：
//   1. 一切路径都可注入（overrides）或经环境变量覆盖，默认值才落 ~/.dsh；
//   2. 测试一律显式传临时目录，绝不落到生产路径；
//   3. 不写死机器名/主机名常量。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 本常量 = **向量库（vectors.db）** 的 schema 版本。
//   2026-10-10 · 补坑库联动A：'1' → '2'（meta 键位加 `<key>:<source>` 命名空间；**表结构未变**，
//   老库靠 `migrateMetaNamespace()` 幂等迁移 + 兼容读，回滚靠「冗余写」保持旧键同值）。
//   ⚠️ 文档索引库（doc-index.db）的 DDL 与本库无关，**不要**跟着改 —— 它有独立常量（见下）。
export const SCHEMA_VERSION = '2';
/** 文档索引库（doc-index.db）的 schema 版本（本轮未动其 DDL ⇒ 保持 '1'） */
export const DOC_INDEX_SCHEMA_VERSION = '1';
export const DEFAULT_MODEL_ID = 'bge-small-zh-v1.5';
export const DEFAULT_DIM = 512;

/** 模型权重目录候选（第一个存在的即用；都不存在则用最后一个 = 会被创建的那个） */
export function defaultModelDirCandidates() {
  return [
    process.env.MEMORY_ENGINE_MODEL_DIR,
    path.join(os.homedir(), '.dsh', 'memory-engine', 'models'), // 可经 MEMORY_ENGINE_MODEL_DIR 覆盖
    path.join(os.homedir(), '.cache', 'dsh-memory-engine', 'models'),
  ].filter(Boolean);
}

export function defaultModelDir() {
  const candidates = defaultModelDirCandidates();
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 忽略探测失败 */
    }
  }
  return candidates[candidates.length - 1];
}

/**
 * 解析配置。overrides 优先级最高，其次环境变量，最后默认值。
 * 关键字段（测试可全部覆盖）：memoryDb / vectorsDb / stateFile / modelDir。
 */
export function resolveConfig(overrides = {}) {
  const env = overrides.env || process.env;
  const dshHome =
    overrides.dshHome ||
    env.DSH_HOME ||
    path.join(os.homedir(), '.dsh');

  const vectorsDir =
    overrides.vectorsDir ||
    env.MEMORY_ENGINE_VECTORS_DIR ||
    path.join(dshHome, 'memory-vectors');

  return {
    dshHome,
    // 数据源：默认生产库；本卡一律传副本路径（方案 §8.1 铁律）
    memoryDb:
      overrides.memoryDb ||
      env.MEMORY_ENGINE_MEMORY_DB ||
      path.join(dshHome, 'memory', 'memory.db'),
    vectorsDir,
    vectorsDb:
      overrides.vectorsDb ||
      env.MEMORY_ENGINE_VECTORS_DB ||
      path.join(vectorsDir, 'vectors.db'),
    stateFile:
      overrides.stateFile ||
      env.MEMORY_ENGINE_STATE ||
      path.join(dshHome, 'butler-memory-vectors-state.json'),

    // 【2026-10-10 · 补坑库联动A】坑库第二向量来源（source='pitfall'）的输入与标记文件
    //   · pitfallsFile：坑库状态文件（**只读**，A 点不写它）
    //   · pitfallVectorDirtyFile：置/清标记双写者的那个标记文件（登记见 dsh-butler/lib/state-files.mjs）
    pitfallsFile:
      overrides.pitfallsFile ||
      env.MEMORY_ENGINE_PITFALLS_FILE ||
      path.join(dshHome, 'butler-pitfalls.json'),
    pitfallVectorDirtyFile:
      overrides.pitfallVectorDirtyFile ||
      env.MEMORY_ENGINE_PITFALL_DIRTY ||
      path.join(dshHome, 'butler-pitfall-vector-dirty.json'),

    // 【2026-10-10 · 补坑库联动BCD】policy 语料面（source='policy' · 落地判据向量化 · B 点）
    //   语料三份里 MVP 只做前两份（方案 §4 B.3-1）：① persona 铁律段 ② 技能段；③ 文档段默认空
    //   （「不做全量 docs」是方案的明写 Non-goal —— 那是 S3 doc-index 的活）。
    //   ⚠️ policy 库**只在本机建**（D5 已拍 = 不跨机传 persona/技能文本）⇒ 库不进任何同步仓。
    policyPersonaDir:
      overrides.policyPersonaDir ||
      env.MEMORY_ENGINE_POLICY_PERSONA_DIR ||
      path.join(dshHome, '.agent-presets'),
    policySkillsRoot:
      overrides.policySkillsRoot ||
      env.MEMORY_ENGINE_POLICY_SKILLS_ROOT ||
      path.join(dshHome, 'skills'),
    policyDocsPaths: overrides.policyDocsPaths || null, // 默认空（后置项，不默认扫全量 docs）

    // 文档索引层（方案 §3.2：独立库出主库；§4 载体清单）
    docIndexDb:
      overrides.docIndexDb ||
      env.DOC_INDEX_DB ||
      path.join(vectorsDir, 'doc-index.db'),
    docIndexState:
      overrides.docIndexState ||
      env.DOC_INDEX_STATE ||
      path.join(dshHome, 'butler-doc-index-state.json'),
    // 扫描面与 path 口径锚（不写死机器名；方案 §4 宿主迁移契约）
    docsRoot: overrides.docsRoot || env.DOC_INDEX_DOCS_ROOT || path.join(process.cwd(), 'docs'),
    dshRoot: overrides.dshRoot || env.DOC_INDEX_DSH_ROOT || process.cwd(),

    modelDir: overrides.modelDir || defaultModelDir(),
    modelId: overrides.modelId || env.MEMORY_ENGINE_MODEL_ID || DEFAULT_MODEL_ID,
    dim: Number(overrides.dim || env.MEMORY_ENGINE_DIM || DEFAULT_DIM),

    // 同步参数（方案 §3.1：批 50）
    batchSize: Number(overrides.batchSize || env.MEMORY_ENGINE_BATCH || 50),
    // 兜底 hash 轮转段数（方案 §3.1：按周 / id 段轮转覆盖全表）
    sweepSegments: Number(overrides.sweepSegments || env.MEMORY_ENGINE_SWEEP_SEGMENTS || 20),

    // 召回参数（方案 §3.3）
    vectorTopK: Number(overrides.vectorTopK || env.MEMORY_ENGINE_VEC_TOPK || 20),
    ftsTopK: Number(overrides.ftsTopK || env.MEMORY_ENGINE_FTS_TOPK || 20),
    rrfK: Number(overrides.rrfK || env.MEMORY_ENGINE_RRF_K || 60),
    resultTopK: Number(overrides.resultTopK || env.MEMORY_ENGINE_RESULT_TOPK || 8),

    // 编码桥（方案 §3.1 编码通道契约：仅回环、端口 8201）
    bridgeHost: overrides.bridgeHost || env.MEMORY_ENGINE_BRIDGE_HOST || '127.0.0.1',
    bridgePort: Number(overrides.bridgePort || env.MEMORY_ENGINE_BRIDGE_PORT || 8201),

    hostId: overrides.hostId || env.MEMORY_ENGINE_HOST_ID || os.hostname(),
  };
}
