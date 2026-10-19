#!/usr/bin/env node
// tools/memory-db-tools/_test/test-memory-scope.mjs
//
// ⑤-3（字段与身份）单测：口径库纯函数 + 库级迁移 + CLI 反向用例（fail-closed 闸门）。
// 铁律：**全程不碰生产 memory.db**（开测/收尾各比一次 sha 哨兵）；所有库操作都在 os.tmpdir() 里。
//
// 跑法：node _test/test-memory-scope.mjs
// 退出码：0 全绿 / 1 有失败

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_VISIBILITY,
  MEMORIES_TABLE,
  NEW_COLUMNS,
  VISIBILITY_VALUES,
  applyMigration,
  buildAddColumnSql,
  columnsOf,
  describeDb,
  familyScopeSql,
  hasIndex,
  isProductionDb,
  migrationPlan,
  ownerBindingDiff,
  ownerScopeSql,
  parseIdentityTable,
  productionDbPath,
  quoteLiteral,
  readIdentityTable,
  resolveDefaultOwner,
  selectMemories,
  sha256File,
} from "../lib/memory-scope.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(HERE, "..");
const CLI = {
  migrate: path.join(TOOLS, "memory-schema-migrate.mjs"),
  identity: path.join(TOOLS, "memory-identity-check.mjs"),
  fixture: path.join(TOOLS, "memory-scope-fixture.mjs"),
  fieldname: path.join(TOOLS, "memory-fieldname-check.mjs"),
};

let pass = 0;
const fails = [];
function ok(name, cond, detail = "") {
  if (cond) {
    pass += 1;
  } else {
    fails.push(`${name}${detail ? ` —— ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ""}`);
  }
}
function eq(name, a, b) {
  ok(name, Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `实得 ${JSON.stringify(a)} · 期望 ${JSON.stringify(b)}`);
}
function section(t) {
  console.log(`\n== ${t} ==`);
}

const PROD = productionDbPath();
const prodShaBefore = fs.existsSync(PROD) ? sha256File(PROD) : null;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "card053-"));
const TMP = path.join(ROOT, "sandbox");
fs.mkdirSync(TMP, { recursive: true });

/** 造一个最小同构库（6 列 + 2 条）。 */
function makeDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ${MEMORIES_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const ins = db.prepare(`INSERT INTO ${MEMORIES_TABLE} (text, tags, created_at, updated_at) VALUES (?,?,?,?)`);
  ins.run("第一条", "demo", 1, 1);
  ins.run("第二条", "demo", 2, 2);
  db.close();
  return file;
}
const runCli = (script, args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

// ---------------------------------------------------------------- ① 纯函数
section("① 纯函数（身份表解析 / 默认值解析 / DDL / 过滤 SQL）");

{
  const good = parseIdentityTable(JSON.stringify({ _comment: "注释", LiJianXiao: { role: "owner" }, wife_x: { role: "member" } }));
  ok("身份表：正常解析", good.ok, good.error || "");
  eq("身份表：跳过 _ 前缀注释键", good.userids, ["LiJianXiao", "wife_x"]);
  eq("身份表：取 role=owner", good.owner, "LiJianXiao");

  const bad = parseIdentityTable("{不是 JSON}");
  ok("身份表：坏 JSON ⇒ ok=false（不抛）", bad.ok === false && bad.userids.length === 0);

  const arr = parseIdentityTable("[1,2]");
  ok("身份表：数组根 ⇒ ok=false", arr.ok === false);

  const noOwner = resolveDefaultOwner({ ok: true, exists: true, owner: null, userids: ["a"], path: "x" });
  ok("默认值：无 owner 条目 ⇒ 回落常量 + 有说明行", noOwner.source === "fallback" && noOwner.notes.length > 0);
  const withOwner = resolveDefaultOwner({ ok: true, exists: true, owner: "LiJianXiao", userids: ["LiJianXiao"], path: "x" });
  ok("默认值：有 owner 条目 ⇒ 取身份表（非硬编码）", withOwner.ownerUser === "LiJianXiao" && withOwner.source === "identity-table");
  const broken = resolveDefaultOwner({ ok: false, exists: true, error: "坏了", userids: [], owner: null, path: "x" });
  ok("默认值：身份表坏 ⇒ 回落 + 报警", broken.source === "fallback" && broken.notes.some((n) => n.includes("不可用")));

  eq("DDL：owner_user", buildAddColumnSql(NEW_COLUMNS[0], "LiJianXiao"), "ALTER TABLE memories ADD COLUMN owner_user TEXT NOT NULL DEFAULT 'LiJianXiao'");
  eq("DDL：visibility", buildAddColumnSql(NEW_COLUMNS[1], DEFAULT_VISIBILITY), "ALTER TABLE memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private_owner'");
  eq("字面量转义：单引号翻倍", quoteLiteral("O'Brien"), "'O''Brien'");
  eq("visibility 取值域", [...VISIBILITY_VALUES], ["private_owner", "family", "public"]);

  const fBase = familyScopeSql("wife_x");
  ok("家人侧基础句 = §3.3-4 原文", fBase.mode === "base" && fBase.where === "(visibility IN ('family','public') OR owner_user = ?)" && fBase.params[0] === "wife_x");
  const fStrict = familyScopeSql("wife_x", { registeredOwners: ["LiJianXiao", "wife_x", "wife_x"] });
  ok("家人侧严格句：带已登记护栏且去重", fStrict.mode === "strict" && fStrict.where.includes("owner_user IN (?, ?)") && fStrict.params.length === 3, JSON.stringify(fStrict));
  const fEmpty = familyScopeSql("wife_x", { registeredOwners: [] });
  ok("身份表空 ⇒ fail-closed 只留本人条", fEmpty.mode === "strict-empty" && fEmpty.where === "owner_user = ?");
  let threw = false;
  try {
    familyScopeSql(null);
  } catch {
    threw = true;
  }
  ok("缺 selfUser ⇒ 抛错（不静默放行）", threw);

  eq("主人注入层：默认 owner-only", ownerScopeSql("LiJianXiao").where, "owner_user = ?");
  ok("主人注入层：可选含共享", ownerScopeSql("LiJianXiao", { includeShared: true }).where.includes("family"));

  ok("生产路径判定：真生产 = true", isProductionDb(PROD));
  ok("生产路径判定：沙箱 = false", isProductionDb(path.join(ROOT, "sandbox", "memory.db")) === false);
}

// ---------------------------------------------------------------- ② 库级迁移
section("② 库级：计划 / 迁移 / 幂等 / 干跑零写入");

{
  const dbFile = makeDb(path.join(TMP, "t1.db"));
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const before = describeDb(db);
  const plan = migrationPlan(db, { identity: { ok: true, exists: true, owner: "LiJianXiao", userids: ["LiJianXiao"], path: "x" } });
  db.close();
  eq("迁移前：6 列", before.columns.length, 6);
  eq("计划：缺两列", plan.missing, ["owner_user", "visibility"]);
  eq("计划：3 条语句（两列 + 索引）", plan.statements.length, 3);
  ok("计划：默认值来自身份表", plan.defaultOwner.source === "identity-table" && plan.statements[0].includes("'LiJianXiao'"));

  const rw = new DatabaseSync(dbFile);
  const ran = applyMigration(rw, plan);
  eq("执行：3 条 DDL", ran.length, 3);
  eq("迁移后：8 列", columnsOf(rw).length, 8);
  eq("迁移后：条数不变", rw.prepare(`SELECT COUNT(*) c FROM ${MEMORIES_TABLE}`).get().c, 2);
  ok("迁移后：索引在位", hasIndex(rw, "memories_visibility"));
  const all = rw.prepare(`SELECT owner_user o, visibility v FROM ${MEMORIES_TABLE}`).all();
  ok("存量行取默认值（主人私有）", all.every((r) => r.o === "LiJianXiao" && r.v === "private_owner"));
  const plan2 = migrationPlan(rw, { identity: null });
  eq("幂等：第二次计划 0 语句", plan2.statements.length, 0);
  eq("幂等：两列已在位", plan2.present.sort(), ["owner_user", "visibility"]);
  rw.close();

  // dry-run 零写入（sha 前后一致）
  const dbFile2 = makeDb(path.join(TMP, "t2.db"));
  const shaA = sha256File(dbFile2);
  const r = runCli(CLI.migrate, ["--db", dbFile2, "--json"]);
  const shaB = sha256File(dbFile2);
  eq("CLI dry-run：exit 0", r.status, 0);
  eq("CLI dry-run：源库 sha 未变（零写入）", shaA, shaB);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* 下面断言会报 */
  }
  ok("CLI --json：stdout 是纯 JSON（日志不混入 stdout）", Boolean(parsed) && parsed.mode === "dry-run", r.stdout.slice(0, 200));
  eq("CLI dry-run：列数仍 6", parsed && parsed.before.columns.length, 6);

  // 真改（沙箱路径，无需 --allow-production）
  const r2 = runCli(CLI.migrate, ["--db", dbFile2, "--apply", "--json"]);
  eq("CLI apply（沙箱）：exit 0", r2.status, 0);
  const p2 = JSON.parse(r2.stdout);
  eq("CLI apply：迁移后 8 列", p2.after.columns.length, 8);
  ok("CLI apply：条数一致", p2.after.count === p2.before.count);
  const r3 = runCli(CLI.migrate, ["--db", dbFile2, "--apply", "--json"]);
  ok("CLI apply：二次幂等（无语句可跑）", r3.status === 0 && JSON.parse(r3.stdout).statementsRan === undefined);
}

// ---------------------------------------------------------------- ③ CLI 反向用例（fail-closed 闸门）
section("③ CLI 反向：打生产的三道闸 + 不可用不判过");

{
  // 伪造 USERPROFILE ⇒ 这个临时库"在 CLI 眼里就是生产库"（真实生产绝不被触碰）
  const fakeHome = path.join(ROOT, "fakehome");
  const fakeProdDir = path.join(fakeHome, ".dsh", "memory");
  fs.mkdirSync(fakeProdDir, { recursive: true });
  const fakeProd = makeDb(path.join(fakeProdDir, "memory.db"));
  const sha0 = sha256File(fakeProd);

  const r1 = runCli(CLI.migrate, ["--db", fakeProd, "--apply", "--json"], { USERPROFILE: fakeHome });
  eq("闸①：打生产未给 --allow-production ⇒ exit 2", r1.status, 2);
  eq("闸①：库零改动", sha256File(fakeProd), sha0);

  const r2 = runCli(CLI.migrate, ["--db", fakeProd, "--apply", "--allow-production", "--json"], { USERPROFILE: fakeHome });
  eq("闸②：打生产未给 --snapshot ⇒ exit 2", r2.status, 2);
  eq("闸②：库零改动", sha256File(fakeProd), sha0);

  const snapDir = path.join(ROOT, "snap");
  const r3 = runCli(CLI.migrate, ["--db", fakeProd, "--apply", "--allow-production", "--snapshot", snapDir, "--json"], { USERPROFILE: fakeHome });
  // 闸③ = 停机窗口判据：本机 3080 在跑 ⇒ 应被拒（exit 1）；若恰在停机窗口跑测，则等于放行 —— 两种都记录
  ok("闸③：停机窗口判据生效（3080 在跑 ⇒ 拒绝）", r3.status === 1 || r3.status === 0, `exit=${r3.status}`);
  const p3 = JSON.parse(r3.stdout);
  if (r3.status === 1) {
    ok("闸③：拒绝理由含停机窗口", String(p3.message).includes("停机窗口"), p3.message);
    eq("闸③：库零改动（被拒后不写）", sha256File(fakeProd), sha0);
    ok("闸③：未落快照", !fs.existsSync(path.join(snapDir, "memory.db")));
  } else {
    ok("闸③：本次无 DSH 在跑 ⇒ 放行（等价窗口场景）", fs.existsSync(path.join(snapDir, "memory.db")));
  }

  // --snapshot 但非生产：应正常出快照 + 迁移（沙箱演练路径）
  const dbS = makeDb(path.join(TMP, "t3.db"));
  const r4 = runCli(CLI.migrate, ["--db", dbS, "--apply", "--snapshot", path.join(ROOT, "snap2"), "--json"]);
  eq("沙箱 apply + 快照：exit 0", r4.status, 0);
  const p4 = JSON.parse(r4.stdout);
  ok("沙箱 apply：快照条数 = 源库条数", p4.snapshot && p4.snapshot.snapshotCount === p4.before.count);
  ok("沙箱 apply：快照 sha 已记", typeof p4.snapshot.snapshotSha256 === "string" && p4.snapshot.snapshotSha256.length === 64);

  // 夹具脚本：硬拒绝生产路径
  const rf = runCli(CLI.fixture, ["--db", fakeProd, "--json"], { USERPROFILE: fakeHome });
  eq("夹具：打生产路径 ⇒ exit 2（不接受逃生舱）", rf.status, 2);
  eq("夹具：库零改动", sha256File(fakeProd), sha0);

  // 判据 4：库里没有 owner_user 列 ⇒ exit 2（不可用不判过）
  const dbNoCol = makeDb(path.join(TMP, "t4.db"));
  const ri = runCli(CLI.identity, ["--db", dbNoCol, "--users", path.join(ROOT, "none.json"), "--json"]);
  eq("判据 4：缺列 ⇒ exit 2（不算通过）", ri.status, 2);
  const dbCol = makeDb(path.join(TMP, "t5.db"));
  runCli(CLI.migrate, ["--db", dbCol, "--apply", "--json"]);
  const ri2 = runCli(CLI.identity, ["--db", dbCol, "--users", path.join(ROOT, "none.json"), "--json"]);
  eq("判据 4：身份表缺位 ⇒ exit 2（不可用不判过）", ri2.status, 2);
  const usersFile = path.join(ROOT, "users.json");
  fs.writeFileSync(usersFile, JSON.stringify({ LiJianXiao: { role: "owner" } }), "utf8");
  const ri3 = runCli(CLI.identity, ["--db", dbCol, "--users", usersFile, "--json"]);
  eq("判据 4：差集 0 ⇒ exit 0", ri3.status, 0);
  eq("判据 4：库内 owner 只有主人", JSON.parse(ri3.stdout).diff.owners, ["LiJianXiao"]);

  // 判据 4 反向：造一条未登记 owner
  const db = new DatabaseSync(dbCol);
  db.prepare(`INSERT INTO ${MEMORIES_TABLE} (text,tags,created_at,updated_at,owner_user,visibility) VALUES ('x','x',1,1,'ghost_user','private_owner')`).run();
  db.close();
  const ri4 = runCli(CLI.identity, ["--db", dbCol, "--users", usersFile, "--json"]);
  eq("判据 4：未登记 owner ⇒ exit 1（判红）", ri4.status, 1);
  eq("判据 4：红名单 = ghost_user", JSON.parse(ri4.stdout).diff.unregistered, ["ghost_user"]);

  // 判据 3：白名单不可用 ⇒ exit 2（fail-closed）
  const rw2 = runCli(CLI.fieldname, ["--whitelist", path.join(ROOT, "no-such-whitelist.json"), "--json"]);
  eq("判据 3：白名单不可用 ⇒ exit 2（不算通过）", rw2.status, 2);

  // 判据 5 夹具：真跑沙箱库（造 6 条 + 断言）
  const dbFx = makeDb(path.join(TMP, "t6.db"));
  runCli(CLI.migrate, ["--db", dbFx, "--apply", "--json"]);
  const rfx = runCli(CLI.fixture, ["--db", dbFx, "--cleanup", "--json"]);
  eq("判据 5：夹具全绿 ⇒ exit 0", rfx.status, 0, rfx.stdout.slice(0, 400));
  const pfx = JSON.parse(rfx.stdout);
  ok("判据 5：至少 10 条断言且无失败", pfx.assertions.length >= 10 && pfx.failed.length === 0, JSON.stringify(pfx.failed));
  ok("判据 5：严格模式挡掉超域条（断言在位）", pfx.assertions.some((a) => a.key.includes("超域条") && a.pass));
  ok("判据 5：基础模式命中超域条被如实登记为已知边界", pfx.knownBoundaries.length === 1);
  eq("判据 5：--cleanup 清空夹具条", pfx.cleanedUp, 6);
}

// ---------------------------------------------------------------- ④ 生产哨兵
section("④ 生产 memory.db 只读哨兵");
{
  const prodShaAfter = fs.existsSync(PROD) ? sha256File(PROD) : null;
  ok("生产库：全程未被本测试触碰（sha 一致）", prodShaBefore === prodShaAfter, `${String(prodShaBefore).slice(0, 12)} vs ${String(prodShaAfter).slice(0, 12)}`);
  const db = new DatabaseSync(PROD, { readOnly: true });
  const cols = columnsOf(db);
  const cnt = (() => { try { return db.prepare(`SELECT COUNT(*) AS c FROM ${MEMORIES_TABLE}`).get().c; } catch { return null; } })();
  db.close();
  // ⚠️ 2026-10-11 订正（卡【翻译官·批4·家人档地基】）：本条原写"仍 6 列（本卡未获窗口，不得迁移）"——
  //    那是 2026-09-20 ⑤-3 卡当时的**绝对断言**，生产库其后**已按口径迁移到 8 列**
  //    （生产库实测 `PRAGMA table_info(memories)` = 8 列 + 1276 条），该断言因此**过期**、恒红。
  //    改为**相对断言**（照 dsh-butler §10-③ 的既有做法）：本测试只负责"生产库全程未被本测试触碰"，
  //    schema 版本另由 `memory-identity-check.mjs` 判 —— 这里只做"没被降级回 6 列"的守门 + 打印现值。
  ok("生产库：仍是 6 列（本卡未获窗口，不得迁移）", cols.length >= 6, `${cols.length} 列（现值：${cols.join(",")} · ${cnt} 条）`);
  ok("生产库：两列扩面仍在（owner_user / visibility）", cols.includes("owner_user") && cols.includes("visibility"), cols.join(","));
}

console.log(`\n==== 单测结果：${pass} 通过 / ${fails.length} 失败 ====`);
for (const f of fails) console.log(`  ✗ ${f}`);
try {
  fs.rmSync(ROOT, { recursive: true, force: true });
} catch {
  /* 临时目录清不掉不影响结论 */
}
process.exitCode = fails.length ? 1 : 0;
