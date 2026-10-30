// 记忆域标签补齐 CLI
//
// 干的事：把库里待处理的记忆条目按批送给分类模型，模型只准从固定的域标签集合里挑，
// 挑完写回库、并把「这批问过了」记进幂等台账（所以中断重跑不会重复花钱）。
//
// 命令行形态（对外契约，参数名 / 默认值 / 退出码一律照旧）：
//   --db <path>                必填。本工具没有默认库路径 —— 写死库路径是明令禁止的
//   --apply                    真跑（缺省是 dry-run：只规划、不调模型、不写库）
//   --snapshot <dir>           真跑前先 VACUUM INTO 到 <dir>/memory.db
//   --batch <n>                每批条数（25）
//   --limit <n>                本次最多取多少条（0 = 不限）
//   --max-chars-per-item <n>   送模型时单条正文截断长度（240）
//   --max-calls / --max-tokens 每日成本闸（缺省取库里的 COST_LIMITS）
//   --owner-user <id>          本机 owner 的 userid；缺省先查身份表，再不行用内置常量
//   --state <file>             幂等台账落点（缺省 <home>/memory/domain-tags-state.json）
//   --model / --base-url       分类模型档
//   --no-daily-report          不写日报段
//   --daily-report <file>      覆盖日报落点
//   --json                     stdout 只留 JSON，人看的话全走 stderr
//
// 退出码：0 = 正常收尾（包含「成本闸到点、主动停」这种受控停止）
//         1 = 有异常 / 2 = 用法错 / 3 = 环境不可用（没 key、库不在）
import fs from 'node:fs';
import path from 'node:path';
import { isMainEntry, parseArgs, num, makeLogger } from '../lib/cli-util.mjs';
import * as D from '../lib/domain-tags.mjs';

const EXIT = { OK: 0, FAIL: 1, USAGE: 2, ENV: 3 };
const OWNER_FALLBACK = 'LiJianXiao';
const OWNER_SOURCES = ['../../memory-db-tools/lib/memory-scope.mjs', '../dsh-memory-local/src/schema-migrate.mjs'];

/** 数值型开关：源长什么样、落到哪个字段、不给时取什么。 */
const NUMERIC_OPTIONS = [
  { from: 'batch', to: 'batchSize', fallback: 25 },
  { from: 'limit', to: 'limit', fallback: 0 },
  { from: 'max-chars-per-item', to: 'maxCharsPerItem', fallback: 240 },
  { from: 'max-calls', to: 'callsPerDay', fallback: D.COST_LIMITS.callsPerDay },
  { from: 'max-tokens', to: 'tokensPerDay', fallback: D.COST_LIMITS.tokensPerDay },
];

if (isMainEntry(import.meta.url)) {
  main().catch((e) => {
    console.error(`未捕获异常：${e?.stack ?? e}`);
    process.exitCode = EXIT.FAIL;
  });
}

/**
 * 本机 owner 的 userid：先问权威实现，再问自检镜像，最后才用内置常量。
 * 顺序不能反 —— 常量只是兜底，不是口径。
 */
async function resolveOwnerUser(explicit, home) {
  if (explicit) return { user: explicit, source: 'cli' };
  for (const rel of OWNER_SOURCES) {
    const hit = await askOwnerSource(rel, home);
    if (hit) return hit;
  }
  return {
    user: OWNER_FALLBACK,
    source: '内置回落（两条权威源都不可用）',
    notes: ['⚠️ 身份表解析不可用 ⇒ 回落常量'],
  };
}

async function askOwnerSource(rel, home) {
  try {
    const mod = await import(new URL(rel, import.meta.url).href);
    const table = mod.readIdentityTable ? mod.readIdentityTable(home) : null;
    const resolved = mod.resolveDefaultOwner ? mod.resolveDefaultOwner(table) : null;
    if (resolved?.ownerUser) {
      return { user: resolved.ownerUser, source: `${rel} (${resolved.source})`, notes: resolved.notes ?? [] };
    }
  } catch {
    /* 这一路不可用，换下一路 */
  }
  return null;
}

/** 数值开关一次性取齐（表驱动，省得逐个 if）。 */
function takeNumbers(flags) {
  const bag = {};
  for (const opt of NUMERIC_OPTIONS) bag[opt.to] = num(flags[opt.from], opt.fallback);
  return bag;
}

/** 选工作集：非本机 owner 的先摘出去（归属从严，绝不出机），台账里盖过章的也不重复问。 */
function planWork(items, { ownerColumn, ownerUser, processed }) {
  const queue = [];
  const foreign = [];
  for (const row of items) {
    const holder = ownerColumn ? row.ownerUser : ownerUser;
    if (holder !== ownerUser) {
      foreign.push({ id: row.id, ownerUser: holder ?? '(空)' });
      continue;
    }
    if (processed[String(row.id)]) continue;
    queue.push(row);
  }
  return { queue, foreign };
}

/** 模型输出落库前的清洗：只认本批的 id、只认固定集合里的标签（防模型自由发挥）。 */
function sanitizeModelItems(raw, batch) {
  const wanted = new Map(batch.map((row) => [Number(row.id), row]));
  const keep = [];
  let dropped = 0;
  for (const item of raw) {
    const id = Number(item?.id);
    if (!Number.isFinite(id) || !wanted.has(id)) continue;
    const labels = Array.isArray(item?.domains) ? item.domains : Array.isArray(item?.domain) ? item.domain : [];
    const valid = labels.filter((label) => D.DOMAIN_TOKEN_BY_LABEL[String(label).trim()] !== undefined);
    dropped += labels.length - valid.length;
    keep.push({ id, domains: valid });
  }
  // 模型漏答的条目按「没有标签」记 —— 写库时就当空集合，别让它们卡住后面的批
  for (const row of batch) {
    const id = Number(row.id);
    if (!keep.some((r) => r.id === id)) keep.push({ id, domains: [] });
  }
  return { rows: keep, dropped };
}

function bump(state, field, delta) {
  state.stats[field] = Number(state.stats[field] ?? 0) + delta;
}

/** 收尾：把 JSON 或人话吐出来，再把退出码钉住。 */
function seal(result, code, opts) {
  result.exitCode = code;
  if (opts.asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else opts.log(`\n[${code === EXIT.OK ? 'OK' : 'STOP'}] exit=${code}`);
  process.exitCode = code;
}

function refuse(code, message, asJson) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
  void asJson;
  return code;
}

async function main() {
  const { flags } = parseArgs();
  const asJson = Boolean(flags.json);
  const log = makeLogger({ json: asJson });

  const dbPath = flags.db ? path.resolve(String(flags.db)) : '';
  if (!dbPath) return refuse(EXIT.USAGE, '用法错：必须给 --db <库路径>（本脚本没有默认库路径 —— 写死路径是明令禁止的）', asJson);
  if (!fs.existsSync(dbPath)) return refuse(EXIT.ENV, `环境不可用：库不存在 ${dbPath}`, asJson);

  const conf = takeNumbers(flags);
  const limits = { callsPerDay: conf.callsPerDay, tokensPerDay: conf.tokensPerDay };
  const apply = Boolean(flags.apply);
  const home = path.dirname(path.dirname(dbPath)); // <home>/memory/memory.db → <home>
  const stateFile = flags.state ? path.resolve(String(flags.state)) : path.join(home, 'memory', 'domain-tags-state.json');
  const snapshotDir = flags.snapshot ? path.resolve(String(flags.snapshot)) : null;
  const model = flags.model ? String(flags.model) : D.DEFAULT_LLM.model;
  const baseUrl = flags['base-url'] ? String(flags['base-url']) : D.DEFAULT_LLM.baseUrl;
  const nowIso = new Date().toISOString();

  const owner = await resolveOwnerUser(flags['owner-user'] ? String(flags['owner-user']) : null, home);
  const result = {
    at: nowIso,
    mode: apply ? 'apply' : 'dry-run',
    db: dbPath,
    model,
    baseUrl,
    ownerUser: owner.user,
    ownerSource: owner.source,
    limits,
    batchSize: conf.batchSize,
    maxCharsPerItem: conf.maxCharsPerItem,
    stats: {},
    cost: null,
    stopping: null,
    ok: false,
    exitCode: EXIT.OK,
  };

  log(`目标库    : ${dbPath}`);
  log(`本机 owner: ${owner.user}（来源 ${owner.source}）`);
  log(`分类模型  : ${model} @ ${baseUrl}（成本闸 ≤${limits.callsPerDay} 次 / ≤${limits.tokensPerDay} token 每日）`);
  for (const note of owner.notes ?? []) log(`⚠️ ${note}`);

  const scanned = D.readCandidates(dbPath, { limit: conf.limit, maxCharsPerItem: conf.maxCharsPerItem });
  const book = D.readState(stateFile, dbPath, nowIso);
  if (!scanned.ownerColumn) log('⚠️ 库无 owner_user 列（未迁移的老库形态）⇒ 全部条目按「本机 owner」处理');

  const { queue, foreign } = planWork(scanned.items, {
    ownerColumn: scanned.ownerColumn,
    ownerUser: owner.user,
    processed: book.processed,
  });
  const batchCount = Math.ceil(queue.length / conf.batchSize);
  const firstBatchTokens = queue.length ? D.estimateTokens(queue.slice(0, conf.batchSize)) : 0;

  result.stats = {
    scanned: scanned.items.length,
    skippedOwner: foreign.length,
    alreadyProcessed: scanned.items.length - queue.length - foreign.length,
    pending: queue.length,
    plannedBatches: batchCount,
    estimatedTokensPerBatch: firstBatchTokens,
  };
  log(`扫描 ${scanned.items.length} 条 · 跳过(非本机 owner) ${foreign.length} · 已处理(台账) ${result.stats.alreadyProcessed} · 待处理 ${queue.length}（${batchCount} 批）`);
  if (foreign.length) {
    const preview = foreign.map((x) => x.id).slice(0, 20).join(',');
    log(`  ⚠️ 跳过条目（归属从严：不进第三方）id=[${preview}${foreign.length > 20 ? '…' : ''}]`);
  }

  if (!apply) {
    log('\n[DRY-RUN] 未写任何内容（未调模型、未写 state）；要真跑加 --apply');
    result.ok = true;
    result.state = { file: stateFile, cost: book.cost };
    return seal(result, EXIT.OK, { asJson, log });
  }

  if (!queue.length) {
    log('\n无待处理条目（幂等台账已覆盖）—— 零写入');
    result.ok = true;
    result.state = { file: stateFile, cost: book.cost, processed: Object.keys(book.processed).length };
    return seal(result, EXIT.OK, { asJson, log });
  }

  // 动钱之前先算总账：首批都过不去就干脆一批都不跑
  const preflight = D.costGate(book, firstBatchTokens, limits);
  if (!preflight.ok) {
    result.stopping = preflight.reason;
    log(`\n[STOP] 成本闸：${preflight.reason}（超限即停，不重试）`);
    result.ok = true;
    return seal(result, EXIT.OK, { asJson, log });
  }

  if (snapshotDir) {
    const file = D.vacuumInto(dbPath, path.join(snapshotDir, 'memory.db'));
    result.snapshot = { file, bytes: fs.statSync(file).size };
    log(`✓ 快照：${result.snapshot.file}（${result.snapshot.bytes} B）`);
  } else {
    log('⚠️ 未给 --snapshot：本次无快照（副本演练可接受，生产前置必须有）');
    result.snapshot = null;
  }

  const apiKey = process.env[D.DEFAULT_LLM.credentialKey] || D.readCredential(D.DEFAULT_LLM.credentialKey);
  if (!apiKey) {
    log(`环境不可用：找不到 ${D.DEFAULT_LLM.credentialKey}（env 与 .credentials.yaml 都没有）`);
    result.exitCode = EXIT.ENV;
    return seal(result, EXIT.ENV, { asJson, log });
  }

  const startedAt = Date.now();
  const db = D.openDb(dbPath, { write: true });
  book.stats.runs = Number(book.stats.runs ?? 0) + 1;
  try {
    for (let round = 0; round < batchCount; round += 1) {
      const batch = queue.slice(round * conf.batchSize, (round + 1) * conf.batchSize);
      if (!batch.length) break;
      const gate = D.costGate(book, D.estimateTokens(batch), limits);
      if (!gate.ok) {
        result.stopping = gate.reason;
        log(`\n[STOP] 成本闸：${gate.reason}（超限即停，不重试）`);
        break;
      }

      const roundStart = Date.now();
      const reply = await D.callClassifier({ items: batch, apiKey, baseUrl, model });
      if (!reply.ok) {
        result.stopping = `模型调用失败（第 ${round + 1} 批）：${reply.error}`;
        log(`\n[STOP] ${result.stopping}`);
        break;
      }
      book.cost.calls = Number(book.cost.calls ?? 0) + 1;
      book.cost.promptTokens = Number(book.cost.promptTokens ?? 0) + Number(reply.usage?.prompt_tokens ?? 0);
      book.cost.completionTokens = Number(book.cost.completionTokens ?? 0) + Number(reply.usage?.completion_tokens ?? 0);
      book.cost.date = nowIso.slice(0, 10);

      const cleaned = sanitizeModelItems(reply.items, batch);
      const written = await D.applyResults(db, cleaned.rows);
      if (!written.ok) {
        result.stopping = `写库失败（第 ${round + 1} 批）：${written.error}`;
        log(`\n[STOP] ${result.stopping}`);
        break;
      }

      // 「问过了」入账：连「模型说没标签」的也算 —— 否则下一轮又会花钱问同一批
      for (const row of batch) {
        const hit = cleaned.rows.find((r) => r.id === Number(row.id));
        book.processed[String(row.id)] = D.tagSetHash(hit ? hit.domains : []);
      }
      book.stats.batches = Number(book.stats.batches ?? 0) + 1;
      bump(book, 'tagged', written.written);
      bump(book, 'noTag', cleaned.rows.filter((r) => r.domains.length === 0).length);
      book.stats.skippedOwner = foreign.length;
      bump(book, 'skippedUnknownDomain', cleaned.dropped);
      book.updatedAt = new Date().toISOString();
      D.writeState(stateFile, book); // 每批落盘 ⇒ 断电也能接着跑
      const dayTokens = Number(book.cost.promptTokens) + Number(book.cost.completionTokens);
      log(`  批 ${round + 1}/${batchCount}: 调用 ${book.cost.calls} 次 · 写 ${written.written} 条 · 已是 ${written.unchanged} 条 · 耗时 ${Date.now() - roundStart}ms · 当日 token ${dayTokens}`);
    }
  } finally {
    try {
      db.close();
    } catch {
      /* 关不掉也不影响结果 */
    }
  }

  // 台账里记一笔「这些为什么没送」，方便下次查账
  for (const skip of foreign) book.skipped[String(skip.id)] = `owner=${skip.ownerUser}`;
  book.updatedAt = new Date().toISOString();
  D.writeState(stateFile, book);

  const usedTokens = Number(book.cost.promptTokens) + Number(book.cost.completionTokens);
  const line = D.renderDailyLine({
    mode: 'apply',
    stats: book.stats,
    cost: book.cost,
    state: { processedCount: Object.keys(book.processed).length },
    limits,
    stoppedReason: result.stopping,
  });
  result.cost = { ...book.cost, usedTokens };
  result.state = { file: stateFile, processed: Object.keys(book.processed).length };
  log(`\n完成：批次 ${book.stats.batches} · 本轮写 ${book.stats.tagged} 条 · 当日调用 ${book.cost.calls}/${limits.callsPerDay} · 当日 token ${usedTokens}/${limits.tokensPerDay} · 用时 ${Date.now() - startedAt}ms`);

  if (!flags['no-daily-report']) {
    const reportFile = flags['daily-report'] ? path.resolve(String(flags['daily-report'])) : D.dailyReportPath({});
    const done = D.updateDailySection({ file: reportFile, line, dryRun: false });
    result.dailyReport = { file: reportFile, ...done, line };
    const suffix = done.ok ? `（${done.replaced ? '段替换' : '追加段'}）` : `（${done.reason}）`;
    log(`${done.ok ? '✓' : '⚠️'} 日报：${reportFile}${suffix}`);
  }
  result.dailyLine = line;
  result.ok = true;
  return seal(result, EXIT.OK, { asJson, log });
}
