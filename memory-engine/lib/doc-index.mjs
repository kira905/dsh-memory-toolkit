// 记忆引擎 v2 · 离线层 —— 文档索引器主编排（方案 §3.2 / §5.2 / §5.4 / §7）
//
// 一轮做的事（顺序即语义）：
//   ① 扫描面（`docs/**/*.md`，排除 4 类）+ 取范围（首期 10 篇 / --all / --only）
//   ② 差分：比对 state 里的 `mtime/size` + 库中是否已有条 ⇒ **没变的一篇都不碰**
//      （「变了才 UPSERT 该篇」＝ §5.4 去重键口径；幂等靠 path 主键）
//   ③ 变了 → 生成摘要（rule 确定性 / llm 受 §3.5 成本闸）→ 逐批 UPSERT（busy_timeout + 重试 3 次 / 退避 ≤60s）
//   ④ 清孤条（文档变短后残留的 `path#§N`）
//   ⑤ 写 state（原子） + 日报一行；**任何失败都只记不抛**（卡要求"不报错给主人"）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { textHash } from './hashes.mjs';
import {
  DEFAULT_DOCS_ROOT,
  DEFAULT_DSH_ROOT,
  FIRST_BATCH,
  FIRST_BATCH_SOURCE,
  parseStructure,
  planRows,
  readDoc,
  scanDocs,
} from './doc-scan.mjs';
import { emptyCost, resolveApiKey, rolloverCost, summarizeAll } from './doc-summarize.mjs';
import {
  META_KEYS,
  deleteStaleRows,
  hasDocRows,
  listRows,
  openDocIndexStore,
  setMeta,
  upsertDocs,
  withBusyRetry,
} from './doc-index-store.mjs';

export const DOC_INDEX_STATE_SCHEMA = 1;
export const HISTORY_MAX = 20;
/** 小批量（方案 §5.2：独立库各自加锁 + 小批量）。 */
export const DEFAULT_BATCH = 5;

// ---------------------------------------------------------------- state

export function readState(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null; // 缺失/损坏一律当"首次运行"（state 是可重建载体）
  }
}

export function writeState(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file); // 同目录 rename：原子且不跨盘（跨盘 rename 必炸，铁律）
    return true;
  } catch {
    return false;
  }
}

export function pushHistory(prev, entry, max = HISTORY_MAX) {
  const hist = Array.isArray(prev?.history) ? prev.history.slice(-(max - 1)) : [];
  hist.push(entry);
  while (hist.length > max) hist.shift();
  return hist;
}

// ---------------------------------------------------------------- 范围与差分

/** 解析本轮范围：`--all` 全扫描面 / `--only a,b` 指定 / 默认首期 10 篇。 */
export function resolveScope({ scanned, flags = {} }) {
  const byRel = new Map(scanned.map((d) => [d.rel, d]));
  if (flags.all || flags.scope === 'all') {
    return { mode: 'all', source: '扫描面全量（--all）', docs: scanned, missing: [] };
  }
  const only =
    typeof flags.only === 'string' && flags.only.trim()
      ? flags.only.split(',').map((s) => s.trim()).filter(Boolean)
      : null;
  const want = only ?? FIRST_BATCH;
  const docs = [];
  const missing = [];
  for (const rel of want) {
    const hit = byRel.get(rel);
    if (hit) docs.push(hit);
    else missing.push(rel);
  }
  return {
    mode: only ? 'only' : 'first-batch',
    source: only ? '--only 显式指定' : FIRST_BATCH_SOURCE,
    docs,
    missing,
  };
}

/**
 * 是否要重建该篇。判据（方案 §3.2「比对 mtime/size/text_hash，变了才 UPSERT 该篇」）：
 *   state 里 mtime/size 未变 **且** 上次结果 ok **且** 库中已有该篇主条 ⇒ 跳过，一个字节都不碰。
 * @param {{doc:object, prevEntry:object|null, hasRow:boolean, force:boolean}} p
 */
export function needsRebuild({ doc, prevEntry, hasRow, force = false }) {
  if (force) return { rebuild: true, reason: 'forced' };
  if (!prevEntry) return { rebuild: true, reason: 'new' };
  if (Number(prevEntry.mtime) !== Number(doc.mtime) || Number(prevEntry.size) !== Number(doc.size)) {
    return { rebuild: true, reason: 'mtime-or-size-changed' };
  }
  // ⚠️ 只有 **failed** 才强制重算；'ok'（本轮重建过）与 'skipped'（本轮已确认最新）都表示"已同步"。
  //    实测踩过：把 'skipped' 也当"未同步" ⇒ 跳过轮与重建轮来回振荡（永远有一半的轮次在重算摘要）。
  if (prevEntry.lastResult === 'failed') return { rebuild: true, reason: 'last-failed' };
  if (!hasRow) return { rebuild: true, reason: 'missing-in-db' };
  return { rebuild: false, reason: 'unchanged' };
}

// ---------------------------------------------------------------- 日报一行

/** 日报一行文案（纯函数；state 与日报段共用）。 */
export function renderDailyLine(state) {
  const r = state?.lastRun ?? {};
  const cost = state?.cost ?? { calls: 0, tokens: 0 };
  const failed = Number(r.failedCount ?? (Array.isArray(r.failed) ? r.failed.length : 0));
  const head = `📄 文档索引（doc-index）：${r.totalDocs ?? 0} 篇 / ${r.totalRows ?? 0} 条`;
  const detail = `本轮 重建 ${r.rebuilt ?? 0} · 跳过 ${r.skipped ?? 0} · 写库 ${r.upserted ?? 0} · 清孤条 ${r.staleDeleted ?? 0}`;
  const tail = `失败 ${failed} · 成本 ${cost.calls ?? 0} 次调用 ${cost.tokens ?? 0} token`;
  const warn = failed ? ` ⚠️ ${String(r.failed?.[0]?.error ?? '').slice(0, 80)}` : '';
  return `${head} · ${detail} · ${tail}${warn}`;
}

/** 当日日报路径（与 report.mjs 同口径：`<docsDir>\管家报告\<YYYY-MM-DD>-<host>.md`）。 */
export function dailyReportPath({ docsDir = DEFAULT_DOCS_ROOT, host, now = Date.now() } = {}) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return path.join(docsDir, '管家报告', `${date}-${host || os.hostname()}.md`);
}

export const DAILY_SECTION_TITLE = '## 📄 文档索引（doc-index）';

/**
 * 幂等更新当日日报里的「📄 文档索引」段：**文件不存在则不新建**
 * （照既有先例「日报缺失 → 跳过不报错」；日报是 report.mjs 的产物，本模块只往里补一行）。
 * @returns {{ok:boolean, file:string, reason?:string, created?:boolean}}
 */
export function updateDailySection({ file, line, dryRun = false }) {
  let txt;
  try {
    txt = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, file, reason: 'daily-missing' };
  }
  const lines = txt.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === DAILY_SECTION_TITLE);
  const block = [DAILY_SECTION_TITLE, '', `> ${line}`, ''];
  let out;
  let created = false;
  if (idx < 0) {
    out = `${txt.replace(/\s*$/, '')}\n\n${block.join('\n')}`;
    created = true;
  } else {
    // 段体 = 标题之后到下一个 `## ` 之前
    let end = lines.length;
    for (let j = idx + 1; j < lines.length; j += 1) {
      if (/^##\s/.test(lines[j])) {
        end = j;
        break;
      }
    }
    out = [...lines.slice(0, idx), ...block, ...lines.slice(end)].join('\n');
    if (out === txt) return { ok: true, file, reason: 'unchanged', created: false };
  }
  if (dryRun) return { ok: true, file, reason: 'dry-run', created };
  try {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, out, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, file, reason: `write-failed:${String((e && e.message) || e)}` };
  }
  return { ok: true, file, created };
}

// ---------------------------------------------------------------- 主流程

/**
 * 跑一轮文档索引（纯编排；外部依赖可注入 ⇒ 单测零副作用、零网络）。
 * @returns {Promise<{ok:boolean, exitCode:number, status:string, stats:object, state:object, lines:string[]}>}
 */
export async function runDocIndexOnce({ flags = {}, env = process.env, now = () => Date.now(), deps = {} } = {}) {
  const lines = [];
  const log = (m) => lines.push(String(m));
  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags.rebuild) || Boolean(flags.force);
  const batchSize = Number(flags.batch ?? DEFAULT_BATCH) || DEFAULT_BATCH;
  const useLlm = Boolean(flags.llm);
  const startedAt = now();

  const docsRoot = path.resolve(String(flags['docs-root'] || env.DOC_INDEX_DOCS_ROOT || DEFAULT_DOCS_ROOT));
  const dshRoot = path.resolve(String(flags['dsh-root'] || DEFAULT_DSH_ROOT));
  const home = path.resolve(String(flags.home || env.DSH_HOME || path.join(os.homedir(), '.dsh')));
  const dbPath = path.resolve(
    String(flags['doc-index-db'] || env.DOC_INDEX_DB || path.join(home, 'memory-vectors', 'doc-index.db')),
  );
  const stateFile = path.resolve(String(flags['state-file'] || path.join(home, 'butler-doc-index-state.json')));
  const hostId = flags.host || os.hostname();

  const readStateFn = deps.readState ?? readState;
  const writeStateFn = deps.writeState ?? writeState;
  const openStore = deps.openStore ?? openDocIndexStore;
  const scanFn = deps.scanDocs ?? scanDocs;
  const readDocFn = deps.readDoc ?? readDoc;
  const summarizeFn = deps.summarizeAll ?? summarizeAll;
  const upsertFn = deps.upsertDocs ?? upsertDocs;
  const deleteStaleFn = deps.deleteStaleRows ?? deleteStaleRows;

  const prev = readStateFn(stateFile) ?? {};
  const d = new Date(startedAt);
  const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cost = rolloverCost(prev.cost ?? emptyCost(dateKey), dateKey);

  const stats = {
    scope: null,
    scopeSource: null,
    docsRoot,
    dbPath,
    stateFile,
    scanned: 0,
    considered: 0,
    totalDocs: 0,
    totalRows: 0,
    rebuilt: 0,
    skipped: 0,
    upserted: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    staleDeleted: 0,
    longDocs: 0,
    failures: [],
    failed: [],
    failedCount: 0,
    missing: [],
    batches: 0,
    busyWaits: 0,
    llmCalls: 0,
    llmTokens: 0,
    rowsByDoc: {},
    decisions: {},
    startedAt,
    finishedAt: 0,
    elapsedMs: 0,
  };

  const finish = (status, extra = {}) => {
    stats.finishedAt = now();
    stats.elapsedMs = stats.finishedAt - stats.startedAt;
    const state = {
      ...prev,
      schemaVersion: DOC_INDEX_STATE_SCHEMA,
      hostId,
      docsRoot,
      dbPath,
      stateFile,
      runs: (prev.runs ?? 0) + 1,
      lastRunAt: new Date(stats.finishedAt).toISOString(),
      lastStatus: status,
      lastRun: stats,
      paths: extra.paths ?? prev.paths ?? {},
      history: pushHistory(prev, {
        at: new Date(stats.finishedAt).toISOString(),
        status,
        rebuilt: stats.rebuilt,
        skipped: stats.skipped,
        upserted: stats.upserted,
        failed: stats.failedCount,
      }),
      cost: extra.cost ?? cost,
    };
    state.lastDailyLine = renderDailyLine(state);
    if (!dryRun) writeStateFn(stateFile, state);
    return state;
  };

  // ① 扫描面 + 范围
  const scanned = scanFn(docsRoot, { dshRoot });
  stats.scanned = scanned.length;
  const scope = resolveScope({ scanned, flags });
  stats.scope = scope.mode;
  stats.scopeSource = scope.source;
  stats.considered = scope.docs.length;
  stats.missing = scope.missing;
  log(
    `[doc-index] 扫描面 ${scanned.length} 篇（已排除 变更流水/管家报告/坑库/_archive）`
      + ` · 本轮范围 ${scope.mode} = ${scope.docs.length} 篇（${scope.source}）`,
  );
  if (scope.missing.length) {
    log(`[doc-index] ⚠️ 清单里 ${scope.missing.length} 篇不在扫描面内：${scope.missing.join('、')}`);
  }

  if (!scope.docs.length) {
    const state = finish('empty', { paths: prev.paths ?? {} });
    return { ok: true, exitCode: 0, status: 'empty', stats, state, lines };
  }

  // 打开独立库（dry-run 且库不存在 ⇒ 不建库、不建目录）
  let store = null;
  if (!dryRun || fs.existsSync(dbPath)) {
    store = openStore(dbPath, { create: !dryRun, hostId });
  }
  const db = store?.db ?? null;
  let summaries = { byKey: new Map(), cost, calls: 0, tokens: 0, stopped: null, failures: [], skippedForFamily: [] };

  try {
    // ② 差分
    const prevPaths = prev.paths ?? {};
    const rebuildList = [];
    for (const doc of scope.docs) {
      const hasRow = db ? hasDocRows(db, doc.rel) : Boolean(prevPaths[doc.rel]);
      const decision = needsRebuild({ doc, prevEntry: prevPaths[doc.rel] ?? null, hasRow, force });
      stats.decisions[doc.rel] = decision;
      if (!decision.rebuild) {
        stats.skipped += 1;
        log(`[doc-index] 跳过 ${doc.rel}（未变：mtime/size 与 state 一致且库中已有条）`);
        continue;
      }
      rebuildList.push({ doc, reason: decision.reason });
    }

    // ③ 读文档 + 解析 + 切条 + 生成摘要
    const planMap = new Map();
    const docsForSummary = [];
    for (const item of rebuildList) {
      try {
        const { text, chars } = readDocFn(item.doc.abs);
        const structure = parseStructure(text);
        const doc = { ...item.doc, chars, structure };
        planMap.set(doc.rel, { doc, rows: planRows(doc), reason: item.reason });
        docsForSummary.push(doc);
      } catch (e) {
        stats.failures.push({ path: item.doc.rel, error: `读取/解析失败：${String((e && e.message) || e)}` });
      }
    }

    if (docsForSummary.length) {
      summaries = await summarizeFn({
        docs: docsForSummary,
        plans: new Map([...planMap].map(([rel, v]) => [rel, v.rows])),
        mode: useLlm ? 'llm' : 'rule',
        cost,
        date: dateKey,
        llm: useLlm ? buildLlmConfig(flags, env, home) : null,
        deps,
      });
      for (const f of summaries.failures ?? []) stats.failures.push(f);
      stats.llmCalls = Number(summaries.calls) || 0;
      stats.llmTokens = Number(summaries.tokens) || 0;
      if (summaries.stopped) log(`[doc-index] ⛔ 成本闸：${summaries.stopped} ⇒ 本轮剩余文档停止（不重试）`);
    }

    // ④ 分批 UPSERT
    const payload = [];
    for (const [rel, entry] of planMap) {
      const usable = entry.rows.filter((r) => summaries.byKey.has(r.key));
      if (usable.length !== entry.rows.length) {
        stats.failures.push({
          path: rel,
          error: `摘要缺失 ${entry.rows.length - usable.length}/${entry.rows.length} 条（成本闸中止或上游失败）⇒ 该篇跳过，下轮重试`,
        });
      }
      if (!usable.length) continue;
      stats.rebuilt += 1;
      stats.rowsByDoc[rel] = usable.length;
      if (entry.rows.length > 1) stats.longDocs += 1;
      for (const r of usable) {
        const s = summaries.byKey.get(r.key);
        payload.push({
          path: r.key,
          mtime: entry.doc.mtime,
          size: entry.doc.size,
          textHash: s.textHash,
          summary: s.summary,
          ownerUser: flags['owner-user'] || 'LiJianXiao',
          visibility: flags.visibility || 'private_owner',
          updatedAt: entry.doc.mtime, // 索引条描述的是**该文档的 mtime**（方案 §3.2 索引条形态）
        });
      }
    }
    stats.totalRows = Object.values(stats.rowsByDoc).reduce((a, b) => a + b, 0);
    stats.totalDocs = Object.keys(stats.rowsByDoc).length;

    if (payload.length && !dryRun) {
      for (let i = 0; i < payload.length; i += batchSize) {
        const chunk = payload.slice(i, i + batchSize);
        stats.batches += 1;
        const r = await withBusyRetry(() => upsertFn(db, chunk), {
          sleep: deps.sleep,
          delaysMs: deps.retryDelaysMs,
          onRetry: (n, e) => {
            stats.busyWaits += 1;
            log(`[doc-index] 库被锁，退避重试第 ${n} 次（${String((e && e.message) || e)}）`);
          },
        });
        if (!r.ok) {
          // 超限记 failed（不报错给主人）；细到每篇，下轮只重跑这些
          for (const c of chunk) {
            const rel = String(c.path).split('#§')[0];
            if (!stats.failures.some((f) => f.path === rel)) stats.failures.push({ path: rel, error: r.error });
          }
          log(`[doc-index] ❌ 批 ${stats.batches} 写库失败（放弃该批，下轮重试）：${r.error}`);
          continue;
        }
        stats.upserted += r.value.inserted + r.value.updated;
        stats.inserted += r.value.inserted;
        stats.updated += r.value.updated;
        stats.unchanged += r.value.unchanged;
      }
    } else if (payload.length && dryRun) {
      log(`[doc-index] --dry-run：本应写 ${payload.length} 条（未写库）`);
    }

    // ⑤ 清孤条（只清已重建的篇；跳过的与失败的都不动）
    if (!dryRun && db) {
      for (const [rel, entry] of planMap) {
        const keep = entry.rows.filter((r) => summaries.byKey.has(r.key)).map((r) => r.key);
        if (!keep.length) continue;
        const r = await withBusyRetry(() => deleteStaleFn(db, rel, keep), { sleep: deps.sleep, delaysMs: deps.retryDelaysMs });
        if (r.ok) stats.staleDeleted += Number(r.value) || 0;
        else stats.failures.push({ path: rel, error: `清孤条失败：${r.error}` });
      }
    }

    // ⑥ meta
    if (!dryRun && db) {
      await withBusyRetry(
        () => {
          setMeta(db, META_KEYS.hostId, hostId);
          setMeta(db, META_KEYS.lastRunAt, new Date(stats.finishedAt || now()).toISOString());
          setMeta(
            db,
            META_KEYS.lastRunStats,
            JSON.stringify({
              rebuilt: stats.rebuilt,
              skipped: stats.skipped,
              upserted: stats.upserted,
              failed: stats.failures.length,
            }),
          );
        },
        { sleep: deps.sleep },
      );
      // 规模以**库内真实值**为准：跳过轮（本轮没重建任何一篇）也必须显示真实规模，
      // 不能按"本轮写了多少"算 —— 否则日报一行会在跳过轮显示 "0 篇 / 0 条"（实测踩过）。
      try {
        const all = (deps.listRows ?? listRows)(db);
        stats.totalRows = all.length;
        stats.totalDocs = new Set(all.map((r) => String(r.path).split('#§')[0])).size;
      } catch {
        /* 查询失败保持既有值 */
      }
    }
  } catch (e) {
    stats.failures.push({ path: '(run)', error: `运行异常：${String((e && e.message) || e)}` });
    log(`[doc-index] ❌ 运行异常（只记失败，不影响其它机制）：${String((e && e.message) || e)}`);
  } finally {
    try {
      if (store) store.db.close();
    } catch {
      /* ignore */
    }
  }

  // per-path state（mtime / size / lastResult / failCount —— 卡要求四字段）
  // lastResult 语义：'ok' 本轮重建过 / 'skipped' 本轮确认未变 / 'failed' 本轮失败（下轮强制重算）
  const paths = { ...(prev.paths ?? {}) };
  const failedMap = new Map(stats.failures.map((f) => [f.path, f.error]));
  const stampIso = new Date(stats.finishedAt || now()).toISOString();
  for (const doc of scope.docs) {
    const prevEntry = paths[doc.rel] ?? { failCount: 0 };
    const rebuiltDone = Object.prototype.hasOwnProperty.call(stats.rowsByDoc, doc.rel);
    const decision = stats.decisions[doc.rel] ?? {};
    let lastResult = rebuiltDone ? 'ok' : 'skipped';
    if (failedMap.has(doc.rel)) lastResult = 'failed';
    paths[doc.rel] = {
      mtime: doc.mtime,
      size: doc.size,
      lastResult,
      failCount: lastResult === 'failed' ? Number(prevEntry.failCount || 0) + 1 : 0,
      rows: stats.rowsByDoc[doc.rel] ?? prevEntry.rows ?? 0,
      reason: decision.reason ?? null,
      updatedAt: stampIso,
      error: failedMap.get(doc.rel) ?? null,
    };
  }
  stats.failed = stats.failures.filter((f) => f.path !== '(run)');
  stats.failedCount = stats.failed.length;
  const status = stats.failedCount ? 'failed' : stats.rebuilt === 0 ? 'noop' : 'ok';
  const state = finish(status, {
    paths,
    cost: { date: summaries.cost?.date ?? dateKey, calls: stats.llmCalls, tokens: stats.llmTokens },
  });

  // 日报一行（默认写；`--no-daily` 关闭。日报文件不存在 ⇒ 不新建，只记 reason）
  const dailyFile = dailyReportPath({ docsDir: docsRoot, host: hostId, now: startedAt });
  const daily = updateDailySection({
    file: dailyFile,
    line: state.lastDailyLine,
    dryRun: dryRun || Boolean(flags['no-daily']),
  });
  stats.daily = daily;
  log(`[doc-index] 日报一行：${state.lastDailyLine}`);
  log(`[doc-index] 日报落点：${dailyFile}（${daily.ok ? daily.reason ?? 'written' : daily.reason}）`);
  log(
    `[doc-index] ${status === 'failed' ? '⚠️' : '✅'} 重建 ${stats.rebuilt} / 跳过 ${stats.skipped}`
      + ` · 写库 ${stats.upserted}（新 ${stats.inserted} / 更 ${stats.updated} / 同哈希 ${stats.unchanged}）`
      + ` · 清孤条 ${stats.staleDeleted} · 失败 ${stats.failedCount} · ${stats.elapsedMs}ms`,
  );
  return { ok: true, exitCode: 0, status, stats, state, lines };
}

function buildLlmConfig(flags, env, home) {
  const apiKey =
    flags['llm-key'] || resolveApiKey({ env, credentialsFile: path.join(home, '.credentials.yaml') });
  return {
    apiKey,
    baseUrl: String(flags['llm-base-url'] || env.DOC_INDEX_LLM_BASE_URL || 'https://api.deepseek.com'),
    model: String(flags['llm-model'] || env.DOC_INDEX_LLM_MODEL || 'deepseek-flash'),
  };
}
