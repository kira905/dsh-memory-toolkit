// 文档索引器 —— 一轮的编排（扫描面 → 差分 → 摘要 → 落库 → 清孤条 → 写 state → 日报一行）
//
// 一轮里的顺序就是语义，别调换：
//   ① 扫 docs 面（四类目录排除在外）+ 定本轮范围（首期十篇 / 全量 / 点名）
//   ② 差分：state 里的 mtime/size + 库里有没有这一篇的条 ⇒ 没变的篇一个字节都不碰
//   ③ 变了的篇：读正文 → 解析结构 → 切条 → 出摘要（规则确定性 / 模型受成本闸）
//   ④ 分批 UPSERT（等锁 + 退避重试；批小一点好在锁竞争里让路）
//   ⑤ 清掉本轮没再生成的分条（文档变短后留下的 path#§N 残留）
//   ⑥ state 原子写 + 日报一行
// 任何一步失败都只记账、不往外抛：这条链出问题不该连累别的机制。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_DOCS_ROOT, DEFAULT_DSH_ROOT, FIRST_BATCH, FIRST_BATCH_SOURCE,
  parseStructure, planRows, readDoc, scanDocs,
} from './doc-scan.mjs';
import { emptyCost, resolveApiKey, rolloverCost, summarizeAll } from './doc-summarize.mjs';
import {
  META_KEYS, deleteStaleRows, hasDocRows, listRows,
  openDocIndexStore, setMeta, upsertDocs, withBusyRetry,
} from './doc-index-store.mjs';

export const DOC_INDEX_STATE_SCHEMA = 1;
export const HISTORY_MAX = 20;
// 小批量：独立库各自加锁，一批五条就够
export const DEFAULT_BATCH = 5;

export const DAILY_SECTION_TITLE = '## 📄 文档索引（doc-index）';

// ── state ───────────────────────────────────────────────────────────────────

export function readState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // 文件还没生成 ⇒ 当首次运行
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // 内容坏了同样当首次运行：state 是可重建载体，不该卡住整条链
  }
}

// 原子写：同目录临时件 + rename（跨盘 rename 必炸，所以临时件必须落在目标旁边）
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function writeState(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

// 历史只留最近 max 条，老的直接丢（不追加、不合并）
export function pushHistory(prev, entry, max = HISTORY_MAX) {
  const kept = Array.isArray(prev?.history) ? prev.history.slice(-(max - 1)) : [];
  kept.push(entry);
  while (kept.length > max) kept.shift();
  return kept;
}

// ── 范围与差分 ──────────────────────────────────────────────────────────────

// 本轮做哪些篇：--all 走全扫描面 / --only 点名 / 默认首期那十篇
export function resolveScope({ scanned, flags = {} }) {
  if (flags.all || flags.scope === 'all') {
    return { mode: 'all', source: '扫描面全量（--all）', docs: scanned, missing: [] };
  }

  const explicit = typeof flags.only === 'string' && flags.only.trim()
    ? flags.only.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const wanted = explicit ?? FIRST_BATCH;
  const byRel = new Map(scanned.map((doc) => [doc.rel, doc]));

  const docs = [];
  const missing = [];
  for (const rel of wanted) {
    const found = byRel.get(rel);
    if (found) docs.push(found);
    else missing.push(rel);
  }

  return {
    mode: explicit ? 'only' : 'first-batch',
    source: explicit ? '--only 显式指定' : FIRST_BATCH_SOURCE,
    docs,
    missing,
  };
}

// 重建判据表：从上往下，命中第一条就重建（顺序有意义 —— 强制最高，其次没记录，再其次变了）
const REBUILD_RULES = [
  [(ctx) => ctx.force, 'forced'],
  [(ctx) => !ctx.prevEntry, 'new'],
  [
    (ctx) => Number(ctx.prevEntry.mtime) !== Number(ctx.doc.mtime) || Number(ctx.prevEntry.size) !== Number(ctx.doc.size),
    'mtime-or-size-changed',
  ],
  // 只有 failed 才强推重算：ok（本轮重建过）与 skipped（本轮确认过最新）都算「已同步」；
  // 把 skipped 也当没同步，会让跳过轮和重建轮来回振荡。
  [(ctx) => ctx.prevEntry.lastResult === 'failed', 'last-failed'],
  [(ctx) => !ctx.hasRow, 'missing-in-db'],
];

export function needsRebuild({ doc, prevEntry, hasRow, force = false }) {
  const ctx = { doc, prevEntry, hasRow, force };
  for (const [test, reason] of REBUILD_RULES) if (test(ctx)) return { rebuild: true, reason };
  return { rebuild: false, reason: 'unchanged' };
}

// ── 文案 ────────────────────────────────────────────────────────────────────

// 日报一行（纯函数：state 里存的和日报段里写的必须是同一份文本）
export function renderDailyLine(state) {
  const run = state?.lastRun ?? {};
  const cost = state?.cost ?? { calls: 0, tokens: 0 };
  const failed = Number(run.failedCount ?? (Array.isArray(run.failed) ? run.failed.length : 0));
  const scale = `📄 文档索引（doc-index）：${run.totalDocs ?? 0} 篇 / ${run.totalRows ?? 0} 条`;
  const detail = `本轮 重建 ${run.rebuilt ?? 0} · 跳过 ${run.skipped ?? 0} · 写库 ${run.upserted ?? 0} · 清孤条 ${run.staleDeleted ?? 0}`;
  const bill = `失败 ${failed} · 成本 ${cost.calls ?? 0} 次调用 ${cost.tokens ?? 0} token`;
  const flag = failed ? ` ⚠️ ${String(run.failed?.[0]?.error ?? '').slice(0, 80)}` : '';
  return `${scale} · ${detail} · ${bill}${flag}`;
}

// 当日日报路径（与日报其它段同一口径：<docsDir>/管家报告/<YYYY-MM-DD>-<host>.md）
export function dailyReportPath({ docsDir = DEFAULT_DOCS_ROOT, host, now = Date.now() } = {}) {
  const when = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  return path.join(docsDir, '管家报告', `${date}-${host || os.hostname()}.md`);
}

// 段体替换：从标题行之后一路换到「下一个二级标题」之前
function swapSection(rows, at, block) {
  let stop = rows.length;
  for (let i = at + 1; i < rows.length; i += 1) {
    if (/^##\s/.test(rows[i])) {
      stop = i;
      break;
    }
  }
  return [...rows.slice(0, at), ...block, ...rows.slice(stop)].join('\n');
}

/**
 * 幂等更新当日日报里的「文档索引」段。**文件不存在就不新建** ——
 * 日报是别的模块的产物，本模块只负责往里补一行。
 * @returns {{ok:boolean, file:string, reason?:string, created?:boolean}}
 */
export function updateDailySection({
  file,
  line,
  dryRun = false,
}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, file, reason: 'daily-missing' };
  }

  const rows = text.split(/\r?\n/);
  const sectionLines = [DAILY_SECTION_TITLE, '', `> ${line}`, ''];
  const at = rows.findIndex((row) => row.trim() === DAILY_SECTION_TITLE);
  const created = at < 0;
  const out = created
    ? `${text.replace(/\s*$/, '')}\n\n${sectionLines.join('\n')}`
    : swapSection(rows, at, sectionLines);

  if (!created && out === text) return { ok: true, file, reason: 'unchanged', created: false };
  if (dryRun) return { ok: true, file, reason: 'dry-run', created };
  try {
    writeAtomic(file, out);
  } catch (err) {
    return { ok: false, file, reason: `write-failed:${String((err && err.message) || err)}` };
  }
  return { ok: true, file, created };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

// 注入点：单测把外部依赖整件换掉 ⇒ 零副作用、零网络
const resolveHooks = (deps) => ({
  readState: deps.readState ?? readState,
  writeState: deps.writeState ?? writeState,
  openStore: deps.openStore ?? openDocIndexStore,
  scanDocs: deps.scanDocs ?? scanDocs,
  readDoc: deps.readDoc ?? readDoc,
  summarize: deps.summarizeAll ?? summarizeAll,
  upsert: deps.upsertDocs ?? upsertDocs,
  purge: deps.deleteStaleRows ?? deleteStaleRows,
  list: deps.listRows ?? listRows,
});

// 各类路径一律三档：flags > 环境变量 > 默认值
function resolvePaths(flags, env) {
  const homeFlag = String(flags.home || env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const docsFlag = String(flags['docs-root'] || env.DOC_INDEX_DOCS_ROOT || DEFAULT_DOCS_ROOT);
  const dbFlag = String(flags['doc-index-db'] || env.DOC_INDEX_DB || path.join(homeFlag, 'memory-vectors', 'doc-index.db'));
  const stateFlag = String(flags['state-file'] || path.join(homeFlag, 'butler-doc-index-state.json'));
  return {
    home: path.resolve(homeFlag),
    docsRoot: path.resolve(docsFlag),
    dshRoot: path.resolve(String(flags['dsh-root'] || DEFAULT_DSH_ROOT)),
    dbPath: path.resolve(dbFlag),
    stateFile: path.resolve(stateFlag),
  };
}

// 计数段拆两块：中间夹着三个「数组型」字段，这样字段顺序与既有 state 文件一致
const RUN_COUNTS_A = ['rebuilt', 'skipped', 'upserted', 'inserted', 'updated', 'unchanged', 'staleDeleted', 'longDocs'];
const RUN_COUNTS_B = ['batches', 'busyWaits', 'llmCalls', 'llmTokens'];

function freshStats({ docsRoot, dbPath, stateFile, startedAt }) {
  const tally = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
  return {
    scope: null, scopeSource: null,
    docsRoot, dbPath, stateFile,
    scanned: 0, considered: 0, totalDocs: 0, totalRows: 0,
    ...tally(RUN_COUNTS_A),
    failures: [], failed: [], failedCount: 0, missing: [],
    ...tally(RUN_COUNTS_B),
    rowsByDoc: {}, decisions: {},
    startedAt, finishedAt: 0, elapsedMs: 0,
  };
}

// 模型通路要的三件：key（flags / 环境 / 凭证文件三档）、端点、模型名
function buildLlmConfig(flags, env, home) {
  const key = flags['llm-key'] || resolveApiKey({ env, credentialsFile: path.join(home, '.credentials.yaml') });
  const endpoint = String(flags['llm-base-url'] || env.DOC_INDEX_LLM_BASE_URL || 'https://api.deepseek.com');
  const model = String(flags['llm-model'] || env.DOC_INDEX_LLM_MODEL || 'deepseek-flash');
  return { apiKey: key, baseUrl: endpoint, model };
}

/**
 * 跑一轮文档索引（纯编排）。
 * @returns {Promise<{ok:boolean, exitCode:number, status:string, stats:object, state:object, lines:string[]}>}
 */
export async function runDocIndexOnce({
  flags = {},
  env = process.env,
  now = () => Date.now(),
  deps = {},
} = {}) {
  const notes = [];
  const note = (msg) => notes.push(String(msg));
  const impl = resolveHooks(deps);

  const isDry = Boolean(flags['dry-run']);
  const forceAll = Boolean(flags.rebuild) || Boolean(flags.force);
  const perBatch = Number(flags.batch ?? DEFAULT_BATCH) || DEFAULT_BATCH;
  const wantLlm = Boolean(flags.llm);
  const startAt = now();
  const { home, docsRoot, dshRoot, dbPath, stateFile } = resolvePaths(flags, env);
  const hostTag = flags.host || os.hostname();

  const prior = impl.readState(stateFile) ?? {};
  const clock = new Date(startAt);
  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = `${clock.getFullYear()}-${pad(clock.getMonth() + 1)}-${pad(clock.getDate())}`;
  const cost = rolloverCost(prior.cost ?? emptyCost(dateKey), dateKey);
  const stats = freshStats({ docsRoot, dbPath, stateFile, startedAt: startAt });

  // 收尾：补耗时 → 拼 state → 落盘（dry-run 不写）→ 返回 state
  const wrapUp = (status, extra = {}) => {
    stats.finishedAt = now();
    stats.elapsedMs = stats.finishedAt - stats.startedAt;
    const stampIso = new Date(stats.finishedAt).toISOString();
    const nextState = {
      ...prior,
      schemaVersion: DOC_INDEX_STATE_SCHEMA,
      hostId: hostTag, docsRoot, dbPath, stateFile,
      runs: (prior.runs ?? 0) + 1,
      lastRunAt: stampIso,
      lastStatus: status,
      lastRun: stats,
      paths: extra.paths ?? prior.paths ?? {},
      history: pushHistory(prior, {
        at: stampIso, status,
        rebuilt: stats.rebuilt, skipped: stats.skipped,
        upserted: stats.upserted, failed: stats.failedCount,
      }),
      cost: extra.cost ?? cost,
    };
    nextState.lastDailyLine = renderDailyLine(nextState);
    if (!isDry) impl.writeState(stateFile, nextState);
    return nextState;
  };

  // ① 扫描面 + 范围
  const surface = impl.scanDocs(docsRoot, { dshRoot });
  stats.scanned = surface.length;
  const range = resolveScope({ scanned: surface, flags });
  stats.scope = range.mode;
  stats.scopeSource = range.source;
  stats.considered = range.docs.length;
  stats.missing = range.missing;
  note(
    `[doc-index] 扫描面 ${surface.length} 篇（已排除 变更流水 / 管家报告 / 坑库 / _archive）`
      + ` · 本轮范围 ${range.mode} = ${range.docs.length} 篇（${range.source}）`,
  );
  if (range.missing.length) {
    note(`[doc-index] ⚠️ 清单里 ${range.missing.length} 篇不在扫描面内：${range.missing.join('、')}`);
  }
  if (!range.docs.length) {
    const nextState = wrapUp('empty', { paths: prior.paths ?? {} });
    return { ok: true, exitCode: 0, status: 'empty', stats, state: nextState, lines: notes };
  }

  // 独立库：dry-run 且库还不存在 ⇒ 不建库、不建目录
  let handle = null;
  if (!isDry || fs.existsSync(dbPath)) handle = impl.openStore(dbPath, { create: !isDry, hostId: hostTag });
  const conn = handle?.db ?? null;

  let digests = { byKey: new Map(), cost, calls: 0, tokens: 0, stopped: null, failures: [], skippedForFamily: [] };

  try {
    // ② 差分
    const priorPaths = prior.paths ?? {};
    const dirty = [];
    for (const doc of range.docs) {
      const prevEntry = priorPaths[doc.rel] ?? null;
      const hasRow = conn ? hasDocRows(conn, doc.rel) : Boolean(priorPaths[doc.rel]);
      const verdict = needsRebuild({ doc, prevEntry, hasRow, force: forceAll });
      stats.decisions[doc.rel] = verdict;
      if (verdict.rebuild) {
        dirty.push({ doc, reason: verdict.reason });
        continue;
      }
      stats.skipped += 1;
      note(`[doc-index] 跳过 ${doc.rel}（未变：mtime/size 与 state 一致，库里也已有条）`);
    }

    // ③ 读正文 → 解析 → 切条，顺带攒出要送去出摘要的那批
    const planMap = new Map();
    const toSummarize = [];
    for (const item of dirty) {
      try {
        const { text, chars } = impl.readDoc(item.doc.abs);
        const doc = { ...item.doc, chars, structure: parseStructure(text) };
        planMap.set(doc.rel, { doc, rows: planRows(doc), reason: item.reason });
        toSummarize.push(doc);
      } catch (err) {
        stats.failures.push({ path: item.doc.rel, error: `读取/解析失败：${String((err && err.message) || err)}` });
      }
    }

    if (toSummarize.length) {
      digests = await impl.summarize({
        docs: toSummarize,
        plans: new Map([...planMap].map(([rel, entry]) => [rel, entry.rows])),
        mode: wantLlm ? 'llm' : 'rule',
        cost,
        date: dateKey,
        llm: wantLlm ? buildLlmConfig(flags, env, home) : null,
        deps,
      });
      for (const failure of digests.failures ?? []) stats.failures.push(failure);
      stats.llmCalls = Number(digests.calls) || 0;
      stats.llmTokens = Number(digests.tokens) || 0;
      if (digests.stopped) note(`[doc-index] ⛔ 成本闸：${digests.stopped} ⇒ 本轮剩余文档停止（不重试）`);
    }

    // ④ 组 payload 并分批写库
    const writes = [];
    for (const [rel, entry] of planMap) {
      const usable = entry.rows.filter((row) => digests.byKey.has(row.key));
      const lost = entry.rows.length - usable.length;
      if (lost > 0) {
        stats.failures.push({
          path: rel,
          error: `摘要缺失 ${lost}/${entry.rows.length} 条（成本闸中止或上游失败）⇒ 该篇跳过，下轮重试`,
        });
      }
      if (!usable.length) continue;
      stats.rebuilt += 1;
      stats.rowsByDoc[rel] = usable.length;
      if (entry.rows.length > 1) stats.longDocs += 1;
      for (const row of usable) {
        const digest = digests.byKey.get(row.key);
        writes.push({
          path: row.key,
          mtime: entry.doc.mtime,
          size: entry.doc.size,
          textHash: digest.textHash,
          summary: digest.summary,
          ownerUser: flags['owner-user'] || 'LiJianXiao',
          visibility: flags.visibility || 'private_owner',
          // 索引条描述的是**这篇文档的 mtime**，不是写入时刻
          updatedAt: entry.doc.mtime,
        });
      }
    }
    stats.totalRows = Object.values(stats.rowsByDoc).reduce((sum, n) => sum + n, 0);
    stats.totalDocs = Object.keys(stats.rowsByDoc).length;

    if (writes.length && isDry) note(`[doc-index] --dry-run：本应写 ${writes.length} 条（未写库）`);
    if (writes.length && !isDry) {
      for (let at = 0; at < writes.length; at += perBatch) {
        const batch = writes.slice(at, at + perBatch);
        stats.batches += 1;
        const outcome = await withBusyRetry(() => impl.upsert(conn, batch), {
          sleep: deps.sleep,
          delaysMs: deps.retryDelaysMs,
          onRetry: (n, err) => {
            stats.busyWaits += 1;
            note(`[doc-index] 库被锁，退避重试第 ${n} 次（${String((err && err.message) || err)}）`);
          },
        });
        if (!outcome.ok) {
          // 超限只记失败、不抛；失败细到每篇，下一轮只重跑这些
          for (const cell of batch) {
            const rel = String(cell.path).split('#§')[0];
            if (!stats.failures.some((f) => f.path === rel)) stats.failures.push({ path: rel, error: outcome.error });
          }
          note(`[doc-index] ❌ 批 ${stats.batches} 写库失败（放弃该批，下轮重试）：${outcome.error}`);
          continue;
        }
        stats.upserted += outcome.value.inserted + outcome.value.updated;
        stats.inserted += outcome.value.inserted;
        stats.updated += outcome.value.updated;
        stats.unchanged += outcome.value.unchanged;
      }
    }

    // ⑤ 清孤条：只清本轮重建过的篇，跳过与失败的一律不动
    if (!isDry && conn) {
      for (const [rel, entry] of planMap) {
        const keep = entry.rows.filter((row) => digests.byKey.has(row.key)).map((row) => row.key);
        if (!keep.length) continue;
        const outcome = await withBusyRetry(() => impl.purge(conn, rel, keep), {
          sleep: deps.sleep,
          delaysMs: deps.retryDelaysMs,
        });
        if (outcome.ok) stats.staleDeleted += Number(outcome.value) || 0;
        else stats.failures.push({ path: rel, error: `清孤条失败：${outcome.error}` });
      }
    }

    // ⑥ 元数据 + 规模取库内真实值（跳过轮也要显示真实规模，不能按本轮写了多少算）
    if (!isDry && conn) {
      await withBusyRetry(
        () => {
          setMeta(conn, META_KEYS.hostId, hostTag);
          setMeta(conn, META_KEYS.lastRunAt, new Date(stats.finishedAt || now()).toISOString());
          const snapshotOfRun = { rebuilt: stats.rebuilt, skipped: stats.skipped, upserted: stats.upserted, failed: stats.failures.length };
          setMeta(conn, META_KEYS.lastRunStats, JSON.stringify(snapshotOfRun));
        },
        { sleep: deps.sleep },
      );
      try {
        const all = impl.list(conn);
        stats.totalRows = all.length;
        stats.totalDocs = new Set(all.map((row) => String(row.path).split('#§')[0])).size;
      } catch {
        // 查不动就保持既有值
      }
    }
  } catch (err) {
    stats.failures.push({ path: '(run)', error: `运行异常：${String((err && err.message) || err)}` });
    note(`[doc-index] ❌ 运行异常（只记失败，不影响其它机制）：${String((err && err.message) || err)}`);
  } finally {
    try {
      if (handle) handle.db.close();
    } catch {
      // 关不掉也没事，进程退出会收
    }
  }

  // 每篇的 state 条目：mtime / size / lastResult / failCount（四字段是验收口径）
  // lastResult 含义：ok = 本轮重建过；skipped = 本轮确认未变；failed = 本轮失败（下轮强制重算）
  const perPath = { ...(prior.paths ?? {}) };
  const failByPath = new Map(stats.failures.map((failure) => [failure.path, failure.error]));
  const stamp = new Date(stats.finishedAt || now()).toISOString();
  for (const doc of range.docs) {
    const before = perPath[doc.rel] ?? { failCount: 0 };
    const rebuiltOK = Object.prototype.hasOwnProperty.call(stats.rowsByDoc, doc.rel);
    let lastResult = rebuiltOK ? 'ok' : 'skipped';
    if (failByPath.has(doc.rel)) lastResult = 'failed';
    perPath[doc.rel] = {
      mtime: doc.mtime,
      size: doc.size,
      lastResult,
      failCount: lastResult === 'failed' ? Number(before.failCount || 0) + 1 : 0,
      rows: stats.rowsByDoc[doc.rel] ?? before.rows ?? 0,
      reason: stats.decisions[doc.rel]?.reason ?? null,
      updatedAt: stamp,
      error: failByPath.get(doc.rel) ?? null,
    };
  }

  stats.failed = stats.failures.filter((failure) => failure.path !== '(run)');
  stats.failedCount = stats.failed.length;
  const status = stats.failedCount ? 'failed' : stats.rebuilt === 0 ? 'noop' : 'ok';
  const nextState = wrapUp(status, {
    paths: perPath,
    cost: { date: digests.cost?.date ?? dateKey, calls: stats.llmCalls, tokens: stats.llmTokens },
  });

  // 日报一行（默认写；dry-run 或 --no-daily 只算不写；日报不存在则不新建）
  const reportFile = dailyReportPath({ docsDir: docsRoot, host: hostTag, now: startAt });
  const dailyResult = updateDailySection({
    file: reportFile,
    line: nextState.lastDailyLine,
    dryRun: isDry || Boolean(flags['no-daily']),
  });
  stats.daily = dailyResult;

  note(`[doc-index] 日报一行：${nextState.lastDailyLine}`);
  note(`[doc-index] 日报落点：${reportFile}（${dailyResult.ok ? dailyResult.reason ?? 'written' : dailyResult.reason}）`);
  note(
    `[doc-index] ${status === 'failed' ? '⚠️' : '✅'} 重建 ${stats.rebuilt} / 跳过 ${stats.skipped}`
      + ` · 写库 ${stats.upserted}（新 ${stats.inserted} / 更 ${stats.updated} / 同哈希 ${stats.unchanged}）`
      + ` · 清孤条 ${stats.staleDeleted} · 失败 ${stats.failedCount} · ${stats.elapsedMs}ms`,
  );
  return { ok: true, exitCode: 0, status, stats, state: nextState, lines: notes };
}
