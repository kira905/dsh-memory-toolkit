import { DatabaseSync } from "node:sqlite";

// 只读读指定记忆全文（替代 PowerShell 内联 node -e 读库，避免引号/转义地狱，见记忆 #46 第 2 条）。
// 用法：
//   node read-memories.mjs 9 27       读 #9、#27 全文
//   node read-memories.mjs --all      输出全部记忆全文
// （dsh 运行中也可安全执行，WAL 模式只读无冲突）
const db = new DatabaseSync(`${process.env.USERPROFILE.replaceAll("\\", "/")}/.dsh/memory/memory.db`, { readOnly: true });
const args = process.argv.slice(2);
let rows;
if (args.length === 0 || args.includes("--all")) {
  rows = db.prepare("SELECT id, text, pinned FROM memories ORDER BY id").all();
} else {
  const ids = args.map(Number).filter(Number.isInteger);
  if (!ids.length) {
    console.error("用法：node read-memories.mjs <id> [id ...]  或  --all");
    process.exit(1);
  }
  const placeholders = ids.map(() => "?").join(",");
  rows = db.prepare(`SELECT id, text, pinned FROM memories WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);
}
for (const r of rows) {
  console.log(`=== #${r.id} [pinned=${r.pinned === 1 ? "Y" : "-"}] ===`);
  console.log(r.text + "\n");
}
db.close();
