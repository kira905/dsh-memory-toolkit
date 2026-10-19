// dsh-butler / lib/pitfall-score.mjs —— P4 动态权重 + 阶梯升级（纯函数，R 回归 golden 值）
//
// 方案 §4 P4：
//   动态权重：score = count × 0.5^(距上次踩坑天数 / 30)
//            30 天没再踩 → 权重减半、逐渐沉底，标「疑似已修复」（不删除）
//   阶梯升级：1 次入库 / 2 次上浮 / ≥3 次且跨 ≥2 会话 → 生成候选
//   候选三形态：①做成自动检查项（最优）②内联进相关技能 ③铁律级才动 persona
//   count 口径 = 同签名总出现次数；权重天数取末次出现时间（lastSeen）—— 均进 golden dataset

import { lookupFormByMap } from './pitfall-form-map.mjs';

// 0.2.0（2026-09-12）：suggestForm 先查「错误码/签名 → 形态」映射表（lib/pitfall-form-map.mjs），
//   未命中才回落原文本启发式。起因：AUDIT_NOT_PASSED（真实成因=没走 P5 审计）被猜成「路径存在性预检」。
export const PITFALL_SCORE_VERSION = '0.2.0';

/** 权重半衰期（天）。 */
export const HALF_LIFE_DAYS = 30;
/** 「疑似已修复」判定：距末次出现 ≥ 该天数。 */
export const LIKELY_FIXED_DAYS = 30;
/** 升级候选门槛：次数 ≥ 3 且跨 ≥ 2 会话。 */
export const CANDIDATE_MIN_COUNT = 3;
export const CANDIDATE_MIN_SESSIONS = 2;
/** 坑库收录门槛：≥ 2 次（方案「门槛 ≥2」）。 */
export const PITFALL_MIN_COUNT = 2;
/** seed 条目（历史文字坑）的基准权重：不计 count，只进权重衰减池。 */
export const SEED_BASE_SCORE = 2;

const DAY_MS = 86_400_000;

/**
 * 坑的权重：scan 条目 = count × 衰减；seed 条目 = 基准权重 × 衰减（不计 count）。
 * @param {object} p
 * @param {number} nowMs
 */
export function scoreOf(p, nowMs) {
  if (p?.source === 'seed') {
    const base = Number(p.seedBase ?? SEED_BASE_SCORE) || SEED_BASE_SCORE;
    return Math.round(base * Math.pow(0.5, daysSince(p.lastSeen, nowMs) / HALF_LIFE_DAYS) * 10000) / 10000;
  }
  return decayScore(p?.count, p?.lastSeen, nowMs);
}

/**
 * 动态权重：score = count × 0.5^(距上次踩坑天数 / 30)。
 * @param {number} count 同签名总次数
 * @param {number} lastSeenMs 末次出现时间（epoch ms）
 * @param {number} nowMs
 * @param {number} [halfLifeDays]
 * @returns {number} 保留 4 位小数
 */
export function decayScore(count, lastSeenMs, nowMs, halfLifeDays = HALF_LIFE_DAYS) {
  const c = Number(count) || 0;
  if (!c) return 0;
  const days = daysSince(lastSeenMs, nowMs);
  const raw = c * Math.pow(0.5, days / halfLifeDays);
  return Math.round(raw * 10000) / 10000;
}

/** 距末次出现的天数（负数按 0 处理；无时间戳按 0）。 */
export function daysSince(lastSeenMs, nowMs) {
  const t = Number(lastSeenMs);
  if (!Number.isFinite(t) || t <= 0) return 0;
  const d = (Number(nowMs) - t) / DAY_MS;
  return d > 0 ? d : 0;
}

/** 是否「疑似已修复」（30 天没再踩，不删除，只沉底标注）。 */
export function isLikelyFixed(lastSeenMs, nowMs, days = LIKELY_FIXED_DAYS) {
  return daysSince(lastSeenMs, nowMs) >= days;
}

/**
 * 阶梯形态（方案表）。
 * @returns {'recorded'|'surfaced'|'candidate'}
 */
export function ladderStage(count, sessionCount) {
  const c = Number(count) || 0;
  const s = Number(sessionCount) || 0;
  if (c >= CANDIDATE_MIN_COUNT && s >= CANDIDATE_MIN_SESSIONS) return 'candidate';
  if (c >= PITFALL_MIN_COUNT) return 'surfaced';
  return 'recorded';
}

/** 该坑是否够格进坑库（门槛 ≥2 次；seed 条目豁免，见 source）。 */
export function isRecordable(pitfall) {
  if (pitfall?.source === 'seed') return true;
  return (Number(pitfall?.count) || 0) >= PITFALL_MIN_COUNT;
}

/**
 * 排序：score 降序 → count 降序 → lastSeen 降序 → id 升序（稳定、可测）。
 * @param {object[]} pitfalls
 * @param {number} nowMs
 * @returns {object[]} 新数组（附 score / stage / likelyFixed / daysSinceLast）
 */
export function rankPitfalls(pitfalls, nowMs) {
  const rows = (pitfalls ?? []).map((p) => {
    const sessionCount = Number(p.sessionCount ?? (Array.isArray(p.sessions) ? p.sessions.length : 0));
    return {
      ...p,
      sessionCount,
      score: scoreOf(p, nowMs),
      stage: ladderStage(p.count, sessionCount),
      likelyFixed: isLikelyFixed(p.lastSeen, nowMs),
      daysSinceLast: Math.round(daysSince(p.lastSeen, nowMs) * 10) / 10,
    };
  });
  rows.sort((a, b) => (
    b.score - a.score
    || (Number(b.count) || 0) - (Number(a.count) || 0)
    || (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0)
    || String(a.id).localeCompare(String(b.id))
  ));
  return rows;
}

/** 开工 Top N（跳过疑似已修复；若全被跳过则返回原始前 N 并标注）。 */
export function topN(pitfalls, n, nowMs) {
  const ranked = rankPitfalls(pitfalls, nowMs).filter((p) => !p.excluded);
  const fresh = ranked.filter((p) => !p.likelyFixed);
  const pick = (fresh.length ? fresh : ranked).slice(0, n);
  return pick;
}

/**
 * 建议的升级形态（方案：①自动检查项最优 ②内联技能 ③铁律级才动 persona）。
 *
 * 判定顺序（2026-09-12 起）：
 *   ① 已知错误码 / 签名 → **映射表**（lib/pitfall-form-map.mjs）优先命中 —— 成因确定的坑不交给启发式猜
 *   ② 未命中 → 回落下面的文本启发式（行为与改动前一致）
 *
 * 注：`FS_NOT_OBSERVED / FS_STALE_VERSION` 原在此处被判 `check`，实测方向不对（它们是全局铁律、
 *   已进 persona），2026-09-12 升进映射表判 `persona`；`FS_SANDBOX_DENIED` 等仍走启发式。
 */
export function suggestForm(pitfall) {
  const mapped = lookupFormByMap(pitfall);
  if (mapped) return { form: mapped.form, why: mapped.why, ruleId: mapped.ruleId, via: mapped.via };

  const cat = pitfall?.category ?? '其他';
  const sig = String(pitfall?.sigKey ?? '');
  const text = String(pitfall?.normText ?? pitfall?.sigKey ?? '');
  // 可脚本化检测的坑 → 优先「自动检查项」
  if (/FS_SANDBOX_DENIED/.test(sig)) return { form: 'check', why: '沙箱拒绝=权限配置问题，可做成"写生产路径前先验权限"的检查项' };
  if (/FS_NOT_TEXT|FS_NOT_FOUND/.test(sig)) return { form: 'check', why: '读文件前可先验类型/存在性，适合做成检查项' };
  if (cat === '守护鱼') return { form: 'check', why: '守护鱼类坑适合做成只读健康检查项（dsh-selfcheck 同款）' };
  if (cat === '插件') return { form: 'skill', why: '插件类坑适合内联进 plugin-deploy 技能开头' };
  if (cat === '同步') return { form: 'skill', why: '同步类坑适合内联进同步/备份相关技能或脚本注释' };
  if (cat === '会话') return { form: 'skill', why: '会话类坑适合内联进 session-cleanup / dsh-restart 技能' };
  if (cat === 'pwsh') return { form: 'skill', why: 'pwsh 类坑适合内联进相关技能；若能脚本化则优先检查项' };
  if (/路径|path|<PATH>/i.test(text)) return { form: 'check', why: '路径假设类坑可做成"路径存在性预检"检查项' };
  return { form: 'skill', why: '默认建议内联技能；只有反复踩且影响全局的铁律级才动 persona' };
}

/**
 * 生成升级候选（≥3 次且跨 ≥2 会话；**永不自动改 persona / 技能**）。
 * @param {object} pitfall 已 rank 的坑（含 score/stage）
 * @returns {object|null}
 */
export function buildCandidate(pitfall, nowMs = Date.now()) {
  if (!pitfall || pitfall.source === 'seed') return null;
  if (ladderStage(pitfall.count, pitfall.sessionCount ?? 0) !== 'candidate') return null;
  const sug = suggestForm(pitfall);
  const options = [
    { id: 'check', label: '① 做成自动检查项（最优：坑不可能再犯）', hint: sug.form === 'check' ? sug.why : '若可脚本化判定则首选' },
    { id: 'skill', label: '② 内联进相关技能（加载即见）', hint: sug.form === 'skill' ? sug.why : `建议内联进与「${pitfall.category}」相关的技能开头` },
    { id: 'persona', label: '③ 铁律级才动 persona（需 persona-maintain 流程）', hint: '仅当该坑影响全局且反复踩时才考虑；采纳后必须走 validate-persona 验证' },
  ];
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
    suggested: sug.form,
    why: sug.why,
    options,
    status: 'pending',
    createdAt: new Date(nowMs).toISOString(),
    decidedAt: null,
  };
}
