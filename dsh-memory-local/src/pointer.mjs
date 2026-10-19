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
 * ⚠️ 2026-10-12 事故修复（会话 `session-dddcf909` 第 23 棒永久 HTTP 400）：
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
 */
export function pointerLine(row, { summaryChars = 80, tagChars = 40 } = {}) {
  const tags = compactTags(row.tags, tagChars);
  const tagPart = tags ? ` · tags: ${tags}` : '';
  return `- #${row.id} (${formatDate(row.updated_at)}${tagPart}) ${summarize(row.text, summaryChars)}`;
}

/**
 * 按预算裁剪并渲染指针文本。
 * 逐条累加，任一预算触顶即停（后面的条目丢弃并计数）。
 * @returns {{text:string, lines:string[], items:Array, chars:number, estTokens:number, dropped:number, overflow:boolean}}
 */
export function renderPointer(
  rows,
  { header = POINTER_HEADER, maxItems = 8, maxChars = 800, maxTokens = 600, summaryChars = 80, tagChars = 40 } = {},
) {
  const lines = [];
  const items = [];
  let dropped = 0;
  let overflow = false;
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
    items.push({
      id: Number(row.id),
      chars: line.length,
      summaryChars: summarize(row.text, summaryChars).length,
      tags: row.tags,
      updatedAt: Number(row.updated_at),
    });
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
  };
}

export const POINTER_HEADER_TEXT = POINTER_HEADER;
