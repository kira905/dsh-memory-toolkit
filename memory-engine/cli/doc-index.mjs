// 记忆引擎 v2 · 离线层 —— 文档索引 CLI（方案 §3.2）
//
// 用法：
//   node cli/doc-index.mjs                          # 增量（默认范围 = 首期 10 篇）
//   node cli/doc-index.mjs --all                    # 扫描面全量（⚠️ 全量是 §10 T2 触发器事项）
//   node cli/doc-index.mjs --only docs/a.md,docs/b.md
//   node cli/doc-index.mjs --rebuild                # 忽略差分，范围内全部重跑（按 path 覆盖，幂等）
//   node cli/doc-index.mjs --dry-run                # 只算不写（不建库、不改 state、不写日报）
//   node cli/doc-index.mjs --llm                    # 摘要走便宜模型（受 §3.5 成本闸）
//   node cli/doc-index.mjs --json                   # 机器可读（日志走 stderr）
//   路径可注入：--docs-root / --dsh-root / --doc-index-db / --state-file / --home
import { isMainEntry, parseArgs, makeLogger } from '../lib/cli-util.mjs';
import { runDocIndexOnce } from '../lib/doc-index.mjs';

export async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = makeLogger({ json, quiet: Boolean(flags.quiet) });
  try {
    const r = await runDocIndexOnce({ flags });
    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: r.ok,
            status: r.status,
            exitCode: r.exitCode,
            stats: r.stats,
            dailyLine: r.state.lastDailyLine,
            paths: r.state.paths,
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      for (const l of r.lines) log(l);
    }
    process.exitCode = r.exitCode;
  } catch (e) {
    const msg = String(e && e.stack ? e.stack : e);
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
    else log(`❌ ${msg}`);
    process.exitCode = 2;
  }
}

if (isMainEntry(import.meta.url)) await main();
