import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(`${process.env.USERPROFILE.replaceAll("\\", "/")}/.dsh/memory/memory.db`, { readOnly: true });

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("=== TABLES ===");
console.log(JSON.stringify(tables, null, 2));

for (const t of tables) {
  const name = t.name;
  try {
    const cols = db.prepare(`PRAGMA table_info(${name})`).all();
    console.log(`\n=== TABLE ${name} columns ===`);
    console.log(JSON.stringify(cols, null, 2));
  } catch (e) {
    console.log(`\n=== TABLE ${name} === error: ${e.message}`);
  }
}

db.close();
