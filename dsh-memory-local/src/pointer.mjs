/**
 * FORK-EDIT(2026-09-21): 指针渲染与预算裁剪（方案 §3.4 注入产物 / §8.2 绝对量判据）
 *
 * 预算判据（硬）：条数 ≤8、总量 **≤800 字**、**≤600 token**（取更紧的一档实际生效）；
 * 每条 = `id/路径` + 日期 + tags + **≤80 字摘要首行**（方案 §3.4 Z17 已吸收）。
 *
 * token 计法（写死口径，报告里给实测字符数即可复核）：
 *   · 主口径 = DeepSeek 中文口径：CJK 字符 1 token ≈ 1.5 字，非 CJK 1 token ≈ 3.6 字
 *     （DeepSeek 官方文档口径为「1 个中文字符 ≈ 0.6 token」，取 1.5 是**偏保守**的一侧）
 *   · 另有 `estimateTokensWorstCase` = 1 字 = 1 token 的过度保守口径（只用于报告对照）
 */

/** DeepSeek 中文口径的 token 估算（偏保守：CJK 按 1.5 字/token）。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk / 1.5 + other / 3.6);
}

/** 过度保守口径（1 字符 = 1 token），仅供报告对照，不用于裁剪。 */
export function estimateTokensWorstCase(text) {
  return String(text ?? '').length;
}

const POINTER_HEADER =
  '[相关记忆·指针] 以下可能与当前请求相关的历史记忆索引；需要细节请用 memory_get 展开：';

/** 日期（YYYY-MM-DD，本地时区）。 */
export function formatDate(ms) {
  const d = new Date(Number(ms) || 0);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return '日期未知';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 剥掉孤立代理项（lone surrogate，U+D800–U+DFFF）。
 *
 * ⚠️ 某次事故修复（详见 CHANGELOG）—— 会话历史永久 HTTP 400：
 * 记忆文本里含 emoji（📦/🐋…，星面字符 = 一对代理项）时，若按 **UTF-16 码元** `slice`
 * 截断，会正好切在代理对中间，留下孤立高代理项（如 `\ud83d`）。该文本进会话历史后，
 * 请求体 JSON 变成 `"…\ud83d…"` ⇒ DeepSeek 网关 `Failed to parse the request body as JSON:
 * unexpected end of hex escape` ⇒ **HTTP 400 / INVALID_REQUEST**；而坏消息**永久留在历史里**，
 * 该会话此后**每轮必 400、无法自愈**（实测复现：含孤立代理项 → 400，去掉 → 200）。
 */
export function stripLoneSurrogate(text) {
  return String(text ?? '').replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}

/**
 * 码点安全截断：**不切断代理对**（星面字符算 1 个），并对结果做孤立代理兜底剥离。
 * @param {string} text
 * @param {number} maxChars 按码点计的最大长度
 */
export function sliceSafe(text, maxChars) {
  const s = String(text ?? '');
  const limit = Math.max(0, Number(maxChars) || 0);
  if (limit === 0) return '';
  if (s.length <= limit) return stripLoneSurrogate(s);
  const points = [...s];
  if (points.length <= limit) return stripLoneSurrogate(s);
  return stripLoneSurrogate(points.slice(0, limit).join(''));
}

/**
 * 摘要首行：取正文第一行，压掉换行/多余空白，截到 maxChars（超出加省略号）。
 * @param {string} text
 * @param {number} maxChars 默认 80（方案 §3.4）
 */
export function summarize(text, maxChars = 80) {
  const firstLine = String(text ?? '')
    .split(/\r?\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (firstLine.length <= maxChars) return stripLoneSurrogate(firstLine);
  return `${sliceSafe(firstLine, Math.max(1, maxChars - 1))}…`;
}

/** tags 压缩：空格分隔取前若干个，总长 ≤ maxChars（码点安全，不切断 emoji）。 */
export function compactTags(tags, maxChars = 40) {
  const s = String(tags ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxChars) return stripLoneSurrogate(s);
  return `${sliceSafe(s, Math.max(1, maxChars - 1))}…`;
}

/**
 * 渲染一条指针行（方案 §3.4 形态）。
 * @param {{id:number,text:string,tags:string,updated_at:number}} row
 * @param {{summaryChars?:number, tagChars?:number, expiry?:string}} [opts]
 *   expiry = 过期标注（如 `已过期（until 20200101）`；空串 = 不标，**逐字回到原样**）
 */
export function pointerLine(row, { summaryChars = 80, tagChars = 40, expiry = '' } = {}) {
  const tags = compactTags(row.tags, tagChars);
  const tagPart = tags ? ` · tags: ${tags}` : '';
  // FORK-EDIT(2026-11-04 · 记忆时效)：过期标注插在 `#id` 后、日期括号前。
  // 只增不删：原有结构（`- #id (日期 · tags) 摘要`）一字不动，标注缺省为空 ⇒ 与改动前逐字节一致。
  const markPart = expiry ? ` ${expiry}` : '';
  return `- #${row.id}${markPart} (${formatDate(row.updated_at)}${tagPart}) ${summarize(row.text, summaryChars)}`;
}

/**
 * 按预算裁剪并渲染指针文本。
 *
 * **两遍**：
 *   第一遍 = 原口径决定「哪些条入选、什么顺序」——这一遍里**没有任何标注**，
 *            所以入选集合与排序跟改动前**逐字一致**。
 *   第二遍 = 给已入选的行补过期标注；标注**从本行摘要里让位**（逐字缩摘要直到这行放得下），
 *            仍放不下（摘要已到 40 字）才放弃这一条的标注 —— 800 字 / 600 token 的硬预算一个字没放宽。
 *
 * @param {Array} rows 召回顺序（**本函数不重排**）
 * @param {{header?:string, maxItems?:number, maxChars?:number, maxTokens?:number,
 *          summaryChars?:number, tagChars?:number, expiryOf?:(row:object)=>string}} [opts]
 *   expiryOf = 过期标注回调（缺省 null ⇒ 与改动前逐字节一致；抛错由调用方兜，本函数不再包一层）
 * @returns {{text:string, lines:string[], items:Array, chars:number, estTokens:number, dropped:number,
 *            overflow:boolean, expiryMarked:number, expiryDropped:number, expiryChars:number}}
 *   expiryDropped = 摘要缩到 40 字仍放不下、这一条放弃标注的条数
 */
export function renderPointer(
  rows,
  { header = POINTER_HEADER, maxItems = 8, maxChars = 800, maxTokens = 600, summaryChars = 80, tagChars = 40, expiryOf = null } = {},
) {
  const lines = [];
  const items = [];
  const accepted = []; // 与 lines 一一对应（第二遍加标注时用）
  let dropped = 0;
  let overflow = false;

  // ── 第一遍：入选集与排序（口径 = 改动前，逐字不变）────────────────────────────
  for (const row of rows || []) {
    if (lines.length >= maxItems) {
      dropped += 1;
      overflow = true;
      continue;
    }
    const line = pointerLine(row, { summaryChars, tagChars });
    const candidate = [header, ...lines, line].join('\n');
    if (candidate.length > maxChars || estimateTokens(candidate) > maxTokens) {
      dropped += 1;
      overflow = true;
      continue;
    }
    lines.push(line);
    accepted.push(row);
    items.push({
      id: Number(row.id),
      chars: line.length,
      summaryChars: summarize(row.text, summaryChars).length,
      tags: row.tags,
      updatedAt: Number(row.updated_at),
      expiry: '',
    });
  }

  // ── 第二遍：加过期标注 ────────────────────────────────────────────────────
  // 标注从**本行摘要**里让位（不给总量开口子）：逐字缩摘要直到这一行放得下。
  //   为什么不让总量：800 字 / 600 token 是注入产物的硬判据，一个字都不放宽 ——
  //   历史注入的 chars 中位 774、最大 798（贴着 800）⇒ 直接加 20 字/条会把指针行顶掉；
  //   摘要本来就是"看个大概"，让出几个字不影响判断；仍放不下（摘要已缩到 40 字）才放弃该条标注。
  const MIN_SUMMARY_CHARS = 40;
  let expiryMarked = 0;
  let expiryDropped = 0;
  let expiryChars = 0;
  if (typeof expiryOf === 'function' && accepted.length) {
    const build = (i, line) => {
      const trial = lines.slice();
      trial[i] = line;
      return [header, ...trial].join('\n');
    };
    const fits = (candidate) => candidate.length <= maxChars && estimateTokens(candidate) <= maxTokens;
    for (let i = 0; i < accepted.length; i += 1) {
      let expiry = '';
      try {
        expiry = String(expiryOf(accepted[i]) || '');
      } catch {
        expiry = '';
      }
      if (!expiry) continue;
      let sc = summaryChars;
      let line = pointerLine(accepted[i], { summaryChars: sc, tagChars, expiry });
      let candidate = build(i, line);
      while (!fits(candidate) && sc > MIN_SUMMARY_CHARS) {
        sc -= 1;
        line = pointerLine(accepted[i], { summaryChars: sc, tagChars, expiry });
        candidate = build(i, line);
      }
      if (!fits(candidate)) {
        expiryDropped += 1;
        continue;
      }
      lines[i] = line;
      items[i].expiry = expiry;
      items[i].chars = line.length;
      items[i].summaryChars = summarize(accepted[i].text, sc).length;
      expiryMarked += 1;
      expiryChars += expiry.length + 1;
    }
  }

  const text = lines.length ? [header, ...lines].join('\n') : '';
  return {
    text,
    lines,
    items,
    chars: text.length,
    estTokens: estimateTokens(text),
    worstCaseTokens: estimateTokensWorstCase(text),
    dropped,
    overflow,
    // FORK-EDIT(2026-11-04 · 记忆时效)：过期标注三件（只增字段，既有键一个不动）
    expiryMarked,
    expiryDropped,
    expiryChars,
  };
}

export const POINTER_HEADER_TEXT = POINTER_HEADER;
