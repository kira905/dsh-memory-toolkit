// 12 · 分层软淘汰 + 号段哨兵（K5 新增件的夹具；每件都配阳性 / 阴性对照）
//
// 覆盖三件事：
//   ① layer 字段迁移：干跑零写 / 加列回填 / 幂等 / 备份还原 / 保护闸；
//   ② 软淘汰执行器：搬出守恒 / 搬回逐行指纹一致 / 空表保护 / 边表被改过整批拒动；
//   ③ 号段哨兵：单机正常绿 / 越上界红 / 低于下界红 / 更高位段红 / 更低别台段只披露 / 本机库读不到 rc=4 /
//      远端读不到**不许** rc=4 / 报告只落文件。
//
// 铁律：所有夹具库都造在 os.tmpdir() 下；起子进程时 USERPROFILE / HOME / DSH_HOME 三件套一起隔离。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test, assert, assertEq } from './harness.mjs';
import { makeTempRoot, makeMemoryDb, sampleRows } from './fixtures.mjs';
import { loadLayerConfig, rowDigest, digestRows, compareDigests } from '../lib/layers.mjs';
import { buildPlan, applyMigration, restoreDatabase, inspectDatabase } from '../lib/layer-migrate.mjs';
import { planMove, moveOut, moveBack, dumpDigests, verifyAgainstDump, EVICTED_TABLE } from '../lib/layer-move.mjs';
import { loadBandConfig, evaluate, bandRanges, snapshotLocal, judgeSnapshot } from '../lib/band-sentinel.mjs';

export const __section = '12 · 分层软淘汰（layer 字段 / 搬出搬回）+ 号段哨兵（单机退化）';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..');
const CLI = {
  migrate: path.join(ENGINE, 'cli', 'layer-migrate.mjs'),
  move: path.join(ENGINE, 'cli', 'layer-move.mjs'),
  sentinel: path.join(ENGINE, 'cli', 'band-sentinel.mjs'),
};

/** 子进程环境：三件套全隔离（碰 home 的路径一个都不许真碰）。 */
function isoEnv(root) {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    DSH_HOME: path.join(home, '.dsh'),
    MEMORY_ENGINE_MEMORY_DB: path.join(home, '.dsh', 'memory', 'memory.db'),
  };
}

function run(script, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

function includes(text, needle, label) {
  assert(String(text).includes(needle), `${label}：输出里没有「${needle}」\n---\n${String(text).slice(0, 1200)}\n---`);
}

const shaOf = (p) => inspectDatabase(p).sha256;

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  return file;
}

/** 造一本已迁好「层」的夹具库（回填成 recall）。 */
function preparedDb(root, rows = sampleRows(6)) {
  const dbPath = path.join(root, 'memory.db');
  makeMemoryDb(dbPath, rows);
  const cfg = loadLayerConfig({ file: null });
  const res = applyMigration({ dbPath, cfg, backupPath: path.join(root, 'backup-before-migrate.db') });
  return { dbPath, cfg, migration: res };
}

function countRows(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(db.prepare(sql).get(...params).n);
  } finally {
    db.close();
  }
}

function execSql(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

// ───────────────────────────── ① 层配置与迁移 ─────────────────────────────

test('层名不写死：换一份层配置就换一套层名；缺省层不在集合里当场拒', () => {
  const t = makeTempRoot('k5-layers-');
  try {
    const file = writeJson(path.join(t.root, 'layers.json'), { column: 'tier', layers: ['hot', 'warm', 'cold'], default: 'warm' });
    const cfg = loadLayerConfig({ file, env: {} });
    assertEq(cfg.layers.join('|'), 'hot|warm|cold', '层名来自配置文件');
    assertEq(cfg.defaultLayer, 'warm', '缺省层来自配置文件');
    assertEq(cfg.column, 'tier', '列名来自配置文件');
    let threw = null;
    try {
      loadLayerConfig({ file: writeJson(path.join(t.root, 'bad.json'), { layers: ['a', 'b'], default: 'zzz' }), env: {} });
    } catch (e) {
      threw = e;
    }
    assert(threw && /缺省层/.test(threw.message), '缺省层不在集合里 ⇒ 抛错（不是静默回退）');
  } finally {
    t.cleanup();
  }
});

test('layer-migrate 干跑零写：计划说清要加列，库文件 sha 一字不变', () => {
  const t = makeTempRoot('k5-migrate-dry-');
  try {
    const dbPath = path.join(t.root, 'memory.db');
    makeMemoryDb(dbPath, sampleRows(6));
    const before = shaOf(dbPath);
    const r = run(CLI.migrate, ['--db', dbPath], isoEnv(t.root));
    assertEq(r.status, 0, `rc 应为 0\n${r.stderr}`);
    includes(r.stdout, '将新增', '干跑计划');
    includes(r.stdout, 'dry-run', '干跑标记');
    assertEq(shaOf(dbPath), before, '干跑不许改库文件（sha 不变）');
    assertEq(inspectDatabase(dbPath).columns.some((c) => c.name === 'layer'), false, '干跑后列仍然不在');
  } finally {
    t.cleanup();
  }
});

test('layer-migrate 保护闸：--apply 不带 --backup ⇒ rc=2 且库不动；未知参数也 rc=2', () => {
  const t = makeTempRoot('k5-migrate-guard-');
  try {
    const dbPath = path.join(t.root, 'memory.db');
    makeMemoryDb(dbPath, sampleRows(6));
    const before = shaOf(dbPath);
    const env = isoEnv(t.root);

    const noBackup = run(CLI.migrate, ['--db', dbPath, '--apply'], env);
    assertEq(noBackup.status, 2, '无备份的 --apply 必须 rc=2');
    includes(noBackup.stderr, '--backup', '要说清缺什么');
    assertEq(shaOf(dbPath), before, '拒跑时库不许动');

    const unknown = run(CLI.migrate, ['--db', dbPath, '--wat'], env);
    assertEq(unknown.status, 2, '未知参数必须 rc=2（fail-closed）');
    includes(unknown.stderr, '未知参数', '错误要说人话');

    const missing = run(CLI.migrate, ['--db', path.join(t.root, 'nope.db')], env);
    assertEq(missing.status, 3, '库不存在 ⇒ rc=3');
  } finally {
    t.cleanup();
  }
});

test('layer-migrate --apply：加列 + 回填到缺省层，行数 / seq / 完整性三项复核通过', () => {
  const t = makeTempRoot('k5-migrate-apply-');
  try {
    const dbPath = path.join(t.root, 'memory.db');
    makeMemoryDb(dbPath, sampleRows(6));
    const before = inspectDatabase(dbPath);
    const backup = path.join(t.root, 'backup.db');
    const env = isoEnv(t.root);

    const r = run(CLI.migrate, ['--db', dbPath, '--apply', '--backup', backup], env);
    assertEq(r.status, 0, `rc 应为 0\n${r.stderr}`);
    includes(r.stdout, '已加列', '成功回执');

    const after = inspectDatabase(dbPath);
    assert(after.columns.some((c) => c.name === 'layer'), '列已加');
    assertEq(after.rowCount, before.rowCount, '行数守恒（一行不删）');
    assertEq(after.seq, before.seq, 'sqlite_sequence 不变');
    assertEq(after.integrity, 'ok', 'integrity_check = ok');
    assertEq(countRows(dbPath, "SELECT COUNT(*) AS n FROM memories WHERE layer = 'recall'"), 6, '全部回填成缺省层 recall');
    assertEq(countRows(dbPath, "SELECT COUNT(*) AS n FROM memories WHERE layer IS NULL OR TRIM(layer) = ''"), 0, '没有空层行');

    const bk = inspectDatabase(backup);
    assert(bk.exists && bk.integrity === 'ok', '备份文件在位且完整');
    assertEq(bk.rowCount, before.rowCount, '备份与源库行数一致');
    assertEq(bk.columns.some((c) => c.name === 'layer'), false, '备份是改前状态（没有 layer 列）');
  } finally {
    t.cleanup();
  }
});

test('layer-migrate 幂等：第二次 --apply 一个字节都不写', () => {
  const t = makeTempRoot('k5-migrate-idem-');
  try {
    const dbPath = path.join(t.root, 'memory.db');
    makeMemoryDb(dbPath, sampleRows(6));
    const env = isoEnv(t.root);
    const first = run(CLI.migrate, ['--db', dbPath, '--apply', '--backup', path.join(t.root, 'b1.db')], env);
    assertEq(first.status, 0, `第一次 apply 应成功\n${first.stderr}`);
    const shaAfterFirst = shaOf(dbPath);

    const second = run(CLI.migrate, ['--db', dbPath, '--apply', '--backup', path.join(t.root, 'b2.db')], env);
    assertEq(second.status, 0, `第二次 apply 也应 rc=0\n${second.stderr}`);
    includes(second.stdout, '幂等', '要说清无事可做');
    assertEq(shaOf(dbPath), shaAfterFirst, '第二次 apply 库文件逐字节不变');
    assertEq(fs.existsSync(path.join(t.root, 'b2.db')), false, '无事可做时不该再产出一份备份');
  } finally {
    t.cleanup();
  }
});

test('layer-migrate 可用自定义列名与自定义缺省层（配置驱动，不是写死三个层名）', () => {
  const t = makeTempRoot('k5-migrate-custom-');
  try {
    const dbPath = path.join(t.root, 'memory.db');
    makeMemoryDb(dbPath, sampleRows(4));
    const r = run(
      CLI.migrate,
      ['--db', dbPath, '--apply', '--backup', path.join(t.root, 'b.db'), '--layers', 'hot,warm,cold', '--default-layer', 'warm', '--column', 'tier'],
      isoEnv(t.root),
    );
    assertEq(r.status, 0, `rc 应为 0\n${r.stderr}`);
    const cols = inspectDatabase(dbPath).columns.map((c) => c.name);
    assert(cols.includes('tier'), '列名按 --column 生效');
    assert(!cols.includes('layer'), '没顺手加内置列');
    assertEq(countRows(dbPath, "SELECT COUNT(*) AS n FROM memories WHERE tier = 'warm'"), 4, '回填到自定义缺省层');
  } finally {
    t.cleanup();
  }
});

test('layer-migrate --restore：干跑不动、--apply 复原到改前（含摘掉陈旧 WAL）', () => {
  const t = makeTempRoot('k5-migrate-restore-');
  try {
    const dbPath = path.join(t.root, 'memory.db');
    makeMemoryDb(dbPath, sampleRows(6));
    const preMigration = shaOf(dbPath);
    const env = isoEnv(t.root);
    const backup = path.join(t.root, 'backup.db');

    const applied = run(CLI.migrate, ['--db', dbPath, '--apply', '--backup', backup], env);
    assertEq(applied.status, 0, `迁移应先成功\n${applied.stderr}`);
    const postMigration = shaOf(dbPath);
    assert(postMigration !== preMigration, '迁移确实改了库');

    // 备份还原：干跑不许动
    const dry = run(CLI.migrate, ['--db', dbPath, '--restore', backup], env);
    assertEq(dry.status, 0, `还原干跑 rc 应为 0\n${dry.stderr}`);
    assertEq(shaOf(dbPath), postMigration, '还原干跑不许动库');

    const real = run(CLI.migrate, ['--db', dbPath, '--restore', backup, '--apply'], env);
    assertEq(real.status, 0, `还原 rc 应为 0\n${real.stderr}`);
    assertEq(shaOf(dbPath), preMigration, '还原后 sha 与迁移前逐字节一致');
    assertEq(inspectDatabase(dbPath).columns.some((c) => c.name === 'layer'), false, '还原后列也没了（真回到改前）');
  } finally {
    t.cleanup();
  }
});

// ───────────────────────────── ② 软淘汰执行器 ─────────────────────────────

test('layer-move 干跑零写：说清会搬几行，库文件 sha 不变', () => {
  const t = makeTempRoot('k5-move-dry-');
  try {
    const { dbPath } = preparedDb(t.root);
    execSql(dbPath, "UPDATE memories SET layer = 'archival' WHERE id IN (1, 2)");
    const before = shaOf(dbPath);
    const r = run(CLI.move, ['--db', dbPath, '--layer', 'archival'], isoEnv(t.root));
    assertEq(r.status, 0, `rc 应为 0\n${r.stderr}`);
    includes(r.stdout, 'dry-run', '干跑标记');
    includes(r.stdout, '2 行', '报出要搬的行数');
    assertEq(shaOf(dbPath), before, '干跑不许改库');
    assertEq(countRows(dbPath, 'SELECT COUNT(*) AS n FROM memories'), 6, '行数没变');
  } finally {
    t.cleanup();
  }
});

test('layer-move 搬出守恒：搬出层行数 + 剩下行数 == 搬前总行数，且边表拿到那几行', () => {
  const t = makeTempRoot('k5-move-out-');
  try {
    const { dbPath, cfg } = preparedDb(t.root);
    execSql(dbPath, "UPDATE memories SET layer = 'archival' WHERE id IN (1, 2)");
    const res = moveOut({ dbPath, cfg, layer: 'archival', batch: 'test-batch' });
    assertEq(res.moved, 2, '搬出行数');
    assertEq(res.totalBefore, 6, '搬前总行数');
    assertEq(res.remaining, 4, '剩下行数');
    assertEq(res.evicted, 2, '边表里该层行数');
    assertEq(res.evicted + res.remaining, res.totalBefore, '守恒式必须成立');
    assertEq(countRows(dbPath, 'SELECT COUNT(*) AS n FROM memories'), 4, '主表真的少了 2 行');
    assertEq(countRows(dbPath, `SELECT COUNT(*) AS n FROM ${EVICTED_TABLE} WHERE layer = 'archival'`), 2, '边表正好 2 行');
    assertEq(countRows(dbPath, 'SELECT COUNT(*) AS n FROM memories WHERE layer = \'archival\''), 0, '主表里该层已空');
    // 再跑一次：这层已经空了 ⇒ 0 行，不报错
    const again = moveOut({ dbPath, cfg, layer: 'archival', batch: 'test-batch-2' });
    assertEq(again.moved, 0, '第二次搬出 0 行（幂等）');
  } finally {
    t.cleanup();
  }
});

test('layer-move 搬回后逐行指纹一致（不是只数行数）', () => {
  const t = makeTempRoot('k5-move-roundtrip-');
  try {
    const { dbPath, cfg } = preparedDb(t.root);
    execSql(dbPath, "UPDATE memories SET layer = 'archival' WHERE id IN (1, 3, 5)");
    const dumpFile = path.join(t.root, 'before.json');
    const before = dumpDigests({ dbPath, cfg });
    fs.writeFileSync(dumpFile, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

    moveOut({ dbPath, cfg, layer: 'archival', batch: 'roundtrip' });
    const back = moveBack({ dbPath, cfg, layer: 'archival' });
    assertEq(back.restored, 3, '搬回 3 行');
    assertEq(back.totalAfter, 6, '搬回后主表 6 行');

    const verify = verifyAgainstDump({ dbPath, cfg, dump: JSON.parse(fs.readFileSync(dumpFile, 'utf8')) });
    assertEq(verify.ok, true, `逐行指纹必须一致：缺 ${verify.missing} 多 ${verify.extra} 变 ${verify.changed}`);
    assertEq(verify.checked, 6, '核了 6 行');
    assertEq(countRows(dbPath, `SELECT COUNT(*) AS n FROM ${EVICTED_TABLE}`), 0, '边表已清空');

    // 阴性对照：故意改一行正文，对拍必须红
    execSql(dbPath, "UPDATE memories SET text = text || '（改过）' WHERE id = 5");
    const bad = verifyAgainstDump({ dbPath, cfg, dump: JSON.parse(fs.readFileSync(dumpFile, 'utf8')) });
    assertEq(bad.ok, false, '内容变了 ⇒ 对拍必须红');
    assertEq(bad.changed, [5], '点名到具体 id');
  } finally {
    t.cleanup();
  }
});

test('layer-move 空表保护：会搬空主表时拒跑（rc=1），加 --force 才动', () => {
  const t = makeTempRoot('k5-move-force-');
  try {
    const { dbPath } = preparedDb(t.root);
    const env = isoEnv(t.root);
    const guarded = run(CLI.move, ['--db', dbPath, '--layer', 'recall', '--apply'], env);
    assertEq(guarded.status, 1, '保护性拒跑 ⇒ rc=1');
    includes(guarded.stderr, '--force', '要告诉人怎么过闸');
    assertEq(countRows(dbPath, 'SELECT COUNT(*) AS n FROM memories'), 6, '拒跑时主表完好');

    const forced = run(CLI.move, ['--db', dbPath, '--layer', 'recall', '--apply', '--force'], env);
    assertEq(forced.status, 0, `--force 后应成功\n${forced.stderr}`);
    includes(forced.stdout, '守恒', '要打守恒式');
    assertEq(countRows(dbPath, 'SELECT COUNT(*) AS n FROM memories'), 0, '现在真搬空了');
  } finally {
    t.cleanup();
  }
});

test('layer-move 搬回前核指纹：边表被改过 ⇒ 整批拒动（rc=1），主表不动', () => {
  const t = makeTempRoot('k5-move-tamper-');
  try {
    const { dbPath, cfg } = preparedDb(t.root);
    execSql(dbPath, "UPDATE memories SET layer = 'archival' WHERE id IN (2, 4)");
    moveOut({ dbPath, cfg, layer: 'archival', batch: 'tamper' });
    execSql(dbPath, `UPDATE ${EVICTED_TABLE} SET text = '被改过' WHERE id = 4`, []);

    const env = isoEnv(t.root);
    const r = run(CLI.move, ['--db', dbPath, '--layer', 'archival', '--back', '--apply'], env);
    assertEq(r.status, 1, '指纹不符 ⇒ rc=1');
    includes(r.stderr, '指纹', '要说清是哪条判据拦的');
    assertEq(countRows(dbPath, 'SELECT COUNT(*) AS n FROM memories'), 4, '主表不动（没搬回任何一行）');
    assertEq(countRows(dbPath, `SELECT COUNT(*) AS n FROM ${EVICTED_TABLE}`), 2, '边表也原样');
  } finally {
    t.cleanup();
  }
});

test('layer-move 用法闸：层名不在集合里 / 未知参数 / 库不存在', () => {
  const t = makeTempRoot('k5-move-usage-');
  try {
    const { dbPath } = preparedDb(t.root);
    const env = isoEnv(t.root);
    const badLayer = run(CLI.move, ['--db', dbPath, '--layer', 'nope'], env);
    assertEq(badLayer.status, 2, '层名不在集合里 ⇒ rc=2');
    includes(badLayer.stderr, '层名集合', '要指出集合从哪来');
    assertEq(run(CLI.move, ['--db', dbPath, '--layer', 'recall', '--bogus'], env).status, 2, '未知参数 ⇒ rc=2');
    assertEq(run(CLI.move, ['--db', path.join(t.root, 'nope.db'), '--layer', 'recall'], env).status, 3, '库不存在 ⇒ rc=3');
  } finally {
    t.cleanup();
  }
});

// ───────────────────────────── ③ 号段哨兵 ─────────────────────────────

/** 造一本 id 段受控的夹具库（显式 id）。 */
function bandDb(root, ids) {
  const dbPath = path.join(root, 'memory.db');
  makeMemoryDb(
    dbPath,
    ids.map((id, i) => ({ id, text: `号段夹具 ${id}`, tags: '号段', pinned: 0, created_at: 1_760_000_000 + i, updated_at: 1_760_000_000 + i })),
  );
  return dbPath;
}

test('号段哨兵 单机正常 ⇒ rc=0（不 ssh、只读本机）', () => {
  const t = makeTempRoot('k5-band-ok-');
  try {
    const dbPath = bandDb(t.root, [1, 2, 3, 4, 5, 6]);
    const cfgFile = writeJson(path.join(t.root, 'bands.json'), { self: 'local', width: 1000, bands: [{ host: 'local', base: 1 }] });
    const r = run(CLI.sentinel, ['--db', dbPath, '--config', cfgFile, '--line'], isoEnv(t.root));
    assertEq(r.status, 0, `正常应 rc=0\n${r.stdout}\n${r.stderr}`);
    includes(r.stdout, 'PASS', '结论');
    includes(r.stdout, 'PASS · local seq=6→7', '一行里带 seq 与下一条');
  } finally {
    t.cleanup();
  }
});

test('号段哨兵 越过上界 ⇒ rc=3（阳性对照）；低于下界也 rc=3', () => {
  const t = makeTempRoot('k5-band-over-');
  try {
    const dbPath = bandDb(t.root, [1, 2, 3, 4, 5, 6]);
    const env = isoEnv(t.root);
    const narrow = writeJson(path.join(t.root, 'narrow.json'), { self: 'local', width: 3, bands: [{ host: 'local', base: 1 }] });
    const over = run(CLI.sentinel, ['--db', dbPath, '--config', narrow], env);
    assertEq(over.status, 3, '下一条 id 冲出上界 ⇒ rc=3');
    includes(over.stdout, '冲出本段上界', '要点名是哪条判据');

    const highBase = writeJson(path.join(t.root, 'high.json'), { self: 'local', width: 1000, bands: [{ host: 'local', base: 100 }] });
    const under = run(CLI.sentinel, ['--db', dbPath, '--config', highBase], env);
    assertEq(under.status, 3, '下一条 id 低于下界 ⇒ rc=3');
    includes(under.stdout, '低于本段下界', '要点名是哪条判据');
  } finally {
    t.cleanup();
  }
});

test('号段哨兵 更高位段有行 ⇒ 红；更低位的别台段行 ⇒ 只披露不判红', () => {
  const t = makeTempRoot('k5-band-cross-');
  try {
    const env = isoEnv(t.root);
    // ① 更高位段：self 在 1001 段，peer 在 2001 段 —— peer 段出现行 ⇒ 红
    const higher = bandDb(path.join(t.root), [1001, 1002, 1003, 2005]);
    const cfgHigher = writeJson(path.join(t.root, 'higher.json'), {
      self: 'self', width: 1000, bands: [{ host: 'self', base: 1001 }, { host: 'peer', base: 2001 }],
    });
    const r1 = run(CLI.sentinel, ['--db', higher, '--config', cfgHigher], env);
    assertEq(r1.status, 3, '更高位段有行 ⇒ rc=3');
    includes(r1.stdout, '更高位段', '要说清是哪一段');

    // ② 更低位的别台段：peer 在 1 段（有历史行），self 在 1001 段且 seq 正常 ⇒ 只披露
    const lower = bandDb(path.join(t.root, 'lower'), [1, 2, 6, 1001, 1002, 1003]);
    const cfgLower = writeJson(path.join(t.root, 'lower.json'), {
      self: 'self', width: 1000, bands: [{ host: 'peer', base: 1 }, { host: 'self', base: 1001 }],
    });
    const r2 = run(CLI.sentinel, ['--db', lower, '--config', cfgLower], env);
    assertEq(r2.status, 0, `更低位的别台段只披露，不许判红\n${r2.stdout}`);
    includes(r2.stdout, '不判红', '要明说这条不判');
  } finally {
    t.cleanup();
  }
});

test('号段哨兵 本机库读不到 ⇒ rc=4（真失败），不是 3、也不是 0', () => {
  const t = makeTempRoot('k5-band-missing-');
  try {
    const cfgFile = writeJson(path.join(t.root, 'bands.json'), { self: 'local', width: 1000, bands: [{ host: 'local', base: 1 }] });
    const r = run(CLI.sentinel, ['--db', path.join(t.root, 'nope.db'), '--config', cfgFile, '--line'], isoEnv(t.root));
    assertEq(r.status, 4, '本机库读不到 ⇒ rc=4（fail-closed）');
    includes(r.stderr, 'fail-closed', '要说清这不是通过');
  } finally {
    t.cleanup();
  }
});

test('号段哨兵 多机 + 远端读不到 ⇒ 结论写未探测，退出码**不是 4**', () => {
  const t = makeTempRoot('k5-band-remote-');
  try {
    const dbPath = bandDb(t.root, [1001, 1002, 1003]);
    const cfgFile = writeJson(path.join(t.root, 'bands.json'), {
      self: 'local',
      width: 1000,
      bands: [
        { host: 'local', base: 1001 },
        { host: 'peer', base: 2001, remote: { ssh: 'k5-no-such-host-for-test', node: 'node' } },
      ],
    });
    const env = isoEnv(t.root);
    const r = run(CLI.sentinel, ['--db', dbPath, '--config', cfgFile, '--timeout', '1500'], env);
    assert(r.status !== 4, `远端读不到不许 rc=4（实际 ${r.status}）\n${r.stderr}`);
    assertEq(r.status, 0, '缺省不把"远端未探测"当红');
    includes(`${r.stdout}${r.stderr}`, '未探测', '结论要写未探测 / 不可达');

    const strict = run(CLI.sentinel, ['--db', dbPath, '--config', cfgFile, '--timeout', '1500', '--require-all'], env);
    assertEq(strict.status, 5, '--require-all 时才算失败（rc=5，仍不是 4）');
  } finally {
    t.cleanup();
  }
});

test('号段哨兵 默认关：不落任何文件；--apply --out 才写 JSON，且 stdout 不出 JSON', () => {
  const t = makeTempRoot('k5-band-report-');
  try {
    const dbPath = bandDb(t.root, [1, 2, 3]);
    const cfgFile = writeJson(path.join(t.root, 'bands.json'), { self: 'local', width: 1000, bands: [{ host: 'local', base: 1 }] });
    const outFile = path.join(t.root, 'report.json');
    const env = isoEnv(t.root);

    const plain = run(CLI.sentinel, ['--db', dbPath, '--config', cfgFile], env);
    assertEq(plain.status, 0, `rc 应为 0\n${plain.stderr}`);
    assertEq(fs.existsSync(outFile), false, '缺省模式一个文件都不写');
    assert(!plain.stdout.includes('{"'), 'stdout 不许吐 JSON');

    const applied = run(CLI.sentinel, ['--db', dbPath, '--config', cfgFile, '--apply', '--out', outFile], env);
    assertEq(applied.status, 0, `落盘模式 rc 应为 0\n${applied.stderr}`);
    assert(fs.existsSync(outFile), '--apply --out 才落盘');
    const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assertEq(payload.verdict, 'PASS', '报告里 verdict');
    assertEq(payload.mode, 'single', '报告里模式 = 单机');
    assert(!applied.stdout.includes('"tool":'), 'stdout 不出 JSON（只落文件）');

    const jsonWithoutOut = run(CLI.sentinel, ['--db', dbPath, '--config', cfgFile, '--json'], env);
    assertEq(jsonWithoutOut.status, 2, '--json 不配 --apply --out ⇒ rc=2');
    assertEq(run(CLI.sentinel, ['--db', dbPath, '--config', cfgFile, '--bogus'], env).status, 2, '未知参数 ⇒ rc=2');
  } finally {
    t.cleanup();
  }
});

test('号段哨兵：三个 CLi 的 --help 都通，且写清两种模式与退出码', () => {
  const env = isoEnv(os.tmpdir());
  for (const [name, script] of Object.entries(CLI)) {
    const r = run(script, ['--help'], env);
    assertEq(r.status, 0, `${name} --help 应 rc=0`);
    includes(r.stdout, '退出码', `${name} --help 要写退出码`);
  }
  const sentinelHelp = run(CLI.sentinel, ['--help'], env).stdout;
  includes(sentinelHelp, '单机', '要写单机模式');
  includes(sentinelHelp, '多机', '要多机模式');
  const moveHelp = run(CLI.move, ['--help'], env).stdout;
  includes(moveHelp, '不删', '要写清搬走不等于删');
});

// ───────────────────────────── ④ 夹具库自洽 ─────────────────────────────

test('行指纹算法：同内容同指纹、改一个字段就变（它是"逐行一致"的唯一判据）', () => {
  const cfg = loadLayerConfig({ file: null, env: {} });
  const row = { id: 7, text: '正文', tags: 'a b', pinned: 0, created_at: 1, updated_at: 2, layer: 'recall' };
  const d1 = rowDigest(row, cfg);
  const d2 = rowDigest({ ...row }, cfg);
  assertEq(d1, d2, '同内容 ⇒ 同指纹');
  assert(rowDigest({ ...row, text: '正文改' }, cfg) !== d1, '改正文 ⇒ 指纹变');
  assert(rowDigest({ ...row, layer: 'archival' }, cfg) !== d1, '改层 ⇒ 指纹变');
  const cmp = compareDigests(new Map([[1, 'a'], [2, 'b']]), new Map([[2, 'c'], [3, 'd']]));
  assertEq(cmp.missing, [1], '缺行');
  assertEq(cmp.changed, [2], '变行');
  assertEq(cmp.extra, [3], '多行');
});
