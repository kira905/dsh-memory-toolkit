/**
 * test/schema-migrate.test.mjs —— 记忆引擎 v2 · S3b 表结构自检单测（零依赖、零生产触碰）
 *
 * 覆盖（卡 §四.1 验收 + 自加项）：
 *   01 未加列 ⇒ 自检报"已加列"（两列 + 索引）
 *   02 幂等：连跑两次，第二次 0 语句、0 日志追加
 *   03 列定义落库正确（type / notnull / dflt_value）
 *   04 默认值语义：新插入行 owner_user = 身份表 owner；无身份表 ⇒ 回落常量；visibility = private_owner
 *   05 加列后 `SELECT *` 可用（官方版兼容的库侧前提）
 *   06 失败降级：只读连接 ⇒ ok=false / degraded=true / **不抛** + 日志落一行
 *   07 失败降级：坏库（把表 drop 掉再自检）不抛且降级
 *   08 表不存在 ⇒ skipped（不误报成功）
 *   09 日志：变更写 / 幂等不写 / 日志目录可自行创建
 *   10 **与权威源逐字对照**：tools/memory-db-tools/lib/memory-scope.mjs（⑤-3 卡）的
 *      列定义 / 索引 SQL / buildAddColumnSql 输出 / 回落行为四项全部一致（漂移即红）
 *
 * 用法：node test/schema-migrate.test.mjs
 * 退出码：0 = 全绿 / 1 = 有失败
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import * as S from '../src/schema-migrate.mjs';

let pass = 0;
const failures = [];
const ok = (cond, msg) => {
  if (cond) { pass += 1; process.stdout.write(`  ✓ ${msg}\n`); }
  else { failures.push(msg); process.stdout.write(`  ✗ ${msg}\n`); }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}  (got=${JSON.stringify(a)} want=${JSON.stringify(b)})`);
const section = (t) => process.stdout.write(`\n[${t}]\n`);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's3b-schema-'));
let caseNo = 0;

/** 造一个「6 列 + 若干行」的库（= 加列前的生产形态），返回 { dir, home, dbPath }。 */
function makeLegacyDb({ rows = 2, usersJson = undefined, dropTable = false } = {}) {
  const dir = path.join(tmpRoot, `case-${++caseNo}`);
  const home = path.join(dir, '.dsh');
  fs.mkdirSync(path.join(home, 'memory'), { recursive: true });
  const dbPath = path.join(home, 'memory', 'memory.db');
  if (usersJson !== undefined) fs.writeFileSync(path.join(home, S.IDENTITY_TABLE_NAME), usersJson, 'utf8');
  if (dropTable) { fs.writeFileSync(dbPath, 'not a sqlite file at all', 'utf8'); return { dir, home, dbPath }; }
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX memories_recent ON memories (updated_at DESC, id DESC)');
  const ins = db.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, 0, ?, ?)');
  for (let i = 0; i < rows; i += 1) ins.run(`fixture 记忆 ${i}`, 'fixture', 1700000000000 + i, 1700000000000 + i);
  db.close();
  return { dir, home, dbPath };
}

const logLines = (home) => {
  const f = path.join(home, 'logs', 'memory-schema.log');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

// ────────────────────────────────────────────── 01 未加列 ⇒ 已加列
section('01 未加列 ⇒ 自检报"已加列"');
{
  const { home, dbPath } = makeLegacyDb({});
  const db = new DatabaseSync(dbPath);
  const r = S.ensureMemoryColumns(db, { dbPath });
  ok(r.ok === true, '自检 ok=true');
  ok(r.degraded === false, '未降级');
  eq(r.added.sort(), ['owner_user', 'visibility'], 'added 两列（顺序无关）');
  ok(r.indexCreated === true, '索引 memories_visibility 已创建');
  const cols = S.columnsOf(db);
  eq(cols.slice(6), ['owner_user', 'visibility'], '库内列数 6 → 8');
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='memories_visibility'").get();
  ok(!!idx, '索引真实存在（sqlite_master 可查）');
  db.close();
  const lines = logLines(home);
  ok(lines.length === 1 && lines[0].event === 'migrate' && lines[0].ok === true, '变更落日志一行（event=migrate, ok=true）');
  eq(lines[0]?.added?.sort(), ['owner_user', 'visibility'], '日志记了加列清单');
}

// ────────────────────────────────────────────── 02 幂等
section('02 幂等：连跑两次');
{
  const { home, dbPath } = makeLegacyDb({});
  const db1 = new DatabaseSync(dbPath);
  const r1 = S.ensureMemoryColumns(db1, { dbPath });
  db1.close();
  const db2 = new DatabaseSync(dbPath);
  const r2 = S.ensureMemoryColumns(db2, { dbPath });
  db2.close();
  ok(r1.added.length === 2, '第一次加了两列');
  eq(r2.added, [], '第二次 added 为空');
  eq(r2.statements, [], '第二次 0 条语句');
  eq(r2.present.sort(), ['owner_user', 'visibility'], '第二次报"列已存在"');
  ok(r2.ok === true && r2.degraded === false, '第二次 ok 且不降级');
  const lines = logLines(home);
  ok(lines.length === 1, `幂等无变化不写日志（仍 1 行，实测 ${lines.length}）`);
  const db3 = new DatabaseSync(dbPath, { readOnly: true });
  eq(S.columnsOf(db3).length, 8, '列数稳定在 8（不重复加列）');
  db3.close();
}

// ────────────────────────────────────────────── 03 列定义
section('03 列定义落库正确');
{
  const { dbPath } = makeLegacyDb({});
  const db = new DatabaseSync(dbPath);
  S.ensureMemoryColumns(db, { dbPath });
  const info = db.prepare('PRAGMA table_info(memories)').all();
  const byName = Object.fromEntries(info.map((c) => [c.name, c]));
  ok(byName.owner_user?.type === 'TEXT' && byName.owner_user.notnull === 1, 'owner_user TEXT NOT NULL');
  ok(byName.visibility?.type === 'TEXT' && byName.visibility.notnull === 1, 'visibility TEXT NOT NULL');
  eq(byName.visibility?.dflt_value, `'private_owner'`, 'visibility 默认值 private_owner');
  ok(!!byName.owner_user?.dflt_value, `owner_user 有默认值（${byName.owner_user?.dflt_value}）`);
  const idxSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='memories_visibility'").get()?.sql ?? '';
  ok(/visibility, updated_at DESC/i.test(idxSql), '索引列为 (visibility, updated_at DESC)');
  db.close();
}

// ────────────────────────────────────────────── 04 默认值语义
section('04 默认值语义（身份表优先 / 回落常量）');
{
  // 04a 无身份表 ⇒ 回落常量
  const a = makeLegacyDb({});
  const dba = new DatabaseSync(a.dbPath);
  const ra = S.ensureMemoryColumns(dba, { dbPath: a.dbPath });
  eq(ra.ownerSource, 'fallback', '无身份表 ⇒ ownerSource=fallback');
  eq(ra.ownerUser, S.FALLBACK_OWNER_USER, `回落常量 ${S.FALLBACK_OWNER_USER}`);
  dba.prepare("INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES ('n1','',0,1,1)").run();
  const rowA = dba.prepare("SELECT owner_user, visibility FROM memories WHERE text='n1'").get();
  eq(rowA.owner_user, S.FALLBACK_OWNER_USER, '新行 owner_user = 回落常量');
  eq(rowA.visibility, 'private_owner', '新行 visibility = private_owner');
  const allA = dba.prepare('SELECT COUNT(*) n FROM memories WHERE owner_user=? AND visibility=?').get(S.FALLBACK_OWNER_USER, 'private_owner');
  eq(allA.n, 3, '存量 2 行 + 新 1 行全部拿到默认值（无 NULL）');
  dba.close();

  // 04b 身份表存在（**权威 map 形态**，家人档 §3.3）⇒ 取 role==='owner' 的那个键
  const b = makeLegacyDb({ usersJson: JSON.stringify({ _comment: '注释键应跳过', Wife_01: { role: 'family', name: '家人' }, Owner_X: { role: 'owner', name: '主人' } }) });
  const dbb = new DatabaseSync(b.dbPath);
  const rb = S.ensureMemoryColumns(dbb, { dbPath: b.dbPath });
  eq(rb.ownerSource, 'identity-table', '有身份表 ⇒ ownerSource=identity-table');
  eq(rb.ownerUser, 'Owner_X', 'owner_user 默认值 = 身份表 role=owner 的 userid');
  dbb.close();
  const ddlB = (logLines(b.home)[0]?.ownerUser) ?? null;
  eq(ddlB, 'Owner_X', '日志里记的也是身份表 owner');
  eq(S.readIdentityTable(b.home).userids, ['Wife_01', 'Owner_X'], 'map 形态 userid 集合（`_` 注释键跳过）');

  // 04b-2 包装形态 `{ users: [...] }`（家人档未定稿期可能出现的形态）也认
  const b2 = makeLegacyDb({ usersJson: JSON.stringify({ users: [{ userid: 'U_1', role: 'family' }, { userid: 'U_owner', role: 'owner' }] }) });
  const dbb2 = new DatabaseSync(b2.dbPath);
  eq(S.ensureMemoryColumns(dbb2, { dbPath: b2.dbPath }).ownerUser, 'U_owner', '`{users:[…]}` 形态也认（宽容扩展）');
  dbb2.close();

  // 04c 身份表是数组形态 + 没有 owner 条目 ⇒ 回落
  const c = makeLegacyDb({ usersJson: JSON.stringify([{ userid: 'A', role: 'family' }]) });
  const dbc = new DatabaseSync(c.dbPath);
  const rc = S.ensureMemoryColumns(dbc, { dbPath: c.dbPath });
  eq(rc.ownerSource, 'fallback', '身份表无 owner 条目 ⇒ 回落');
  ok(rc.notes.some((n) => /没有任何 role==='owner'/.test(n)), 'notes 说明原因');
  dbc.close();

  // 04d 身份表坏 JSON ⇒ 回落（不抛）
  const d = makeLegacyDb({ usersJson: '{ this is not json' });
  const dbd = new DatabaseSync(d.dbPath);
  const rd = S.ensureMemoryColumns(dbd, { dbPath: d.dbPath });
  ok(rd.ok === true && rd.ownerSource === 'fallback', '坏身份表 ⇒ 仍迁移成功 + 回落');
  dbd.close();
}

// ────────────────────────────────────────────── 05 SELECT * 可用
section('05 加列后 SELECT * 可用（官方版兼容的库侧前提）');
{
  const { dbPath } = makeLegacyDb({});
  const db = new DatabaseSync(dbPath);
  S.ensureMemoryColumns(db, { dbPath });
  const rows = db.prepare('SELECT * FROM memories ORDER BY id').all();
  ok(rows.length === 2, 'SELECT * 返回全部行');
  eq(Object.keys(rows[0]).length, 8, 'SELECT * 返回 8 列');
  ok('owner_user' in rows[0] && 'visibility' in rows[0], '新列在 SELECT * 里可见');
  db.close();
}

// ────────────────────────────────────────────── 06 失败降级：只读库
section('06 失败降级：只读连接（ALTER 必失败）');
{
  const { home, dbPath } = makeLegacyDb({});
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  let threw = null;
  let r = null;
  try { r = S.ensureMemoryColumns(ro, { dbPath }); } catch (e) { threw = e; }
  ok(threw === null, '**绝不抛**（启动不被阻断）');
  ok(r && r.ok === false && r.degraded === true, 'ok=false + degraded=true');
  ok(!!(r && r.error), `error 有值：${r?.error?.slice(0, 60)}`);
  ro.close();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  eq(S.columnsOf(db).length, 6, '只读库列数仍为 6（没加列）');
  db.close();
  const lines = logLines(home);
  ok(lines.length === 1 && lines[0].ok === false && lines[0].degraded === true, '失败落日志一行（ok=false, degraded=true）');
}

// ────────────────────────────────────────────── 07 失败降级：坏库
section('07 失败降级：库打开后表被删 + 只读挂载式场景');
{
  const { home, dbPath } = makeLegacyDb({});
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE memories');
  const r = S.ensureMemoryColumns(db, { dbPath });
  ok(r.ok === true && r.skipped !== null, '表不存在 ⇒ skipped（不误报"已加列"）');
  db.close();
  ok(logLines(home).length === 0, 'skipped 不写日志');

  // 坏文件：node:sqlite 打开是**惰性**的（不校验内容）⇒ 失败面在**首次访问**（MemoryStore 的 SCHEMA exec）
  const bad = makeLegacyDb({ dropTable: true });
  let openErr = null;
  let handle = null;
  try {
    handle = new DatabaseSync(bad.dbPath);
    handle.exec('SELECT 1');
  } catch (e) { openErr = e; } finally { try { handle?.close(); } catch { /* 忽略 */ } }
  ok(openErr !== null, `坏库在首次访问时抛错（失败面属 MemoryStore 的打开阶段，非本自检；边界见交付报告）`);
}

// ────────────────────────────────────────────── 08 表不存在 / 空库
section('08 空库（无 memories 表）⇒ skipped');
{
  const dir = path.join(tmpRoot, `case-${++caseNo}`);
  const home = path.join(dir, '.dsh');
  fs.mkdirSync(home, { recursive: true });
  const dbPath = path.join(home, 'memory', 'empty.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  const r = S.ensureMemoryColumns(db, { dbPath });
  ok(r.ok === true && r.skipped !== null, '空库 skipped');
  eq(r.added, [], '没有加列');
  db.close();
}

// ────────────────────────────────────────────── 09 日志
section('09 日志行为');
{
  const { home, dbPath } = makeLegacyDb({});
  const db = new DatabaseSync(dbPath);
  const collected = [];
  S.ensureMemoryColumns(db, { dbPath, onLog: (e) => collected.push(e) });
  db.close();
  ok(collected.length === 1, 'onLog 回调收到 1 条');
  ok(typeof collected[0].at === 'string' && typeof collected[0].pid === 'number', '日志含 at/pid');
  const f = path.join(home, 'logs', 'memory-schema.log');
  ok(fs.existsSync(f), '日志文件自动创建（目录不存在也能建）');
  const raw = fs.readFileSync(f, 'utf8').trim();
  ok(raw.startsWith('{') && JSON.parse(raw).event === 'migrate', 'JSON 行格式可解析');
  // 指定 logFile
  const other = path.join(home, 'logs', 'custom.log');
  const db2 = new DatabaseSync(dbPath);
  S.ensureMemoryColumns(db2, { dbPath: 'x', logFile: other, home });
  db2.close();
  ok(!fs.existsSync(other), '幂等（无变更）⇒ 自定义日志也不写');
}

// ────────────────────────────────────────────── 10 与权威源逐字对照
section('10 与权威源 memory-scope.mjs 逐字对照（⑤-3 卡）');
{
  const authoritative = new URL('../../memory-db-tools/lib/memory-scope.mjs', import.meta.url);
  let A = null;
  try {
    A = await import(authoritative.href);
  } catch (e) {
    ok(false, `无法 import 权威源 ${authoritative}：${e.message}`);
  }
  if (A) {
    eq(A.LEGACY_COLUMNS, S.LEGACY_COLUMNS, 'LEGACY_COLUMNS 一致');
    eq(A.VISIBILITY_VALUES, S.VISIBILITY_VALUES, 'VISIBILITY_VALUES 一致');
    eq(A.DEFAULT_VISIBILITY, S.DEFAULT_VISIBILITY, 'DEFAULT_VISIBILITY 一致');
    eq(A.FALLBACK_OWNER_USER, S.FALLBACK_OWNER_USER, 'FALLBACK_OWNER_USER 一致');
    eq(
      A.NEW_COLUMNS.map((c) => ({ ...c })),
      S.NEW_COLUMNS.map((c) => ({ ...c })),
      'NEW_COLUMNS 两列定义逐字段一致',
    );
    eq(A.VISIBILITY_INDEX.sql, S.VISIBILITY_INDEX_SQL, '索引 SQL 逐字一致');
    eq(
      A.buildAddColumnSql(A.NEW_COLUMNS[0], 'X'),
      S.buildAddColumnSql(S.NEW_COLUMNS[0], 'X'),
      'buildAddColumnSql(owner_user) 输出一致',
    );
    eq(
      A.buildAddColumnSql(A.NEW_COLUMNS[1], A.DEFAULT_VISIBILITY),
      S.buildAddColumnSql(S.NEW_COLUMNS[1], S.DEFAULT_VISIBILITY),
      'buildAddColumnSql(visibility) 输出一致',
    );
    // 回落行为一致（无身份表时）
    eq(A.resolveDefaultOwner(null).ownerUser, S.resolveDefaultOwner(null).ownerUser, '回落 ownerUser 一致');
    eq(A.resolveDefaultOwner(null).source, S.resolveDefaultOwner(null).source, '回落 source 标记一致');
    // 同一份身份表文本（权威 map 形态）→ 同一份 owner + 同一份 userid 集合
    const mapText = JSON.stringify({ _note: '注释键', Z_1: { role: 'family' }, Z_owner: { role: 'owner', name: '主人' } });
    eq(A.parseIdentityTable(mapText).owner, S.parseIdentityTable(mapText).owner, 'map 形态：owner 解析一致');
    eq(A.parseIdentityTable(mapText).userids, S.parseIdentityTable(mapText).userids, 'map 形态：userid 集合一致（`_` 注释键跳过）');
    // fork 的**有意扩展**：数组 / `{users:[…]}` 形态也认（权威源原先不认）
    const arrText = JSON.stringify([{ userid: 'Z_owner', role: 'owner' }]);
    eq(S.parseIdentityTable(arrText).owner, 'Z_owner', 'fork 额外认数组形态（有意扩展，非漂移）');
    // ⚠️ 2026-10-11 订正（卡【翻译官·批4·家人档地基】）：权威源**也已认**数组形态，本条由"差异"变成"一致"。
    //    原因 = 方案 §5.6 定稿的新身份表形态是 `{version, default:"deny", users:{<userid>:{…}}}`（**users 是 map**），
    //    而两处实现原先只认"平面 map / users 数组" ⇒ 新表一落盘就会被**读成空表**（`resolveDefaultOwner` 回落常量、
    //    `ownerBindingDiff` 把全部 owner 判成未登记）—— 那是**静默失真**，必须双向堵住。
    eq(A.parseIdentityTable(arrText).owner, 'Z_owner', '权威源认数组形态（2026-10-11 起与 fork 一致）');
    // 新形态（users = map）两处必须同解
    const usersMapText = JSON.stringify({ version: 1, default: 'deny', users: { Z_owner: { role: 'owner', name: '主人' }, Z_1: { role: 'family' } } });
    eq(A.parseIdentityTable(usersMapText).owner, S.parseIdentityTable(usersMapText).owner, 'users-map 形态：owner 解析一致');
    eq(A.parseIdentityTable(usersMapText).userids, S.parseIdentityTable(usersMapText).userids, 'users-map 形态：userid 集合一致');
    eq(A.parseIdentityTable(usersMapText).userids, ['Z_owner', 'Z_1'], 'users-map 形态：两个 userid 都认出来（不被当空表）');
  }
}

// ────────────────────────────────────────────── 汇总
process.stdout.write(`\n${'─'.repeat(60)}\n`);
if (failures.length === 0) {
  process.stdout.write(`[schema-migrate] 全绿：${pass} 项通过\n`);
  process.exitCode = 0;
} else {
  process.stdout.write(`[schema-migrate] 失败 ${failures.length} 项 / 通过 ${pass} 项\n`);
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
  process.exitCode = 1;
}
// 收尾清理（测试目录在 %TEMP%）
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
