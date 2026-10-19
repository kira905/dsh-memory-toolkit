/**
 * FORK-EDIT(2026-09-21): 用户消息构造器（移植 `@deepseek-ai/dsh-llm` 的 message.ts 语义）
 *
 * 官方 `createUserMessage` = `freezeMessage({ ...input, role: 'user', id: MessageId(randomUUID()) })`：
 * 先 structuredClone、再深冻结，保证消息发布后不可变（llm 包对消息做 deepFreeze）。
 * 本文件是等价实现（官方把它内联打包在 dsh-time-context / dsh-tmux-context 等包里，
 * 没有可 import 的公开入口；形态保持一致 ⇒ 注入消息与官方插件注入的消息同构）。
 */
import crypto from 'node:crypto';

function deepFreeze(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  // AbortSignal 是活体取消通道，冻结它会破坏 abort（官方同口径）
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return value;
  const visited = seen || new WeakSet();
  if (visited.has(value)) return value;
  visited.add(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], visited);
  return Object.freeze(value);
}

/**
 * 构造一条已识别、已冻结的 user 消息。
 * @param {{content:Array, source:object}} input
 */
export function createUserMessage(input) {
  return deepFreeze({
    ...input,
    id: crypto.randomUUID(),
    role: 'user',
  });
}
