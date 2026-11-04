/**
 * FORK-EDIT(2026-11-04 · 记忆时效)：`until:YYYYMMDD` 解析 + 过期判定（纯函数、零依赖）。
 *
 * 一句话：**给"有时效的判断"一个到期日；到期后不删，只是召回时降权并标出来。**
 *
 * 三条设计铁律：
 *   ① **落点 = tags**（与既有 `src:<kind>#<token>;` 回指习惯一致）。tags 已被 FTS 全文索引
 *      ⇒ 只加标签、不加列、不改表；也就不会出现"表结构迁移"这种会把老库拖进半迁移态的事。
 *   ② **fail-open**：认不出来的写法（`until:abc` / `until:20251340` / 空值）一律当"无期限"，
 *      既不当过期、也不抛错；只在统计里留一条"格式不认识"，不拦任何链路。
 *   ③ **不动打分本体**：本模块只做"读 tags → 判过期 → 给一条标注字符串 + 一个权重"，
 *      RRF / 余弦 / bm25 一个字不碰；排序层面的降权由调用方做**稳定分区**（结果集不增不删）。
 *
 * 为什么"过期不删"：记忆是主人的账，删了就找不回来；而"过期"往往是"当时对、现在不一定"，
 * 让模型看见「已过期（until 20200101）」比悄悄消失安全得多。
 *
 * 急救关（本模块不是服务端常驻状态：`untilEnabled()` 调用时读 env，夹具可现改现测）：
 *   `MEMORY_UNTIL=0` ⇒ 所有条目按「无 until」处理（`expired` 恒 false、不加任何标注）
 *   —— 与没有本模块时逐字一致。
 */

/** 标签前缀（大小写不敏感识别，但只认这一个键名）。 */
export const UNTIL_PREFIX = 'until:';

/** 已过期条目的权重（观测用：`expiryWeight`；不参与 RRF 本体计算）。 */
export const EXPIRY_WEIGHT = 0.5;

/** 急救关：`MEMORY_UNTIL=0` ⇒ 整套判定失效（调用时读，便于夹具现改现测）。 */
export function untilEnabled() {
  return String(process.env.MEMORY_UNTIL ?? '') !== '0';
}

/** 毫秒 → 本地时区的 `YYYYMMDD`（与 tags 里写的是同一个字面形态）。 */
export function stampOf(ms) {
  const d = new Date(Number(ms) || 0);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 8 位数字 → 合法真实日期？`20250230` / `20251301` 都不算。 */
function isRealDate(s) {
  if (!/^\d{8}$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  if (y < 1970 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** 宽松归一：`2025-11-30` / `2025/11/30` / `2025.11.30` / `"20251130"` 都折成 `20251130`；折不了返回 null。 */
function normalizeStamp(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/^[`'"[({<]+/, '')
    .replace(/[`'"[)\]}>.,;。，；]+$/, '');
  const digits = s.replace(/[-/.]/g, '');
  return isRealDate(digits) ? digits : null;
}

/**
 * 从 tags 里读 `until:`（宽松读）。
 *
 * 认这些写法（都实打实出现在记忆 tags 里过）：
 *   · `until:20251130`            —— 标准形态
 *   · `until: 20251130`           —— 空格分隔的 tags 串里会裂成两个 token（`until:` + `20251130`）⇒ 向后看一个 token
 *   · `until:2025-11-30` / `until:"20251130"` —— 归一后再判
 *
 * @param {string|unknown} tags
 * @returns {{found:boolean, until:string|null, raw:string|null, invalid:string[]}}
 *   until = 归一后的 `YYYYMMDD`；invalid = 认不出来的原始写法（**不当过期**，只用于统计）
 */
export function parseUntil(tags) {
  const out = { found: false, until: null, raw: null, invalid: [] };
  const s = String(tags ?? '');
  if (!s || s.indexOf('until:') < 0) {
    // 大小写不敏感：`Until:` 也算出现
    if (!/until:/i.test(s)) return out;
  }
  const tokens = s.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const m = /^until:(.*)$/i.exec(tok);
    if (!m) continue;
    out.found = true;
    let value = m[1];
    // `until:` 单独成 token（写成 `until: 20251130` 的必然结果）⇒ 看下一个 token
    if (value === '' && i + 1 < tokens.length && !/^[a-z_]+:/i.test(tokens[i + 1])) value = tokens[i + 1];
    const stamp = normalizeStamp(value);
    if (stamp === null) {
      out.invalid.push(tok + (value !== m[1] ? ` ${value}` : ''));
      continue;
    }
    // 多条时以**第一条合法**为准（写两遍是笔误，不据此判过期/延期）
    if (out.until === null) {
      out.until = stamp;
      out.raw = tok;
    }
  }
  return out;
}

/**
 * 判一条记忆的时效状态。
 * @param {string|unknown} tags
 * @param {number} [nowMs] 参考时刻（缺省 = Date.now()；夹具可固定）
 * @returns {{state:'none'|'active'|'expired'|'invalid'|'disabled', until:string|null,
 *            expired:boolean, note:string, weight:number, invalid:string[], today:string|null}}
 *   note = `已过期（until 20200101）`（只有 expired 非空；其余一律空串 ⇒ 渲染层逐字不变）
 */
export function classify(tags, nowMs = null) {
  const now = nowMs == null ? Date.now() : Number(nowMs);
  const today = stampOf(now);
  const base = { state: 'none', until: null, expired: false, note: '', weight: 1, invalid: [], today };
  if (!untilEnabled()) return { ...base, state: 'disabled' };
  const p = parseUntil(tags);
  const invalid = p.invalid;
  if (p.until === null) return { ...base, state: invalid.length ? 'invalid' : 'none', invalid };
  // 按「日」比较：`until:20251130` 表示 20251130 当天仍有效 ⇒ 只有严格小于今天才算过期
  const expired = today !== null && Number(p.until) < Number(today);
  return {
    state: expired ? 'expired' : 'active',
    until: p.until,
    expired,
    note: expired ? `已过期（until ${p.until}）` : '',
    weight: expired ? EXPIRY_WEIGHT : 1,
    invalid,
    today,
  };
}

/** 渲染用的标注串（未过期/无 until ⇒ 空串，调用方据此保持逐字不变）。 */
export function expiryNoteOf(tags, nowMs = null) {
  return classify(tags, nowMs).note;
}

/**
 * 给一批候选打上时效标记 +（可选）**稳定分区**降权。
 *
 * 「稳定分区」= 过期条目整体移到末尾，两组内部**各自保持传入顺序**（调用方传入的是 RRF / bm25 名次）。
 * 这样：① 结果集不增不删（不多出候选、也不因降权少给一条）；② 未过期条目的相对顺序一字不动；
 * ③ `rrfFuse` / `cosineTopK` / `bm25` 本体零改动。
 *
 * ⚠️ 两条召回入口用**不同**的降权方式（是实测后定的，不是拍脑袋）：
 *   · `memory_search`（工具）⇒ `reorder: true`：按 `limit` 返回、条目不会消失，后移就是纯排序降权；
 *   · 注入件（指针）⇒ `reorder: false`：800 字 / 8 条是**硬预算**，后移会把过期条目直接挤出渲染集
 *     （实测：5 条夹具里 2 条过期 ⇒ 后移后这两条一条都渲染不出来）= 实质等于「删」，违反
 *     「过期条目不删」。所以注入侧用另一档 —— **标注位降权**：名次不动、整行带
 *     「已过期（until …）」标记，让模型当场看到"这条别再当真"。
 *
 * @param {Array<object>} items 候选（不改传入数组）
 * @param {(item:object)=>string} tagsOf 取这条的 tags
 * @param {number} [nowMs]
 * @param {{reorder?:boolean}} [opts] reorder=false ⇒ 只标注、不位移
 * @returns {{items:Array<object>, stats:{expired:number, ids:number[], invalid:Array<{id:any, raw:string[]}>,
 *            today:string|null, downgraded:number, reordered:boolean, disabled:boolean}}}
 */
export function annotate(items, tagsOf, nowMs = null, { reorder = true } = {}) {
  const now = nowMs == null ? Date.now() : Number(nowMs);
  const today = stampOf(now);
  const stats = { expired: 0, ids: [], invalid: [], today, downgraded: 0, reordered: Boolean(reorder), disabled: !untilEnabled() };
  const tagged = [];
  for (const it of Array.isArray(items) ? items : []) {
    let c;
    try {
      c = classify(typeof tagsOf === 'function' ? tagsOf(it) : '', now);
    } catch {
      c = classify('', now); // 取 tags 出任何意外 ⇒ 当无期限（fail-open）
    }
    if (c.invalid.length) stats.invalid.push({ id: it && it.id !== undefined ? it.id : null, raw: c.invalid });
    if (c.expired) {
      stats.expired += 1;
      stats.ids.push(it && it.id !== undefined ? it.id : null);
    }
    tagged.push({ ...it, until: c.until, expired: c.expired, expiryNote: c.note, expiryWeight: c.weight });
  }
  const kept = tagged.filter((x) => !x.expired);
  const moved = tagged.filter((x) => x.expired);
  if (reorder) stats.downgraded = moved.length;
  return { items: reorder ? [...kept, ...moved] : tagged, stats };
}

/** 召回结果（`recall()` 的 hits：自带 `id`，tags 从库里按 id 取）专用壳子。 */
export function annotateHits(hits, tagById, nowMs = null, opts = {}) {
  const map = tagById instanceof Map ? tagById : new Map();
  return annotate(hits, (h) => map.get(String(h.id)) ?? map.get(h.id) ?? '', nowMs, opts);
}

/** `memory_search` 的命中（自带 `tags`）专用壳子。 */
export function annotateMatches(matches, nowMs = null) {
  return annotate(matches, (m) => (m && m.tags) || '', nowMs);
}
