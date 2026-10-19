#!/usr/bin/env node
// 记忆引擎 v2 · S3c —— 提炼产物回滚 CLI（`cli/distill-rollback.mjs`）
//
// 用法：
//   node cli/distill-rollback.mjs --db <memory.db>                 # **默认 dry-run**：只列出会被删的条
//   node cli/distill-rollback.mjs --db <memory.db> --apply         # 真删（先 VACUUM INTO 快照 + 生成一键恢复脚本）
//   node cli/distill-rollback.mjs --db <memory.db> --key <srcKey>  # 只回滚某一组
//   node cli/distill-rollback.mjs --db <memory.db> --id 1001 --apply
//   node cli/distill-rollback.mjs --db <memory.db> --digest        # 只算内容摘要（演练对照用）
//
// 判据：`tags LIKE 'distilled%'`（回滚面就是这个前缀——提炼产物唯一性标记）
// 退出码：0 = 正常 / 1 = 失败 / 2 = 用法错 / 3 = 环境不可用
import fs from 'node:fs';
import path from 'node:path';
import { isMainEntry, parseArgs, makeLogger, num } from '../lib/cli-util.mjs';
import { listDistilled, rollbackDistilled, contentDigest, fileSha256 } from '../lib/distill-rollback.mjs';

const USAGE = 'node cli/distill-rollback.mjs --db <memory.db> [--apply] [--key <srcKey>]... [--id <id>]... '
  + '[--snapshot-dir <dir>] [--limit N] [--digest [--real-only]] [--show N] [--json] [--help]';

async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = makeLogger({ json, quiet: Boolean(flags.quiet) });
  if (flags.help) { process.stdout.write(`用法：${USAGE}\n`); return 0; }

  const dbPath = flags.db ? path.resolve(String(flags.db)) : null;
  if (!dbPath) { process.stderr.write('用法错：必须给 --db <库路径>\n'); return 2; }
  if (!fs.existsSync(dbPath)) { process.stderr.write(`环境不可用：库不存在 ${dbPath}\n`); return 3; }

  const collect = (v) => (v === undefined ? [] : String(v).split(',').map((x) => x.trim()).filter(Boolean));
  const keys = collect(flags.key);
  const ids = collect(flags.id).map((x) => Number(x)).filter((x) => Number.isFinite(x));

  if (flags.digest) {
    // `--real-only`：只算**真实（非派生）条**的内容摘要 —— 演练判据要的是「回滚后真实条一个字节没变」
    //   （整表摘要会把被删掉的提炼条也算进去 ⇒ 对比必然"不一致"，那是判据写错、不是回滚失败）
    const exclude = flags['real-only'] ? 'distilled%' : null;
    const d = contentDigest(dbPath, { excludeTagsLike: exclude });
    const out = { db: dbPath, realOnly: Boolean(exclude), ...d, fileSha256: fileSha256(dbPath) };
    if (json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else log(`${exclude ? '真实条' : '整表'}内容摘要：条数 ${d.count} · digest ${d.digest} · 全表条数 ${d.allCount} · 文件 sha ${out.fileSha256}`);
    return 0;
  }

  const apply = Boolean(flags.apply);
  const before = contentDigest(dbPath);
  const items = listDistilled({ dbPath, keys: keys.length ? keys : null, ids: ids.length ? ids : null, limit: num(flags.limit, 0) });

  log(`库      : ${dbPath}`);
  log(`模式    : ${apply ? 'APPLY（真删）' : 'DRY-RUN（只列不删）'}`);
  log(`库现状  : 全表 ${before.allCount} 条（其中提炼条 ${before.allCount - before.count} 条）· 内容摘要 ${before.digest}`);
  log(`命中筛选: ${items.length} 条（--key ${keys.length ? keys.join(',') : '-'} / --id ${ids.length ? ids.join(',') : '-'}）`);
  for (const it of items.slice(0, Number(flags.show ?? 50))) log(`  #${it.id} src=${it.srcKey} date=${it.date} ${it.chars} 字 · ${it.head.slice(0, 70)}`);

  if (!items.length) {
    if (json) process.stdout.write(JSON.stringify({ ok: true, matched: 0, deleted: 0, before }, null, 2) + '\n');
    return 0;
  }
  if (!apply) {
    log('（dry-run：未删除任何东西；加 --apply 才真删，删除前会自动 VACUUM INTO 快照）');
    if (json) process.stdout.write(JSON.stringify({ ok: true, dryRun: true, matched: items.length, ids: items.map((x) => x.id), before }, null, 2) + '\n');
    return 0;
  }

  const r = rollbackDistilled({
    dbPath, apply: true, keys: keys.length ? keys : null, ids: ids.length ? ids : null,
    snapshotDir: flags['snapshot-dir'] ? path.resolve(String(flags['snapshot-dir'])) : null,
  });
  log(`已删除  : ${r.deleted} 条（id ${r.deletedIds.join(',')}）`);
  log(`删除前快照: ${r.snapshot}${r.snapshotSha256 ? ` · sha ${r.snapshotSha256}` : ''}`);
  log(`一键恢复: ${r.rollbackFile}`);
  log(`回滚后  : 全表 ${r.after.allCount} 条 · 内容摘要 ${r.after.digest}${r.after.digest === before.digest ? ' ✅ 与删除前一致' : ' ⚠️ 与删除前不一致'}`);
  for (const w of r.warnings ?? []) log(`⚠️ ${w}`);
  if (json) process.stdout.write(JSON.stringify({ ok: true, ...r, fileSha256: fileSha256(dbPath) }, null, 2) + '\n');
  return 0;
}

if (isMainEntry(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`未捕获异常：${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
}

export { main };
