// 记忆引擎 v2 · 离线层 —— 启动自检（方案 §8.3 交付物 #9）
//
// 四判据：模型可用性 / 维度一致 / 表存在性（缺则重建）/ hostId 校验。
// 自检失败绝不阻断启动：返回结构化结果，由调用方决定是否降级。
import { SCHEMA_VERSION } from './config.mjs';
import { META_KEYS, getMeta, getMetaFor, setMeta, countVectors } from './vectors-store.mjs';

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
  const add = (name, status, detail, extra = {}) => {
    checks.push({ name, status, detail, ...extra });
    return status;
  };

  // ① 表存在性（缺则重建）
  const t = store.schema.tables;
  if (t.vectors && t.meta) {
    add(
      '表存在性',
      'ok',
      store.schema.created.length
        ? `缺表已重建：${store.schema.created.join(', ')}`
        : 'vectors / meta 均在位',
      { created: store.schema.created },
    );
  } else {
    add('表存在性', 'fail', 'vectors 或 meta 表缺失且重建失败');
  }

  // ② schemaVersion
  const sv = getMeta(db, META_KEYS.schemaVersion);
  add(
    'schemaVersion',
    sv === SCHEMA_VERSION ? 'ok' : 'warn',
    sv === SCHEMA_VERSION ? `=${sv}` : `库内为 ${sv ?? '(空)'}，代码期望 ${SCHEMA_VERSION}`,
    { schemaVersion: sv },
  );

  // ③ 模型可用性
  let health = { ready: false, error: 'not probed' };
  try {
    health = await embedder.health();
  } catch (e) {
    health = { ready: false, error: String(e && e.message ? e.message : e) };
  }
  add(
    '模型可用性',
    health.ready ? 'ok' : 'fail',
    health.ready
      ? `${health.model ?? embedder.modelId} @ ${health.modelDir ?? health.bridge ?? embedder.kind}`
      : `不可用：${health.error || 'unknown'}`,
    { health },
  );

  // ④ 维度一致（编码探测 + 与库内 meta / 配置三方比对）
  let probeDim = null;
  let probeError = null;
  try {
    const v = await embedder.encode('维度自检');
    probeDim = v.length;
  } catch (e) {
    probeError = String(e && e.message ? e.message : e);
  }
  const metaDim = getMetaFor(db, META_KEYS.dim, sourceName);
  if (probeError) {
    add('维度一致', 'fail', `编码探测失败：${probeError}`);
  } else {
    const configOk = Number(probeDim) === Number(config.dim);
    const metaOk = metaDim == null || Number(metaDim) === Number(probeDim);
    const status = configOk && metaOk ? 'ok' : 'fail';
    add(
      '维度一致',
      status,
      `实测 ${probeDim} 维 / 配置 ${config.dim} / 库内 ${metaDim ?? '(空)'}` +
        (status === 'ok' ? '' : ' ⇒ 需全量重建（--full）'),
      { probeDim, configDim: config.dim, metaDim },
    );
  }

  // ⑤ hostId 校验（向量库明确不同步；hostId 不符说明库来自别的机器）
  const metaHost = getMeta(db, META_KEYS.hostId);
  if (!metaHost) {
    setMeta(db, META_KEYS.hostId, String(config.hostId));
    add('hostId 校验', 'ok', `首次初始化，已写入 ${config.hostId}`);
  } else if (metaHost === String(config.hostId)) {
    add('hostId 校验', 'ok', `=${metaHost}`);
  } else {
    add(
      'hostId 校验',
      allowHostMismatch ? 'warn' : 'fail',
      `库内 hostId=${metaHost}，当前=${config.hostId} ⇒ 该库非本机产物，建议全量重建（--full）`,
      { metaHost, current: config.hostId },
    );
  }

  // ⑥ 覆盖度（信息项；非判据）——【2026-10-10 · 补坑库联动A】改成**逐 source** 报告
  //    ⚠️ 判据不是"向量数 vs 记忆数"这一种：坑源的对照物是**坑库条数**（`butler-pitfalls.json` 的条目数）。
  const srcList = sources && sources.length
    ? sources.map((s) => ({ name: String(s.name), source: s.source }))
    : source
      ? [{ name: String(sourceName), source }]
      : [];
  for (const s of srcList) {
    const label = srcList.length > 1 ? `向量覆盖度(${s.name})` : '向量覆盖度';
    try {
      const memCount = s.source.count();
      const vecCount = countVectors(db, s.name);
      const ratio = memCount ? (vecCount / memCount) * 100 : 0;
      add(label, 'info', `${s.name} 源：向量 ${vecCount} 条 / 源条数 ${memCount} 条（${ratio.toFixed(1)}%）`, {
        sourceName: s.name,
        vecCount,
        memCount,
      });
    } catch (e) {
      add(label, 'warn', `统计失败：${String(e && e.message ? e.message : e)}`);
    }
  }

  const failed = checks.filter((c) => c.status === 'fail');
  const warned = checks.filter((c) => c.status === 'warn');
  return { ok: failed.length === 0, checks, failed: failed.length, warned: warned.length };
}
