// tick-hook 并发压测的「子进程工人」（只被 10-tick-hook.test.mjs 拉起）
// 用法：node _tickhook-worker.mjs <mark|consume> <markerPath> <durationMs>
//   mark    —— 循环置标记（每次写自己的 updatedAt），结束打印事件数与 errors
//   consume —— 循环清标记（每次取 consumeStart），结束打印每次的 cleared/consumeStart/consumedUpdatedAt
// 设计：**捕异常计数上报**（不吞），事件列表截断到 2000 条上限（防超大 stdout）。
import { markDirty, clearMarkerIfStale } from '../lib/tick-hook.mjs';

const [mode, markerPath, durationRaw] = process.argv.slice(2);
const durationMs = Number(durationRaw) || 1500;
const deadline = Date.now() + durationMs;
const events = [];
const errors = [];
let n = 0;
let violations = 0;
let minAt = null;
let maxAt = null;

function note(at) {
  if (minAt === null || at < minAt) minAt = at;
  if (maxAt === null || at > maxAt) maxAt = at;
}

try {
  if (mode === 'mark') {
    while (Date.now() < deadline) {
      const at = Date.now();
      try {
        markDirty(markerPath, { at, reason: `loadtest-${n}` });
        n += 1;
        note(at);
        if (events.length < 2000) events.push(at);
      } catch (e) {
        errors.push(`${e && e.code ? e.code : 'ERR'}:${String(e && e.message).slice(0, 80)}`);
      }
    }
  } else {
    while (Date.now() < deadline) {
      const consumeStart = Date.now();
      try {
        const r = clearMarkerIfStale(markerPath, consumeStart);
        if (r.cleared && !(Number(r.consumedUpdatedAt) < consumeStart)) violations += 1;
        if (r.cleared) note(Number(r.consumedUpdatedAt));
        n += 1;
        if (events.length < 2000) {
          events.push({ cleared: r.cleared, reason: r.reason, consumeStart, consumedUpdatedAt: r.consumedUpdatedAt ?? null });
        }
      } catch (e) {
        errors.push(`${e && e.code ? e.code : 'ERR'}:${String(e && e.message).slice(0, 80)}`);
      }
    }
  }
} catch (e) {
  errors.push(`fatal:${String(e && e.stack).slice(0, 200)}`);
}

process.stdout.write(`${JSON.stringify({ mode, n, violations, errors, minAt, maxAt, events })}\n`);
