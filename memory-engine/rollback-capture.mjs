#!/usr/bin/env node
// rollback-capture.mjs —— 「会话提炼记忆」批次撤回器（2026-10-26 转正版 · 卡「会话提炼T0T2」T0）
//
// 来历：接线 v1 阶段（2026-10-26 09:17）写在临时目录里，`_tmp` 一清就没
//   （那张卡的 D-7 未办）⇒ 本卡把它**提拔进 `tools\memory-engine\`**，并按方案 §4-4 补上
//   **`--id`（单条）/ `--run`（单轮）** 两个粒度（原来只认 `--tag`，`--id`/`--run` 全 rc 2 = 用法错）。
//
// 作用：把本批次由提炼落库的条**降层 + 标记作废**（不物理删）。
//   · 默认 **dry-run 只列**，一个字节都不写；
//   · `--apply` 才写：tags 里 `recall:…` → `archival:…`（降层，不再每轮/按需注入）+ 追加 `void:<日期>`；
//   · `--restore` 反向恢复（`archival:` → `recall:`、摘掉 `void:*`）—— 撤回本身也可撤；
//   · **绝不物理 DELETE**、**绝不改 schema**、**绝不碰 text 正文**（只改 tags / pinned）。
//
// 三种粒度（任选其一；都不给 = 按 `--tag` 整批）：
//   `--tag capture:202610`    整批（默认）
//   `--run 20261026-0410`     单轮：查账本 `runs[]` 里同 runId 的 `writtenIds`（方案 §4-3）
//   `--id 1000836`            单条
//
// 守卫：
//   ① **只认 capture 批次的条**：命中的每一行 tags 里必须有 `capture:*`（`--id` / `--run` 也照样查），
//      否则**整批拒动** —— 防"指错 id 把主人的记忆降层"；
//   ② 乐观锁：`UPDATE ... WHERE id=? AND tags=?`，命中数 ≠1 即整批回滚；
//   ③ 幂等：已 `void:*` 的行在 apply 态跳过（第二次跑 = 零动作）；
//   ④ apply 前后各读一次总条数，**必须相等**（不删不加）；
//   ⑤ 写前把「before 行 + 本次选择器」落 `_archive\capture-rollback-<时间戳>\before.json`；
//   ⑥ dry-run 是函数内第一道门（`doApply` 只在 --apply 时为真）。
//
// 退出码（走 process.exitCode，不硬退）：
//   0 成功 / 3 命中数为 0（没东西可撤，不算错）/ 4 守卫拦下（乐观锁 / 总条数变化 / 命中行不带 capture 标签）
//   / 5 `--run` 在账本里找不到该 runId（或账本损坏/不存在）/ 2 用法错
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolveCaptureHome } from './lib/session-capture.mjs';

const DEFAULT_TAG = 'capture:202610';

function parseArgs(argv) {
  const o = {
    apply: false, restore: false, tag: DEFAULT_TAG, tagExplicit: false,
    id: null, run: null, ledger: null, db: null, outRoot: path.join(process.cwd(), '_archive'),
    limit: null, json: false, help: false,
  };
  const need = (i, a) => {
    const v = argv[i];
    if (v === undefined || String(v).startsWith('--')) throw new Error(`${a} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { o.apply = true; continue; }
    if (a === '--restore') { o.restore = true; continue; }
    if (a === '--json') { o.json = true; continue; }
    if (a === '-h' || a === '--help') { o.help = true; continue; }
    if (a === '--tag') { o.tag = need(++i, a); o.tagExplicit = true; continue; }
    if (a === '--id') { const v = Number(need(++i, a)); if (!Number.isInteger(v) || v <= 0) throw new Error(`--id 要正整数：${v}`); o.id = v; continue; }
    if (a === '--run') { o.run = String(need(++i, a)); continue; }
    if (a === '--ledger') { o.ledger = path.resolve(need(++i, a)); continue; }
    if (a === '--db') { o.db = path.resolve(need(++i, a)); continue; }
    if (a === '--out-root') { o.outRoot = path.resolve(need(++i, a)); continue; }
    if (a === '--limit') { o.limit = Number(need(++i, a)); continue; }
    throw new Error(`未知参数：${a}`);
  }
  // 三种粒度互斥（`--tag` 缺省存在但不算"给过"，所以只在显式给时参与互斥判断）
  const picked = [o.id !== null ? '--id' : null, o.run !== null ? '--run' : null, o.tagExplicit ? '--tag' : null].filter(Boolean);
  if (picked.length > 1) throw new Error(`粒度参数互斥，只给一个：${picked.join(' / ')}`);
  // 注意：--restore 与 --apply **可以**同用（恢复也要真写才生效）；--restore 单独跑 = 恢复的 dry-run。
  return o;
}

const USAGE = [
  'usage: node rollback-capture.mjs [--tag capture:202610 | --run <runId> | --id <n>] [--apply | --restore --apply]',
  '',
  '  默认 = dry-run，只列出该批次的行（零写入）',
  '  --tag <标签>       整批粒度（默认 capture:202610）',
  '  --run <runId>      单轮粒度：查账本 runs[].writtenIds（账本默认 <home>\\memory-capture\\ledger.json）',
  '  --id <n>           单条粒度',
  '  --ledger <路径>    --run 用的账本（默认按 DSH home 解析）',
  '  --apply            降层 + 打作废标记（recall:→archival:，加 void:<日期>）',
  '  --restore --apply  反向恢复（archival:→recall:，摘掉 void:*）',
  '  --db <路径>        默认 <home>\\memory\\memory.db',
  '  --out-root <目录>  before 快照落点，默认 <当前目录>/_archive',
  '  --limit N          只处理前 N 条（演练用）',
  '',
  '  绝不 DELETE、绝不改 schema、绝不碰 text；命中行若不带 capture:* 标签 ⇒ 整批拒动（rc=4）。',
].join('\n');

function nowStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sha8(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 8).toUpperCase();
}

const tagList = (tags) => String(tags || '').split(/\s+/).filter(Boolean);
const captureTagsOf = (tags) => tagList(tags).filter((t) => /^capture:/i.test(t));

function layerOf(tags) {
  return tagList(tags).find((x) => /^(core|recall|archival):/i.test(x)) || null;
}
function markVoid(tags, day) {
  const t = tagList(tags).filter((x) => !/^void:/i.test(x));
  t.push(`void:${day}`);
  return t.join(' ');
}
const unmarkVoid = (tags) => tagList(tags).filter((x) => !/^void:/i.test(x)).join(' ');
const toArchival = (tags) => tagList(tags).map((x) => (/^recall:/i.test(x) ? x.replace(/^recall:/i, 'archival:') : x)).join(' ');
const toRecall = (tags) => tagList(tags).map((x) => (/^archival:/i.test(x) ? x.replace(/^archival:/i, 'recall:') : x)).join(' ');

/** 从账本里取某轮的 writtenIds（账本缺失/损坏/无该 runId ⇒ 返回结构化原因，不猜）。 */
function loadRunIds(ledgerFile, runId) {
  if (!fs.existsSync(ledgerFile)) return { ok: false, reason: `账本不存在：${ledgerFile}` };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch (e) { return { ok: false, reason: `账本读不出 JSON：${e?.message ?? e}` }; }
  const runs = Array.isArray(doc?.runs) ? doc.runs : [];
  const hit = runs.find((r) => String(r?.runId ?? '') === String(runId));
  if (!hit) return { ok: false, reason: `账本里没有 runId=${runId}（现有 ${runs.length} 轮：${runs.slice(-5).map((r) => r?.runId).join(', ') || '空'}）` };
  const ids = (Array.isArray(hit.writtenIds) ? hit.writtenIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return { ok: true, ids, run: hit, ledgerFile };
}

function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`[usage] ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) { console.log(USAGE); return 0; }

  const home = resolveCaptureHome({});
  const dbPath = o.db || path.join(home, 'memory', 'memory.db');
  if (!fs.existsSync(dbPath)) { console.error(`[rollback] 库不存在：${dbPath}`); return 2; }

  // 选择器
  let mode = 'tag';
  let selector = `标签=${o.tag}`;
  let runInfo = null;
  let idsFilter = null;
  if (o.id !== null) { mode = 'id'; selector = `单条 id=${o.id}`; idsFilter = [o.id]; }
  if (o.run !== null) {
    mode = 'run';
    const ledgerFile = o.ledger || path.join(home, 'memory-capture', 'ledger.json');
    const got = loadRunIds(ledgerFile, o.run);
    if (!got.ok) { console.error(`[rollback] --run 取不到 id：${got.reason}`); return 5; }
    runInfo = { runId: o.run, ledgerFile, writtenIds: got.ids, run: got.run };
    selector = `单轮 runId=${o.run}（账本 ${got.ids.length} 条 writtenIds）`;
    idsFilter = got.ids;
    if (!got.ids.length) { console.log(`[rollback] 该轮 writtenIds 为空（判"记"0 条）⇒ 无可撤回。`); return 3; }
  }

  const db = new DatabaseSync(dbPath, { readOnly: !o.apply });
  db.exec('PRAGMA busy_timeout = 5000;');
  const total = () => db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;

  const before = total();
  let rows;
  if (mode === 'tag') {
    rows = db.prepare('SELECT id, tags, pinned, created_at FROM memories WHERE tags LIKE ? ORDER BY id').all(`%${o.tag}%`)
      .filter((r) => tagList(r.tags).includes(o.tag));
  } else {
    const marks = idsFilter.map(() => '?').join(',');
    rows = idsFilter.length ? db.prepare(`SELECT id, tags, pinned, created_at FROM memories WHERE id IN (${marks}) ORDER BY id`).all(...idsFilter) : [];
    const missing = idsFilter.filter((id) => !rows.some((r) => Number(r.id) === Number(id)));
    if (missing.length) console.log(`  ⚠️ 有 ${missing.length} 个 id 在库里找不到（可能已被删）：${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}`);
  }
  if (o.limit && o.limit > 0) rows = rows.slice(0, o.limit);

  const header = o.restore ? '恢复（archival→recall，摘 void）' : '撤回（recall→archival，打 void）';
  console.log(`[rollback-capture] 模式=${o.apply ? `APPLY · ${header}` : `DRY-RUN · ${header}`}`);
  console.log(`  db=${dbPath}`);
  console.log(`  粒度=${selector} · 命中 ${rows.length} 条 · 全库 ${before} 条`);

  if (rows.length === 0) {
    console.log('  没有命中行 ⇒ 无可撤回（这不是错误）。');
    db.close();
    return 3;
  }

  // 守卫①：每一行都必须带 capture:* 标签（单条/单轮粒度更要查 —— 防指错 id）
  const offBatch = rows.filter((r) => captureTagsOf(r.tags).length === 0);
  if (offBatch.length) {
    console.error(`\n  ❌ 守卫拦下：${offBatch.length} 行不带 capture:* 标签，不属于提炼批次 ⇒ 整批拒动。`);
    for (const r of offBatch.slice(0, 10)) console.error(`     #${r.id} tags=${r.tags}`);
    db.close();
    return 4;
  }

  const day = nowStamp().slice(0, 8);
  const plan = [];
  for (const r of rows) {
    const hasVoid = tagList(r.tags).some((x) => /^void:/i.test(x));
    let nextTags;
    let action;
    if (o.restore) { nextTags = unmarkVoid(toRecall(r.tags)); action = 'restore'; }
    else if (hasVoid) { action = 'skip-already-void'; nextTags = r.tags; }
    else { nextTags = markVoid(toArchival(r.tags), day); action = 'void+downlayer'; }
    plan.push({
      id: r.id, action, beforeTags: r.tags, afterTags: nextTags,
      layerBefore: layerOf(r.tags), layerAfter: layerOf(nextTags), captureTags: captureTagsOf(r.tags),
    });
  }

  for (const p of plan) {
    const flag = p.action === 'skip-already-void' ? '  ⏭ ' : '  · ';
    console.log(`${flag}#${p.id} ${p.layerBefore || '-'} → ${p.layerAfter || '-'}  ${p.action}  [${p.captureTags.join(' ')}]`);
    console.log(`      前: ${p.beforeTags}`);
    console.log(`      后: ${p.afterTags}`);
  }

  const todo = plan.filter((p) => p.action !== 'skip-already-void');
  if (!o.apply) {
    console.log(`\n  DRY-RUN：将改 ${todo.length} 条（零写入）。加 --apply 才落。`);
    db.close();
    return 0;
  }

  // before 快照（写前落盘，人工可复核）
  const outDir = path.join(o.outRoot, `capture-rollback-${nowStamp()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const snapshot = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    mode: o.restore ? 'restore' : 'void',
    granularity: mode,
    tag: o.tag,
    run: runInfo ? { runId: runInfo.runId, ledgerFile: runInfo.ledgerFile, writtenIds: runInfo.writtenIds } : null,
    db: dbPath,
    totalBefore: before,
    rows: plan.map((p) => ({ id: p.id, action: p.action, tags: p.beforeTags, nextTags: p.afterTags, captureTags: p.captureTags })),
  };
  const snapPath = path.join(outDir, 'before.json');
  fs.writeFileSync(snapPath, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`\n  before 快照：${snapPath}（sha ${sha8(JSON.stringify(snapshot))}）`);

  // 事务写：乐观锁 —— tags 与读到的完全一致才写；命中数≠1 即整批回滚
  let changed = 0;
  let failed = null;
  try {
    db.exec('BEGIN IMMEDIATE');
    const upd = db.prepare('UPDATE memories SET tags = ?, updated_at = ? WHERE id = ? AND tags = ?');
    const nowMs = Date.now();
    for (const p of todo) {
      const res = upd.run(p.afterTags, nowMs, p.id, p.beforeTags);
      if (Number(res.changes) !== 1) { failed = `#${p.id} 命中 ${res.changes} 行（乐观锁失败）`; break; }
      changed += 1;
    }
    if (failed) db.exec('ROLLBACK'); else db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    failed = `写库异常：${e?.message ?? e}`;
  }

  if (failed) {
    console.error(`\n  ❌ 守卫拦下，整批已回滚：${failed}`);
    db.close();
    return 4;
  }

  const after = total();
  console.log(`  写后：改 ${changed} 条 · 全库 ${after} 条（前 ${before} 条）`);
  if (after !== before) {
    console.error(`  ❌ 总条数变了（${before} → ${after}）—— 只允许改标签，不许增删行。`);
    db.close();
    return 4;
  }
  console.log(`  ✅ 完成：${changed} 条${o.restore ? '已恢复' : '已降层+打作废标记'}，零删除、零 schema 改动。`);
  db.close();
  return 0;
}

process.exitCode = main();
