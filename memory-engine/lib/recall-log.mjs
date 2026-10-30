// 召回留痕：每一轮召回的旁路 JSONL（谁问的、命中哪几条、多少分、是不是降级出来的）。
//
// 为什么要有它：召回质量是「事后才知道」的事 —— 没有一份可回放的记录，"这次查偏了"
// 就只能靠记忆猜。所以这里只做一件事：把每轮结果压成一行 JSON 追加到旁路文件，
// 与注入主路完全解耦（写失败绝不影响召回）。
//
// 三条边界：
//   ① **不缝进主路**：主路只在拿到结果后调一次 `recordRecall()`；本模块抛错一律被吞。
//   ② **不会长成黑洞**：字节上限触发轮转（保留 N 代）+ 天数上限清理旧代，两个闸同时管；
//      `keepFiles: 0` 表示"只留当前文件，超限就清空重开"。
//   ③ **默认不写**：库不该在纯查询里偷偷落盘（query 可能带隐私）。开关 = 显式给目录 /
//      环境变量 `DSH_MEMORY_RECALL_LOG_DIR`；`DSH_MEMORY_RECALL_LOG=off` 一键关回。
//
// 行格式（字段只增不改，方便下游按 `v` 兼容）：
//   { t, v:1, event:'recall', source, query, queryChars, triggered, hitCount,
//     degraded:{mode,reason,topK}|null, encodeError:{name,ms}|null,
//     lexicon:{enabled,status,hits}|null, timings:{encodeMs,lexiconMs,totalMs},
//     hits:[{rank, id, refId, score, sources}] }
import fs from 'node:fs';
import path from 'node:path';

/** 出厂默认：单文件 512 KB、留 3 代、14 天，query 只留前 200 字，命中最多记 8 条。 */
export const RECALL_LOG_DEFAULTS = Object.freeze({
  file: 'recall.jsonl',
  maxBytes: 512 * 1024,
  keepFiles: 3,
  keepDays: 14,
  maxQueryChars: 200,
  maxHits: 8,
});

const ENV_DIR = 'DSH_MEMORY_RECALL_LOG_DIR';
const ENV_SWITCH = 'DSH_MEMORY_RECALL_LOG';

const OFF_WORDS = new Set(['0', 'off', 'false', 'no', 'disable', 'disabled']);
const ON_WORDS = new Set(['1', 'on', 'true', 'yes', 'enable', 'enabled']);

/**
 * 开关：`DSH_MEMORY_RECALL_LOG` = on/off。返回 null 表示"没表态"（由有没有给目录决定）。
 * @param {object} [env]
 * @returns {boolean|null}
 */
export function recallLogSwitch(env = process.env) {
  const raw = env ? env[ENV_SWITCH] : undefined;
  if (raw === undefined || raw === null || raw === '') return null;
  const text = String(raw).trim().toLowerCase();
  if (OFF_WORDS.has(text)) return false;
  if (ON_WORDS.has(text)) return true;
  return null;
}

/** 日志目录：显式入参 > 环境变量 `DSH_MEMORY_RECALL_LOG_DIR`；都没有 ⇒ null（不启用）。 */
export function resolveRecallLogDir({ dir = null, env = process.env } = {}) {
  if (dir) return path.resolve(String(dir));
  const fromEnv = env ? env[ENV_DIR] : null;
  return fromEnv ? path.resolve(String(fromEnv)) : null;
}

const clip = (value, limit) => {
  const text = String(value ?? '');
  if (!limit || limit <= 0 || text.length <= limit) return text;
  return [...text].slice(0, limit).join('');
};

const roundTo = (value, digits = 3) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const scale = 10 ** digits;
  return Math.round(parsed * scale) / scale;
};

/**
 * 召回结果 → 一行记录（只留判读需要的字段；记忆正文一概不记）。
 * @param {object} result `recall()` / `recallMulti()` 的返回值
 * @param {{maxQueryChars?:number, maxHits?:number}} [options]
 */
export function buildRecallRecord(result, options = {}) {
  const maxQueryChars = options.maxQueryChars ?? RECALL_LOG_DEFAULTS.maxQueryChars;
  const maxHits = options.maxHits ?? RECALL_LOG_DEFAULTS.maxHits;
  const hits = Array.isArray(result?.hits) ? result.hits : [];
  const stats = result?.stats || {};
  const timings = result?.timings || {};
  const kept = maxHits > 0 ? hits.slice(0, maxHits) : hits;

  return {
    v: 1,
    event: 'recall',
    source: stats.sourceName || (Array.isArray(stats.sources) ? stats.sources.join(',') : null),
    query: clip(result?.query, maxQueryChars),
    queryChars: String(result?.query ?? '').length,
    triggered: Boolean(result?.triggered),
    reason: result?.reason ?? null,
    hitCount: hits.length,
    degraded: result?.degraded ?? null,
    encodeError: result?.encodeError ?? null,
    lexicon: stats.lexiconEnabled === undefined
      ? null
      : { enabled: Boolean(stats.lexiconEnabled), status: stats.lexiconStatus ?? null, hits: stats.lexiconHits ?? 0 },
    timings: {
      encodeMs: roundTo(timings.encodeMs),
      lexiconMs: roundTo(timings.lexiconMs),
      totalMs: roundTo(timings.totalMs),
    },
    hits: kept.map((hit, at) => ({
      rank: at + 1,
      id: hit?.id ?? null,
      refId: hit?.refId ?? null,
      score: roundTo(hit?.score, 6),
      sources: Array.isArray(hit?.sources) ? hit.sources : [],
    })),
  };
}

/**
 * 写一条记录。logger 为 null / 已关 ⇒ 空操作（返回 false），**永不抛错**。
 * @param {{record?:Function}|null} logger
 * @param {object} result
 * @param {object} [options]
 * @returns {boolean}
 */
export function recordRecall(logger, result, options = {}) {
  if (!logger || typeof logger.record !== 'function') return false;
  try {
    return logger.record(buildRecallRecord(result, options));
  } catch {
    return false;
  }
}

// 文件名里不许出现目录分隔符：轮转后代由它派生，别给外部路径留口子。
const assertPlainName = (name) => {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`recall-log: 文件名不能带路径（收到 ${JSON.stringify(name)}）`);
  }
};

/**
 * 旁路日志器：单文件追加 + 按字节轮转 + 按天数清旧代。
 *
 * 目录必须先给（没给就是编程错误，当场抛）；一旦建好，所有写操作都吞错。
 * @param {{dir:string, file?:string, maxBytes?:number, keepFiles?:number, keepDays?:number,
 *          maxQueryChars?:number, maxHits?:number, enabled?:boolean, now?:Function,
 *          fsImpl?:object, echo?:Function|null}} config
 */
export function createRecallLog(config = {}) {
  const dir = config.dir ? path.resolve(String(config.dir)) : '';
  if (!dir) throw new Error('recall-log: 需要 dir（日志目录）');
  const file = String(config.file || RECALL_LOG_DEFAULTS.file);
  assertPlainName(file);
  const fsImpl = config.fsImpl || fs;
  const now = config.now || Date.now;
  const enabled = config.enabled !== false;
  const maxBytes = Math.max(0, Number(config.maxBytes ?? RECALL_LOG_DEFAULTS.maxBytes));
  const keepFiles = Math.max(0, Math.trunc(Number(config.keepFiles ?? RECALL_LOG_DEFAULTS.keepFiles)));
  const keepDays = Math.max(0, Number(config.keepDays ?? RECALL_LOG_DEFAULTS.keepDays));
  const recordOptions = {
    maxQueryChars: config.maxQueryChars ?? RECALL_LOG_DEFAULTS.maxQueryChars,
    maxHits: config.maxHits ?? RECALL_LOG_DEFAULTS.maxHits,
  };

  const active = path.join(dir, file);
  const ext = path.extname(file) || '.jsonl';
  const base = path.basename(file, ext);
  const generationPath = (n) => path.join(dir, `${base}.${n}${ext}`);
  const generationPattern = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
  );

  const stats = { written: 0, rotations: 0, pruned: 0, errors: 0 };
  const sizeOf = (target) => {
    try {
      return fsImpl.statSync(target).size;
    } catch {
      return 0;
    }
  };

  // 只清理本目录下、由本文件派生的轮转代（不接受任何外部路径）
  const prune = () => {
    let names = [];
    try {
      names = fsImpl.readdirSync(dir).filter((name) => generationPattern.test(name));
    } catch {
      return;
    }
    const cutoff = keepDays > 0 ? now() - keepDays * 86400000 : 0;
    for (const name of names) {
      const target = path.join(dir, name);
      const generation = Number(generationPattern.exec(name)[1]);
      const tooMany = keepFiles > 0 && generation > keepFiles;
      let tooOld = false;
      if (cutoff > 0) {
        try {
          tooOld = fsImpl.statSync(target).mtimeMs < cutoff;
        } catch {
          tooOld = false;
        }
      }
      if (!tooMany && !tooOld) continue;
      try {
        fsImpl.rmSync(target, { force: true });
        stats.pruned += 1;
      } catch {
        /* 删不掉不算错：下一轮轮转还会再试 */
      }
    }
  };

  const rotate = () => {
    stats.rotations += 1;
    if (keepFiles === 0) {
      // 只留当前文件：超限就把旧内容丢掉重开（不留代）
      try {
        fsImpl.rmSync(active, { force: true });
      } catch {
        stats.errors += 1;
        return false;
      }
      return true;
    }
    // 逐代右移：active → .1 → .2 …，最老的一代被覆盖
    for (let n = keepFiles; n >= 1; n -= 1) {
      const from = n === 1 ? active : generationPath(n - 1);
      const to = generationPath(n);
      const size = sizeOf(from);
      if (size <= 0) continue;
      try {
        fsImpl.rmSync(to, { force: true });
        fsImpl.renameSync(from, to);
      } catch {
        stats.errors += 1;
        return false;
      }
    }
    prune();
    return true;
  };

  const record = (payload) => {
    if (!enabled) return false;
    try {
      const line = `${JSON.stringify({ t: new Date(now()).toISOString(), ...payload })}\n`;
      fsImpl.mkdirSync(dir, { recursive: true });
      if (maxBytes > 0 && sizeOf(active) + line.length > maxBytes) rotate();
      fsImpl.appendFileSync(active, line, 'utf8');
      stats.written += 1;
      return true;
    } catch {
      stats.errors += 1;
      return false;
    }
  };

  return {
    enabled,
    dir,
    file: active,
    record,
    rotate,
    prune,
    recordOptions,
    stats: () => ({ ...stats, bytes: sizeOf(active) }),
    close: () => {},
  };
}

/**
 * 按「显式目录 / 环境变量」开一个日志器；没配置就返回 null（= 不写）。
 * 开关 `DSH_MEMORY_RECALL_LOG=off` 时即使配了目录也不写。
 * @param {{dir?:string|null, enabled?:boolean|null, env?:object}} [options]
 */
export function openRecallLog(options = {}) {
  const env = options.env || process.env;
  const wanted = options.enabled === undefined || options.enabled === null
    ? recallLogSwitch(env)
    : options.enabled;
  if (wanted === false) return null;
  const dir = resolveRecallLogDir({ dir: options.dir, env });
  if (!dir) return null;
  try {
    return createRecallLog({ ...options, dir });
  } catch {
    return null;
  }
}
