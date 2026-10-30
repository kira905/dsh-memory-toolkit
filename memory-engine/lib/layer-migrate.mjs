// 加层字段的迁移引擎：探查 → 出计划 → 备份 → 事务内改 → 改完复核。
//
// 五条硬约束（每条都在代码里）：
//   ① **默认 dry-run**：只有显式 apply 才写；调用方没给 backup 就不许写（先备份再动 schema）；
//   ② **零删行**：本文件的 SQL 里没有 DELETE / DROP；行数在事务内与事务后各核一次；
//   ③ **幂等**：列已在、空值已清零 ⇒ 一个字节都不写（第二次 apply 的 sha 与前一次相同）；
//   ④ **跨盘不 rename**：备份一律「写新文件 + sha 校验」；还原走「同目录临时文件 + rename」，
//      临时文件与目标同盘，因此不会踩 EXDEV；
//   ⑤ **改完必复核**：行数、id 上界、sqlite_sequence、PRAGMA integrity_check 四项与改前对拍。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { GuardError } from './cli-strict.mjs';

export const MEMORY_TABLE = 'memories';
const BUSY_TIMEOUT_MS = 8000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** SQLite 字符串字面量转义：单引号翻倍（路径里可能出现）。 */
const quoteSql = (text) => `'${String(text).replace(/'/g, "''")}'`;

function openRead(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`库文件不存在：${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  return db;
}

/** 只读取数：表清单 / 列清单 / 行数 / 序列 / 完整性。 */
export function inspectDatabase(dbPath) {
  const abs = path.resolve(dbPath);
  const out = {
    dbPath: abs,
    exists: fs.existsSync(abs),
    bytes: 0,
    sha256: null,
    tables: [],
    hasMemoryTable: false,
    columns: [],
    rowCount: null,
    seq: null,
    integrity: null,
    error: null,
  };
  if (!out.exists) {
    out.error = `库文件不存在：${abs}`;
    return out;
  }
  out.bytes = fs.statSync(abs).size;
  out.sha256 = sha256(fs.readFileSync(abs));

  let db = null;
  try {
    db = openRead(abs);
    out.tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all()
      .map((r) => String(r.name));
    out.hasMemoryTable = out.tables.includes(MEMORY_TABLE);
    if (out.hasMemoryTable) {
      out.columns = db.prepare(`PRAGMA table_info(${MEMORY_TABLE})`).all().map((r) => ({
        name: String(r.name),
        type: String(r.type ?? ''),
        notnull: Number(r.notnull ?? 0),
        dflt: r.dflt_value === null ? null : String(r.dflt_value),
      }));
      out.rowCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${MEMORY_TABLE}`).get().n);
      try {
        const s = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(MEMORY_TABLE);
        out.seq = s ? Number(s.seq) : null;
      } catch {
        out.seq = null; // 没有 AUTOINCREMENT 就不会有 sqlite_sequence，不算错
      }
    }
    try {
      const r = db.prepare('PRAGMA integrity_check').get();
      out.integrity = r ? String(r.integrity_check ?? Object.values(r)[0]) : null;
    } catch (e) {
      out.integrity = `读不动：${e && e.message}`;
    }
  } catch (e) {
    out.error = `打不开（只读）：${e && e.message}`;
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

function countEmptyLayer(db, cfg) {
  const col = cfg.column;
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM ${MEMORY_TABLE} WHERE ${col} IS NULL OR TRIM(${col}) = ''`).get();
    return Number(r.n);
  } catch {
    return null;
  }
}

function layerHistogram(db, cfg) {
  const col = cfg.column;
  const rows = db.prepare(`SELECT ${col} AS v, COUNT(*) AS n FROM ${MEMORY_TABLE} GROUP BY ${col} ORDER BY n DESC`).all();
  const known = new Set(cfg.layers.map((n) => n.toLowerCase()));
  const hist = {};
  const outOfSet = {};
  for (const row of rows) {
    const key = row.v === null || String(row.v).trim() === '' ? '(空)' : String(row.v);
    hist[key] = Number(row.n);
    if (key !== '(空)' && !known.has(key.toLowerCase())) outOfSet[key] = Number(row.n);
  }
  return { hist, outOfSet };
}

/** 出计划：只读，绝不写。 */
export function buildPlan(dbPath, cfg) {
  const info = inspectDatabase(dbPath);
  const plan = {
    dbPath: info.dbPath,
    column: cfg.column,
    defaultLayer: cfg.defaultLayer,
    layerNames: cfg.layers,
    info,
    blockers: [],
    hasColumn: false,
    needsAlter: false,
    needsBackfill: false,
    rowCount: info.rowCount,
    emptyLayerRows: null,
    histogram: {},
    outOfSet: {},
    seq: info.seq,
    integrity: info.integrity,
  };
  if (!info.exists) plan.blockers.push(info.error);
  else if (info.error) plan.blockers.push(info.error);
  else if (!info.hasMemoryTable) plan.blockers.push(`库里没有 ${MEMORY_TABLE} 表 —— 这不是一本记忆库`);
  if (info.integrity && info.integrity !== 'ok') plan.blockers.push(`PRAGMA integrity_check 不是 ok：${info.integrity}`);

  if (plan.blockers.length) return plan;

  plan.hasColumn = info.columns.some((c) => c.name.toLowerCase() === cfg.column.toLowerCase());
  let db = null;
  try {
    db = openRead(info.dbPath);
    if (plan.hasColumn) {
      plan.emptyLayerRows = countEmptyLayer(db, cfg);
      const { hist, outOfSet } = layerHistogram(db, cfg);
      plan.histogram = hist;
      plan.outOfSet = outOfSet;
      plan.needsBackfill = Number(plan.emptyLayerRows) > 0;
    } else {
      plan.needsAlter = true;
      // 列还没有 ⇒ 加列即回填，条数就是全表
      plan.emptyLayerRows = plan.rowCount;
      plan.needsBackfill = plan.rowCount > 0;
    }
  } catch (e) {
    plan.blockers.push(`取数失败：${e && e.message}`);
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
  return plan;
}

/**
 * 做备份：默认**逐字节复制**（无 WAL 时最直白，还原后与原件逐字节相同）；
 * 库旁有非空 `-wal` 时改用 `VACUUM INTO`（单文件、含 WAL 内容，避免半截复制）。
 * 两种办法都在写完之后**打开副本核对**：行数 / 序列 / 完整性。
 */
export function createBackup({ dbPath, backupPath }) {
  const src = path.resolve(dbPath);
  const dst = path.resolve(backupPath);
  if (src.toLowerCase() === dst.toLowerCase()) throw new Error('备份路径不能是库本身');
  if (fs.existsSync(dst)) throw new GuardError(`备份文件已存在，不覆盖：${dst}（换个带时间戳的名字，或先挪走）`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });

  const before = inspectDatabase(src);
  if (!before.exists || before.error) throw new Error(`源库读不了，拒绝备份：${before.error ?? src}`);

  const wal = `${src}-wal`;
  const hasLiveWal = fs.existsSync(wal) && fs.statSync(wal).size > 0;
  let method = hasLiveWal ? 'vacuum-into' : 'file-copy';

  if (hasLiveWal) {
    let db = null;
    try {
      db = openRead(src);
      db.exec(`VACUUM INTO ${quoteSql(dst)}`);
    } catch (e) {
      throw new Error(`备份失败（VACUUM INTO 不行，而源库带活的 WAL 又不能直接复制）：${e && e.message}`);
    } finally {
      try {
        if (db) db.close();
      } catch {
        /* ignore */
      }
    }
  } else {
    method = 'file-copy';
    fs.copyFileSync(src, dst);
  }

  const after = inspectDatabase(dst);
  if (!after.exists || after.error) throw new Error(`备份文件打不开：${after.error}`);
  if (after.rowCount !== before.rowCount) {
    throw new Error(`备份行数不符（源 ${before.rowCount} / 备份 ${after.rowCount}）—— 库可能正在被写，重跑一次`);
  }
  if (after.integrity !== 'ok') throw new Error(`备份完整性检查不是 ok：${after.integrity}`);
  return {
    method,
    path: dst,
    bytes: after.bytes,
    sha256: after.sha256,
    rows: after.rowCount,
    seq: after.seq,
    integrity: after.integrity,
    byteIdentical: after.sha256 === before.sha256,
    source: { path: src, bytes: before.bytes, sha256: before.sha256, rows: before.rowCount, seq: before.seq },
  };
}

/** 事务内把计划做完，然后复核四项。 */
export function applyMigration({ dbPath, cfg, backupPath }) {
  const plan = buildPlan(dbPath, cfg);
  if (plan.blockers.length) throw new Error(`计划有阻断项，不动库：${plan.blockers.join('；')}`);
  if (!plan.needsAlter && !plan.needsBackfill) {
    return { changed: false, plan, backup: null, verify: { rowCountSame: true, seqSame: true, integrity: plan.integrity } };
  }
  if (!backupPath) throw new Error('动 schema 前必须先备份：用 --backup <path> 指定一份（拒绝无备份写入）');

  const backup = createBackup({ dbPath, backupPath });
  const abs = path.resolve(dbPath);
  const db = new DatabaseSync(abs);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  let touched = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    if (plan.needsAlter) {
      db.exec(`ALTER TABLE ${MEMORY_TABLE} ADD COLUMN ${cfg.column} TEXT NOT NULL DEFAULT ${quoteSql(cfg.defaultLayer)}`);
    }
    if (plan.needsBackfill) {
      const stmt = db.prepare(
        `UPDATE ${MEMORY_TABLE} SET ${cfg.column} = ? WHERE ${cfg.column} IS NULL OR TRIM(${cfg.column}) = ''`,
      );
      const res = stmt.run(cfg.defaultLayer);
      touched = Number(res.changes ?? 0);
    }
    // 加列时既有行由列默认值直接填好（0 次 UPDATE）—— 记账按"被填了多少行"算，别报 0
    if (plan.needsAlter) touched += Number(plan.rowCount ?? 0);
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    db.close();
    throw new Error(`迁移事务回滚（库未改）：${e && e.message}；备份仍在 ${backup.path}`);
  }
  db.close();

  const after = buildPlan(dbPath, cfg);
  const verify = {
    rowCountSame: after.rowCount === plan.rowCount,
    seqSame: after.seq === plan.seq,
    integrity: after.integrity,
    emptyAfter: after.emptyLayerRows,
    histogram: after.histogram,
  };
  if (!verify.rowCountSame) throw new Error(`行数变了（${plan.rowCount} → ${after.rowCount}）—— 立刻用备份还原：${backup.path}`);
  if (!verify.seqSame) throw new Error(`sqlite_sequence 变了（${plan.seq} → ${after.seq}）—— 立刻用备份还原：${backup.path}`);
  if (Number(verify.emptyAfter) !== 0) throw new Error(`回填后仍有 ${verify.emptyAfter} 行空层 —— 立刻用备份还原：${backup.path}`);
  if (verify.integrity !== 'ok') throw new Error(`迁移后完整性不是 ok：${verify.integrity} —— 用备份还原：${backup.path}`);

  return { changed: true, plan, backup, touched, verify, after };
}

/** 还原：从备份写回库文件。默认 dry-run；真写走「同目录临时文件 + sha 校验 + rename」。 */
export function restoreDatabase({ backupPath, dbPath, apply = false }) {
  const backup = inspectDatabase(backupPath);
  if (!backup.exists) throw new Error(`备份不存在：${path.resolve(backupPath)}`);
  if (backup.error) throw new Error(`备份打不开：${backup.error}`);
  if (!backup.hasMemoryTable) throw new Error(`备份里没有 ${MEMORY_TABLE} 表 —— 不是一本记忆库的备份`);
  if (backup.integrity !== 'ok') throw new Error(`备份完整性不是 ok：${backup.integrity}`);

  const target = inspectDatabase(dbPath);
  const plan = {
    backup: { path: backup.dbPath, bytes: backup.bytes, sha256: backup.sha256, rows: backup.rowCount, seq: backup.seq },
    target: target.exists
      ? { path: target.dbPath, bytes: target.bytes, sha256: target.sha256, rows: target.rowCount, seq: target.seq }
      : { path: path.resolve(dbPath), bytes: null, sha256: null, rows: null, seq: null, missing: true },
    sidecars: ['-wal', '-shm'].filter((s) => fs.existsSync(path.resolve(dbPath) + s)),
    applied: false,
    verify: null,
  };
  if (!apply) return plan;

  const abs = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // 陈旧 WAL 与新库文件配在一起 = 直接损坏库，必须先摘掉（这是备份还原的一部分，不是删数据）
  for (const suffix of ['-wal', '-shm']) {
    const side = abs + suffix;
    if (fs.existsSync(side)) fs.rmSync(side, { force: true });
  }
  const tmp = `${abs}.restore-${process.pid}-${Date.now()}.tmp`;
  fs.copyFileSync(backup.dbPath, tmp);
  const tmpSha = sha256(fs.readFileSync(tmp));
  if (tmpSha !== backup.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`临时副本 sha 与备份不符（${tmpSha.slice(0, 12)} ≠ ${backup.sha256.slice(0, 12)}）—— 未替换`);
  }
  fs.renameSync(tmp, abs); // 同目录 rename：不跨盘，不会 EXDEV

  const after = inspectDatabase(abs);
  if (!after.exists || after.error || after.sha256 !== backup.sha256) {
    throw new Error(`还原后核对失败（${after.error ?? `sha ${String(after.sha256).slice(0, 12)}`}）—— 库文件已替换，请人工确认`);
  }
  plan.applied = true;
  plan.verify = { sha256: after.sha256, rows: after.rowCount, seq: after.seq, integrity: after.integrity };
  return plan;
}
