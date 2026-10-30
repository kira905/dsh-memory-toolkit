// 坑的权重与升级阶梯 —— 全是纯函数，给定输入就给定输出（回归时有 golden 值盯着）。
//
// 两个概念：
//   权重：踩得越勤越重，但会随时间自然衰减 —— count × 0.5^(距上次踩坑的天数 / 半衰期)。
//         沉下去不等于删掉：超过一个半衰期没再踩，只标"疑似已修复"，条目仍留在库里。
//   阶梯：踩 1 次入库 / 2 次上浮 / 3 次以上且跨 2 个会话才生成升级候选。
//         候选有三种落点（自动检查项 → 内联技能 → persona 铁律），越靠后越重；
//         本件只负责"建议哪一种"，从不自己动手改 persona 或技能。
//
// 形态判定先查映射表（同目录的 pitfall-form-map.mjs）：成因确定的坑交给表，表里没有才回落到
// 按文本特征猜。起因很实在 —— 有类坑的文本里净是路径，一猜就猜成"路径存在性预检"，
// 方向完全反了。
//
// 口径约定：count = 同签名的总出现次数；衰减的天数取末次出现时间（lastSeen）。

import { lookupFormByMap } from './pitfall-form-map.mjs';

// 本版起 suggestForm 换了判定顺序：先查表、再启发式（表在本件之外，见上面的 import）。
export const PITFALL_SCORE_VERSION = '0.2.0';

/** 权重半衰期（天）：每过这么多天，权重乘 1/2 */
export const HALF_LIFE_DAYS = 30;
/** 距末次出现超过这么多天 → 标"疑似已修复"（只沉底，不删除） */
export const LIKELY_FIXED_DAYS = 30;
/** 升级候选的两道门槛：出现次数、跨会话数 */
export const CANDIDATE_MIN_COUNT = 3;
export const CANDIDATE_MIN_SESSIONS = 2;
/** 够格进坑库的门槛（seed 条目另算） */
export const PITFALL_MIN_COUNT = 2;
/** seed 条目（历史文字坑）的基准权重：不数 count，只进衰减池 */
export const SEED_BASE_SCORE = 2;

const DAY_MS = 86_400_000;
const ROUND_SCALE = 10000;
const DECAY_BASE = 0.5;

// 权重统一保留 4 位小数：先放大再取整再缩回，避免 0.1+0.2 式的尾巴进报告
function round4(value) {
  return Math.round(value * ROUND_SCALE) / ROUND_SCALE;
}

/**
 * 距上次踩坑过了多少天。
 * 没有时间戳、时间戳非法、或者算出来是负数（时钟回拨）一律按 0 天处理。
 * @param {number} lastSeenMs
 * @param {number} nowMs
 * @returns {number}
 */
export function daysSince(lastSeenMs, nowMs) {
  const seen = Number(lastSeenMs);
  if (!Number.isFinite(seen) || seen <= 0) return 0;
  const elapsed = (Number(nowMs) - seen) / DAY_MS;
  return elapsed > 0 ? elapsed : 0;
}

/**
 * 动态权重：count × 0.5^(天数 / 半衰期)。
 * @param {number} count 同签名总次数
 * @param {number} lastSeenMs 末次出现时间（epoch ms）
 * @param {number} nowMs
 * @param {number} [halfLifeDays]
 * @returns {number} 保留 4 位小数；count 为 0 直接 0
 */
export function decayScore(count, lastSeenMs, nowMs, halfLifeDays = HALF_LIFE_DAYS) {
  const occurrences = Number(count) || 0;
  if (occurrences === 0) return 0;
  const factor = Math.pow(DECAY_BASE, daysSince(lastSeenMs, nowMs) / halfLifeDays);
  return round4(occurrences * factor);
}

/**
 * 一条坑的当前权重。两种来源分开算：
 *   scan 条目 —— count 走衰减；
 *   seed 条目 —— 没有 count，用基准权重（seedBase）走衰减。
 * @param {object} pitfall
 * @param {number} nowMs
 * @returns {number}
 */
export function scoreOf(pitfall, nowMs) {
  if (pitfall?.source === 'seed') {
    const baseline = Number(pitfall.seedBase ?? SEED_BASE_SCORE) || SEED_BASE_SCORE;
    return round4(baseline * Math.pow(DECAY_BASE, daysSince(pitfall.lastSeen, nowMs) / HALF_LIFE_DAYS));
  }
  return decayScore(pitfall?.count, pitfall?.lastSeen, nowMs);
}

/** 是否"疑似已修复"（够久没再踩；不删条目，只是沉底并打标） */
export function isLikelyFixed(lastSeenMs, nowMs, days = LIKELY_FIXED_DAYS) {
  return daysSince(lastSeenMs, nowMs) >= days;
}

/**
 * 阶梯档位。
 * @returns {'recorded'|'surfaced'|'candidate'}
 */
export function ladderStage(count, sessionCount) {
  const hits = Number(count) || 0;
  const sessions = Number(sessionCount) || 0;
  if (hits >= CANDIDATE_MIN_COUNT && sessions >= CANDIDATE_MIN_SESSIONS) return 'candidate';
  return hits >= PITFALL_MIN_COUNT ? 'surfaced' : 'recorded';
}

/** 够不够格进坑库：seed 条目豁免（它是人工挑进去的历史文字坑） */
export function isRecordable(pitfall) {
  if (pitfall?.source === 'seed') return true;
  return (Number(pitfall?.count) || 0) >= PITFALL_MIN_COUNT;
}

// 会话数：优先认显式字段，没有就数 sessions 数组的长度；两种情况都过一遍 Number
function sessionTally(pitfall) {
  const explicit = pitfall.sessionCount;
  if (explicit === undefined || explicit === null) {
    return Array.isArray(pitfall.sessions) ? pitfall.sessions.length : 0;
  }
  return Number(explicit);
}

// 排序规则写成一个比较器：权重降序 → 次数降序 → 末次时间降序 → id 升序（保证可复现）
function rankOrder(left, right) {
  return right.score - left.score
    || (Number(right.count) || 0) - (Number(left.count) || 0)
    || (Number(right.lastSeen) || 0) - (Number(left.lastSeen) || 0)
    || String(left.id).localeCompare(String(right.id));
}

/**
 * 排序并补齐派生字段。
 * @param {object[]} pitfalls
 * @param {number} nowMs
 * @returns {object[]} 新数组（附 score / stage / likelyFixed / daysSinceLast）
 */
export function rankPitfalls(pitfalls, nowMs) {
  const decorated = (pitfalls ?? []).map((pitfall) => {
    const sessionCount = sessionTally(pitfall);
    return {
      ...pitfall,
      sessionCount,
      score: scoreOf(pitfall, nowMs),
      stage: ladderStage(pitfall.count, sessionCount),
      likelyFixed: isLikelyFixed(pitfall.lastSeen, nowMs),
      daysSinceLast: Math.round(daysSince(pitfall.lastSeen, nowMs) * 10) / 10,
    };
  });
  decorated.sort(rankOrder);
  return decorated;
}

/**
 * 开工前看一眼的 Top N：跳过被排除的；全是"疑似已修复"时退回原始前 N（免得空手）。
 * @param {object[]} pitfalls
 * @param {number} n
 * @param {number} nowMs
 * @returns {object[]}
 */
export function topN(pitfalls, n, nowMs) {
  const usable = rankPitfalls(pitfalls, nowMs).filter((row) => !row.excluded);
  const fresh = usable.filter((row) => !row.likelyFixed);
  return (fresh.length ? fresh : usable).slice(0, n);
}

// 没有稳定错误码、只能靠签名特征认的坑（按顺序试，先命中者胜）
const SIGNATURE_FORMS = [
  {
    pattern: /FS_SANDBOX_DENIED/,
    form: 'check',
    why: '沙箱拒绝=权限配置问题，可做成"写生产路径前先验权限"的检查项',
  },
  {
    pattern: /FS_NOT_TEXT|FS_NOT_FOUND/,
    form: 'check',
    why: '读文件前可先验类型/存在性，适合做成检查项',
  },
];

// 按分类给形态：分类信息只有一层，逐条 if 不如查表
const CATEGORY_FORMS = new Map([
  ['守护鱼', { form: 'check', why: '守护鱼类坑适合做成只读健康检查项（dsh-selfcheck 同款）' }],
  ['插件', { form: 'skill', why: '插件类坑适合内联进 plugin-deploy 技能开头' }],
  ['同步', { form: 'skill', why: '同步类坑适合内联进同步/备份相关技能或脚本注释' }],
  ['会话', { form: 'skill', why: '会话类坑适合内联进 session-cleanup / dsh-restart 技能' }],
  ['pwsh', { form: 'skill', why: 'pwsh 类坑适合内联进相关技能；若能脚本化则优先检查项' }],
]);

const PATH_HINT_RE = /路径|path|<PATH>/i;
const PATH_FORM = { form: 'check', why: '路径假设类坑可做成"路径存在性预检"检查项' };
const FALLBACK_FORM = { form: 'skill', why: '默认建议内联技能；只有反复踩且影响全局的铁律级才动 persona' };

/**
 * 建议的升级形态。
 * 判定顺序：① 映射表（错误码 / 签名）命中即用 → ② 签名特征 → ③ 分类 → ④ 文本里提到路径 → ⑤ 默认。
 * 前两步之外都是启发式，只在前面的都认不出来时才轮到。
 * @param {object} pitfall
 * @returns {{form:'check'|'skill'|'persona', why:string, ruleId?:string, via?:string}}
 */
export function suggestForm(pitfall) {
  const fromMap = lookupFormByMap(pitfall);
  if (fromMap) return { form: fromMap.form, why: fromMap.why, ruleId: fromMap.ruleId, via: fromMap.via };

  const signature = String(pitfall?.sigKey ?? '');
  for (const entry of SIGNATURE_FORMS) {
    if (entry.pattern.test(signature)) return { form: entry.form, why: entry.why };
  }

  const byCategory = CATEGORY_FORMS.get(pitfall?.category ?? '其他');
  if (byCategory) return { form: byCategory.form, why: byCategory.why };

  const body = String(pitfall?.normText ?? pitfall?.sigKey ?? '');
  const chosen = PATH_HINT_RE.test(body) ? PATH_FORM : FALLBACK_FORM;
  return { ...chosen };
}

// 三个选项的文案固定：谁排第一、哪个被标"最优"，都是方案定死的，不按输入变
function candidateOptions(suggestion, category) {
  return [
    {
      id: 'check',
      label: '① 做成自动检查项（最优：坑不可能再犯）',
      hint: suggestion.form === 'check' ? suggestion.why : '若可脚本化判定则首选',
    },
    {
      id: 'skill',
      label: '② 内联进相关技能（加载即见）',
      hint: suggestion.form === 'skill' ? suggestion.why : `建议内联进与「${category}」相关的技能开头`,
    },
    {
      id: 'persona',
      label: '③ 铁律级才动 persona（需 persona-maintain 流程）',
      hint: '仅当该坑影响全局且反复踩时才考虑；采纳后必须走 validate-persona 验证',
    },
  ];
}

/**
 * 生成升级候选（次数 ≥3 且跨 ≥2 会话）。
 * 只是"候选"：本函数永不改 persona / 技能，落不落、落哪里由人拍。
 * @param {object} pitfall 已 rank 过的坑（最好带 score/stage）
 * @param {number} [nowMs]
 * @returns {object|null} 不够格 / seed 条目 → null
 */
export function buildCandidate(pitfall, nowMs = Date.now()) {
  if (!pitfall || pitfall.source === 'seed') return null;
  if (ladderStage(pitfall.count, pitfall.sessionCount ?? 0) !== 'candidate') return null;

  const suggestion = suggestForm(pitfall);
  return {
    id: pitfall.id,
    pitfallId: pitfall.id,
    sigKey: pitfall.sigKey,
    category: pitfall.category,
    count: pitfall.count,
    sessionCount: pitfall.sessionCount,
    score: pitfall.score ?? decayScore(pitfall.count, pitfall.lastSeen, nowMs),
    tools: pitfall.tools ?? {},
    normText: pitfall.normText ?? '',
    suggested: suggestion.form,
    why: suggestion.why,
    options: candidateOptions(suggestion, pitfall.category),
    status: 'pending',
    createdAt: new Date(nowMs).toISOString(),
    decidedAt: null,
  };
}
