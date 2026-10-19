import { DatabaseSync } from "node:sqlite";

// 只读列出全部记忆的 id / 创建时间 / 更新时间 / 标题（毫秒 epoch 已转本地时间）。
// 用法：node show-mem-times.mjs [id ...]   （不给 id 则列全部；dsh 运行中也可安全执行）
const db = new DatabaseSync(`${process.env.USERPROFILE.replaceAll("\\", "/")}/.dsh/memory/memory.db`, { readOnly: true });
const fmt = ms => new Date(ms).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });

const args = process.argv.slice(2);
let rows;
if (args.length === 0) {
  rows = db.prepare("SELECT id, created_at, updated_at, text, pinned FROM memories ORDER BY id").all();
} else {
  const ids = args.map(Number).filter(Number.isInteger);
  if (!ids.length) { console.error("用法：node show-mem-times.mjs <id> [id ...]（不给 id 列全部）"); process.exit(1); }
  const ph = ids.map(() => "?").join(",");
  rows = db.prepare(`SELECT id, created_at, updated_at, text, pinned FROM memories WHERE id IN (${ph}) ORDER BY id`).all(...ids);
}
for (const r of rows) {
  const firstLine = r.text.split("\n")[0].slice(0, 60);
  console.log(`#${String(r.id).padStart(3)} [${r.pinned === 1 ? "pin" : "  -"}] 创建 ${fmt(r.created_at)}  更新 ${fmt(r.updated_at)}  ${firstLine}`);
}
db.close();
