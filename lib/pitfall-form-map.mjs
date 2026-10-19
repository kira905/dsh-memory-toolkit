// dsh-butler / lib/pitfall-form-map.mjs —— P4「错误码 / 签名 → 建议形态」映射表
//
// 为什么需要这张表（2026-09-12 主人点名）：
//   `pitfall-score.mjs` 的 suggestForm 原先只按文本特征猜形态，实测跑偏——
//   `AUDIT_NOT_PASSED`（真实成因：写保护区没先走 P5 审计）被猜成「路径存在性预检」check，
//   方向完全不对。**已知错误码的坑，成因是确定的**，不应交给启发式猜。
//
// 口径（判定顺序，命中即返回，不再往下走）：
//   ① 错误码精确命中本条表（code 字段 > sigKey 的第 2 段 > normText 中出现的 SCREAMING_SNAKE 码）
//   ② 签名正则命中（sigRe；用于没有稳定错误码、只能靠签名特征认的坑）
//   ③ 都没命中 → 回落 `pitfall-score.mjs` 的原启发式（行为与改动前完全一致）
//
// 形态只有三种（与方案 §4 P4 一致）：`check` 自动检查项 / `skill` 内联技能 / `persona` persona 铁律。
// 本文件是**纯数据 + 纯函数**，不碰状态、不写盘。
//
// 维护：新增一行即可生效（无副作用、无需改 render / 面板）；改完跑 `_test/test-pitfall.mjs`。

export const FORM_MAP_VERSION = '0.1.0';

/**
 * @typedef {object} FormRule
 * @property {string} id        规则 id（进 why/日志，稳定可断言）
 * @property {string[]} [codes] 命中的错误码（大写 SCREAMING_SNAKE）
 * @property {RegExp} [sigRe]   签名/文本正则（无稳定错误码时用）
 * @property {'check'|'skill'|'persona'} form 建议形态
 * @property {string} why       给主人看的一句话理由（写清真实成因）
 */

/** @type {FormRule[]} */
export const FORM_RULES = [
  {
    id: 'audit-not-passed',
    codes: ['AUDIT_NOT_PASSED'],
    form: 'skill',
    why: '流程类（不是路径问题）：写 persona / 技能 / 核心启动链前必须「先落临时文件 → butler-audit-cli 审计 → 用 write 写同一内容」；建议内联进 persona-maintain / P5 写入守门人相关技能',
  },
  {
    id: 'audit-hash-mismatch',
    codes: ['AUDIT_HASH_MISMATCH'],
    form: 'skill',
    why: '流程类：审计凭证与被写内容 hash 绑定——一处一审计、改完再验 hash，staged 内容必须与写入内容逐字节一致；建议内联进 persona-maintain 技能',
  },
  {
    id: 'fs-not-observed',
    codes: ['FS_NOT_OBSERVED'],
    form: 'persona',
    why: '铁律级（全局、高频）：改/覆盖已存在文件前必须先 read；已进 persona【铁律·edit/write 必须先读】，此处不再新增检查项',
  },
  {
    id: 'fs-stale-version',
    codes: ['FS_STALE_VERSION'],
    form: 'persona',
    why: '铁律级（全局）：junction 路径与同文件多处修改必须重读后**串行 edit**（并行 edit 会互相刷新 mtime）；已进 persona 对应铁律',
  },
  {
    id: 'search-failed',
    codes: ['SEARCH_FAILED'],
    form: 'check',
    why: '路径假设类：rg/grep/glob 目标不存在或不可达，可做成"搜索前先验路径存在"的只读检查项',
  },
];

/** 快速查码表（大小写不敏感）。 */
const CODE_INDEX = new Map();
for (const r of FORM_RULES) {
  for (const c of r.codes ?? []) CODE_INDEX.set(String(c).toUpperCase(), r);
}

/** SCREAMING_SNAKE 错误码（至少含一个下划线，避免把 FsError 之类类名当码）。 */
export const ERROR_CODE_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

/** 不是错误码的占位（signatureOf 在拿不到 code 时写 NO_CODE）。 */
const NOT_A_CODE = new Set(['NO_CODE']);

/**
 * 按优先级提取这条坑里出现的错误码：code 字段 → sigKey 第 2 段 → 文本中出现的码。
 * @param {object} pitfall
 * @returns {string[]} 去重后的候选码（越靠前越权威）
 */
export function extractErrorCodes(pitfall) {
  const out = [];
  const push = (v) => {
    const s = String(v ?? '').toUpperCase().trim();
    if (!s || NOT_A_CODE.has(s)) return;
    if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s)) return;
    if (!out.includes(s)) out.push(s);
  };
  push(pitfall?.code);

  const sig = String(pitfall?.sigKey ?? '');
  if (sig) {
    const seg = sig.split('|')[1];
    push(seg);
    for (const m of sig.matchAll(ERROR_CODE_RE)) push(m[1]);
  }
  const text = String(pitfall?.normText ?? '');
  if (text) for (const m of text.matchAll(ERROR_CODE_RE)) push(m[1]);
  return out;
}

/**
 * 查表：错误码优先，其次签名正则。
 * @param {object} pitfall
 * @returns {{form:'check'|'skill'|'persona', why:string, ruleId:string, via:'code'|'sig', matched:string}|null}
 *          未命中返回 null（调用方回落启发式）
 */
export function lookupFormByMap(pitfall) {
  const codes = extractErrorCodes(pitfall);
  for (const c of codes) {
    const rule = CODE_INDEX.get(c);
    if (rule) return { form: rule.form, why: `【映射表 ${rule.id}】${rule.why}`, ruleId: rule.id, via: 'code', matched: c };
  }
  const hay = `${pitfall?.name ?? ''}|${pitfall?.code ?? ''}|${pitfall?.sigKey ?? ''}|${pitfall?.normText ?? ''}`;
  for (const rule of FORM_RULES) {
    if (rule.sigRe && rule.sigRe.test(hay)) {
      return { form: rule.form, why: `【映射表 ${rule.id}】${rule.why}`, ruleId: rule.id, via: 'sig', matched: String(rule.sigRe) };
    }
  }
  return null;
}

/** 该错误码是否在表内（面板/调试用）。 */
export function isMappedCode(code) {
  return CODE_INDEX.has(String(code ?? '').toUpperCase());
}

/** 表内全部错误码（单测断言用）。 */
export function mappedCodes() {
  return [...CODE_INDEX.keys()].sort();
}
