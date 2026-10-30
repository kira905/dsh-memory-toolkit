// 号段哨兵入口：一条命令看「下一条新 id 会不会落到别人的号段里」。
//
//   node memory-engine/cli/band-sentinel.mjs                    # 单机缺省：只读本机库，只打印
//   node memory-engine/cli/band-sentinel.mjs --line              # 只打一行
//   node memory-engine/cli/band-sentinel.mjs --apply --out r.json # 落盘报告（JSON）
//
// 退出码：0 正常（含"远端未探测"，只看本机）/ 2 用法或配置错 / 3 号段异常 / 4 本机库读不到 / 5 加了 --require-all 且有段未探测
import fs from 'node:fs';
import path from 'node:path';
import { parseCli, rejectBadArgs, usageError, settle, writeTextFile } from '../lib/cli-strict.mjs';
import { isMainEntry } from '../lib/cli-util.mjs';
import { defaultMemoryDbPath } from '../lib/layers.mjs';
import { loadBandConfig, evaluate, formatHuman, formatLine, EXIT as SENTINEL_EXIT } from '../lib/band-sentinel.mjs';

const HELP = `band-sentinel —— 记忆 id 号段哨兵（纯只读；缺省单机退化）

用法：
  node memory-engine/cli/band-sentinel.mjs                       单机缺省：只读本机库、只打印
  node memory-engine/cli/band-sentinel.mjs --line                只打一行（日报正文用）
  node memory-engine/cli/band-sentinel.mjs --only <host[,host]>  只看某几段
  node memory-engine/cli/band-sentinel.mjs --apply --out <file>  把结论落盘成 JSON 报告

开关：
  --db <path>             本机记忆库（缺省 = 引擎配置里的 memory.db）
  --config <file>         号段配置（缺省 memory-engine/config/bands.json）
  --only <host[,host]>    只跑这几段
  --band <host>=<base>    临时改某段的基值（可重复；验收用：故意传错看它会不会点名）
  --timeout <ms>          单段远端超时（缺省 20000）
  --require-all           有段未探测 / 不可达也判失败（rc=5）—— 接定时/自检时用
  --apply                 允许把报告落盘（缺省只读 + 只打印，一个文件都不写）
  --out <file>            --apply 的落盘路径
  --json                  报告用 JSON（**只落文件**，必须与 --apply --out 同用）
  --line                  只打一行
  --quiet                 不出人话
  --help

两种模式（怎么退化）：
  · 单机（缺省）：配置里只有一条 band ⇒ 只读本机库的 sqlite_sequence，
    判「下一条新 id」是否落在 [base, base+width)；**不 ssh、不假装知道别的机器**。
  · 多机（可选）：配置里有多条 band 且非本机条目给了 remote（ssh 别名 + 远端 node 路径）时才去读。
    任一远端读不到 ⇒ 结论写「未探测 / 不可达」，**退出码不会是 4**（4 只留给本机库读不到）。

判据：
  · 下一条新 id 越出本段（低于下界 / 冲出上界）⇒ 红；
  · 出现更高位段的行 ⇒ 红；出现更低位的别台段行 ⇒ **只披露不判红**（删行=删记忆，且不影响后续新 id）；
  · 本机库读不到 ⇒ rc=4（fail-closed，不算通过）。

退出码：0 正常 · 2 用法/配置错 · 3 号段异常 · 4 本机库读不到 · 5 --require-all 且有段未探测
`;

const SPEC = {
  db: 'string',
  config: 'string',
  only: 'string',
  band: 'string',
  timeout: 'number',
  'require-all': 'bool',
  apply: 'bool',
  out: 'string',
  json: 'bool',
  line: 'bool',
  quiet: 'bool',
};

/** 可重复开关：`--band a=1 --band b=2` 与 `--band=a=1` 都收。 */
function collectPairs(argv, name) {
  const out = [];
  const eqForm = `${name}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === name) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) out.push(next);
      continue;
    }
    if (token.startsWith(eqForm)) out.push(token.slice(eqForm.length));
  }
  return out;
}

function parseOverrides(list) {
  const out = {};
  for (const item of list) {
    const at = item.indexOf('=');
    if (at <= 0) throw new Error(`--band 的形状是 host=base，收到 ${JSON.stringify(item)}`);
    const host = item.slice(0, at).trim().toLowerCase();
    const base = Number(item.slice(at + 1).trim());
    if (!Number.isInteger(base) || base <= 0) throw new Error(`--band ${host}=${item.slice(at + 1)} 的 base 不是正整数`);
    out[host] = base;
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const parsed = parseCli(argv, SPEC);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  const bad = rejectBadArgs(parsed);
  if (bad.length) return usageError([...bad, '（--help 看用法）']);

  const f = parsed.flags;
  const json = Boolean(f.json);
  const apply = Boolean(f.apply);
  const out = f.out ? path.resolve(f.out) : null;

  if (json && !apply) return usageError('`--json` 只落文件：请与 --apply --out <file> 同用（缺省只读只打印）');
  if (json && !out) return usageError('`--json` 要配 --out <file>');
  if (out && !apply) return usageError('给了 --out 就要加 --apply：缺省模式一个文件都不写');

  let overrides;
  try {
    overrides = parseOverrides(collectPairs(argv, '--band'));
  } catch (e) {
    return usageError(e.message);
  }

  let config;
  try {
    config = loadBandConfig({ file: f.config || null });
  } catch (e) {
    return usageError(`号段配置不成立：${e.message}`);
  }

  const dbPath = f.db ? path.resolve(f.db) : defaultMemoryDbPath();
  const only = f.only ? String(f.only).split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean) : null;
  const report = evaluate({
    config,
    dbPath,
    only,
    overrides,
    timeoutMs: Number.isFinite(f.timeout) ? f.timeout : 20000,
  });

  if (apply && out) {
    writeTextFile(out, `${JSON.stringify({ ...report, dbPath, reportFile: out }, null, 2)}\n`);
  }
  if (!f.quiet) {
    process.stdout.write(`${f.line ? `${formatLine(report)}\n` : `${formatHuman(report)}\n`}`);
    if (apply && out) process.stdout.write(`  报告已落盘：${out}\n`);
  }

  const base = report.exitCode;
  const exit = Boolean(f['require-all']) && report.unprobed.length ? SENTINEL_EXIT.UNPROBED : base;
  process.exitCode = exit;
  if (exit === SENTINEL_EXIT.LOCAL_UNREADABLE && !f.quiet) {
    process.stderr.write(`  本机库读不到 ⇒ rc=${SENTINEL_EXIT.LOCAL_UNREADABLE}（fail-closed，不算通过）\n`);
  }
  if (!fs.existsSync(dbPath)) {
    // 本机库不在时 evaluate 已判 LOCAL-UNREADABLE；这里只是让 --line 输出时也提醒一句
    if (!f.quiet && !f.line) process.stderr.write(`  缺省库路径：${dbPath}\n`);
  }
}

try {
  if (isMainEntry(import.meta.url)) main();
} catch (e) {
  settle(e, { prefix: '[band-sentinel]' });
}
