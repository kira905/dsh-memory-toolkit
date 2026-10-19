// 记忆引擎 v2 · S3c —— 提炼产物回滚（方案 §3.5 回滚行）
//
// 口径：**按 `tags LIKE 'distilled%'` 批量列出 / 删除**；默认 dry-run；删除前 `VACUUM INTO` 快照。
// 为什么按 tag 而不是按 id 清单：提炼条是**推断产物**，主人可能整批否定（"这批结论不对"），
//   也可能只否定某几组 ⇒ 两种粒度都要能选：`--key <srcKey>`（整组）/ `--id <行 id>`（单条）。
// ⚠️ 删除语句**恒带 `AND tags LIKE 'distilled%'`** —— 即使调用方算错了 id 集合，也不可能误删真实记忆。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { vacuumInto } from './domain-tags.mjs';
import { DISTILL_PREFIX } from './distill.mjs';

/** 解析提炼条标签 → {srcKey, srcIds, date}。 */
export function parseDistilledTags(tags) {
  const t = String(tags ?? '');
  if (!t.startsWith(DISTILL_PREFIX)) return null;
  const key = t.match(/(?:^|\s)src=([0-9a-f]+)(?:\s|$)/);
  const ids = t.match(/(?:^|\s)srcids=([0-9,\s]*)(?:\s|$)/);
  const date = t.match(/(?:^|\s)date=(\d{8})(?:\s|$)/);
  return {
    srcKey: key ? key[1] : null,
    srcIds: ids && ids[1] ? ids[1].split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : [],
    date: date ? date[1] : null,
  };
}

function open(dbPath, { readOnly = false } = {}) {
  const db = readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
  if (!readOnly) db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/**
 * 列出提炼条（只读）。
 * @param {{dbPath:string, keys?:string[], ids?:number[], limit?:number, headChars?:number}} p
 */
export function listDistilled({ dbPath, keys = null, ids = null, limit = 0, headChars = 100 }) {
  const db = open(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(`SELECT id, text, tags, updated_at, created_at${hasCol(db, 'owner_user') ? ', owner_user, visibility' : ''} FROM memories WHERE tags LIKE 'distilled%' ORDER BY id`)
      .all();
    let items = rows.map((r) => {
      const meta = parseDistilledTags(r.tags) ?? { srcKey: null, srcIds: [], date: null };
      return {
        id: Number(r.id), srcKey: meta.srcKey, srcIds: meta.srcIds, date: meta.date,
        chars: String(r.text ?? '').length,
        head: String(r.text ?? '').slice(0, headChars).replace(/\s+/g, ' '),
        tags: r.tags, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
        ownerUser: r.owner_user ?? null, visibility: r.visibility ?? null,
      };
    });
    if (Array.isArray(keys) && keys.length) {
      const want = new Set(keys.map((k) => String(k)));
      items = items.filter((x) => want.has(String(x.srcKey)));
    }
    if (Array.isArray(ids) && ids.length) {
      const want = new Set(ids.map((x) => Number(x)));
      items = items.filter((x) => want.has(x.id));
    }
    if (limit > 0) items = items.slice(0, Number(limit));
    return items;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function hasCol(db, name) {
  return db.prepare('PRAGMA table_info(memories)').all().some((r) => r.name === name);
}

/**
 * **内容级摘要**：按 id 排序取 (id, text, tags, pinned, updated_at) 逐行哈希再整体哈希。
 * 为什么不用文件 sha256：SQLite 写回后页布局会变（同样的内容也可能字节不同），
 *   文件 sha 无法回答"回滚后库是否回到原状"；内容摘要可以（本卡演练的判据就靠它）。
 */
export function contentDigest(dbPath, { excludeTagsLike = null } = {}) {
  const db = open(dbPath, { readOnly: true });
  try {
    const where = excludeTagsLike ? ` WHERE tags NOT LIKE '${excludeTagsLike}'` : '';
    const rows = db.prepare(`SELECT id, text, tags, pinned, updated_at FROM memories${where} ORDER BY id`).all();
    const h = crypto.createHash('sha256');
    for (const r of rows) h.update(`${r.id}\u0001${r.text}\u0001${r.tags}\u0001${r.pinned}\u0001${r.updated_at}\u0002`, 'utf8');
    return { count: rows.length, digest: h.digest('hex'), allCount: Number(db.prepare('SELECT COUNT(*) n FROM memories').get().n) };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export function fileSha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 批量回滚。
 * @param {{dbPath:string, apply?:boolean, keys?:string[], ids?:number[], snapshotDir?:string,
 *          now?:number, keepSnapshot?:boolean}} p
 * @returns {{ok:boolean, matched:number, deleted:number, deletedIds:number[], snapshot:string|null,
 *            before:object, after:object, dryRun:boolean, rollbackFile:string|null}}
 */
export function rollbackDistilled(p = {}) {
  const { dbPath, keys = null, ids = null, snapshotDir = null, now = Date.now(), apply = false } = p;
  const before = contentDigest(dbPath);
  const items = listDistilled({ dbPath, keys, ids });
  const out = {
    ok: true, dryRun: !apply, matched: items.length, deleted: 0, deletedIds: [],
    snapshot: null, before, after: before, items: items.map((x) => ({ id: x.id, srcKey: x.srcKey, head: x.head })),
    rollbackFile: null, warnings: [],
  };
  if (!items.length) return out;

  if (!apply) return out;

  // 删除前快照（**唯一回滚点**）
  const dir = snapshotDir ?? path.join(path.dirname(dbPath), 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(Number(now)).toISOString().replace(/[:.]/g, '-');
  const snap = path.join(dir, `memory-before-distill-rollback-${stamp}.db`);
  vacuumInto(dbPath, snap);
  out.snapshot = snap;
  out.snapshotSha256 = fileSha256(snap);

  const db = open(dbPath);
  try {
    // FTS 同步靠 `memories_ad` 触发器（触发器缺失时 DELETE 不会清 FTS 影子表 ⇒ 显式提示）
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memories'").all().map((r) => r.name);
    out.triggers = triggers;
    if (!triggers.some((n) => /_ad$|delete/i.test(n))) out.warnings.push('未发现 memories 的 AFTER DELETE 触发器 ⇒ FTS 影子表可能残留（建议核对 memories_fts）');

    const targetIds = items.map((x) => x.id);
    const stmt = db.prepare(`DELETE FROM memories WHERE id = ? AND tags LIKE 'distilled%'`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of targetIds) {
        const r = stmt.run(id);
        if (Number(r.changes || 0) > 0) out.deletedIds.push(id);
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
    out.deleted = out.deletedIds.length;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  out.after = contentDigest(dbPath);
  // 反向回滚脚本（把快照拷回去 = 一键恢复）
  if (out.snapshot) {
    const rbFile = path.join(dir, `restore-memory-${stamp}.mjs`);
    fs.writeFileSync(rbFile, restoreScript({ snapshot: snap, target: dbPath }), 'utf8');
    out.rollbackFile = rbFile;
  }
  return out;
}

/** 生成"把快照写回目标库"的一键恢复脚本（纯 ASCII 头 + 覆盖前校验存在性）。 */
function restoreScript({ snapshot, target }) {
  return `// 自动生成：把提炼回滚前的快照写回目标记忆库（覆盖式）
// 用法：node ${path.basename('restore-memory.mjs')}  或  node "本文件路径"
import fs from 'node:fs';
const SNAP = ${JSON.stringify(snapshot)};
const TARGET = ${JSON.stringify(target)};
if (!fs.existsSync(SNAP)) { console.error('快照不存在：' + SNAP); process.exit(3); }
for (const suffix of ['', '-wal', '-shm']) {
  const f = TARGET + suffix;
  try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.before-restore'); } catch { /* ignore */ }
}
fs.copyFileSync(SNAP, TARGET);
for (const suffix of ['-wal', '-shm']) { try { fs.rmSync(TARGET + suffix, { force: true }); } catch { /* ignore */ } }
console.log('已恢复：' + TARGET + ' <- ' + SNAP);
`;
}
