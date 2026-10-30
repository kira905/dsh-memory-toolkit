#!/usr/bin/env node
// 会话日志 → 记忆条（新入口；与内核的 `cli/distill.mjs` 并存，互不影响）。
//
// 与旧入口的分工：
//   旧入口吃「库里窗口内变动的记忆」，按语义聚类再提炼；
//   本入口吃「一份会话 JSONL」，只抽能回指来源的结论句，再合成 ≤N 条写回。
//   旧入口的默认值 / 参数名 / 退出码一个都没改 —— 两边是两条独立的路。
//
// 用法：
//   node memory-engine/cli/distill-sessions.mjs --source <会话.jsonl>                    缺省 dry-run：只抽、只规划
//   node memory-engine/cli/distill-sessions.mjs --source <会话.jsonl> --max-tokens 30000  dry-run + 预算（列出将写什么）
//   node memory-engine/cli/distill-sessions.mjs --source <会话.jsonl> --db <memory.db> --max-tokens 30000 --apply
//
// 退出码：0 = 正常（**含"没配预算所以没跑"**）/ 1 = 失败 / 2 = 用法错 / 3 = 环境不可用（源文件或库不在）
import fs from 'node:fs';
import path from 'node:path';
import { isMainEntry } from '../lib/cli-util.mjs';
import { parseCli, rejectBadArgs, usageError, settle, emitJsonReport, EXIT } from '../lib/cli-strict.mjs';
import {
  runSessionDistill, DEFAULT_LIMIT, NO_BUDGET_MESSAGE, makeRunId, runKeyOf,
} from '../lib/session-distill.mjs';
import { DEFAULT_LLM } from '../lib/distill.mjs';
import { DEFAULTS as SOURCE_DEFAULTS } from '../lib/session-source.mjs';

const HELP = `distill-sessions —— 会话日志 → 记忆（提炼的输入面；缺省 dry-run）

用法：
  node memory-engine/cli/distill-sessions.mjs --source <会话.jsonl>
  node memory-engine/cli/distill-sessions.mjs --source <会话.jsonl> --max-tokens <n> [--limit 5]
  node memory-engine/cli/distill-sessions.mjs --source <会话.jsonl> --db <memory.db> --max-tokens <n> --apply

它做什么：
  一行一个事件的 .jsonl 进来 → 只挑「能回指来源的结论句」（决定 / 口径 / 偏好 / 修复方案）→
  交给模型合成 ≤N 条结论 → 写回记忆库，标签以 distilled 开头并带 sess= 与 run=session:<批次>。
  每条结论都挂着来源（场次 + 行号 + 原文锚），不写摘要、不写过程叙述。

开关：
  --source <file>          会话日志（一行一个 JSON 事件）。给 .jsonl.zstd 也行：能用 node 内置 zstd 逐帧解就解开，
                           解不开会明确告诉你「这是压缩日志，先解压」（不会静默失败）
  --db <path>              记忆库；--apply 时必填（无默认值：写死生产路径是明令禁止的）
  --apply                  真跑：调模型 → 拍快照 → 写库 → 记台账
  --dry-run                显式干跑（缺省就是这个）；与 --apply 同时给算用法错
  --limit <n>              最多写几条结论（缺省 ${DEFAULT_LIMIT}）
  --max-tokens <n>         每日预算（token）。**不给、台账里也没配 ⇒ 本轮一次模型都不调**（rc=0）
                           给了就在 --apply 时写进台账，往后不带这个开关也按台账里的预算走
  --state <file>           台账（缺省：库同级的 butler-session-distill-state.json；没有库就没有台账）
  --snapshot-dir <dir>     写库前 VACUUM INTO 的落点（缺省：库同级 snapshots/）
  --run <id>               批次 id（缺省自动生成）。撤回就按这一批：整批一个来源键
  --owner-user <id>        库里有 owner_user 列时写它（缺省 local）
  --session-id <id>        日志里没有 type=session 事件时，用它补来源 id
  --max-chars <n>          单句长度上限（缺省 ${SOURCE_DEFAULTS.maxChars}；超了跳过并计数）
  --model <name>           模型名（缺省 ${DEFAULT_LLM.model}）
  --base-url <url>         模型服务地址（缺省 ${DEFAULT_LLM.baseUrl}）
  --now <iso>              把某个时刻当"现在"（演练 / 复现用）
  --json                   机器可读报告落文件（**必须配 --out，且不上 stdout**）
  --out <file>             --json 的落盘路径
  --quiet                  只打最终那几行
  --help

提炼的边界（三条，别指望它干第四件）：
  · 不做摘要式写入：过程叙述、寒暄、疑问、推测、工具输出一律不进库；
  · 只写能回指来源的结论条：每条都带场次 / 行号 / 原文锚，回不去原文的宁可不写；
  · 没配每日预算就不跑：不继承任何缺省额度，也不"没配=无限跑"。

撤回：
  node memory-engine/cli/distill-rollback.mjs --db <memory.db> --key <批次键> --apply
  （批次键 = 本轮打印的 src=，一批一个键 ⇒ 一条命令整批撤掉；撤前会先拍快照）

退出码：0 正常（含"没配预算 / 没候选 / 已产出过"）/ 1 失败 / 2 用法错 / 3 环境不可用
`;

const SPEC = {
  source: 'string',
  db: 'string',
  apply: 'bool',
  'dry-run': 'bool',
  limit: 'number',
  'max-tokens': 'number',
  state: 'string',
  'snapshot-dir': 'string',
  run: 'string',
  'owner-user': 'string',
  'session-id': 'string',
  'max-chars': 'number',
  model: 'string',
  'base-url': 'string',
  now: 'string',
  json: 'bool',
  out: 'string',
  quiet: 'bool',
};

/** 台账缺省落点：库同级（没有库就没有台账 —— 别偷偷往生产路径写）。 */
export function defaultStateFile(dbPath) {
  if (!dbPath) return null;
  return path.join(path.dirname(path.resolve(dbPath)), 'butler-session-distill-state.json');
}

export function parseCliArgs(argv) {
  const parsed = parseCli(argv, SPEC);
  return { parsed, bad: rejectBadArgs(parsed) };
}

export async function main(argv = process.argv.slice(2)) {
  const { parsed } = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    return EXIT.OK;
  }
  const bad = rejectBadArgs(parsed);
  if (bad.length) {
    usageError([...bad, '', '先 --help 看一眼可用开关。']);
    return EXIT.USAGE;
  }
  const flags = parsed.flags;
  const say = (line) => { if (!flags.quiet) process.stdout.write(`${line}\n`); };

  if (flags.apply && flags['dry-run']) {
    usageError(['--apply 与 --dry-run 不能同时给：缺省就是 dry-run，要真写只加 --apply。']);
    return EXIT.USAGE;
  }
  if (!flags.source) {
    usageError(['缺少 --source <会话.jsonl>：没有输入就没什么可提炼的。']);
    return EXIT.USAGE;
  }
  if (flags.apply && !flags.db) {
    usageError(['--apply 必须配 --db <memory.db>：本工具不会猜你的库在哪。']);
    return EXIT.USAGE;
  }
  if (flags.json && !flags.out) {
    usageError(['--json 要配 --out <file>：机器可读内容只落文件，不上 stdout。']);
    return EXIT.USAGE;
  }
  if (flags.db && !fs.existsSync(flags.db) && flags.apply) {
    process.stderr.write(`❌ 记忆库不存在：${flags.db}\n`);
    return EXIT.UNREADABLE;
  }
  if (flags.now && Number.isNaN(Date.parse(flags.now))) {
    usageError([`--now 不是可解析的时间：${flags.now}`]);
    return EXIT.USAGE;
  }

  const now = flags.now ? Date.parse(flags.now) : Date.now();
  const apply = Boolean(flags.apply);
  const dbPath = flags.db ? path.resolve(flags.db) : null;
  const stateFile = flags.state ? path.resolve(flags.state) : defaultStateFile(dbPath);
  const runId = flags.run ? String(flags.run) : makeRunId(now);

  say(`[distill-sessions] ${apply ? '真跑' : '干跑（dry-run）'} · 批次 ${runId} · 来源 ${flags.source}`);
  const result = await runSessionDistill({
    source: path.resolve(flags.source),
    dbPath,
    apply,
    limit: flags.limit ?? DEFAULT_LIMIT,
    maxTokens: flags['max-tokens'] ?? null,
    maxChars: flags['max-chars'] ?? SOURCE_DEFAULTS.maxChars,
    stateFile,
    snapshotDir: flags['snapshot-dir'] ? path.resolve(flags['snapshot-dir']) : null,
    runId,
    ownerUser: flags['owner-user'] ?? null,
    sessionId: flags['session-id'] ?? null,
    model: flags.model ?? DEFAULT_LLM.model,
    baseUrl: flags['base-url'] ?? DEFAULT_LLM.baseUrl,
    now,
  });

  const ext = result.extraction;
  if (ext) {
    say(`[distill-sessions] 抽句：${ext.lines} 行 / ${ext.events} 个事件 ⇒ 候选 ${ext.candidates} 条（挡下：${ext.skippedLine}）`);
  }
  if (result.source?.compressed) say(`[distill-sessions] ${result.source.note}`);
  for (const warning of result.warnings ?? []) say(`[distill-sessions] ⚠️ ${warning}`);

  // 结论类几行**不受 --quiet 影响**：--quiet 只压过程日志，压掉结论等于不告诉你跑没跑。
  const emit = (line) => process.stdout.write(`${line}\n`);

  if (result.stopping === 'NO_BUDGET') {
    emit(`[distill-sessions] ${NO_BUDGET_MESSAGE}`);
    say(`[distill-sessions] 怎么配：给 --max-tokens <n>（真跑时会写进台账），或先一次 --dry-run 看估算 token。`);
  } else if (result.stopping === 'BUDGET_SPENT' || result.stopping === 'ESTIMATE_OVER') {
    emit(`[distill-sessions] ${result.message}`);
  } else if (result.stopping === 'SOURCE_UNREADABLE') {
    process.stderr.write(`❌ ${result.message}\n`);
  } else if (result.message) {
    emit(`[distill-sessions] ${result.message}`);
  }

  if (result.planned?.length) {
    say('');
    say(`将写（最多 ${flags.limit ?? DEFAULT_LIMIT} 条）${apply ? '—— 已写' : '—— dry-run 不会写'}：`);
    for (const item of result.planned) {
      if (item.conclusion) {
        say(`  ${item.index}. [L${item.lines?.join(',') ?? '?'}] ${item.conclusion}`);
        for (const anchor of item.anchors ?? []) say(`       锚：L${anchor.line} ${anchor.anchor}`);
      } else {
        say(`  ${item.index}. [${item.kind} · L${item.line}] ${item.text}`);
        say(`       锚：${item.anchor}`);
      }
    }
  }

  if (result.budget) {
    const b = result.budget;
    const budgetLine = b.tokens === null ? '未配置' : `${b.spent}/${b.tokens} token（剩余 ${b.remaining}，来源 ${b.source}）`;
    say('');
    say(`预算：${budgetLine}${result.tokens ? ` · 本轮估算 ${result.tokens.estimated} token` : ''}`);
  }
  if (result.model) {
    say(`模型：${result.model.model} · ${result.model.ok ? 'ok' : `失败：${result.model.error}`} · ${result.model.ms}ms · `
      + `${result.model.promptTokens}+${result.model.completionTokens} token`);
  }
  if (apply && result.written) {
    emit(`写回：${result.written} 条（跳过已存在 ${result.skippedExisting ?? 0} 条）· 快照 ${result.snapshot}`);
    emit(`撤回：node memory-engine/cli/distill-rollback.mjs --db ${dbPath} --key ${result.srcKey} --apply`);
  }
  emit(`[distill-sessions] 结论：${result.stopping ?? 'OK'}${result.exitCode ? `（rc=${result.exitCode}）` : ''}`);

  if (flags.json) {
    const payload = {
      ...result,
      at: new Date(now).toISOString(),
      srcKey: result.srcKey,
      srcKeyFull: runKeyOf(runId),
      candidates: result.planned,
    };
    delete payload.warningsText;
    const written2 = emitJsonReport({ json: true, out: flags.out, payload });
    say(`JSON → ${written2}`);
  }
  return result.exitCode ?? EXIT.OK;
}

if (isMainEntry(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code ?? 0; })
    .catch((failure) => settle(failure, { prefix: '[distill-sessions]' }));
}
