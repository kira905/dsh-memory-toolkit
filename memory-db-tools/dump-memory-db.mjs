import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(`${process.env.USERPROFILE.replaceAll("\\", "/")}/.dsh/memory/memory.db`, { readOnly: true });

const rows = db.prepare("SELECT id, text, tags, pinned, created_at, updated_at FROM memories ORDER BY id").all();
console.log(`TOTAL: ${rows.length}`);
for (const r of rows) {
  console.log(`\n--- #${r.id} [pinned=${r.pinned}] tags=${r.tags} created=${r.created_at} updated=${r.updated_at} ---`);
  console.log(r.text);
}

db.close();
