// 记忆引擎 v2 · 离线层 —— 文档索引**逃生舱**（方案 §7「doc-index.db 损坏 / 陈旧 → 重建器一键全量刷新」）
//
// 用法：
//   node cli/doc-index-rebuild.mjs                  # 一键全量刷新（范围内按 path 重跑，幂等）
//   node cli/doc-index-rebuild.mjs --purge          # 先清空范围内全部条再重建（模拟库损坏/陈旧）
//   node cli/doc-index-rebuild.mjs --no-snapshot    # 不写重建前快照（默认会写）
//   node cli/doc-index-rebuild.mjs --restore <快照文件>   # 回滚：用快照覆盖当前库
//   node cli/doc-index-rebuild.mjs --list-snapshots # 列出可用快照
//   路径可注入：--docs-root / --dsh-root / --doc-index-db / --state-file / --home / --snapshot-dir
//
// 退出码：0 成功 / 1 有失败 / 2 用法错
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isMainEntry, parseArgs, makeLogger } from '../lib/cli-util.mjs';
import { runDocIndexOnce } from '../lib/doc-index.mjs';
import { openDocIndexStore, snapshotDb } from '../lib/doc-index-store.mjs';

const EXIT = { OK: 0, FAIL: 1, USAGE: 2 };

function resolvePaths(flags, env = process.env) {
  const home = path.resolve(String(flags.home || env.DSH_HOME || path.join(os.homedir(), '.dsh')));
  const vectorsDir = path.join(home, 'memory-vectors');
  const dbPath = path.resolve(String(flags['doc-index-db'] || env.DOC_INDEX_DB || path.join(vectorsDir, 'doc-index.db')));
  const snapshotDir = path.resolve(String(flags['snapshot-dir'] || path.join(vectorsDir, 'doc-index-snapshots')));
  return { home, vectorsDir, dbPath, snapshotDir };
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 重建前快照（VACUUM INTO；库不存在则跳过——没有可备份的东西）。 */
export function takeSnapshot({ dbPath, snapshotDir, log = () => {} }) {
  if (!fs.existsSync(dbPath)) return { ok: true, skipped: true, reason: '库不存在（首次建库无需快照）' };
  const dest = path.join(snapshotDir, `doc-index-${ts()}.db`);
  const store = openDocIndexStore(dbPath, { create: false });
  try {
    snapshotDb(store.db, dest);
  } finally {
    try {
      store.db.close();
    } catch {
      /* ignore */
    }
  }
  const size = fs.statSync(dest).size;
  log(`[rebuild] 重建前快照：${dest}（${size} B）`);
  return { ok: true, dest, size };
}

/** 列出快照（按时间倒序）。 */
export function listSnapshots(snapshotDir) {
  try {
    return fs
      .readdirSync(snapshotDir)
      .filter((n) => n.startsWith('doc-index-') && n.endsWith('.db'))
      .map((n) => ({ name: n, file: path.join(snapshotDir, n), size: fs.statSync(path.join(snapshotDir, n)).size, mtime: fs.statSync(path.join(snapshotDir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/**
 * 回滚：用快照覆盖当前库（先把当前库另存为 `.before-restore-<ts>`，绝不静默丢）。
 * ⚠️ WAL 副作用：覆盖前必须清掉 `-wal` / `-shm`，否则新库会被旧 WAL 污染。
 */
export function restoreFromSnapshot({ dbPath, snapshotFile, log = () => {} }) {
  if (!fs.existsSync(snapshotFile)) return { ok: false, error: `快照不存在：${snapshotFile}` };
  if (!fs.existsSync(dbPath)) return { ok: false, error: `目标库不存在：${dbPath}` };
  const backup = `${dbPath}.before-restore-${ts()}`;
  fs.copyFileSync(dbPath, backup);
  for (const suffix of ['-wal', '-shm']) {
    const f = `${dbPath}${suffix}`;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  }
  fs.copyFileSync(snapshotFile, dbPath);
  log(`[rebuild] 已回滚：${snapshotFile} → ${dbPath}（回滚前副本：${backup}）`);
  return { ok: true, backup, from: snapshotFile };
}

export async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = makeLogger({ json, quiet: Boolean(flags.quiet) });
  const { dbPath, snapshotDir, home } = resolvePaths(flags);

  try {
    if (flags['list-snapshots']) {
      const snaps = listSnapshots(snapshotDir);
      if (json) process.stdout.write(JSON.stringify({ ok: true, snapshotDir, snapshots: snaps }, null, 2) + '\n');
      else {
        log(`快照目录：${snapshotDir}`);
        if (!snaps.length) log('（无快照）');
        for (const s of snaps) log(`  ${new Date(s.mtime).toLocaleString('zh-CN')}  ${s.size} B  ${s.file}`);
      }
      return EXIT.OK;
    }

    if (typeof flags.restore === 'string') {
      const r = restoreFromSnapshot({ dbPath, snapshotFile: path.resolve(flags.restore), log });
      if (json) process.stdout.write(JSON.stringify({ ok: r.ok, ...r }, null, 2) + '\n');
      return r.ok ? EXIT.OK : EXIT.FAIL;
    }

    // ① 重建前快照（默认开）
    let snapshot = { ok: true, skipped: true, reason: '--no-snapshot' };
    if (!flags['no-snapshot'] && !flags['dry-run']) {
      snapshot = takeSnapshot({ dbPath, snapshotDir, log });
    }

    // ② --purge：先清空范围内全部条（模拟"库损坏 / 陈旧"后的干净重建）
    if (flags.purge && !flags['dry-run'] && fs.existsSync(dbPath)) {
      const store = openDocIndexStore(dbPath, { create: false });
      try {
        const n = store.db.prepare('DELETE FROM doc_index').run().changes;
        log(`[rebuild] --purge：已清空 doc_index（删除 ${Number(n) || 0} 条）`);
      } finally {
        try {
          store.db.close();
        } catch {
          /* ignore */
        }
      }
    }

    // ③ 一键全量刷新（force = 忽略差分，按 path 覆盖）
    const r = await runDocIndexOnce({
      flags: { ...flags, rebuild: true, home, 'doc-index-db': dbPath },
    });
    for (const l of r.lines) log(l);

    const out = {
      ok: r.status !== 'failed',
      status: r.status,
      dbPath,
      snapshot,
      stats: r.stats,
      dailyLine: r.state.lastDailyLine,
    };
    if (json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else log(`[rebuild] 完成：${r.state.lastDailyLine}`);
    return r.status === 'failed' ? EXIT.FAIL : EXIT.OK;
  } catch (e) {
    const msg = String(e && e.stack ? e.stack : e);
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
    else log(`❌ ${msg}`);
    return EXIT.USAGE;
  }
}

if (isMainEntry(import.meta.url)) process.exitCode = await main();
