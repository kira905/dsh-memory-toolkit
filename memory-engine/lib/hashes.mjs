// 记忆引擎 v2 · 离线层 —— 哈希工具
import crypto from 'node:crypto';

/** 记忆正文哈希（方案 §3.1：text_hash = sha256(text)） */
export function textHash(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** 稳定摘要（日志/报告用） */
export function shortHash(h, n = 12) {
  return String(h || '').slice(0, n);
}
