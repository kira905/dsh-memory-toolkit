// 正文与标识的摘要工具。
//
// 全仓只用一种算法：sha256 的十六进制形态。选它的理由是**跨机可复算** ——
// 日志、台账、去重键都拿这个值对齐，换机器重算必须得到同一串。
import { createHash } from 'node:crypto';

const ALGORITHM = 'sha256';
const SHORT_LEN = 12;

/**
 * 正文指纹。
 * 入参先归一到字符串（null / undefined 折成空串），
 * 免得同一份正文因为传参形态不同算出两个哈希。
 */
export function textHash(text) {
  const source = text == null ? '' : String(text);
  return createHash(ALGORITHM).update(source, 'utf8').digest('hex');
}

/**
 * 截短显示（日志与报告里用）。
 * 哈希本身是 ASCII 十六进制，按码元切与按码点切结果相同，这里沿用 String#slice。
 */
export function shortHash(h, n = SHORT_LEN) {
  const value = h || '';
  return String(value).slice(0, n);
}
