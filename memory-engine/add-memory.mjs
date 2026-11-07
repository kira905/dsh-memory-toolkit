// 库层写入一条真实记忆（等价于 DSH memory 插件的写入：INSERT memories，FTS 由既有触发器 memories_ai/au/ad 自动同步）
// 用法：node add-memory.mjs --db <path> --spec <spec.json>
//   spec.json = { "text": "...", "tags": "a,b", "ownerUser": "<你的用户名>", "expectBand": 3000000 }
// 之所以走 JSON 文件而不是命令行：经 ssh 给远端 cmd 传中文参数会把引号剥掉（cross-host-ops §2.16）。
import fs from 'node:fs';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const dbPath = val('--db');
const specPath = val('--spec');
if (!dbPath || !specPath) { console.error('用法：node add-memory.mjs --db <path> --spec <spec.json>'); process.exit(3); }
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
if (!spec.text) { console.error('spec 缺 text'); process.exit(3); }

const db = new DatabaseSync(dbPath, { readOnly: false });
db.exec('PRAGMA busy_timeout=5000');
const before = db.prepare('SELECT COUNT(*) n, MAX(id) mx FROM memories').get();
const now = Date.now();
const r = db.prepare(`INSERT INTO memories (text, tags, pinned, created_at, updated_at, owner_user, visibility)
                      VALUES (?, ?, 0, ?, ?, ?, ?)`).run(
  spec.text,
  spec.tags || '',
  now,
  now,
  spec.ownerUser || os.userInfo().username,
  'private_owner'
);
const id = Number(r.lastInsertRowid);
const after = db.prepare('SELECT COUNT(*) n, MAX(id) mx FROM memories').get();
const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='memories'").get();
const fts = db.prepare('SELECT COUNT(*) n FROM memories_fts').get();
const inFts = db.prepare('SELECT rowid FROM memories_fts WHERE rowid = ?').get(id);
// 读回这一条，确认真的落地（不是只拿到 rowid）
const back = db.prepare('SELECT id, length(text) L, tags FROM memories WHERE id = ?').get(id);
db.close();

const out = {
  db: dbPath,
  newId: id,
  expectBand: spec.expectBand ?? null,
  inBand: spec.expectBand ? id >= spec.expectBand && id < spec.expectBand + 1000000 : null,
  rowsBefore: Number(before.n),
  rowsAfter: Number(after.n),
  maxIdAfter: Number(after.mx),
  seqAfter: Number(seq?.seq),
  ftsRows: Number(fts.n),
  presentInFts: !!inFts,
  readBack: back ? { id: Number(back.id), textLen: Number(back.L), tags: back.tags } : null,
};
console.log(JSON.stringify(out, null, 2));
process.exitCode = spec.expectBand ? (out.inBand ? 0 : 3) : 0;
