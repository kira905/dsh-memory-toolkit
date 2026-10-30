// 提炼产物回滚（方案 §3.5 的回滚行）
//
// 口径：按 `tags LIKE 'distilled%'` 批量列、批量删；默认 dry-run；真删之前先用 VACUUM INTO 拍快照。
// 为什么认 tag 而不认 id 清单：提炼条本身是**推断产物**，主人可能一句话否掉一整批，
//   也可能只否掉其中某几组 ⇒ 两种粒度都得给：`--key <srcKey>` 整组、`--id <行 id>` 单条。
// ⚠ 删除语句**恒带 `AND tags LIKE 'distilled%'`**：调用方就算把 id 集合算错，也误伤不到真实记忆。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { vacuumInto } from './domain-tags.mjs';
import { DISTILL_PREFIX } from './distill.mjs';

// 标签里的三个属性位：来源键 / 来源 id 串 / 提炼日期
const TAG_SRCKEY_RE = /(?:^|\s)src=([0-9a-f]+)(?:\s|$)/;
const TAG_SRCIDS_RE = /(?:^|\s)srcids=([0-9,\s]*)(?:\s|$)/;
const TAG_DATE_RE = /(?:^|\s)date=(\d{8})(?:\s|$)/;

const SQL_LIST = `SELECT id, text, tags, updated_at, created_at%EXTRA% FROM memories WHERE tags LIKE 'distilled%' ORDER BY id`;
const SQL_TRIGGERS = "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memories'";
const SQL_DELETE = "DELETE FROM memories WHERE id = ? AND tags LIKE 'distilled%'";

// 库里有没有某一列（老库没有 owner_user / visibility 这两个多人口径字段）
function columnExists(db, name) {
  return db.prepare('PRAGMA table_info(memories)').all().some((row) => row.name === name);
}

// 统一开关库：只读走 readOnly 连接，写连接才设 busy_timeout；关库一律放 finally
function withDb(dbPath, { readOnly = false } = {}, body) {
  const conn = readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
  try {
    if (!readOnly) conn.exec('PRAGMA busy_timeout = 5000;');
    return body(conn);
  } finally {
    try { conn.close(); } catch { /* 关不掉也不拖累结果 */ }
  }
}

// 解析提炼条标签 → {srcKey, srcIds, date}；不是提炼条就给 null
export function parseDistilledTags(tags) {
  const raw = String(tags ?? '');
  if (!raw.startsWith(DISTILL_PREFIX)) return null;

  const pick = (pattern) => {
    const hit = pattern.exec(raw);
    return hit ? hit[1] : '';
  };
  const idText = pick(TAG_SRCIDS_RE);
  const ids = idText
    ? idText.split(',').map((piece) => Number(piece.trim())).filter((n) => Number.isFinite(n))
    : [];
  return {
    srcKey: pick(TAG_SRCKEY_RE) || null,
    srcIds: ids,
    date: pick(TAG_DATE_RE) || null,
  };
}

// 列出提炼条（只读）；keys / ids 是两组独立过滤，limit > 0 才截断
export function listDistilled({ dbPath, keys = null, ids = null, limit = 0, headChars = 100 }) {
  return withDb(dbPath, { readOnly: true }, (conn) => {
    const extra = columnExists(conn, 'owner_user') ? ', owner_user, visibility' : '';
    const rows = conn.prepare(SQL_LIST.replace('%EXTRA%', extra)).all();
    const keySet = new Set((Array.isArray(keys) ? keys : []).map((k) => String(k)));
    const idSet = new Set((Array.isArray(ids) ? ids : []).map((x) => Number(x)));

    const listed = [];
    for (const row of rows) {
      const meta = parseDistilledTags(row.tags) ?? { srcKey: null, srcIds: [], date: null };
      if (keySet.size > 0 && !keySet.has(String(meta.srcKey))) continue;
      if (idSet.size > 0 && !idSet.has(Number(row.id))) continue;
      const text = String(row.text ?? '');
      listed.push({
        id: Number(row.id),
        srcKey: meta.srcKey,
        srcIds: meta.srcIds,
        date: meta.date,
        chars: text.length,
        head: text.slice(0, headChars).replace(/\s+/g, ' '),
        tags: row.tags,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        ownerUser: row.owner_user ?? null,
        visibility: row.visibility ?? null,
      });
    }
    return limit > 0 ? listed.slice(0, Number(limit)) : listed;
  });
}

// **内容级摘要**：按 id 排序取 (id, text, tags, pinned, updated_at)，逐行拼再整体哈希。
// 为什么不看文件 sha256：SQLite 写回后页布局会变（内容一样也可能字节不同），
//   文件 sha 回答不了"回滚后库是否回到原状"，内容摘要能。
export function contentDigest(dbPath, { excludeTagsLike = null } = {}) {
  return withDb(dbPath, { readOnly: true }, (conn) => {
    const filter = excludeTagsLike ? ` WHERE tags NOT LIKE '${excludeTagsLike}'` : '';
    const rows = conn.prepare(`SELECT id, text, tags, pinned, updated_at FROM memories${filter} ORDER BY id`).all();
    const hash = crypto.createHash('sha256');
    const FIELD_SEP = '\u0001';
    const ROW_END = '\u0002';
    for (const row of rows) {
      const fields = [row.id, row.text, row.tags, row.pinned, row.updated_at].map((value) => String(value));
      hash.update(`${fields.join(FIELD_SEP)}${ROW_END}`, 'utf8');
    }
    const allCount = Number(conn.prepare('SELECT COUNT(*) n FROM memories').get().n);
    return { count: rows.length, digest: hash.digest('hex'), allCount };
  });
}

// 文件 sha256（读不动就给 null，怎么记由调用方决定）
export function fileSha256(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

// 删除前快照：这是整条链上唯一的回滚点
function writeSnapshot(dbPath, snapshotDir, now) {
  const dir = snapshotDir ?? path.join(path.dirname(dbPath), 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(Number(now)).toISOString().replace(/[:.]/g, '-');
  const snap = path.join(dir, `memory-before-distill-rollback-${stamp}.db`);
  vacuumInto(dbPath, snap);
  return { dir, stamp, snap };
}

// 真删：先记触发器现场（FTS 影子表靠 memories_ad 同步），再在一个事务里逐条删
function deleteDistilledRows(dbPath, items) {
  return withDb(dbPath, {}, (conn) => {
    const triggers = conn.prepare(SQL_TRIGGERS).all().map((row) => row.name);
    const wipe = conn.prepare(SQL_DELETE);
    const removed = [];
    conn.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        const res = wipe.run(item.id);
        if (Number(res.changes || 0) > 0) removed.push(item.id);
      }
      conn.exec('COMMIT');
    } catch (err) {
      try { conn.exec('ROLLBACK'); } catch { /* 忽略 */ }
      throw err;
    }
    return { triggers, removed };
  });
}

// 生成"把快照写回目标库"的一键恢复脚本（覆盖前先把现有库另存一份）
function restoreScriptText({ snapshot, target }) {
  const lines = [
    '// 自动生成：把提炼回滚前的快照写回目标记忆库（覆盖式，覆盖前先另存现有库）',
    '// 用法：node <本文件路径>',
    "import fs from 'node:fs';",
    `const SNAPSHOT = ${JSON.stringify(snapshot)};`,
    `const DB_TARGET = ${JSON.stringify(target)};`,
    "const CURRENT_SUFFIXES = ['', '-wal', '-shm'];",
    'if (!fs.existsSync(SNAPSHOT)) {',
    "  console.error('快照不存在：' + SNAPSHOT);",
    '  process.exit(3);',
    '}',
    'for (const suffix of CURRENT_SUFFIXES) {',
    '  const file = DB_TARGET + suffix;',
    "  try { if (fs.existsSync(file)) fs.copyFileSync(file, file + '.before-restore'); } catch { /* 忽略 */ }",
    '}',
    'fs.copyFileSync(SNAPSHOT, DB_TARGET);',
    "for (const suffix of ['-wal', '-shm']) { try { fs.rmSync(DB_TARGET + suffix, { force: true }); } catch { /* 忽略 */ } }",
    "console.log('已恢复：' + DB_TARGET + ' <- ' + SNAPSHOT);",
    '',
  ];
  return lines.join('\n');
}

// 批量回滚主入口：先摘要 + 列表；没命中或 dry-run 都早退；真删才拍快照
export function rollbackDistilled(p = {}) {
  const { dbPath, keys = null, ids = null, snapshotDir = null, now = Date.now(), apply = false } = p;
  const before = contentDigest(dbPath);
  const items = listDistilled({ dbPath, keys, ids });

  const out = {
    ok: true,
    dryRun: !apply,
    matched: items.length,
    deleted: 0,
    deletedIds: [],
    snapshot: null,
    before,
    after: before,
    items: items.map((item) => ({ id: item.id, srcKey: item.srcKey, head: item.head })),
    rollbackFile: null,
    warnings: [],
  };
  if (items.length === 0) return out;
  if (!apply) return out;

  const shot = writeSnapshot(dbPath, snapshotDir, now);
  out.snapshot = shot.snap;
  out.snapshotSha256 = fileSha256(shot.snap);

  const wiped = deleteDistilledRows(dbPath, items);
  out.triggers = wiped.triggers;
  if (!wiped.triggers.some((name) => /_ad$|delete/i.test(name))) {
    out.warnings.push('memories 上没有 AFTER DELETE 触发器 ⇒ FTS 影子表可能残留脏行（建议核对 memories_fts）');
  }
  out.deletedIds = wiped.removed;
  out.deleted = wiped.removed.length;

  out.after = contentDigest(dbPath);

  // 反向回滚脚本：把快照拷回去 = 一键恢复
  if (out.snapshot) {
    const rbFile = path.join(shot.dir, `restore-memory-${shot.stamp}.mjs`);
    fs.writeFileSync(rbFile, restoreScriptText({ snapshot: shot.snap, target: dbPath }), 'utf8');
    out.rollbackFile = rbFile;
  }
  return out;
}
