// 软淘汰执行器入口：把一整层搬进本库的边表（不删），一条命令出去、一条命令回来。
//
//   node memory-engine/cli/layer-move.mjs --db <库> --layer archival                 干跑：说会搬几行
//   node memory-engine/cli/layer-move.mjs --db <库> --layer archival --apply          真搬（主表 → 边表）
//   node memory-engine/cli/layer-move.mjs --db <库> --layer archival --back --apply   搬回（边表 → 主表）
//   node memory-engine/cli/layer-move.mjs --db <库> --dump <before.json>              搬前留一份逐行指纹
//   node memory-engine/cli/layer-move.mjs --db <库> --verify <before.json>            搬回后逐行对拍
//
// 退出码：0 正常 · 1 校验失败 / 保护性拒跑 · 2 用法错 · 3 库不可读
import fs from 'node:fs';
import path from 'node:path';
import { parseCli, rejectBadArgs, usageError, settle, emitJsonReport, EXIT } from '../lib/cli-strict.mjs';
import { isMainEntry } from '../lib/cli-util.mjs';
import { loadLayerConfig, defaultMemoryDbPath, canonicalLayerName, describeConfig } from '../lib/layers.mjs';
import {
  planMove, moveOut, moveBack, dumpDigests, verifyAgainstDump, writeDump, readDump, EVICTED_TABLE,
} from '../lib/layer-move.mjs';

const HELP = `layer-move —— 软淘汰：整层搬走（不删），一条命令出去、一条命令回来

用法：
  node memory-engine/cli/layer-move.mjs --db <库> --layer <层>                  干跑：说会搬几行（零写）
  node memory-engine/cli/layer-move.mjs --db <库> --layer <层> --apply          搬出：主表 → ${EVICTED_TABLE}
  node memory-engine/cli/layer-move.mjs --db <库> --layer <层> --back --apply   搬回：${EVICTED_TABLE} → 主表
  node memory-engine/cli/layer-move.mjs --db <库> --dump <file>                 导出逐行指纹（搬前凭据）
  node memory-engine/cli/layer-move.mjs --db <库> --verify <file>               拿指纹件对拍当前主表
  node memory-engine/cli/layer-move.mjs --help

开关：
  --db <path>        目标记忆库（--apply 必须显式给；干跑缺省 = 引擎配置里的 memory.db）
  --layer <name>     要搬出/搬回的层（必须在层名集合里）
  --apply            真写（缺省 dry-run：一个字节都不动）
  --dry-run          显式声明干跑（缺省就是它；与 --apply 互斥）
  --back             反向：把这一层从边表搬回主表
  --force            搬走会清空主表时才需要的显式确认（防层名写错）
  --dump <file>      把当前主表（或 --layer 限定的那层）的逐行指纹写成 JSON
  --verify <file>    拿 --dump 的产物对拍：缺行 / 多行 / 内容变了 三类分开报
  --batch <name>     批次名（缺省 evict-<时间戳>），落在边表的 batch 列
  --column <name>    层列名（缺省取配置）
  --layers <a,b,c>   层名集合（缺省取配置）
  --config <file>    换一份层配置
  --json             机器可读摘要（**只落文件**，必须配 --out）
  --out <file>       --json 的落点
  --quiet            少说两句
  --help

语义（别把它当删除）：
  · 搬走的行原样躺在 ${EVICTED_TABLE} 里，带 content_sha 指纹；搬回时先核指纹再写回。
  · 硬判据：搬出层行数 + 剩下行数 == 搬前总行数（事务内断言，不成立整批回滚）。
  · 软淘汰省的是上下文与召回面，不是磁盘：搬走的行仍占库体积，边表也没有 FTS 索引。

退出码：0 正常 · 1 校验失败或保护性拒跑 · 2 用法错 · 3 库不可读
`;

const SPEC = {
  db: 'string',
  layer: 'string',
  apply: 'bool',
  'dry-run': 'bool',
  back: 'bool',
  force: 'bool',
  dump: 'string',
  verify: 'string',
  batch: 'string',
  column: 'string',
  layers: 'string',
  config: 'string',
  json: 'bool',
  out: 'string',
  quiet: 'bool',
};

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

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
  const say = (line) => {
    if (!f.quiet) process.stdout.write(`${line}\n`);
  };
  const modes = ['dump', 'verify', 'back'].filter((k) => f[k]);
  if (modes.length > 1) return usageError(`一次只能干一件事：${modes.map((m) => `--${m}`).join(' / ')} 互斥`);

  let cfg;
  try {
    cfg = loadLayerConfig({ file: f.config || null, layers: f.layers || null, column: f.column || null });
  } catch (e) {
    return usageError(`层配置不成立：${e.message}`);
  }
  for (const w of cfg.warnings) say(`⚠️ ${w}`);

  const dbPath = f.db ? path.resolve(f.db) : defaultMemoryDbPath();
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`❌ 库不可读：${dbPath} 不存在\n`);
    process.exitCode = EXIT.UNREADABLE;
    return;
  }

  // ── 导出指纹
  if (f.dump) {
    const dump = dumpDigests({ dbPath, cfg, layer: f.layer ? canonicalLayerName(cfg, f.layer) : null });
    const out = writeDump(f.dump, dump);
    say(`✅ 指纹已导出：${out}（${dump.count} 行 · 层=${dump.layer ?? '(全表)'}）`);
    emitJsonReport({ json: f.json, out: f.out, payload: { tool: 'layer-move', mode: 'dump', db: dbPath, layer: dump.layer, count: dump.count, file: out } });
    process.exitCode = EXIT.OK;
    return;
  }

  // ── 对拍指纹
  if (f.verify) {
    const dump = readDump(f.verify);
    const res = verifyAgainstDump({ dbPath, cfg, dump });
    say(`指纹对拍：核 ${res.checked} 行 · 当前 ${res.currentCount} 行`);
    if (res.ok) {
      say('✅ 逐行一致（缺 0 / 多 0 / 变 0）');
    } else {
      say(`❌ 不一致：缺 [${res.missing.join(',')}] 多 [${res.extra.join(',')}] 变 [${res.changed.join(',')}]`);
    }
    emitJsonReport({ json: f.json, out: f.out, payload: { tool: 'layer-move', mode: 'verify', db: dbPath, ...res } });
    process.exitCode = res.ok ? EXIT.OK : EXIT.FAIL;
    return;
  }

  if (!f.layer) return usageError('缺 --layer <层>：要搬哪一层（--help 看层名集合从哪来）');
  const layer = canonicalLayerName(cfg, f.layer);
  if (!layer) return usageError(`「${f.layer}」不在层名集合 [${cfg.layers.join(', ')}] 里（--layers 可改，或改配置）`);

  // ── 搬回
  if (f.back) {
    if (!f.apply) {
      const plan = planMove({ dbPath, cfg, layer });
      say(`干跑（搬回）：层「${layer}」在边表里有 ${plan.evictedRows} 行 · 主表 ${plan.totalRows} 行`);
      say('dry-run：未写任何东西（加 --apply 才搬）');
      emitJsonReport({ json: f.json, out: f.out, payload: { tool: 'layer-move', mode: 'back-dry-run', db: dbPath, layer, evicted: plan.evictedRows, total: plan.totalRows } });
      process.exitCode = EXIT.OK;
      return;
    }
    const res = moveBack({ dbPath, cfg, layer });
    say(`✅ 搬回 ${res.restored} 行（主表 ${res.totalBefore} → ${res.totalAfter}）${res.reason ? ` · ${res.reason}` : ''}`);
    if (res.seqBefore !== undefined && res.seqAfter !== res.seqBefore) say(`⚠️ sqlite_sequence 变了：${res.seqBefore} → ${res.seqAfter}`);
    emitJsonReport({ json: f.json, out: f.out, payload: { tool: 'layer-move', mode: 'back', db: dbPath, layer, ...res } });
    process.exitCode = EXIT.OK;
    return;
  }

  // ── 搬出
  const plan = planMove({ dbPath, cfg, layer });
  if (plan.blockers.length) {
    for (const b of plan.blockers) process.stderr.write(`❌ ${b}\n`);
    process.exitCode = EXIT.UNREADABLE;
    return;
  }
  say(`层配置：${describeConfig(cfg)}`);
  say(`主表 ${plan.totalRows} 行 · 层「${layer}」${plan.layerRows} 行 · 边表已有该层 ${plan.evictedRows} 行`);
  if (plan.leavesEmpty) say(`⚠️ 这一搬会把主表搬空（${plan.layerRows}/${plan.totalRows}）—— 真要这么干得加 --force`);
  if (!f.apply) {
    say('dry-run：未写任何东西（加 --apply 才搬）');
    emitJsonReport({ json: f.json, out: f.out, payload: { tool: 'layer-move', mode: 'move-dry-run', db: dbPath, layer, plan } });
    process.exitCode = EXIT.OK;
    return;
  }
  if (!f.db) return usageError('--apply 必须显式给 --db <库>：不许靠缺省路径改到家目录那本库');
  const batch = f.batch || `evict-${stamp()}`;
  const res = moveOut({ dbPath, cfg, layer, batch, force: Boolean(f.force) });
  say(`✅ 搬出 ${res.moved} 行 → ${EVICTED_TABLE}（批次 ${res.batch}）`);
  say(`   守恒：搬出 ${res.evicted} + 剩下 ${res.remaining} = 搬前 ${res.totalBefore} ${res.evicted + res.remaining === res.totalBefore ? '✅' : '❌'}`);
  if (res.moved === 0) say('   （这一层本来就是空的 —— 没搬任何行）');
  if (res.seqBefore !== undefined && res.seqAfter !== res.seqBefore) say(`⚠️ sqlite_sequence 变了：${res.seqBefore} → ${res.seqAfter}`);
  emitJsonReport({ json: f.json, out: f.out, payload: { tool: 'layer-move', mode: 'move', db: dbPath, layer, ...res } });
  process.exitCode = EXIT.OK;
}

try {
  if (isMainEntry(import.meta.url)) main();
} catch (e) {
  settle(e, { prefix: '[layer-move]' });
}
