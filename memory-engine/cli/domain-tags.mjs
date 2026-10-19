// 记忆引擎 v2 · S3b —— 域标签补齐 CLI（方案 §3.6 / §5.4 / §7 / §3.9 D2）
//
// 用法：
//   node cli/domain-tags.mjs --db <库路径>                       # dry-run（默认；只读规划，零写入）
//   node cli/domain-tags.mjs --db <库路径> --apply                # 真跑（副本库；分批 + 可续跑）
//   node cli/domain-tags.mjs --db <库路径> --apply --snapshot <dir>   # 跑前 VACUUM INTO 快照
//   node cli/domain-tags.mjs --db <库路径> --limit 25 --batch 25   # 只跑 1 批（试跑）
//   node cli/domain-tags.mjs --db <库路径> --apply --json          # 机器可读（stdout 只有 JSON）
//
// 关键开关：`--batch`（每批条数，默认 25）· `--max-chars-per-item`（送模型的单条截断，默认 240）
//           `--owner-user`（本机 owner 的 userid；缺省由身份表解析、再回落常量）· `--state <file>`
//           `--max-calls`（默认 20）· `--max-tokens`（默认 150000）· `--model` · `--base-url`
//           `--no-daily-report`（不写日报段）· `--daily-report <path>`（覆盖日报路径）
//
// 退出码：0 = 完成/无待处理（含"成本闸停机"这种受控停止）；1 = 有异常；2 = 用法错；3 = 环境不可用（无 key / 库不存在）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isMainEntry, parseArgs, num, makeLogger } from '../lib/cli-util.mjs';
import * as D from '../lib/domain-tags.mjs';

const argv = process.argv.slice(2);
if (isMainEntry(import.meta.url)) {
  main().catch((e) => {
    console.error(`未捕获异常：${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
}

/** 解析「本机 owner 的 userid」：优先 ⑤-3 的权威实现，其次 fork 的自检镜像，最后内置回落。 */
async function resolveOwnerUser(explicit, home) {
  if (explicit) return { user: explicit, source: 'cli' };
  const cands = ['../../memory-db-tools/lib/memory-scope.mjs', '../dsh-memory-local/src/schema-migrate.mjs'];
  for (const rel of cands) {
    try {
      const mod = await import(new URL(rel, import.meta.url).href);
      const identity = mod.readIdentityTable ? mod.readIdentityTable(home) : null;
      const r = mod.resolveDefaultOwner ? mod.resolveDefaultOwner(identity) : null;
      if (r && r.ownerUser) return { user: r.ownerUser, source: `${rel} (${r.source})`, notes: r.notes ?? [] };
    } catch { /* 试下一个候选 */ }
  }
  return { user: 'LiJianXiao', source: '内置回落（两条权威源都不可用）', notes: ['⚠️ 身份表解析不可用 ⇒ 回落常量'] };
}

async function main() {
  const { flags } = parseArgs(argv);
  const json = Boolean(flags.json);
  const log = makeLogger({ json });
  const dbPath = flags.db ? path.resolve(String(flags.db)) : null;
  if (!dbPath) {
    console.error('用法错：必须给 --db <库路径>（本脚本没有默认库路径 —— 写死路径是明令禁止的）');
    process.exitCode = 2;
    return;
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`环境不可用：库不存在 ${dbPath}`);
    process.exitCode = 3;
    return;
  }

  const apply = Boolean(flags.apply);
  const batchSize = num(flags.batch, 25);
  const limit = num(flags.limit, 0);
  const maxCharsPerItem = num(flags['max-chars-per-item'], 240);
  const limits = { callsPerDay: num(flags['max-calls'], D.COST_LIMITS.callsPerDay), tokensPerDay: num(flags['max-tokens'], D.COST_LIMITS.tokensPerDay) };
  const home = path.dirname(path.dirname(dbPath)); // <home>/memory/memory.db → <home>
  const stateFile = flags.state ? path.resolve(String(flags.state)) : path.join(home, 'memory', 'domain-tags-state.json');
  const snapshotDir = flags.snapshot ? path.resolve(String(flags.snapshot)) : null;
  const model = flags.model ? String(flags.model) : D.DEFAULT_LLM.model;
  const baseUrl = flags['base-url'] ? String(flags['base-url']) : D.DEFAULT_LLM.baseUrl;
  const nowIso = new Date().toISOString();

  const owner = await resolveOwnerUser(flags['owner-user'] ? String(flags['owner-user']) : null, home);
  const result = {
    at: nowIso, mode: apply ? 'apply' : 'dry-run', db: dbPath, model, baseUrl,
    ownerUser: owner.user, ownerSource: owner.source, limits, batchSize, maxCharsPerItem,
    stats: {}, cost: null, stopping: null, ok: false, exitCode: 0,
  };

  log(`库      : ${dbPath}`);
  log(`本机 owner: ${owner.user}（来源 ${owner.source}）`);
  log(`模型    : ${model} @ ${baseUrl}（成本闸 ≤${limits.callsPerDay} 次 / ≤${limits.tokensPerDay} token 每日）`);
  for (const n of owner.notes ?? []) log(`⚠️ ${n}`);

  // ── 只读取样 + 过滤 ────────────────────────────────────────────────────────
  const scanned = D.readCandidates(dbPath, { limit, maxCharsPerItem });
  const state = D.readState(stateFile, dbPath, nowIso);
  if (!scanned.ownerColumn) log('⚠️ 库无 owner_user 列（未迁移的老库形态）⇒ 全部条目按「本机 owner」处理');

  const pending = [];
  const skippedOwner = [];
  for (const it of scanned.items) {
    const ownerUser = scanned.ownerColumn ? it.ownerUser : owner.user;
    if (ownerUser !== owner.user) {
      // D2 从严：归属不明 / 非本机 owner ⇒ **一律不送第三方模型**，跳过并记账
      skippedOwner.push({ id: it.id, ownerUser: ownerUser ?? '(空)' });
      continue;
    }
    if (state.processed[String(it.id)]) continue; // 幂等台账：已处理过的不再送模型
    pending.push(it);
  }
  const batches = Math.ceil(pending.length / batchSize);
  const estimated = pending.slice(0, batchSize).length ? D.estimateTokens(pending.slice(0, batchSize)) : 0;
  result.stats = {
    scanned: scanned.items.length, skippedOwner: skippedOwner.length, alreadyProcessed: scanned.items.length - pending.length - skippedOwner.length,
    pending: pending.length, plannedBatches: batches, estimatedTokensPerBatch: estimated,
  };
  log(`扫描 ${scanned.items.length} 条 · 跳过(非本机 owner) ${skippedOwner.length} · 已处理(台账) ${result.stats.alreadyProcessed} · 待处理 ${pending.length}（${batches} 批）`);
  if (skippedOwner.length) log(`  ⚠️ 跳过条目（D2 从严：不进第三方）id=[${skippedOwner.map((s) => s.id).slice(0, 20).join(',')}${skippedOwner.length > 20 ? '…' : ''}]`);

  if (!apply) {
    log('\n[DRY-RUN] 未写任何内容（未调模型、未写 state）；要真跑加 --apply');
    result.ok = true;
    result.state = { file: stateFile, cost: state.cost };
    return finish(result, 0, json, log);
  }

  // ── 成本闸（调用前总检查） ─────────────────────────────────────────────────
  if (pending.length === 0) {
    log('\n无待处理条目（幂等台账已覆盖）—— 零写入');
    result.ok = true;
    result.state = { file: stateFile, cost: state.cost, processed: Object.keys(state.processed).length };
    return finish(result, 0, json, log);
  }
  const gate0 = D.costGate(state, estimated, limits);
  if (!gate0.ok) {
    result.stopping = gate0.reason;
    log(`\n[STOP] 成本闸：${gate0.reason}（超限即停，不重试）`);
    result.ok = true;
    return finish(result, 0, json, log);
  }

  // ── 快照（§3.6 前置） ──────────────────────────────────────────────────────
  if (snapshotDir) {
    const dest = path.join(snapshotDir, 'memory.db');
    const file = D.vacuumInto(dbPath, dest);
    const st = fs.statSync(file);
    result.snapshot = { file, bytes: st.size };
    log(`✓ 快照：${file}（${st.size} B）`);
  } else {
    log('⚠️ 未给 --snapshot：本次无快照（副本演练可接受，生产前置必须有）');
    result.snapshot = null;
  }

  // ── 分类模型 key ──────────────────────────────────────────────────────────
  const apiKey = process.env[D.DEFAULT_LLM.credentialKey] || D.readCredential(D.DEFAULT_LLM.credentialKey);
  if (!apiKey) {
    log(`环境不可用：找不到 ${D.DEFAULT_LLM.credentialKey}（env 与 .credentials.yaml 都没有）`);
    result.exitCode = 3;
    return finish(result, 3, json, log);
  }

  // ── 分批跑 ────────────────────────────────────────────────────────────────
  const db = D.openDb(dbPath, { write: true });
  state.stats.runs = Number(state.stats.runs ?? 0) + 1;
  const runStart = Date.now();
  try {
    for (let b = 0; b < batches; b += 1) {
      const slice = pending.slice(b * batchSize, (b + 1) * batchSize);
      if (slice.length === 0) break;
      const est = D.estimateTokens(slice);
      const gate = D.costGate(state, est, limits);
      if (!gate.ok) {
        result.stopping = gate.reason;
        log(`\n[STOP] 成本闸：${gate.reason}（超限即停，不重试）`);
        break;
      }
      const callStart = Date.now();
      const resp = await D.callClassifier({ items: slice, apiKey, baseUrl, model });
      if (!resp.ok) {
        result.stopping = `模型调用失败（第 ${b + 1} 批）：${resp.error}`;
        log(`\n[STOP] ${result.stopping}`);
        break;
      }
      state.cost.calls = Number(state.cost.calls ?? 0) + 1;
      state.cost.promptTokens = Number(state.cost.promptTokens ?? 0) + Number(resp.usage?.prompt_tokens ?? 0);
      state.cost.completionTokens = Number(state.cost.completionTokens ?? 0) + Number(resp.usage?.completion_tokens ?? 0);
      state.cost.date = nowIso.slice(0, 10);

      // 模型输出 → 只保留本批条目的 id（防模型编 id）；域标签只从固定集合里认（appendDomainTags 里过滤）
      const inBatch = new Map(slice.map((it) => [Number(it.id), it]));
      const results = [];
      let unknownDomainDropped = 0;
      for (const item of resp.items) {
        const id = Number(item?.id);
        if (!Number.isFinite(id) || !inBatch.has(id)) continue;
        const rawDomains = Array.isArray(item?.domains) ? item.domains : (Array.isArray(item?.domain) ? item.domain : []);
        const valid = rawDomains.filter((d) => D.DOMAIN_TOKEN_BY_LABEL[String(d).trim()] !== undefined);
        unknownDomainDropped += rawDomains.length - valid.length;
        results.push({ id, domains: valid });
      }
      const missing = slice.filter((it) => !results.some((r) => r.id === Number(it.id)));
      for (const m of missing) results.push({ id: Number(m.id), domains: [] }); // 模型漏答 ⇒ 记为"无标签"，不写库

      const wr = await D.applyResults(db, results);
      if (!wr.ok) {
        result.stopping = `写库失败（第 ${b + 1} 批）：${wr.error}`;
        log(`\n[STOP] ${result.stopping}`);
        break;
      }
      // 幂等台账：本批已处理（含"无标签"——它们也算处理过，避免每轮重复问模型）
      for (const it of slice) {
        const r = results.find((x) => x.id === Number(it.id));
        state.processed[String(it.id)] = D.tagSetHash(r ? r.domains : []);
      }
      state.stats.batches = Number(state.stats.batches ?? 0) + 1;
      state.stats.tagged = Number(state.stats.tagged ?? 0) + wr.written;
      state.stats.noTag = Number(state.stats.noTag ?? 0) + results.filter((r) => r.domains.length === 0).length;
      state.stats.skippedOwner = skippedOwner.length;
      state.stats.skippedUnknownDomain = Number(state.stats.skippedUnknownDomain ?? 0) + unknownDomainDropped;
      state.updatedAt = new Date().toISOString();
      D.writeState(stateFile, state); // **每批落盘** ⇒ 可中断续跑
      log(`  批 ${b + 1}/${batches}: 调用 ${state.cost.calls} 次 · 写 ${wr.written} 条 · 已是 ${wr.unchanged} 条 · 耗时 ${Date.now() - callStart}ms · 当日 token ${Number(state.cost.promptTokens) + Number(state.cost.completionTokens)}`);
    }
  } finally {
    try { db.close(); } catch { /* 忽略 */ }
  }

  // ── 汇总 + 日报一行 ───────────────────────────────────────────────────────
  for (const s of skippedOwner) state.skipped[String(s.id)] = `owner=${s.ownerUser}`;
  state.updatedAt = new Date().toISOString();
  D.writeState(stateFile, state);
  const usedTokens = Number(state.cost.promptTokens) + Number(state.cost.completionTokens);
  const line = D.renderDailyLine({
    mode: 'apply', stats: state.stats, cost: state.cost, state: { processedCount: Object.keys(state.processed).length },
    limits, stoppedReason: result.stopping,
  });
  result.cost = { ...state.cost, usedTokens };
  result.state = { file: stateFile, processed: Object.keys(state.processed).length };
  log(`\n完成：批次 ${state.stats.batches} · 本轮写 ${state.stats.tagged} 条 · 当日调用 ${state.cost.calls}/${limits.callsPerDay} · 当日 token ${usedTokens}/${limits.tokensPerDay} · 用时 ${Date.now() - runStart}ms`);
  if (!flags['no-daily-report']) {
    const reportFile = flags['daily-report'] ? path.resolve(String(flags['daily-report'])) : D.dailyReportPath({});
    const r = D.updateDailySection({ file: reportFile, line, dryRun: false });
    result.dailyReport = { file: reportFile, ...r, line };
    log(`${r.ok ? '✓' : '⚠️'} 日报：${reportFile}${r.ok ? `（${r.replaced ? '段替换' : '追加段'}）` : `（${r.reason}）`}`);
  }
  result.dailyLine = line;
  result.ok = true;
  return finish(result, 0, json, log);
}

function finish(result, code, json, log) {
  result.exitCode = code;
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    log(`\n[${code === 0 ? 'OK' : 'STOP'}] exit=${code}`);
  }
  process.exitCode = code;
}
