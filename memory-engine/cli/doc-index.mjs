// 文档索引 CLI（离线层）：跑一轮「文档 → 索引库」的增量同步。
//
// 常见用法
//   什么都不给                     增量跑一轮，范围是首期那 10 篇
//   --all                          扫描面全量（重活，别随手跑）
//   --only a.md,b.md               只处理点名的几篇
//   --rebuild                      无视差分，范围内按 path 全跑（覆盖写，重跑幂等）
//   --dry-run                      只算不写：不建库、不动 state、不写日报
//   --llm                          摘要改走便宜模型（同样受成本闸约束）
//   --json                         机器可读；人话日志改走 stderr
// 路径都能改：--docs-root / --dsh-root / --doc-index-db / --state-file / --home
import { isMainEntry, parseArgs, makeLogger } from '../lib/cli-util.mjs';
import { runDocIndexOnce } from '../lib/doc-index.mjs';

/** 机器读 JSON，人读逐行 —— 两条路别混。 */
function narrate(run, { json, log }) {
  if (!json) {
    for (const line of run.lines) log(line);
    return;
  }
  const digest = {
    ok: run.ok,
    status: run.status,
    exitCode: run.exitCode,
    stats: run.stats,
    dailyLine: run.state.lastDailyLine,
    paths: run.state.paths,
  };
  process.stdout.write(`${JSON.stringify(digest, null, 2)}\n`);
}

/** 出错也要分两条路说清楚，然后按既定语义回 2。 */
function complain(e, { json, log }) {
  const msg = String(e?.stack ?? e);
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
  else log(`❌ ${msg}`);
  return 2;
}

export async function main() {
  const parsed = parseArgs();
  const flags = parsed.flags;
  const asJson = Boolean(flags.json);
  const log = makeLogger({ json: asJson, quiet: Boolean(flags.quiet) });
  const channel = { json: asJson, log };

  try {
    const run = await runDocIndexOnce({ flags });
    narrate(run, channel);
    process.exitCode = run.exitCode;
  } catch (e) {
    process.exitCode = complain(e, channel);
  }
}

const invokedDirectly = isMainEntry(import.meta.url);
if (invokedDirectly) await main();
