/**
 * lib-mem-conflict.mjs —— 记忆「硬矛盾」判据（纯函数 · 零 IO · 零依赖）
 *
 * 统一形式：同一槽（factKey 相等）上，两侧取值集合交集为空 ⇒ hard-conflict。
 * 三个取值域：日期/时刻（区间）、数值（单位 + 谓词相同的区间）、枚举（白名单固定集）。
 * 其余一律 unknown（宁漏不假）。
 *
 * 🔴 **判词表外置**：哪种写法算日期 / 数值 / 枚举、哪些槽可判枚举、区间分隔符、
 *    单位与谓词表、tag 前缀 —— 全部在 `mem-conflict-rules.json`，本文件只留机制。
 *    换一套词表（另一门语言、另一套单位）不用改代码：设 `DSH_MEM_CONFLICT_RULES`
 *    指向自己的 JSON 即可；或用 `loadRules(file)` 单独解析后在调用方自建判据。
 *
 * 本文件只做判据，不做 IO、不碰库、不接生产。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_RULES_URL = new URL('./mem-conflict-rules.json', import.meta.url);

/** 转义正则元字符（词表里可能出现 `.` `%` `(` 这类字符）。 */
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 解析一份判词表并做最小校验（缺字段即抛，别让它静默变成"什么都不能判"）。
 * @param {string} [file] 词表路径；缺省 = 随包那份
 * @returns {object} 归一化后的规则对象（含预编译正则）
 */
export function loadRules(file) {
  const target = file ? pathToFileURL(path.resolve(file)) : DEFAULT_RULES_URL;
  const raw = JSON.parse(fs.readFileSync(target, 'utf8'));

  const need = (cond, what) => {
    if (!cond) throw new Error(`mem-conflict rules: ${what}`);
  };
  need(raw.verdicts && raw.verdicts.hard, 'verdicts.hard missing');
  need(Array.isArray(raw.range?.separators) && raw.range.separators.length, 'range.separators missing');
  need(raw.dateMarkers && raw.dateMarkers.year && raw.dateMarkers.month && raw.dateMarkers.day, 'dateMarkers incomplete');
  need(Array.isArray(raw.units) && raw.units.length, 'units missing');
  need(raw.predicates && raw.predicates.currentValue, 'predicates incomplete');
  need(raw.tags && raw.tags.factPrefix && raw.tags.valuePrefix, 'tags prefixes missing');

  const M = raw.dateMarkers;
  const P = raw.predicates;
  const T = raw.tags;
  const seps = raw.range.separators.map(esc).join('|');

  return {
    ...raw,
    // 预编译：解析热路径不重复构造正则
    re: {
      rangeSep: new RegExp(seps),
      ymdCn: new RegExp(`^(\\d{4})${esc(M.year)}(\\d{1,2})${esc(M.month)}(\\d{1,2})${esc(M.day)}$`),
      ymCn: new RegExp(`^(\\d{4})${esc(M.year)}(\\d{1,2})${esc(M.month)}$`),
      yCn: new RegExp(`^(\\d{4})${esc(M.year)}$`),
      mdCn: new RegExp(`^(\\d{1,2})${esc(M.month)}(\\d{1,2})${esc(M.day)}$`),
      upperPrefix: new RegExp(`^(?:${(P.upperPrefixes || []).map(esc).join('|') || '\\u0000'})`),
      lowerPrefix: new RegExp(`^(?:${(P.lowerPrefixes || []).map(esc).join('|') || '\\u0000'})`),
      factTag: new RegExp(`^${esc(T.factPrefix)}([^\\s]+)$`),
      valueTag: new RegExp(`^${esc(T.valuePrefix)}([^\\s]+)$`, 'i'),
      contradicts: new RegExp(`^${esc(T.contradictsPrefix)}(\\d{4,9})$`, 'i'),
      contradictedBy: new RegExp(`^${esc(T.contradictedByPrefix)}(\\d{4,9})$`, 'i'),
    },
  };
}

/** 模块级词表：`DSH_MEM_CONFLICT_RULES` 可指向自己的 JSON（boot 期读一次）。 */
export const RULES = loadRules(process.env.DSH_MEM_CONFLICT_RULES);

/* ---------------- 判定结果码（值来自词表，只增不删） ---------------- */

export const R_HARD = RULES.verdicts.hard;
export const R_NONE = RULES.verdicts.none ?? 'no-conflict';
export const R_UNKNOWN = RULES.verdicts.unknown ?? 'unknown';
export const R_AMBIG = RULES.verdicts.ambiguous ?? 'ambiguous';

/** 全角 → 半角 + 空白归一（槽名与取值都用它） */
export function norm(s) {
  return String(s ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------- 日期 / 时刻 ---------------- */

const D_DAY = /^(\d{4})(?:[-/.])(\d{1,2})(?:[-/.])(\d{1,2})$/;

/**
 * 解析成区间 [lo, hi]（整数编码 y*10000 + m*100 + d；年粒度 lo=Y0000, hi=Y1231 表示整年）
 * 返回 { kind:'date'|'time', lo, hi } | null
 */
export function parseTime(raw, rules = RULES) {
  const s = norm(raw);
  if (!s) return null;
  const { re } = rules;

  let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(s))) {
    const y = +m[1], mo = +m[2];
    if (mo < 1 || mo > 12) return null;
    return { kind: 'date', lo: y * 10000 + mo * 100, hi: y * 10000 + mo * 100 + 31 };
  }
  if ((m = re.yCn.exec(s))) {
    const y = +m[1];
    return { kind: 'date', lo: y * 10000, hi: y * 10000 + 1231 };
  }
  if ((m = re.ymCn.exec(s))) {
    const y = +m[1], mo = +m[2];
    if (mo < 1 || mo > 12) return null;
    return { kind: 'date', lo: y * 10000 + mo * 100, hi: y * 10000 + mo * 100 + 31 };
  }
  if ((m = re.ymdCn.exec(s))) return dayOf(+m[1], +m[2], +m[3]);
  if ((m = D_DAY.exec(s))) return dayOf(+m[1], +m[2], +m[3]);
  if ((m = re.mdCn.exec(s))) {
    // 无年份 ⇒ 约定 y = 0，调用方按「两侧都无年份才可比」处理
    return dayOf(0, +m[1], +m[2]);
  }
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) {
    const hh = +m[1], mm = +m[2];
    if (hh > 23 || mm > 59) return null;
    return { kind: 'time', lo: hh * 100 + mm, hi: hh * 100 + mm };
  }
  return null;

  function dayOf(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const v = y * 10000 + mo * 100 + d;
    return { kind: 'date', lo: v, hi: v };
  }
}

/** 日期区间串（a~b / a 至 b）；任一解析失败即 null */
export function parseTimeRange(raw, rules = RULES) {
  const s = norm(raw);
  if (!rules.re.rangeSep.test(s)) return parseTime(s, rules);
  const [a, b] = s.split(rules.re.rangeSep).map((x) => x.trim());
  const A = parseTime(a, rules), B = parseTime(b, rules);
  if (!A || !B || A.kind !== B.kind) return null;
  return { kind: A.kind, lo: Math.min(A.lo, B.lo), hi: Math.max(A.hi, B.hi) };
}

const noYear = (t) => t.lo < 10000 && t.hi < 10000; // y=0 占位

function overlap(a, b) {
  return Math.max(a.lo, b.lo) <= Math.min(a.hi, b.hi);
}

/* ---------------- 数值 ---------------- */

/**
 * 解析数值项：`12 条` / `≤12 条` / `<=12 条` / `12~20 条` / `上限 20 条` / `现值 5 条`
 * 返回 { vlo, vhi, unit, predicate } | null
 */
export function parseNumber(raw, rules = RULES) {
  let s = norm(raw);
  if (!s) return null;
  const P = rules.predicates;
  const NAMED = [P.currentValue, P.upperBound, P.lowerBound, P.total].filter(Boolean);

  let predicate = null;
  for (const p of NAMED) {
    if (s.startsWith(p)) { predicate = p; s = s.slice(p.length).trim(); break; }
  }
  if (!predicate && rules.re.upperPrefix.test(s)) predicate = P.upperBound;
  if (!predicate && rules.re.lowerPrefix.test(s)) predicate = P.lowerBound;
  s = s.replace(rules.re.upperPrefix, '').replace(rules.re.lowerPrefix, '').trim();

  let unit = null;
  for (const u of rules.units) {
    if (s.endsWith(u)) { unit = u; s = s.slice(0, -u.length).trim(); break; }
  }
  if (!unit) return null;

  if (rules.re.rangeSep.test(s)) {
    const [a, b] = s.split(rules.re.rangeSep).map((x) => x.trim());
    const A = Number(a), B = Number(b);
    if (!isFinite(A) || !isFinite(B)) return null;
    return { vlo: Math.min(A, B), vhi: Math.max(A, B), unit, predicate: predicate ?? P.currentValue };
  }
  const n = Number(s);
  if (!isFinite(n)) return null;
  const pred = predicate ?? P.currentValue;
  if (pred === P.upperBound) return { vlo: -Infinity, vhi: n, unit, predicate: pred };
  if (pred === P.lowerBound) return { vlo: n, vhi: Infinity, unit, predicate: pred };
  return { vlo: n, vhi: n, unit, predicate: pred };
}

/* ---------------- 枚举白名单 ---------------- */

/** 只有词表里列出的槽可做枚举判；自由文本一律 unknown（防误杀同义词） */
export const ENUM_SLOTS = RULES.enumSlots || {};

/* ---------------- 主判据 ---------------- */

/**
 * @param {{factKey?:string, value:string}} a
 * @param {{factKey?:string, value:string}} b
 * @returns {'hard-conflict'|'no-conflict'|'unknown'|'ambiguous'}
 */
export function judge(a, b, rules = RULES) {
  const ka = norm(a?.factKey), kb = norm(b?.factKey);
  if (!ka || !kb || ka !== kb) return R_UNKNOWN; // 唯一入口

  const va = norm(a?.value), vb = norm(b?.value);
  if (!va || !vb) return R_UNKNOWN;

  /* 1) 日期 / 时刻 */
  const ta = parseTimeRange(va, rules), tb = parseTimeRange(vb, rules);
  if (ta && tb) {
    if (ta.kind !== tb.kind) return R_UNKNOWN; // 日期 vs 时刻不可比
    if (noYear(ta) !== noYear(tb)) return R_UNKNOWN; // 一侧无年份 ⇒ 不可比
    return overlap(ta, tb) ? R_NONE : R_HARD;
  }

  /* 2) 数值 */
  const na = parseNumber(va, rules), nb = parseNumber(vb, rules);
  if (na && nb) {
    if (na.unit !== nb.unit) return R_UNKNOWN; // 跨单位禁换算
    if (na.predicate !== nb.predicate) return R_UNKNOWN; // 谓词不同不可比
    const lo = Math.max(na.vlo, nb.vlo), hi = Math.min(na.vhi, nb.vhi);
    return lo <= hi ? R_NONE : R_HARD;
  }

  /* 3) 枚举（仅词表白名单槽） */
  const allowed = (rules.enumSlots || {})[ka];
  if (allowed) {
    if (allowed.includes(va) && allowed.includes(vb)) return va === vb ? R_NONE : R_HARD;
    return R_UNKNOWN;
  }

  return R_UNKNOWN; // 硬清单：自由文本 / 语义 / 模糊 / 不同粒度写法 —— 一律不判
}

/* ---------------- tag 落地（幂等） ---------------- */

export const R_FORWARD = RULES.re.contradicts;
export const R_REVERSE = RULES.re.contradictedBy;

/** 把 tag 加进空格分隔的 tags 串（已有即跳过；禁 `a+b` 拼接） */
export function addTag(tags, tag) {
  const list = String(tags ?? '').split(/\s+/).filter(Boolean);
  if (list.some((t) => t.toLowerCase() === String(tag).toLowerCase())) return list.join(' ');
  return [...list, tag].join(' ');
}

/** 判定只读一边（与 supersedes 同纪律：只读 contradicts:） */
export function contradictsOf(tags) {
  return String(tags ?? '').split(/\s+/).filter((t) => R_FORWARD.test(t));
}

/* ══════════════════════════════════════════════════════════════════════════════
 * §A 接线层（**判据本体到此为止；以下只做「从一条记忆里取出判据的入参」**）
 *
 * 为什么需要这一段：判据本体吃 `{factKey, value}`，而库里一条记忆只有 `text` + `tags`。
 * 约定：槽 = tags 前缀 `fact:对象.方面`；取值载体 = tags 里的 `val:<取值>`。
 *
 * 本件的取法（零猜测，宁漏不假）：
 *   ① 取值载体 = tags 里的 `val:<取值>`（与 `fact:` 同族、零 schema、同一套正则纪律）；
 *   ② tags 没有 `val:` ⇒ **只认正文整串**能被 parseTimeRange / parseNumber 解析的情形
 *      （`text === "1990年3月"` 这种）；**禁子串抽取**（从「1990年3月出生，2010年结婚」里抠
 *      日期 = 猜，猜错就误杀 ⇒ 一律 unknown）；
 *   ③ 枚举白名单槽没有 `val:` ⇒ 正文**整串**恰好等于白名单里的一个取值才算；
 *   ④ 多个 `fact:` / 多个 `val:` ⇒ 不选（unknown），不猜"哪个才是槽"。
 * 这一层不引别名表、不做单位换算、不看语义。
 * ══════════════════════════════════════════════════════════════════════════════ */

export const R_FACT = RULES.re.factTag;
export const R_VAL = RULES.re.valueTag;

/** 取这条记忆的槽：tags 里恰好一个 `fact:` ⇒ 槽名；0 个或多个 ⇒ null（不猜） */
export function factKeyOf(tags) {
  const hits = String(tags ?? '').split(/\s+/).filter(Boolean).map((t) => R_FACT.exec(t)).filter(Boolean);
  if (hits.length !== 1) return null;
  return norm(hits[0][1]) || null;
}

/** 取这条记忆的显式取值：`val:` tag 优先；否则正文整串可解析（见 §A ① ②） */
export function valueOf(tags, text) {
  const vals = String(tags ?? '').split(/\s+/).filter(Boolean).map((t) => R_VAL.exec(t)).filter(Boolean);
  if (vals.length === 1) return norm(vals[0][1]) || null; // 2 个以上 ⇒ 不猜
  if (vals.length > 1) return null;
  const body = norm(text);
  if (!body || /\s/.test(body)) return null; // 带空格/多行的正文 = 自由文本 ⇒ 不抠子串
  return body; // 单 token 正文：是不是取值交给 judge 判（白名单外的自由文本它会给 unknown）
}

/** 一条记忆 ⇒ 判据入参（取不出 ⇒ null，调用方按 unknown 处理） */
export function slotOf(note) {
  const factKey = factKeyOf(note?.tags);
  if (!factKey) return null;
  const value = valueOf(note?.tags, note?.text);
  if (!value) return null;
  return { factKey, value };
}

/**
 * 拿新条 + 同槽旧条列表 ⇒ 命中的矛盾对（**只判、不写库**）。
 * @param {{id?:number, tags:string, text:string}} fresh
 * @param {Array<{id:number, tags:string, text:string}>} others
 * @returns {{verdict:string, pairs:Array<{otherId:number, verdict:string}>}}
 */
export function compareWithSlot(fresh, others) {
  const mine = slotOf(fresh);
  const pairs = [];
  if (!mine) return { verdict: R_UNKNOWN, pairs };
  let worst = R_NONE;
  let seen = 0;
  for (const other of Array.isArray(others) ? others : []) {
    const hit = judge(mine, slotOf(other) ?? { factKey: null, value: null });
    seen++;
    pairs.push({ otherId: Number(other?.id) || 0, verdict: hit });
    if (hit === R_HARD) worst = R_HARD;
    else if (hit === R_AMBIG && worst === R_NONE) worst = R_AMBIG;
    else if (hit === R_UNKNOWN && worst === R_NONE) worst = R_UNKNOWN;
  }
  return { verdict: seen === 0 ? R_UNKNOWN : worst, pairs };
}
