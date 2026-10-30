// 启动自检：把「引擎现在到底能不能用」拆成几条独立判据，逐条给结论。
//
// 设计取舍：自检**永不阻断启动**。任何一条判死，也只是往清单里写一条 fail，
// 由调用方自己决定是降级跑还是重建 —— 因为自检本身挂掉比带病启动更糟。
import { SCHEMA_VERSION } from './config.mjs';
import { META_KEYS, getMeta, getMetaFor, setMeta, countVectors } from './vectors-store.mjs';

const errorText = (e) => String(e && e.message ? e.message : e);

// ------------------------------------------------------------------ 各判据

/** ① 表存在性：缺表时 open 阶段应已重建，这里只核对重建结果。 */
function checkTables(store) {
  const have = store.schema.tables;
  if (!have.vectors || !have.meta) {
    return { name: '表存在性', status: 'fail', detail: 'vectors 或 meta 表缺失且重建失败' };
  }
  const created = store.schema.created;
  return {
    name: '表存在性',
    status: 'ok',
    detail: created.length ? `缺表已重建：${created.join(', ')}` : 'vectors / meta 均在位',
    created,
  };
}

/** ② 库内 schemaVersion 与代码期望值是否一致（不一致只 warn，不做迁移）。 */
function checkSchemaVersion(db) {
  const found = getMeta(db, META_KEYS.schemaVersion);
  const same = found === SCHEMA_VERSION;
  return {
    name: 'schemaVersion',
    status: same ? 'ok' : 'warn',
    detail: same ? `=${found}` : `库内为 ${found ?? '(空)'}，代码期望 ${SCHEMA_VERSION}`,
    schemaVersion: found,
  };
}

/** ③ 模型可用性：探针本身可能抛，抛了也算「不可用」而不是让自检崩。 */
async function probeModel(embedder) {
  try {
    return await embedder.health();
  } catch (e) {
    return { ready: false, error: errorText(e) };
  }
}

function checkModel(health, embedder) {
  const model = health.model ?? embedder.modelId;
  const where = health.modelDir ?? health.bridge ?? embedder.kind;
  return {
    name: '模型可用性',
    status: health.ready ? 'ok' : 'fail',
    detail: health.ready ? `${model} @ ${where}` : `不可用：${health.error || 'unknown'}`,
    health,
  };
}

/** ④ 维度三方比对：实测维 vs 配置维 vs 库内 meta。 */
async function probeDimension(embedder) {
  try {
    const vector = await embedder.encode('维度自检');
    return { dim: vector.length, error: null };
  } catch (e) {
    return { dim: null, error: errorText(e) };
  }
}

function checkDimension(probe, db, config, sourceName) {
  if (probe.error) {
    return { name: '维度一致', status: 'fail', detail: `编码探测失败：${probe.error}` };
  }
  const stored = getMetaFor(db, META_KEYS.dim, sourceName);
  const fitsConfig = Number(probe.dim) === Number(config.dim);
  const fitsStore = stored == null || Number(stored) === Number(probe.dim);
  const status = fitsConfig && fitsStore ? 'ok' : 'fail';
  const hint = status === 'ok' ? '' : ' ⇒ 需全量重建（--full）';
  return {
    name: '维度一致',
    status,
    detail: `实测 ${probe.dim} 维 / 配置 ${config.dim} / 库内 ${stored ?? '(空)'}${hint}`,
    probeDim: probe.dim,
    configDim: config.dim,
    metaDim: stored,
  };
}

/** ⑤ hostId：向量库明确不跨机同步，库里的 hostId 与当前机器不符 = 库不是本机产物。 */
function checkHostId(db, config, allowHostMismatch) {
  const stored = getMeta(db, META_KEYS.hostId);
  if (!stored) {
    setMeta(db, META_KEYS.hostId, String(config.hostId));
    return { name: 'hostId 校验', status: 'ok', detail: `首次初始化，已写入 ${config.hostId}` };
  }
  if (stored === String(config.hostId)) {
    return { name: 'hostId 校验', status: 'ok', detail: `=${stored}` };
  }
  return {
    name: 'hostId 校验',
    status: allowHostMismatch ? 'warn' : 'fail',
    detail: `库内 hostId=${stored}，当前=${config.hostId} ⇒ 该库非本机产物，建议全量重建（--full）`,
    metaHost: stored,
    current: config.hostId,
  };
}

/** ⑥ 覆盖度（信息项，不是判据）：每个来源各有自己的对照物，不能用同一个分母。 */
function coverageTargets(source, sources, sourceName) {
  if (sources && sources.length) return sources.map((s) => ({ name: String(s.name), source: s.source }));
  if (source) return [{ name: String(sourceName), source }];
  return [];
}

function checkCoverage(target, db, multi) {
  const name = multi ? `向量覆盖度(${target.name})` : '向量覆盖度';
  try {
    const total = target.source.count();
    const encoded = countVectors(db, target.name);
    const pct = total ? (encoded / total) * 100 : 0;
    return {
      name,
      status: 'info',
      detail: `${target.name} 源：向量 ${encoded} 条 / 源条数 ${total} 条（${pct.toFixed(1)}%）`,
      sourceName: target.name,
      vecCount: encoded,
      memCount: total,
    };
  } catch (e) {
    return { name, status: 'warn', detail: `统计失败：${errorText(e)}` };
  }
}

// ------------------------------------------------------------------ 入口

export async function runSelfcheck({
  store,
  source = null,
  sources = null,
  sourceName = 'memory',
  embedder,
  config,
  allowHostMismatch = true,
}) {
  const db = store.db;
  const checks = [];
  const record = (entry) => {
    checks.push(entry);
    return entry.status;
  };

  record(checkTables(store));
  record(checkSchemaVersion(db));

  const health = await probeModel(embedder);
  record(checkModel(health, embedder));

  record(checkDimension(await probeDimension(embedder), db, config, sourceName));
  record(checkHostId(db, config, allowHostMismatch));

  const targets = coverageTargets(source, sources, sourceName);
  const multi = targets.length > 1;
  for (const target of targets) record(checkCoverage(target, db, multi));

  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn');
  return { ok: failed.length === 0, checks, failed: failed.length, warned: warned.length };
}
