// 给记忆库加 `layer` 字段的入口。默认 dry-run；动 schema 必须先备份。
//
//   node memory-engine/cli/layer-migrate.mjs                                  # 干跑：只说会做什么
//   node memory-engine/cli/layer-migrate.mjs --db <库> --apply --backup <备份路径>
//   node memory-engine/cli/layer-migrate.mjs --db <库> --restore <备份路径>    # 干跑还原
//   node memory-engine/cli/layer-migrate.mjs --db <库> --restore <备份路径> --apply
//   node memory-engine/cli/layer-migrate.mjs --help
//
// 退出码：0 正常 · 1 迁移/复核失败 · 2 用法错 · 3 库不可读
import fs from 'node:fs';
import path from 'node:path';
import { parseCli, rejectBadArgs, usageError, settle, emitJsonReport, EXIT } from '../lib/cli-strict.mjs';
import { isMainEntry } from '../lib/cli-util.mjs';
import { loadLayerConfig, defaultMemoryDbPath, describeConfig, splitNames } from '../lib/layers.mjs';
import { buildPlan, applyMigration, restoreDatabase } from '../lib/layer-migrate.mjs';

const HELP = `layer-migrate —— 给记忆库加「层」字段（默认干跑；动 schema 前必先备份）

用法：
  node memory-engine/cli/layer-migrate.mjs [--db <库>]                       干跑：只说会做什么
  node memory-engine/cli/layer-migrate.mjs --db <库> --apply --backup <文件>  真加列 + 回填
  node memory-engine/cli/layer-migrate.mjs --db <库> --restore <备份>         干跑还原
  node memory-engine/cli/layer-migrate.mjs --db <库> --restore <备份> --apply  真还原
  node memory-engine/cli/layer-migrate.mjs --help

开关：
  --db <path>            目标记忆库（干跑缺省 = 引擎配置里的 memory.db；--apply 必须显式给）
  --apply                真写（缺省 dry-run，一个字节都不动）
  --dry-run              显式声明干跑（缺省就是它；与 --apply 互斥）
  --backup <path>        --apply 必填：动库前先把库文件备份到这里（已存在则拒写，不覆盖旧备份）
  --restore <path>       从备份还原（默认干跑；配 --apply 才替换库文件）
  --column <name>        层列名（缺省取配置，内置 layer）
  --layers <a,b,c>       层名集合（缺省取配置，内置 core,recall,archival）
  --default-layer <name> 存量行回填到哪一层（缺省取配置，内置 recall；必须在层名集合里）
  --config <file>        换一份层配置（缺省 memory-engine/config/layers.json）
  --json                 机器可读摘要（**只落文件**，必须配 --out）
  --out <file>           --json 的落点
  --quiet                少说两句
  --help

语义：
  · 只加列 + 回填，**一行不删**：行数 / sqlite_sequence / integrity_check 三项改完复核；
  · 幂等：列已在、空值已清零 ⇒ 第二次 --apply 一个字节都不写；
  · 跨盘安全：备份走「写新文件 + sha 校验」，还原走「同目录临时文件 + rename」，不用跨盘 rename。

退出码：0 正常 · 1 迁移或复核失败 · 2 用法错 · 3 库不可读
`;

const SPEC = {
  db: 'string',
  apply: 'bool',
  'dry-run': 'bool',
  backup: 'string',
  restore: 'string',
  column: 'string',
  layers: 'string',
  'default-layer': 'string',
  config: 'string',
  json: 'bool',
  out: 'string',
  quiet: 'bool',
};

function printPlan(plan, cfg) {
  const say = (line) => process.stdout.write(`${line}\n`);
  say(`库：${plan.dbPath}${plan.info.exists ? `（${plan.info.bytes} B · ${plan.info.rowCount} 行）` : ''}`);
  say(`层配置：${describeConfig(cfg)}`);
  if (plan.blockers.length) {
    for (const b of plan.blockers) say(`  ❌ ${b}`);
    return;
  }
  say(`列 ${cfg.column}：${plan.hasColumn ? '已在' : '不在 ⇒ 将新增（NOT NULL DEFAULT ' + cfg.defaultLayer + '）'}`);
  say(`待回填（层为空）行数：${plan.emptyLayerRows}`);
  if (plan.hasColumn && Object.keys(plan.histogram).length) {
    const hist = Object.entries(plan.histogram).map(([k, v]) => `${k}=${v}`).join(' · ');
    say(`当前层分布：${hist}`);
  }
  if (Object.keys(plan.outOfSet).length) {
    say(`⚠️ 有行落在层名集合之外（不改它们，只报告）：${Object.entries(plan.outOfSet).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  }
  say(`整库完整性：${plan.integrity ?? '(无)'} · seq=${plan.seq}`);
  say(
    plan.needsAlter || plan.needsBackfill
      ? `计划：${plan.needsAlter ? '加列' : ''}${plan.needsAlter && plan.needsBackfill ? ' + ' : ''}${plan.needsBackfill ? `回填 ${plan.emptyLayerRows} 行到「${cfg.defaultLayer}」` : ''}（dry-run：未写任何东西）`
      : '计划：无事可做（列已在、没有空层行）⇒ 再跑 --apply 也不会写',
  );
}

function printRestore(plan) {
  const say = (line) => process.stdout.write(`${line}\n`);
  say(`备份：${plan.backup.path}（${plan.backup.bytes} B · ${plan.backup.rows} 行 · sha ${String(plan.backup.sha256).slice(0, 16)}）`);
  say(`目标：${plan.target.path}${plan.target.missing ? '（不存在，将新建）' : `（${plan.target.bytes} B · ${plan.target.rows} 行 · sha ${String(plan.target.sha256).slice(0, 16)}）`}`);
  if (plan.sidecars.length) say(`⚠️ 目标旁有 ${plan.sidecars.join(' ')} —— 还原时会先摘掉（陈旧 WAL 配新库文件 = 直接损坏）`);
  say(plan.applied ? `✅ 已还原（sha ${String(plan.verify.sha256).slice(0, 16)} · ${plan.verify.rows} 行 · integrity ${plan.verify.integrity}）` : 'dry-run：未替换任何文件（加 --apply 才写）');
}

function main() {
  const parsed = parseCli(process.argv.slice(2), SPEC);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  const bad = rejectBadArgs(parsed);
  if (bad.length) return usageError([...bad, '（--help 看用法）']);

  const f = parsed.flags;
  if (f.apply && f['dry-run']) return usageError('--apply 与 --dry-run 不能同时给（缺省就是 dry-run）');
  const json = Boolean(f.json);
  const quiet = Boolean(f.quiet);
  const say = (line) => {
    if (!quiet) process.stdout.write(`${line}\n`);
  };

  let cfg;
  try {
    cfg = loadLayerConfig({ file: f.config || null, layers: f.layers || null, defaultLayer: f['default-layer'] || null, column: f.column || null });
  } catch (e) {
    return usageError(`层配置不成立：${e.message}`);
  }
  for (const w of cfg.warnings) say(`⚠️ ${w}`);

  const dbPath = f.db ? path.resolve(f.db) : defaultMemoryDbPath();
  // 先把手滑闸摆好：真写必须点名库、且（迁移时）必须带备份
  if (f.apply && !f.db) return usageError('--apply 必须显式给 --db <库>：不许靠缺省路径改到家目录那本库');
  if (f.apply && !f.restore && !f.backup) return usageError('--apply 必须先备份：加 --backup <文件>（拒绝无备份写入）');
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`❌ 库不可读：${dbPath} 不存在\n`);
    process.exitCode = EXIT.UNREADABLE;
    return;
  }

  // ── 还原分支
  if (f.restore) {
    if (!fs.existsSync(f.restore)) {
      process.stderr.write(`❌ 备份不存在：${path.resolve(f.restore)}\n`);
      process.exitCode = EXIT.UNREADABLE;
      return;
    }
    const plan = restoreDatabase({ backupPath: f.restore, dbPath, apply: Boolean(f.apply) });
    if (!quiet) printRestore(plan);
    emitJsonReport({ json, out: f.out, payload: { tool: 'layer-migrate', mode: 'restore', db: dbPath, ...plan } });
    process.exitCode = EXIT.OK;
    return;
  }

  // ── 迁移分支
  const plan = buildPlan(dbPath, cfg);
  if (plan.blockers.length) {
    for (const b of plan.blockers) process.stderr.write(`❌ ${b}\n`);
    process.exitCode = EXIT.UNREADABLE;
    return;
  }
  if (!quiet) printPlan(plan, cfg);
  if (!f.apply) {
    emitJsonReport({ json, out: f.out, payload: { tool: 'layer-migrate', mode: 'dry-run', db: dbPath, cfg: { column: cfg.column, layers: cfg.layers, defaultLayer: cfg.defaultLayer }, plan: { ...plan, info: undefined } } });
    process.exitCode = EXIT.OK;
    return;
  }

  const result = applyMigration({ dbPath, cfg, backupPath: f.backup });
  if (!quiet) {
    if (!result.changed) say('✅ 无事可做（幂等：列已在、没有空层行）—— 一个字节都没写');
    else {
      say(`✅ 已加列/回填：动 ${result.touched} 行 · 备份 ${result.backup.method} → ${result.backup.path}（${result.backup.bytes} B · sha ${result.backup.sha256.slice(0, 16)}）`);
      say(`   复核：行数不变 ${result.verify.rowCountSame} · seq 不变 ${result.verify.seqSame} · 完整性 ${result.verify.integrity} · 空层行 ${result.verify.emptyAfter}`);
    }
  }
  emitJsonReport({ json, out: f.out, payload: { tool: 'layer-migrate', mode: 'apply', db: dbPath, changed: result.changed, touched: result.touched ?? 0, backup: result.backup, verify: result.verify } });
  process.exitCode = EXIT.OK;
}

try {
  if (isMainEntry(import.meta.url)) main();
} catch (e) {
  settle(e, { prefix: '[layer-migrate]' });
}
