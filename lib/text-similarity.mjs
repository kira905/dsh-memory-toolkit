/**
 * text-similarity.mjs —— 文本归一化与近重复度量（纯函数，零 IO）
 *
 * 会话候选的去重/近重复判定靠这三个函数：`normalizeText` 归一化、`shingles` 取
 * 6-gram 集合、`jaccard` 算相似度。判定阈值在 `THRESHOLDS` 里，改阈值 = 改行为，
 * 属「判定口径」变更 —— 改的时候把 `judgeVersion`（见 `memory-engine/lib/capture-judge.mjs`）
 * 一起升，别只改数字。
 *
 * 与 `dsh-memory-local` 里影子判定用的同口径实现保持一致：两边若各改一边，
 * 同一段文本会得到两个相似度 ⇒ 去重结论对不上。
 */

export const THRESHOLDS = Object.freeze({
  dup: 0.90,
  sim: 0.74,
  shingle: 6,
});

/** 纯函数：规范化（去设备标注、去空白、去标点）。 */
export function normalizeText(s) {
  return String(s)
    .replace(/【设备[：:][^】]*】/g, '')
    .replace(/\s+/g, '')
    .replace(/[，。、；：！？（）【】《》""''`\-—…·.,;:!?()\[\]<>"']/g, '');
}

/** 纯函数：k-gram shingle 集合（k 默认 6）。 */
export function shingles(text, k = THRESHOLDS.shingle) {
  const t = normalizeText(text);
  const set = new Set();
  for (let i = 0; i + k <= t.length; i++) set.add(t.slice(i, i + k));
  if (t.length < k && t.length) set.add(t);
  return set;
}

/** 纯函数：Jaccard 相似度（对称，小集合先遍历）。 */
export function jaccard(A, B) {
  if (!A || !B || !A.size || !B.size) return 0;
  let inter = 0;
  if (A.size > B.size) return jaccard(B, A);
  for (const s of A) if (B.has(s)) inter += 1;
  return inter / (A.size + B.size - inter);
}
