// 文档索引的「逃生舱」：库烂了 / 陈旧了，用它重建；重建前自动留快照，出事能一键盖回去。
//
// 支持的动作与开关：
//   无开关            一键全量刷新（范围内按 path 重跑，幂等）
//   --purge           先清空范围内的条再重建（模拟"库损坏 / 陈旧"）
//   --no-snapshot     不留重建前快照（缺省会留）
//   --restore <快照>  回滚：用快照覆盖当前库
//   --list-snapshots  列出可用快照
//   路径注入：--docs-root / --dsh-root / --doc-index-db / --state-file / --home / --snapshot-dir
//
// 退出码：0 成功 / 1 有失败 / 2 用法错
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isMainEntry, parseArgs, makeLogger } from '../lib/cli-util.mjs';
import { runDocIndexOnce } from '../lib/doc-index.mjs';
import { openDocIndexStore, snapshotDb } from '../lib/doc-index-store.mjs';

const RC = { ok: 0, fail: 1, usage: 2 };
const SNAP_HEAD = 'doc-index-';
const SNAP_TAIL = '.db';

/** 本地时间戳（快照文件名）：YYYYMMDD-HHMMSS。 */
function stamp(when = new Date()) {
  const two = (v) => `${v}`.padStart(2, '0');
  const day = `${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}`;
  const clock = [when.getHours(), when.getMinutes(), when.getSeconds()].map(two).join('');
  return `${day}-${clock}`;
}

/** 落点解析：home 一定，其余三项才有默认值。 */
function resolvePaths(flags, env = process.env) {
  const fallbackHome = path.join(os.homedir(), '.dsh');
  const home = path.resolve(String(flags.home || env.DSH_HOME || fallbackHome));
  const vectorsDir = path.join(home, 'memory-vectors');
  const dbPath = path.resolve(String(flags['doc-index-db'] || env.DOC_INDEX_DB || path.join(vectorsDir, 'doc-index.db')));
  return {
    home,
    vectorsDir,
    dbPath,
    snapshotDir: path.resolve(String(flags['snapshot-dir'] || path.join(vectorsDir, 'doc-index-snapshots'))),
  };
}

/** 开库 → 干活 → 无论成败都把库关掉（快照与清表都借这个壳）。 */
function withStore(dbPath, work) {
  const store = openDocIndexStore(dbPath, { create: false });
  try {
    return work(store.db);
  } finally {
    try { store.db.close(); } catch { /* 关不掉不盖住真正的错 */ }
  }
}

/** 重建前快照（VACUUM INTO）。库还不存在 ⇒ 没有可备份的东西，跳过即可。 */
export function takeSnapshot({ dbPath, snapshotDir, log = () => {} }) {
  const hasDb = fs.existsSync(dbPath);
  if (!hasDb) return { ok: true, skipped: true, reason: '库不存在（首次建库无需快照）' };
  const dest = path.join(snapshotDir, `${SNAP_HEAD}${stamp()}${SNAP_TAIL}`);
  withStore(dbPath, (db) => snapshotDb(db, dest));
  const { size } = fs.statSync(dest);
  log(`[rebuild] 重建前快照已留：${dest}（${size} B）`);
  return { ok: true, size, dest };
}

/** 列快照（新→旧）。目录不在 = 没有快照，不是错误。 */
export function listSnapshots(snapshotDir) {
  let entries;
  try {
    entries = fs.readdirSync(snapshotDir);
  } catch {
    return [];
  }
  try {
    const picked = [];
    for (const name of entries) {
      const looksLikeSnap = name.startsWith(SNAP_HEAD) && name.endsWith(SNAP_TAIL);
      if (!looksLikeSnap) continue;
      const file = path.join(snapshotDir, name);
      const info = fs.statSync(file);
      picked.push({ name, file, size: info.size, mtime: info.mtimeMs });
    }
    picked.sort((a, b) => b.mtime - a.mtime);
    return picked;
  } catch {
    return [];
  }
}

function existenceProblem(file, label) {
  return fs.existsSync(file) ? null : `${label}：${file}`;
}

/**
 * 回滚：快照盖回当前库。当前库先另存一份 `.before-restore-<ts>`，绝不静默丢东西。
 * 注意覆盖前必须清 `-wal` / `-shm`，否则新库会被旧 WAL 污染。
 */
export function restoreFromSnapshot({ dbPath, snapshotFile, log = () => {} }) {
  const blocker = existenceProblem(snapshotFile, '快照不存在') ?? existenceProblem(dbPath, '目标库不存在');
  if (blocker) return { ok: false, error: blocker };
  const backup = `${dbPath}.before-restore-${stamp()}`;
  copyFile(dbPath, backup);
  for (const sidecar of ['-wal', '-shm']) {
    const f = `${dbPath}${sidecar}`;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  copyFile(snapshotFile, dbPath);
  log(`[rebuild] 快照已回滚：${snapshotFile} → ${dbPath}（回滚前副本 ${backup}）`);
  return { ok: true, backup, from: snapshotFile };
}

function copyFile(from, to) {
  fs.copyFileSync(from, to);
}

/** 子命令：列快照。 */
function cmdList({ flags, json, log, paths }) {
  const snaps = listSnapshots(paths.snapshotDir);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, snapshotDir: paths.snapshotDir, snapshots: snaps }, null, 2)}\n`);
    return RC.ok;
  }
  log(`快照目录：${paths.snapshotDir}`);
  if (!snaps.length) log('（这个目录里还没有快照）');
  for (const s of snaps) log(`  ${new Date(s.mtime).toLocaleString('zh-CN')}  ${s.size} B  ${s.file}`);
  return RC.ok;
}

/** 子命令：从快照回滚。 */
function cmdRestore({ flags, json, log, paths }) {
  const r = restoreFromSnapshot({ dbPath: paths.dbPath, snapshotFile: path.resolve(flags.restore), log });
  if (json) process.stdout.write(`${JSON.stringify({ ok: r.ok, ...r }, null, 2)}\n`);
  return r.ok ? RC.ok : RC.fail;
}

/** 子命令：一键重建（缺省动作）。 */
async function cmdRebuild({ flags, json, log, paths }) {
  // ① 先留退路（--no-snapshot / --dry-run 时不写）
  let snapshot = { ok: true, skipped: true, reason: '--no-snapshot' };
  const wantSnapshot = !flags['no-snapshot'] && !flags['dry-run'];
  if (wantSnapshot) snapshot = takeSnapshot({ dbPath: paths.dbPath, snapshotDir: paths.snapshotDir, log });

  // ② --purge：先把范围内的条清空，模拟"库烂了"从零重建
  const canPurge = flags.purge && !flags['dry-run'] && fs.existsSync(paths.dbPath);
  if (canPurge) {
    const removed = withStore(paths.dbPath, (db) => db.prepare('DELETE FROM doc_index').run().changes);
    log(`[rebuild] 清表完成：doc_index 删了 ${Number(removed) || 0} 条`);
  }

  // ③ 全量刷新：ignore 差分、按 path 覆盖，所以重跑幂等
  const r = await runDocIndexOnce({ flags: { ...flags, rebuild: true, home: paths.home, 'doc-index-db': paths.dbPath } });
  for (const line of r.lines) log(line);

  const payload = {
    ok: r.status !== 'failed',
    status: r.status,
    dbPath: paths.dbPath,
    snapshot,
    stats: r.stats,
    dailyLine: r.state.lastDailyLine,
  };
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else log(`[rebuild] 收工：${r.state.lastDailyLine}`);
  return r.status === 'failed' ? RC.fail : RC.ok;
}

const SUBCOMMANDS = [
  { pick: (flags) => Boolean(flags['list-snapshots']), run: cmdList },
  { pick: (flags) => typeof flags.restore === 'string', run: cmdRestore },
];

export async function main() {
  const { flags } = parseArgs();
  const asJson = Boolean(flags.json);
  const log = makeLogger({ json: asJson, quiet: Boolean(flags.quiet) });
  const paths = resolvePaths(flags);
  const chosen = SUBCOMMANDS.find((c) => c.pick(flags));
  try {
    return await (chosen ? chosen.run({ flags, json: asJson, log, paths }) : cmdRebuild({ flags, json: asJson, log, paths }));
  } catch (e) {
    const msg = String(e?.stack ?? e);
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
    else log(`❌ ${msg}`);
    return RC.usage;
  }
}

const launchedDirectly = isMainEntry(import.meta.url);
if (launchedDirectly) process.exitCode = await main();
