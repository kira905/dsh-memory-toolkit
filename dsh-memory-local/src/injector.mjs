/**
 * FORK-EDIT(2026-09-21): 注入编排（方案 §3.4 注入层 / §6.1 指针注入链 / §7 fail-open）
 *
 * 契约：
 *   · 触发：仅 `step === 1` + user 文本非空（短暗号也算，方案 §3.3 Z16）；纯符号/单字跳过
 *   · 召回：S1 编码桥（POST /encode）+ 向量为主 + FTS 补位 + RRF(k=60) + **排除 pinned**
 *   · 预算：条数 ≤8、总量 ≤800 字 / ≤600 token（方案 §8.2 绝对量硬判据）
 *   · 去重：**以 surface 可见性为准**（压缩是遮蔽 seq 区间、不是删消息）+ 保守退化
 *           「每会话最多注入 N 次」（默认 3）+ 回合级一次性（step 多次只注入一次）
 *   · fail-open：任一环节异常/超时 ⇒ 不注入 + 写日志（绝不阻塞对话）
 */
import * as recallImpl from './recall.mjs';
import { renderPointer } from './pointer.mjs';
import { openMemoryReader } from './memory-read.mjs';
import { openVectorsReader } from './vectors-read.mjs';
import { createBridgeClient } from './bridge.mjs';
// FORK-EDIT(2026-09-22): U3 adapter 接入 —— 事件名收敛到适配层唯一源（值恒等，零语义变化）。
import { EV } from './host-adapter.js';

export const SOURCE_KIND = 'memory-recall';
export const SOURCE_VERSION = 1;

/** 从 claimed 批次里取本轮最后一条 user 文本（方案 §3.3 查询构造）。 */
export function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const texts = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    const joined = texts.join('\n').trim();
    if (joined) return joined;
  }
  return '';
}

/**
 * surface 可见性：数出**当前可见 surface** 里本插件注入过的 user 消息（方案 §3.4 Z12）。
 * 压缩遮蔽的 seq 区间不出现在 surface.nodes 里 ⇒ 被遮蔽的历史注入不计入 ⇒ 允许重新注入。
 *
 * FORK-EDIT(2026-10-09 · 冲刺600-M1 卡《注入去重修复》)：取事件面改为**新面优先、老线回落**。
 *   背景（上卡 §6 实测坐实的升级遗留缺陷）：主包 0.1.5-rc.2 的 `Session` 已删 `get events()`
 *   （只剩 `eventAt(seq)` / `snapshotEvents()`），老写法 `session.events[seq]` ⇒ `session.events`
 *   恒 `undefined` ⇒ 本函数开头守卫直接 return `{count:0}` ⇒ `maxPerSession` 与
 *   `surface-same-payload` 两道去重**永不触发**（每个回合都注入一次）。
 *   两面对照（静态取证，同构）：0.1.5-rc.2 `eventAt(seq) { return this.log[seq] }`
 *   （`@deepseek-ai/dsh-session/lib/index.js:1096`）；老面 `get events()` 返回的是**同一个**
 *   `this.log` 数组 ⇒ `events[seq]` 与 `eventAt(seq)` 取到同一个 `{seq, type, data}` 事件对象。
 *   `surface.nodes` 语义未变（0.1.5-rc.2 仍是 seq 数组：`lib/index.js:480` getter、
 *   `lib/types/surface.d.ts:94` `readonly nodes: readonly SessionSeq[]`）。
 *   ⚠️ 本卡只改这一处：不碰注入阈值 / 预算 / 去重语义 / 其它文件。
 * @returns {{count:number, lastText:string|null, ids:Set<string>}}
 */
export function visibleInjections(agent, kind = SOURCE_KIND) {
  const out = { count: 0, lastText: null, ids: new Set() };
  const session = agent && agent.session;
  const nodes = session && session.surface && Array.isArray(session.surface.nodes) ? session.surface.nodes : null;
  const hasEventAt = Boolean(session) && typeof session.eventAt === 'function';
  const events = session ? session.events : undefined;
  // 守卫：只有 nodes 不可用、或「两种取事件面都不可用」才早退
  // （不得因 0.1.5 起 `session.events` 缺失而恒判 0）
  if (!nodes || (!hasEventAt && !events)) return out;
  for (const seq of nodes) {
    const ev = hasEventAt ? session.eventAt(seq) : events[seq];
    if (!ev || ev.type !== EV.USER_MESSAGE) continue;
    const data = ev.data;
    if (!data || !data.source || data.source.kind !== kind) continue;
    out.count += 1;
    const text = (Array.isArray(data.content) ? data.content : [])
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (text) out.lastText = text;
    if (Array.isArray(data.source.items)) for (const id of data.source.items) out.ids.add(String(id));
  }
  return out;
}

/** 硬超时包装（超时即放弃，不排队、不重试，方案 §3.4/§6.1 ③）。 */
export function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ timedOut: true });
      }
    }, Math.max(1, Number(ms) || 1));
    promise.then(
      (v) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      (e) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve({ error: String(e && e.message ? e.message : e) });
        }
      },
    );
  });
}

/**
 * @param {object} opts
 * @param {object} opts.config 已解析参数（见 index.js 的 resolveRecallConfig）
 * @param {object} opts.logger createRecallLogger() 产物（可注入内存实现）
 * @param {object} [opts.moduleGate] createModuleGate() 产物
 * @param {object} [opts.bridge] 覆盖桥实现（单测注入 stub）
 * @param {object} [opts.deps]  { recall, openMemoryReader, openVectorsReader, now }
 */
export function createRecallInjector({
  config,
  logger,
  moduleGate = null,
  bridge = null,
  deps = {},
} = {}) {
  const _recall = deps.recall || recallImpl;
  const _openMemory = deps.openMemoryReader || openMemoryReader;
  const _openVectors = deps.openVectorsReader || openVectorsReader;
  const now = deps.now || (() => Date.now());

  let memory = null;
  let vectors = null;
  let index = null;
  let indexAt = 0;
  const turnMark = new WeakMap(); // agent → 已注入的 turn（回合级一次性）
  const stats = { decided: 0, injected: 0, skipped: 0, timeouts: 0, errors: 0 };

  const br = bridge || (
    config.enabled
      ? createBridgeClient({
          host: config.bridgeHost,
          port: config.bridgePort,
          portScanMax: config.bridgePortScanMax,
          encodeTimeoutMs: config.encodeTimeoutMs,
        })
      : null
  );

  const openMemory = () => {
    if (!memory) memory = _openMemory(config.memoryDb);
    return memory;
  };

  const openVectors = () => {
    if (!vectors) vectors = _openVectors(config.vectorsDb);
    return vectors;
  };

  const getIndex = () => {
    const ttl = config.indexTtlMs;
    if (index && now() - indexAt < ttl) return index;
    const v = openVectors();
    index = _recall.buildVectorIndex
      ? _recall.buildVectorIndex(v.db, { source: 'memory' })
      : null;
    indexAt = now();
    return index;
  };

  const close = () => {
    try {
      if (memory) memory.close();
    } catch {
      /* ignore */
    }
    try {
      if (vectors) vectors.close();
    } catch {
      /* ignore */
    }
    memory = null;
    vectors = null;
    index = null;
  };

  /** 门与依赖状态（只读，诊断用）。 */
  const status = () => {
    const gate = moduleGate ? moduleGate.check() : { enabled: true, reason: 'no-gate' };
    return {
      enabled: Boolean(config.enabled),
      module: gate,
      bridge: br ? { host: br.host, port: br.port, stats: br.stats ? br.stats() : null } : null,
      cache: { memory: Boolean(memory), vectors: Boolean(vectors), index: index ? index.count : 0 },
      stats: { ...stats },
      config: {
        memoryDb: config.memoryDb,
        vectorsDb: config.vectorsDb,
        logPath: logger ? logger.path : null,
        timeoutMs: config.timeoutMs,
        encodeTimeoutMs: config.encodeTimeoutMs,
        maxItems: config.maxItems,
        maxChars: config.maxChars,
        maxTokens: config.maxTokens,
        maxPerSession: config.maxPerSession,
      },
    };
  };

  /**
   * 单轮决策。**除日志外无副作用**；所有异常都转成 skip。
   * @returns {Promise<{action:'inject'|'skip', reason:string, text?:string, meta?:object}>}
   */
  const decide = async ({ query, agent, turn, step, sessionId = null, __flag = null, budgetMs = null }) => {
    stats.decided += 1;
    const t0 = now();
    const budget = Number.isFinite(Number(budgetMs)) && Number(budgetMs) > 0 ? Number(budgetMs) : config.timeoutMs;
    const elapsed = () => now() - t0;
    /** 预算复核（**不依赖 setTimeout**：长同步段会把定时器回调推到预算之后）。 */
    const overBudget = () => budget > 0 && elapsed() > budget;
    const base = { sessionId, turn: turn ?? null, step: step ?? null };
    const skip = (reason, extra = {}) => {
      stats.skipped += 1;
      // 硬超时已放弃本轮 ⇒ 迟到结束的内层链**不再补写日志**（否则一次超时会留下两行，污染统计口径）
      if (__flag && __flag.abandoned) return { action: 'skip', reason: 'abandoned-silent', meta: null };
      const rec = { event: 'skip', reason, ms: elapsed(), ...base, ...extra };
      if (logger) logger.log(rec);
      return { action: 'skip', reason, meta: rec };
    };

    try {
      if (!config.enabled) return skip('plugin-disabled');
      if (step !== 1) return skip('not-step-1');
      if (moduleGate && !moduleGate.check().enabled) {
        return skip(`module-drain:${moduleGate.check().reason}`);
      }
      const q = String(query ?? '');
      const gate = _recall.shouldTrigger(q);
      if (!gate.trigger) return skip(`query-${gate.reason}`, { chars: q.length });
      if (agent && turn != null && turnMark.get(agent) === turn) return skip('turn-already-injected');

      const seen = visibleInjections(agent);
      if (seen.count >= config.maxPerSession) {
        return skip('surface-visible-limit', { visible: seen.count, limit: config.maxPerSession });
      }

      const health = await br.probe();
      if (!health || !health.ok) {
        return skip('bridge-unavailable', { bridge: health ? health.error : 'no-client' });
      }

      let source;
      let store;
      try {
        source = openMemory();
        store = openVectors();
      } catch (e) {
        return skip('datastore-unavailable', { error: String(e && e.message ? e.message : e) });
      }

      const idx = getIndex();
      const qtext = q.length > config.queryMaxChars ? q.slice(0, config.queryMaxChars) : q;
      const r = await _recall.recall({
        query: qtext,
        store,
        source,
        embedder: br,
        index: idx,
        vectorTopK: config.vectorTopK,
        ftsTopK: config.ftsTopK,
        rrfK: config.rrfK,
        resultTopK: config.resultTopK,
      });
      if (!r.triggered) return skip(`recall-${r.reason}`);

      const ids = r.hits.map((h) => h.id);
      const rows = source.rowsByIds(ids);
      const byId = new Map(rows.map((row) => [Number(row.id), row]));
      const ordered = ids.map((id) => byId.get(Number(id))).filter(Boolean);
      const rendered = renderPointer(ordered, {
        maxItems: config.maxItems,
        maxChars: config.maxChars,
        maxTokens: config.maxTokens,
        summaryChars: config.summaryChars,
      });
      if (!rendered.text || !rendered.items.length) return skip('no-renderable-hits');

      if (seen.lastText && seen.lastText === rendered.text) {
        return skip('surface-same-payload', { visible: seen.count });
      }

      if (agent && turn != null) turnMark.set(agent, turn);
      stats.injected += 1;
      const meta = {
        event: 'inject',
        reason: 'ok',
        items: rendered.items.length,
        ids: rendered.items.map((i) => i.id),
        chars: rendered.chars,
        estTokens: rendered.estTokens,
        worstCaseTokens: rendered.worstCaseTokens,
        dropped: rendered.dropped,
        visibleBefore: seen.count,
        hits: r.hits.length,
        sources: r.hits.map((h) => h.sources.join('+')),
        timings: r.timings,
        indexSize: r.stats.indexSize,
        bridgePort: health.port,
        model: health.model,
        ms: now() - t0,
        ...base,
      };
      // 硬超时已放弃 / 已超预算 ⇒ 本轮不注入（调用方拿到的是 skip），也不落 inject 行
      if (__flag && __flag.abandoned) return { action: 'skip', reason: 'abandoned-silent', meta: null };
      if (overBudget()) return skip('timeout', { lateTimer: true, budgetMs: budget });
      if (logger) logger.log(meta);
      return { action: 'inject', reason: 'ok', text: rendered.text, meta };
    } catch (e) {
      stats.errors += 1;
      return skip('exception', { error: String(e && e.stack ? e.stack : e) });
    }
  };

  /** 带硬超时的决策（超时 ⇒ skip + 日志；被放弃的 promise 结果被丢弃，且**不再补写日志**）。
   *
   * ⚠️ 为什么还要「事后 elapsed 复核」（2026-09-21 真机实测修正）：
   * `setTimeout` 的计时器回调在**事件循环被长同步段（首次向量矩阵构建 + 余弦全扫）阻塞**时会被推迟，
   * 于是 `withTimeout` 可能在预算之后才 settle，把一次 524ms 的决策当成成功返回 —— 实测踩到过一次。
   * ⇒ 双判据：定时器先到 或 **返回时 elapsed > 预算** 都算超时，一律不注入（fail-open，宁可不注入）。
   */
  const decideWithTimeout = async (args) => {
    const t0 = now();
    const flag = { abandoned: false };
    const out = await withTimeout(decide({ ...args, __flag: flag, budgetMs: config.timeoutMs }), config.timeoutMs);
    const elapsed = now() - t0;
    const overBudget = !(out && (out.timedOut || out.error)) && elapsed > config.timeoutMs;
    if ((out && out.timedOut) || overBudget) {
      stats.timeouts += 1;
      flag.abandoned = true; // 通知迟到完成的内层链：本轮已放弃，别写日志
      const rec = {
        event: 'skip',
        reason: 'timeout',
        ms: elapsed,
        budgetMs: config.timeoutMs,
        lateTimer: Boolean(overBudget),
        sessionId: args ? args.sessionId : null,
        turn: args ? args.turn : null,
        step: args ? args.step : null,
      };
      if (logger) logger.log(rec);
      return { action: 'skip', reason: 'timeout', meta: rec };
    }
    if (out && out.error) {
      stats.errors += 1;
      const rec = { event: 'skip', reason: 'exception', error: out.error, ms: now() - t0 };
      if (logger) logger.log(rec);
      return { action: 'skip', reason: 'exception', meta: rec };
    }
    return out;
  };

  /** `memory_get` 展开留痕（方案 §8.2 展开率）。只记元数据，不记正文。 */
  const logExpand = ({ id, chars, truncated, sessionId = null, found = true }) => {
    if (!logger) return;
    logger.log({ event: 'expand', id: Number(id), chars: Number(chars) || 0, truncated: Boolean(truncated), found: Boolean(found), sessionId });
  };

  /** 只读取一条记忆全文（`memory_get` 用；复用召回侧的只读连接）。 */
  const getById = (id) => openMemory().getById(id);

  /**
   * 预热：插件启用时在后台先把向量矩阵读进内存 + 探一次桥。
   * 动机（2026-09-21 真机实测）：首次注入要同步构建 622×512 矩阵（几十~上百 ms），
   * 叠上探活与编码容易顶破 300ms 预算 ⇒ 提前预热，把首次注入拉到与稳态同档。
   * 失败一律静默（预热失败不影响 fail-open 语义）。
   */
  const warmup = async () => {
    try {
      if (!config.enabled) return { ok: false, reason: 'disabled' };
      const health = await br.probe(true);
      if (!health || !health.ok) return { ok: false, reason: 'bridge-unavailable' };
      const idx = getIndex();
      return { ok: true, count: idx ? idx.count : 0, bridgePort: health.port };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e) };
    }
  };

  return {
    decide,
    decideWithTimeout,
    status,
    close,
    logExpand,
    getById,
    warmup,
    get bridge() {
      return br;
    },
    _internals: { getIndex, openMemory, openVectors, visibleInjections },
  };
}
