#!/usr/bin/env node
// 提炼产物回滚 CLI：把 `distilled…` 标签的条目按组 / 按 id 删掉，删之前先留快照 + 一键恢复脚本。
//
// 用法：
//   node cli/distill-rollback.mjs --db <memory.db>                 # 缺省 dry-run：只列会被删的条
//   node cli/distill-rollback.mjs --db <memory.db> --apply         # 真删（先 VACUUM INTO 快照 + 生成恢复脚本）
//   node cli/distill-rollback.mjs --db <memory.db> --key <srcKey>  # 只回滚某一组
//   node cli/distill-rollback.mjs --db <memory.db> --id 1001 --apply
//   node cli/distill-rollback.mjs --db <memory.db> --digest        # 只算内容摘要（演练对照用）
//
// 回滚面 = `tags LIKE 'distilled%'` —— 这个前缀就是提炼产物的唯一性标记。
// 退出码：0 = 正常 / 1 = 失败 / 2 = 用法错 / 3 = 环境不可用
import fs from 'node:fs';
import path from 'node:path';
import { isMainEntry, parseArgs, makeLogger, num } from '../lib/cli-util.mjs';
import { listDistilled, rollbackDistilled, contentDigest, fileSha256 } from '../lib/distill-rollback.mjs';

const USAGE = [
  'node cli/distill-rollback.mjs',
  '--db <memory.db>',
  '[--apply]',
  '[--key <srcKey>]...',
  '[--id <id>]...',
  '[--snapshot-dir <dir>]',
  '[--limit N]',
  '[--digest [--real-only]]',
  '[--show N]',
  '[--json]',
  '[--help]',
].join(' ');

const DISTILLED_LIKE = 'distilled%';
const DEFAULT_SHOW = 50;

/** 逗号分隔的多值开关 → 干净数组（空串与首尾空白都丢掉）。 */
function splitList(raw) {
  if (raw === undefined) return [];
  return String(raw)
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean);
}

function emit(json, payload, human, log) {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else if (human) log(human);
}

/** 只算摘要：`--real-only` 排除派生条，判据才是「真实条一个字节没动」。 */
function runDigest({ dbPath, json, log, realOnly }) {
  const d = contentDigest(dbPath, { excludeTagsLike: realOnly ? DISTILLED_LIKE : null });
  const sha = fileSha256(dbPath);
  const payload = { db: dbPath, realOnly: Boolean(realOnly), ...d, fileSha256: sha };
  const scope = realOnly ? '真实条' : '整表';
  emit(json, payload, `${scope}内容摘要：条数 ${d.count} · digest ${d.digest} · 全表条数 ${d.allCount} · 文件 sha ${sha}`, log);
  return 0;
}

/** 把当前状态 + 命中清单讲清楚（人看的四行）。 */
function describeSelection({ dbPath, apply, before, items, keys, ids, log }) {
  log(`库      : ${dbPath}`);
  log(`模式    : ${apply ? 'APPLY（真删）' : 'DRY-RUN（只列不删）'}`);
  log(`库现状  : 全表 ${before.allCount} 条（其中提炼条 ${before.allCount - before.count} 条）· 内容摘要 ${before.digest}`);
  log(`命中筛选: ${items.length} 条（--key ${keys.length ? keys.join(',') : '-'} / --id ${ids.length ? ids.join(',') : '-'}）`);
}

/** 真删：先快照、再删、再把删除前后摘要摆一起。 */
function runApply({ dbPath, keys, ids, snapshotDir, before, json, log }) {
  const r = rollbackDistilled({
    dbPath,
    apply: true,
    keys: keys.length ? keys : null,
    ids: ids.length ? ids : null,
    snapshotDir,
  });
  log(`已删除  : ${r.deleted} 条（id ${r.deletedIds.join(',')}）`);
  log(`删除前快照: ${r.snapshot}${r.snapshotSha256 ? ` · sha ${r.snapshotSha256}` : ''}`);
  log(`一键恢复: ${r.rollbackFile}`);
  const same = r.after.digest === before.digest;
  log(`回滚后  : 全表 ${r.after.allCount} 条 · 内容摘要 ${r.after.digest}${same ? ' ✅ 与删除前一致' : ' ⚠️ 与删除前不一致'}`);
  for (const warn of r.warnings ?? []) log(`⚠️ ${warn}`);
  emit(json, { ok: true, ...r, fileSha256: fileSha256(dbPath) }, null, log);
  return 0;
}

async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = makeLogger({ json, quiet: Boolean(flags.quiet) });
  if (flags.help) {
    process.stdout.write(`用法：${USAGE}\n`);
    return 0;
  }

  const dbPath = flags.db ? path.resolve(String(flags.db)) : null;
  if (!dbPath) {
    process.stderr.write('用法错：必须给 --db <库路径>\n');
    return 2;
  }
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`环境不可用：库不存在 ${dbPath}\n`);
    return 3;
  }

  if (flags.digest) return runDigest({ dbPath, json, log, realOnly: Boolean(flags['real-only']) });

  const keys = splitList(flags.key);
  const ids = splitList(flags.id).map((x) => Number(x)).filter((x) => Number.isFinite(x));
  const apply = Boolean(flags.apply);
  const before = contentDigest(dbPath);
  const items = listDistilled({
    dbPath,
    keys: keys.length ? keys : null,
    ids: ids.length ? ids : null,
    limit: num(flags.limit, 0),
  });

  describeSelection({ dbPath, apply, before, items, keys, ids, log });
  const show = Number(flags.show ?? DEFAULT_SHOW);
  for (const it of items.slice(0, show)) log(`  #${it.id} src=${it.srcKey} date=${it.date} ${it.chars} 字 · ${it.head.slice(0, 70)}`);

  if (!items.length) {
    emit(json, { ok: true, matched: 0, deleted: 0, before }, null, log);
    return 0;
  }
  if (!apply) {
    log('（dry-run：未删除任何东西；加 --apply 才真删，删除前会自动 VACUUM INTO 快照）');
    emit(json, { ok: true, dryRun: true, matched: items.length, ids: items.map((x) => x.id), before }, null, log);
    return 0;
  }

  return runApply({
    dbPath,
    keys,
    ids,
    snapshotDir: flags['snapshot-dir'] ? path.resolve(String(flags['snapshot-dir'])) : null,
    before,
    json,
    log,
  });
}

if (isMainEntry(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`未捕获异常：${e?.stack ?? e}`);
      process.exitCode = 1;
    });
}

export { main };
