#!/usr/bin/env node
/**
 * refine-memories.mjs —— 记忆库「按 payload 逐条改写」通用写入入口（先 dry-run，--apply 才写）
 *
 * 与既有一次性大扫除脚本的关系：
 *   · 后者是 **2026-09-15 长期库大扫除 L4 那次的一次性脚本** —— 它的 `validate()` 内置
 *     `IDS_EXPECTED = [17 个固定 id]` 覆盖度自检（"载荷必须恰好是那 17 条"）⇒ **新 payload 必被 fail-closed 拒**，
 *     不可复用（2026-09-24 实测：新载荷报「载荷缺条目 / 含计划外条目」）。
 *   · 本脚本 = 同一套安全骨架（单事务 / 逐条校验 / 改前全文留档 / 可回滚），**去掉硬编码 id 清单**，
 *     改为「payload 声明什么就改什么」；其余纪律一致。**未改动旧脚本一个字节。**
 *
 * 安全纪律（与旧脚本同）：
 *   · 只 UPDATE memories.text（按 id 逐条），**不碰 pinned / tags / created_at**，不插入、不删除；
 *   · 单事务：任一条校验失败 ⇒ 整体不执行；
 *   · 校验：id 必须真实存在 · text 非空 · `must_contain` 逐条字面命中 · `forbid` 正则不得命中 · 载荷无重复 id；
 *   · 报告含**改前全文**（供回滚），默认落 `_archive`；`--rollback <报告>` 可逐条写回。
 *
 * 用法：
 *   node refine-memories.mjs --payload <f>                      # dry-run（默认）
 *   node refine-memories.mjs --payload <f> --apply              # 真写（单事务）
 *   node refine-memories.mjs --payload <f> --self-test          # 在临时库副本上跑完整通路 + 反校验
 *   node refine-memories.mjs --rollback <报告.json>             # 按报告把改前全文写回
 *   （可选 --db <库> --report <报告>；默认见常量）
 * 退出码：0 正常 ／ 1 校验或执行失败 ／ 2 用法错 ／ 3 环境不可用
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = (process.env.USERPROFILE ?? '').replaceAll('\\', '/');
const DEF_DB = `${HOME}/.dsh/memory/memory.db`;
const DEF_REPORT = path.join(process.cwd(), '_archive', 'memory-refine', 'refine-report.json');

function argOf(argv, name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
function realOr(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}
function mainEntry() {
  const a1 = process.argv[1] ? realOr(process.argv[1]) : '';
  const a2 = realOr(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  return a1.toLowerCase() === a2.toLowerCase();
}

/** 逐条校验；返回 {ok, errors, rows} */
function validate(db, payload) {
  const errors = [];
  const rows = [];
  const seen = new Set();
  for (const e of payload.entries ?? []) {
    if (!Number.isInteger(e.id) || typeof e.text !== 'string' || !e.text.trim()) {
      errors.push(`#${e.id} 载荷形态非法（id 需整数、text 需非空字符串）`);
      continue;
    }
    if (seen.has(e.id)) { errors.push(`#${e.id} 载荷内重复 id`); continue; }
    seen.add(e.id);
    const cur = db.prepare('SELECT text, pinned FROM memories WHERE id=?').get(e.id);
    if (!cur) { errors.push(`#${e.id} 库中不存在（拒绝凭空插入）`); continue; }
    for (const need of e.must_contain ?? []) {
      if (!e.text.includes(need)) errors.push(`#${e.id} 新正文未命中必需关键词「${need}」`);
    }
    for (const pat of e.forbid ?? []) {
      const hit = e.text.match(new RegExp(pat, 'g'));
      if (hit) errors.push(`#${e.id} 新正文命中禁串正则 /${pat}/ → ${hit.slice(0, 2).join(' | ')}`);
    }
    rows.push({ id: e.id, oldLen: cur.text.length, newLen: e.text.length, pinned: cur.pinned });
  }
  if (!rows.length && !errors.length) errors.push('载荷为空');
  return { ok: errors.length === 0, errors, rows };
}

function selfTest(payload, srcDb) {
  console.log('=== self-test：在临时库副本上跑完整 UPDATE 通路（不碰生产库）===');
  const tmp = path.join(os.tmpdir(), `mem-refine-selftest-${Date.now()}.db`);
  try {
    const src = new DatabaseSync(srcDb, { readOnly: true });
    src.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    src.close();
    const t = new DatabaseSync(tmp);
    const v = validate(t, payload);
    if (!v.ok) { console.error(`  ✗ 校验未过：\n    ${v.errors.join('\n    ')}`); t.close(); return false; }
    t.exec('BEGIN');
    const ts = Date.now();
    const up = t.prepare('UPDATE memories SET text=?, updated_at=? WHERE id=?');
    for (const e of payload.entries) up.run(e.text, ts, e.id);
    t.exec('COMMIT');
    let bad = 0;
    for (const e of payload.entries) {
      const after = t.prepare('SELECT text FROM memories WHERE id=?').get(e.id).text;
      if (after !== e.text) { console.error(`  ✗ #${e.id} 写回不一致`); bad++; }
    }
    const nAll = t.prepare('SELECT COUNT(*) n FROM memories').get().n;
    const nSrc = (() => { const d = new DatabaseSync(srcDb, { readOnly: true }); const n = d.prepare('SELECT COUNT(*) n FROM memories').get().n; d.close(); return n; })();
    t.close();
    const ok = bad === 0 && nAll === nSrc;
    console.log(`  ${payload.entries.length} 条 UPDATE → 条数 ${nAll}（源 ${nSrc}）· 逐条比对不一致 ${bad} 处 ${ok ? '✅ 通路正常' : '✗'}`);
    return ok;
  } catch (e) {
    console.error(`  ✗ self-test 失败：${e.message}`);
    return false;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log('用法: node refine-memories.mjs --payload <f> [--apply|--self-test] [--db <库>] [--report <报告>]');
    console.log('      node refine-memories.mjs --rollback <报告.json>');
    return;
  }
  const dbPath = argOf(argv, '--db', DEF_DB);
  const reportPath = argOf(argv, '--report', DEF_REPORT);

  // ---- 回滚分支
  const rbi = argv.indexOf('--rollback');
  if (rbi >= 0) {
    const rep = argv[rbi + 1];
    if (!rep || !fs.existsSync(rep)) { console.error(`[rollback] 报告不存在：${rep}`); process.exitCode = 2; return; }
    const r = JSON.parse(fs.readFileSync(rep, 'utf8'));
    const before = r.before ?? {};
    const beforePinned = r.beforePinned ?? {};
    const ids = Object.keys(before).map(Number);
    const pinIds = Object.keys(beforePinned).map(Number);
    if (!ids.length && !pinIds.length) { console.error('[rollback] 报告既无 before 也无 beforePinned 段'); process.exitCode = 1; return; }
    const db = new DatabaseSync(dbPath);
    db.exec('BEGIN');
    try {
      let n = 0;
      if (ids.length) {
        const up = db.prepare('UPDATE memories SET text=?, updated_at=? WHERE id=?');
        for (const id of ids) { const c = up.run(before[id], Date.now(), id); if (c.changes !== 1) throw new Error(`#${id} 回写影响行数 ${c.changes}`); n++; }
      }
      if (pinIds.length) {
        const up = db.prepare('UPDATE memories SET pinned=?, updated_at=? WHERE id=?');
        for (const id of pinIds) { const c = up.run(beforePinned[id], Date.now(), id); if (c.changes !== 1) throw new Error(`#${id} pinned 回写影响行数 ${c.changes}`); n++; }
      }
      db.exec('COMMIT');
      console.log(`[rollback] 已写回 ${n} 条（text ${ids.length} · pinned ${pinIds.length}）`);
    } catch (e) { db.exec('ROLLBACK'); console.error(`[rollback] 失败已回滚：${e.message}`); process.exitCode = 1; }
    db.close();
    return;
  }

  // ---- unpin 分支：把指定 id 的 pinned 置 0（**内容保留**，只减注入量）
  const upi = argv.indexOf('--unpin');
  if (upi >= 0) {
    const ids = String(argv[upi + 1] ?? '').split(',').map((s) => Number(s.trim())).filter(Number.isInteger);
    if (!ids.length) { console.error('[unpin] 需要 --unpin <id,id,...>'); process.exitCode = 2; return; }
    const db = new DatabaseSync(dbPath);
    const rows = ids.map((id) => {
      const r = db.prepare('SELECT id, pinned, LENGTH(text) AS len FROM memories WHERE id=?').get(id);
      return { id, exists: !!r, pinned: r?.pinned ?? null, len: r?.len ?? null };
    });
    const missing = rows.filter((r) => !r.exists).map((r) => r.id);
    const pinnedNow = db.prepare('SELECT COUNT(*) n FROM memories WHERE pinned=1').get().n;
    console.log(`[unpin] 目标 ${ids.length} 条 · 缺失 ${missing.length} · 当前 pinned 总数 ${pinnedNow}`);
    for (const r of rows) console.log(`  #${r.id}  pinned=${r.pinned}  ${r.len} 字符`);
    if (missing.length) { console.error(`[fail-closed] 以下 id 不存在：${missing.join(',')}`); db.close(); process.exitCode = 1; return; }
    if (!argv.includes('--apply')) { db.close(); console.log('[unpin] dry-run 未写库；加 --apply 执行'); return; }
    const beforePinned = {};
    db.exec('BEGIN');
    try {
      const up = db.prepare('UPDATE memories SET pinned=0, updated_at=? WHERE id=?');
      let n = 0;
      for (const r of rows) {
        beforePinned[r.id] = r.pinned;
        const c = up.run(Date.now(), r.id);
        if (c.changes !== 1) throw new Error(`#${r.id} 影响行数=${c.changes}`);
        n++;
      }
      db.exec('COMMIT');
      const np = db.prepare('SELECT COUNT(*) n FROM memories WHERE pinned=1').get().n;
      console.log(`\n✅ 已降级 ${n} 条 → 现 pinned 条数 = ${np}`);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify({
        at: new Date().toISOString(), session: process.env.DSH_SESSION_ID ?? null, dbPath,
        unpinned: Object.keys(beforePinned).map(Number), beforePinned, pinnedAfter: np,
      }, null, 2) + '\n', 'utf8');
      console.log(`留档：${reportPath}\n回滚：node refine-memories.mjs --rollback "${reportPath}"`);
    } catch (e) { db.exec('ROLLBACK'); console.error(`✗ 事务失败已回滚：${e.message}`); process.exitCode = 1; }
    db.close();
    return;
  }

  const payloadPath = argOf(argv, '--payload', null);
  if (!payloadPath || !fs.existsSync(payloadPath)) { console.error(`[fail-closed] 找不到载荷 ${payloadPath}`); process.exitCode = 3; return; }
  if (!fs.existsSync(dbPath)) { console.error(`[fail-closed] 找不到记忆库 ${dbPath}`); process.exitCode = 3; return; }

  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  console.log(`载荷：${payloadPath}（${(payload.entries ?? []).length} 条）\n目标库：${dbPath}`);

  if (argv.includes('--self-test')) {
    process.exitCode = selfTest(payload, dbPath) ? 0 : 1;
    return;
  }

  const db = new DatabaseSync(dbPath);
  const v = validate(db, payload);
  console.log(`\n校验：${v.ok ? '✅ 全通过' : `✗ ${v.errors.length} 项不通过`}`);
  for (const e of v.errors) console.log(`  ✗ ${e}`);
  console.log('\n逐条明细（id · 改前→改后字符数 · pinned）：');
  for (const r of v.rows) console.log(`  #${String(r.id).padStart(4)}  ${r.oldLen} → ${r.newLen} 字符  pinned=${r.pinned}`);

  if (!v.ok) { db.close(); process.exitCode = 1; return; }
  if (!argv.includes('--apply')) {
    db.close();
    console.log('\n（dry-run：未写库；加 --apply 执行改写）');
    return;
  }

  const stamp = Date.now();
  db.exec('BEGIN');
  try {
    const up = db.prepare('UPDATE memories SET text=?, updated_at=? WHERE id=?');
    const rd = db.prepare('SELECT text FROM memories WHERE id=?');
    const before = {};
    for (const e of payload.entries) before[e.id] = rd.get(e.id).text;
    let n = 0;
    for (const e of payload.entries) {
      const r = up.run(e.text, stamp, e.id);
      if (r.changes !== 1) throw new Error(`#${e.id} UPDATE 影响行数=${r.changes}（期望 1）`);
      n++;
    }
    db.exec('COMMIT');
    const after = db.prepare('SELECT COUNT(*) n, SUM(LENGTH(text)) c FROM memories').get();
    console.log(`\n✅ 已改写 ${n} 条 → 库内 ${after.n} 条 / ${after.c} 字符`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({
      at: new Date().toISOString(), session: process.env.DSH_SESSION_ID ?? null,
      payloadPath, dbPath, updated: n, totalAfter: after.n, charsAfter: after.c, before,
    }, null, 2) + '\n', 'utf8');
    console.log(`改前全文留档（供回滚）：${reportPath}`);
    console.log(`回滚：node refine-memories.mjs --rollback "${reportPath}"`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(`✗ 事务失败已回滚：${err.message}`);
    process.exitCode = 1;
  }
  db.close();
}

if (mainEntry()) main();
