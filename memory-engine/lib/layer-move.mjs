// 软淘汰执行器：把一整层「搬走」而不是删掉 —— 搬到本库内的一张边表（memories_evicted），一条命令出去、一条命令回来。
//
// 为什么选「另一张表」而不是「另一个库文件」（代价写在这里，README 同款）：
//   · 好处：同一个事务里搬进搬出，守恒可以当场断言；不会留下一个可能被误删的旁路库文件；
//     FTS5 触发器仍然在 主表 上，搬出即从索引删除、搬回即重建，索引不会漂。
//   · 代价：搬走的行**仍然占这个库文件的体积**（软淘汰省的是上下文与召回面，不是磁盘）；
//     边表没有 FTS 索引 ⇒ 搬走的行在引擎召回里不可见，只能用 SQL 或 `--back` 取回。
//
// 四条硬判据：
//   ① 守恒：搬出层行数 + 剩下行数 == 搬前总行数（事务内断言，不成立就整批回滚）；
//   ② 逐行可比：每行落边表时记 content_sha（与 lib/layers.mjs 的行指纹同算法），搬回时先核后写；
//   ③ 默认 dry-run：不带 apply 一个字节都不写；
//   ④ 不许把主表搬空：会搬走全部行时要显式 `--force`（防"层名写错"把库清空）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { rowDigest, canonicalLayerName } from './layers.mjs';
import { GuardError } from './cli-strict.mjs';

export const MEMORY_TABLE = 'memories';
export const EVICTED_TABLE = 'memories_evicted';
const BUSY_TIMEOUT_MS = 8000;

const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

/** 边表：列与主表一一对应 + 三个记账列（层 / 指纹 / 批次）。 */
export const EVICTED_DDL = `
CREATE TABLE IF NOT EXISTS ${EVICTED_TABLE} (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  layer TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  batch TEXT NOT NULL,
  moved_at INTEGER NOT NULL
)`;

const MEMORY_COLUMNS = 'id, text, tags, pinned, created_at, updated_at';

function open(dbPath, { readOnly = false } = {}) {
  const abs = path.resolve(dbPath);
  if (!fs.existsSync(abs)) throw new Error(`库文件不存在：${abs}`);
  const db = new DatabaseSync(abs, readOnly ? { readOnly: true } : {});
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return db;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => String(c.name).toLowerCase() === column.toLowerCase());
}

const countAll = (db) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${MEMORY_TABLE}`).get().n);
const countLayerInMain = (db, cfg, layer) =>
  Number(
    db.prepare(`SELECT COUNT(*) AS n FROM ${MEMORY_TABLE} WHERE LOWER(${cfg.column}) = LOWER(?)`).get(String(layer)).n,
  );

function countEvicted(db, layer) {
  if (!tableExists(db, EVICTED_TABLE)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${EVICTED_TABLE} WHERE LOWER(layer) = LOWER(?)`).get(String(layer)).n);
}

function seqOf(db) {
  try {
    const r = db.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(MEMORY_TABLE);
    return r ? Number(r.seq) : null;
  } catch {
    return null;
  }
}

function ensureEvictedTable(db) {
  db.exec(EVICTED_DDL);
}

/** 只说出计划：会不会搬、搬几行、有没有阻断项。 */
export function planMove({ dbPath, cfg, layer }) {
  const db = open(dbPath, { readOnly: true });
  try {
    const plan = {
      dbPath: path.resolve(dbPath),
      layer,
      totalRows: countAll(db),
      hasColumn: columnExists(db, MEMORY_TABLE, cfg.column),
      hasEvictedTable: tableExists(db, EVICTED_TABLE),
      layerRows: 0,
      evictedRows: 0,
      seq: seqOf(db),
      blockers: [],
    };
    if (!plan.hasColumn) {
      plan.blockers.push(`主表没有 ${cfg.column} 列 —— 先跑 layer-migrate --apply 把列加上`);
      return plan;
    }
    plan.layerRows = countLayerInMain(db, cfg, layer);
    plan.evictedRows = countEvicted(db, layer);
    plan.leavesEmpty = plan.layerRows > 0 && plan.layerRows === plan.totalRows;
    return plan;
  } finally {
    db.close();
  }
}

/**
 * 搬出：主表 → 边表。事务内断言守恒；任何一步不符就整批回滚。
 * @returns {{moved:number,totalBefore:number,remaining:number,evicted:number,batch:string,digests:number}}
 */
export function moveOut({ dbPath, cfg, layer, batch, force = false }) {
  const name = canonicalLayerName(cfg, layer);
  if (!name) throw new Error(`「${layer}」不在层名集合 [${cfg.layers.join(', ')}] 里`);
  const plan = planMove({ dbPath, cfg, layer: name });
  if (plan.blockers.length) throw new Error(plan.blockers.join('；'));
  if (plan.layerRows === 0) {
    return { moved: 0, totalBefore: plan.totalRows, remaining: plan.totalRows, evicted: plan.evictedRows, batch, digests: 0 };
  }
  if (plan.leavesEmpty && !force) {
    throw new GuardError(
      `搬走「${name}」会把主表搬空（${plan.layerRows}/${plan.totalRows} 行）—— 这通常是层名填错。确实要搬请加 --force`,
    );
  }

  const db = open(dbPath);
  const before = { rows: countAll(db), seq: seqOf(db) };
  let movedRows = 0;
  try {
    ensureEvictedTable(db);
    const rows = db
      .prepare(`SELECT ${MEMORY_COLUMNS}, ${cfg.column} AS layer_value FROM ${MEMORY_TABLE} WHERE LOWER(${cfg.column}) = LOWER(?) ORDER BY id`)
      .all(name);
    db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare(
      `INSERT INTO ${EVICTED_TABLE} (id, text, tags, pinned, created_at, updated_at, layer, content_sha, batch, moved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const remove = db.prepare(`DELETE FROM ${MEMORY_TABLE} WHERE id = ? AND LOWER(${cfg.column}) = LOWER(?)`);
    const clash = db.prepare(`SELECT id FROM ${EVICTED_TABLE} WHERE id = ?`);
    const now = Date.now();
    for (const row of rows) {
      const layerValue = String(row.layer_value ?? name);
      const digest = rowDigest({ ...row, [cfg.column]: layerValue }, cfg);
      if (clash.get(Number(row.id))) {
        throw new GuardError(`id ${row.id} 已经在边表里（上次搬出没搬回）—— 先 layer-move --back，别覆盖`);
      }
      insert.run(
        Number(row.id), String(row.text ?? ''), String(row.tags ?? ''), Number(row.pinned ?? 0),
        Number(row.created_at ?? 0), Number(row.updated_at ?? 0), layerValue, digest, batch, now,
      );
      const res = remove.run(Number(row.id), name);
      if (Number(res.changes ?? 0) !== 1) throw new Error(`删除主表 id ${row.id} 失败（影响 ${res.changes} 行）`);
      movedRows += 1;
    }
    const remaining = countAll(db);
    const evicted = countEvicted(db, name);
    if (evicted + remaining !== before.rows) {
      throw new Error(`守恒不成立：搬出 ${evicted} + 剩下 ${remaining} ≠ 搬前 ${before.rows}`);
    }
    db.exec('COMMIT');
    return { moved: movedRows, totalBefore: before.rows, remaining, evicted, batch, digests: movedRows, seqBefore: before.seq, seqAfter: seqOf(db) };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    db.close();
  }
}

/**
 * 搬回：边表 → 主表。先逐行核指纹（不符整批拒动），再插回并删边表。
 */
export function moveBack({ dbPath, cfg, layer }) {
  const name = canonicalLayerName(cfg, layer);
  if (!name) throw new Error(`「${layer}」不在层名集合 [${cfg.layers.join(', ')}] 里`);
  const db = open(dbPath);
  const before = { rows: countAll(db), seq: seqOf(db) };
  try {
    if (!tableExists(db, EVICTED_TABLE)) {
      return { restored: 0, totalBefore: before.rows, totalAfter: before.rows, mismatched: [], reason: '边表不存在（没搬出过）' };
    }
    ensureEvictedTable(db);
    const rows = db.prepare(`SELECT * FROM ${EVICTED_TABLE} WHERE LOWER(layer) = LOWER(?) ORDER BY id`).all(name);
    if (rows.length === 0) {
      return { restored: 0, totalBefore: before.rows, totalAfter: before.rows, mismatched: [], reason: `边表里没有「${name}」的行` };
    }

    // 先验后写：任一指纹不符 / 主表已存在同 id ⇒ 整批不动
    const mismatched = [];
    const collisions = [];
    for (const row of rows) {
      const digest = rowDigest({ ...row, [cfg.column]: String(row.layer ?? name) }, cfg);
      if (digest !== String(row.content_sha)) mismatched.push({ id: Number(row.id), stored: String(row.content_sha), now: digest });
      const hit = db.prepare(`SELECT id FROM ${MEMORY_TABLE} WHERE id = ?`).get(Number(row.id));
      if (hit) collisions.push(Number(row.id));
    }
    if (mismatched.length) {
      const ids = mismatched.slice(0, 5).map((m) => m.id).join(', ');
      throw new GuardError(`边表里有 ${mismatched.length} 行内容被改过（指纹不符，例：${ids}）—— 整批拒动`);
    }
    if (collisions.length) {
      throw new GuardError(`主表里已存在同 id 的行（例：${collisions.slice(0, 5).join(', ')}）—— 整批拒动，先查清哪一份该留`);
    }

    db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare(
      `INSERT INTO ${MEMORY_TABLE} (id, text, tags, pinned, created_at, updated_at, ${cfg.column})
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const remove = db.prepare(`DELETE FROM ${EVICTED_TABLE} WHERE id = ? AND LOWER(layer) = LOWER(?)`);
    let restored = 0;
    for (const row of rows) {
      insert.run(
        Number(row.id), String(row.text ?? ''), String(row.tags ?? ''), Number(row.pinned ?? 0),
        Number(row.created_at ?? 0), Number(row.updated_at ?? 0), String(row.layer ?? name),
      );
      const res = remove.run(Number(row.id), name);
      if (Number(res.changes ?? 0) !== 1) throw new Error(`从边表删 id ${row.id} 失败（影响 ${res.changes} 行）`);
      restored += 1;
    }
    const after = countAll(db);
    if (after !== before.rows + restored) {
      throw new Error(`守恒不成立：搬前 ${before.rows} + 搬回 ${restored} ≠ 搬后 ${after}`);
    }
    db.exec('COMMIT');
    return { restored, totalBefore: before.rows, totalAfter: after, mismatched: [], seqBefore: before.seq, seqAfter: seqOf(db) };
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    db.close();
  }
}

/** 导出主表（或某一层）的逐行指纹，当作「搬前长什么样」的凭据。 */
export function dumpDigests({ dbPath, cfg, layer = null }) {
  const db = open(dbPath, { readOnly: true });
  try {
    if (!columnExists(db, MEMORY_TABLE, cfg.column)) throw new Error(`主表没有 ${cfg.column} 列 —— 先跑 layer-migrate`);
    const rows = layer
      ? db
          .prepare(`SELECT ${MEMORY_COLUMNS}, ${cfg.column} AS layer_value FROM ${MEMORY_TABLE} WHERE LOWER(${cfg.column}) = LOWER(?) ORDER BY id`)
          .all(String(layer))
      : db.prepare(`SELECT ${MEMORY_COLUMNS}, ${cfg.column} AS layer_value FROM ${MEMORY_TABLE} ORDER BY id`).all();
    const items = rows.map((row) => ({
      id: Number(row.id),
      digest: rowDigest({ ...row, [cfg.column]: String(row.layer_value ?? '') }, cfg),
    }));
    return { at: new Date().toISOString(), dbPath: path.resolve(dbPath), layer, count: items.length, rows: items };
  } finally {
    db.close();
  }
}

/** 拿导出件对拍当前主表：缺行 / 多行 / 内容变了 三类分开报。 */
export function verifyAgainstDump({ dbPath, cfg, dump }) {
  const now = dumpDigests({ dbPath, cfg, layer: dump.layer ?? null });
  const before = new Map((dump.rows ?? []).map((r) => [Number(r.id), String(r.digest)]));
  const after = new Map(now.rows.map((r) => [Number(r.id), String(r.digest)]));
  const missing = [];
  const extra = [];
  const changed = [];
  for (const [id, digest] of before) {
    if (!after.has(id)) missing.push(id);
    else if (after.get(id) !== digest) changed.push(id);
  }
  for (const id of after.keys()) if (!before.has(id)) extra.push(id);
  const byId = (a, b) => a - b;
  return {
    ok: missing.length === 0 && extra.length === 0 && changed.length === 0,
    checked: before.size,
    currentCount: after.size,
    missing: missing.sort(byId),
    extra: extra.sort(byId),
    changed: changed.sort(byId),
  };
}

/** 写导出件（JSON 只落文件）。 */
export function writeDump(file, dump) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(dump, null, 2)}\n`, 'utf8');
  return abs;
}

export function readDump(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`指纹导出件不在：${abs}`);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

export { sha256 as sha256OfText };
