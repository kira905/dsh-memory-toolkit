import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(`${process.env.USERPROFILE.replaceAll("\\", "/")}/.dsh/memory/memory.db`, { readOnly: true });
const rows = db.prepare("SELECT id, pinned, tags FROM memories ORDER BY id").all();
const pinned = rows.filter(r => r.pinned).map(r => r.id);
console.log(`TOTAL: ${rows.length}`);
console.log(`IDS: ${rows.map(r => r.id).join(", ")}`);
console.log(`PINNED: ${pinned.join(", ")}`);
db.close();
