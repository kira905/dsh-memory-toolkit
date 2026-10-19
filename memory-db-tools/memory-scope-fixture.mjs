#!/usr/bin/env node
// tools/memory-db-tools/memory-scope-fixture.mjs
//
// ⑤ 包 §5 判据 5「检索隔离可证伪」夹具（施工卡 ⑤-3 交付）。
//
// 判据（§5-5 / §3.3-4）：造「主人私有条 + 家人条」→ 家人侧真跑过滤 SQL ⇒
//   · 家人侧**不得**命中主人私有条；· 主人注入层**不得**注入家人条。
// 本卡补充（卡面：「造超域条 ⇒ 必须被过滤掉」）：再验一条 **owner 未登记**的 `visibility='family'` 条
// ⇒ 严格模式（带 `registeredOwners` 护栏）必须把它挡掉。
//
// ⚠️ 本夹具**会写库**（造条）⇒ **硬拒绝生产路径**（不给 `--allow-production` 逃生舱：对生产做这事无意义）。
//    默认在沙箱副本（`VACUUM INTO` 出来的那份，或 `_archive/.../sandbox/` 工作副本）上跑。
//
// 用法：
//   node memory-scope-fixture.mjs --db <沙箱库> [--json] [--cleanup]
// 退出码：0 = 全部断言通过；1 = 有断言失败；2 = 用法错或路径被拒；3 = 环境不可用

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MEMORIES_TABLE,
  familyScopeSql,
  isProductionDb,
  ownerScopeSql,
  productionDbPath,
  selectMemories,
} from "./lib/memory-scope.mjs";

const MARK = "card053-fixture";
const argv = process.argv.slice(2);
function argRaw(name) {
  const i = argv.indexOf(name);
  if (i >= 0) {
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : true;
  }
  const kv = argv.find((a) => a.startsWith(`${name}=`));
  return kv ? kv.slice(name.length + 1) : null;
}
const JSON_OUT = argv.includes("--json");
const log = (...a) => {
  if (!JSON_OUT) console.log(...a);
};

/** 夹具身份表（wife_test / husband_test 已登记；stranger_unregistered **故意不登记**）。 */
const FIXTURE_IDENTITY = Object.freeze({
  LiJianXiao: { name: "主人", role: "owner", caps: ["*"] },
  wife_test: { name: "家人A（夹具）", role: "member", caps: [] },
  husband_test: { name: "家人B（夹具）", role: "member", caps: [] },
});

/** 夹具里"来自身份表"的已登记集合（= 严格模式护栏的输入）。 */
const REGISTERED = Object.freeze(Object.keys(FIXTURE_IDENTITY));

const CASES = Object.freeze([
  { key: "owner_private", owner: "LiJianXiao", visibility: "private_owner", expectFamily: false, expectOwner: true, why: "主人私有条（对家人侧超域）" },
  { key: "owner_family", owner: "LiJianXiao", visibility: "family", expectFamily: true, expectOwner: true, why: "主人显式共享条" },
  { key: "owner_public", owner: "LiJianXiao", visibility: "public", expectFamily: true, expectOwner: true, why: "公开条" },
  { key: "wife_private", owner: "wife_test", visibility: "private_owner", expectFamily: true, expectOwner: false, why: "家人A自己的私有条（本人可见）" },
  { key: "husband_private", owner: "husband_test", visibility: "private_owner", expectFamily: false, expectOwner: false, why: "家人B私有条（对家人A超域）" },
  { key: "stranger_family", owner: "stranger_unregistered", visibility: "family", expectFamily: false, expectOwner: false, why: "**超域条**：owner 未登记却标了 family" },
]);

function main() {
  const dbOpt = argRaw("--db");
  const cleanup = argv.includes("--cleanup");
  const out = { at: new Date().toISOString(), check: "判据5-检索隔离", ok: false, exitCode: 0, assertions: [], knownBoundaries: [] };
  if (!dbOpt || dbOpt === true) return finish(out, 2, "参数错：必须给 --db <沙箱库路径>（本夹具会写库，不接受默认生产路径）");
  const dbPath = path.resolve(String(dbOpt));
  out.db = dbPath;

  if (isProductionDb(dbPath)) {
    return finish(out, 2, `拒绝：${dbPath} 是生产库 —— 本夹具会造条写库，只允许打沙箱副本（生产库路径 = ${productionDbPath()}）`);
  }
  if (!fs.existsSync(dbPath)) return finish(out, 3, `环境不可用：库不存在 ${dbPath}`);

  const db = new DatabaseSync(dbPath);
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO ${MEMORIES_TABLE} (text, tags, pinned, created_at, updated_at, owner_user, visibility) VALUES (?, ?, 0, ?, ?, ?, ?)`);
  const ids = {};

  try {
    // ---- 前置：两列必须在位（迁移跑过）
    const cols = db.prepare(`PRAGMA table_info(${MEMORIES_TABLE})`).all().map((r) => r.name);
    const missing = ["owner_user", "visibility"].filter((c) => !cols.includes(c));
    if (missing.length) return finish(out, 2, `不可用：缺列 [${missing.join(", ")}] —— 先跑 memory-schema-migrate.mjs`);

    // ---- 清掉上一轮夹具条（幂等重跑）
    const pre = db.prepare(`DELETE FROM ${MEMORIES_TABLE} WHERE tags LIKE ?`).run(`%${MARK}%`);
    if (pre.changes) log(`（清掉上一轮夹具条 ${pre.changes} 条）`);

    // ---- 造条
    for (const c of CASES) {
      const r = insert.run(
        `[夹具 ${MARK}] ${c.key} —— ${c.why}`,
        `${MARK} ${c.key}`,
        now,
        now,
        c.owner,
        c.visibility,
      );
      ids[c.key] = Number(r.lastInsertRowid);
    }
    out.fixtureIds = ids;
    log(`造条：${CASES.length} 条（tags 含 ${MARK}）`);
    for (const c of CASES) log(`  · #${ids[c.key]} ${c.owner} / ${c.visibility} —— ${c.why}`);

    // ---- 家人侧（self = wife_test）· 基础模式（§3.3-4 原文）
    // ⚠️ 所有断言都只针对**本次造的夹具条**（`tags LIKE '<MARK>%'`）：真实库有近 600 条数据，
    //    不限定就会被 LIMIT 截断 ⇒ 断言假绿/假红（2026-09-20 本卡实测踩过，见 lib.selectMemories 注释）。
    const fx = (scope) => selectMemories(db, scope, { limit: 10000, tagLike: `%${MARK}%` });
    const base = familyScopeSql("wife_test");
    const famBaseKeys = keysOf(fx(base), ids);

    // ---- 家人侧 · 严格模式（带已登记护栏）
    const strict = familyScopeSql("wife_test", { registeredOwners: REGISTERED });
    const famStrictKeys = keysOf(fx(strict), ids);

    // ---- 主人侧注入层
    const ownerScope = ownerScopeSql("LiJianXiao");
    const ownerKeys = keysOf(fx(ownerScope), ids);

    // ---- 身份表不可用 ⇒ fail-closed（只留本人条）
    const failClosed = familyScopeSql("wife_test", { registeredOwners: [] });
    const fcKeys = keysOf(fx(failClosed), ids);

    out.scopes = {
      familyBase: { mode: base.mode, where: base.where, hit: famBaseKeys },
      familyStrict: { mode: strict.mode, where: strict.where, hit: famStrictKeys },
      ownerInject: { mode: ownerScope.mode, where: ownerScope.where, hit: ownerKeys },
      familyFailClosed: { mode: failClosed.mode, where: failClosed.where, hit: fcKeys },
    };

    // ---- 断言
    const A = (key, pass, detail) => out.assertions.push({ key, pass: Boolean(pass), detail });

    A("家人侧基础模式不命中主人私有条", !famBaseKeys.includes("owner_private"), `命中=[${famBaseKeys.join(", ")}]`);
    A("家人侧基础模式不命中另一家人私有条", !famBaseKeys.includes("husband_private"), `命中=[${famBaseKeys.join(", ")}]`);
    A("家人侧基础模式命中 family/public 条", famBaseKeys.includes("owner_family") && famBaseKeys.includes("owner_public"), `命中=[${famBaseKeys.join(", ")}]`);
    A("家人侧基础模式命中自己的私有条", famBaseKeys.includes("wife_private"), `命中=[${famBaseKeys.join(", ")}]`);
    A("家人侧严格模式不命中超域条", !famStrictKeys.includes("stranger_family"), `命中=[${famStrictKeys.join(", ")}]`);
    A("家人侧严格模式不命中主人私有条", !famStrictKeys.includes("owner_private"), `命中=[${famStrictKeys.join(", ")}]`);
    A("主人注入层不注入家人条", !ownerKeys.includes("wife_private") && !ownerKeys.includes("husband_private"), `命中=[${ownerKeys.join(", ")}]`);
    A("主人注入层命中主人自己的条", ownerKeys.includes("owner_private") && ownerKeys.includes("owner_family"), `命中=[${ownerKeys.join(", ")}]`);
    A("主人注入层不注入超域条", !ownerKeys.includes("stranger_family"), `命中=[${ownerKeys.join(", ")}]`);
    A("身份表不可用 ⇒ fail-closed 只返回本人条", fcKeys.length === 1 && fcKeys[0] === "wife_private", `命中=[${fcKeys.join(", ")}]`);

    // ---- 已知边界（如实记录，不计失败）
    out.knownBoundaries.push({
      key: "基础模式会命中超域条",
      detail: famBaseKeys.includes("stranger_family")
        ? "基础句（§3.3-4 原文：visibility IN ('family','public') OR owner_user=:self）**会**命中 owner 未登记却标 family 的条 ⇒ 实现层应使用严格模式（带 registeredOwners 护栏），且判据 4 会同时判红"
        : "基础句本轮未命中超域条（身份/数据组合变了，需复核）",
    });

    const failed = out.assertions.filter((a) => !a.pass);
    for (const a of out.assertions) log(`  ${a.pass ? "✓" : "✗"} ${a.key} —— ${a.detail}`);
    log(`已知边界：${out.knownBoundaries[0].detail}`);

    if (cleanup) {
      const del = db.prepare(`DELETE FROM ${MEMORIES_TABLE} WHERE tags LIKE ?`).run(`%${MARK}%`);
      out.cleanedUp = del.changes;
      log(`清理：删除夹具条 ${del.changes} 条`);
    }
    return finish(out, failed.length ? 1 : 0, failed.length ? `${failed.length} 条断言失败` : "判据 5 全部断言通过（家人侧不越域 · 主人侧不注入他人条 · 超域条被严格模式挡掉）");
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

function keysOf(rows, ids) {
  const byId = new Map(Object.entries(ids).map(([k, v]) => [Number(v), k]));
  return rows.map((r) => byId.get(Number(r.id))).filter(Boolean).sort();
}

function finish(out, code, message) {
  out.exitCode = code;
  out.ok = code === 0;
  out.message = message;
  out.failed = out.assertions.filter((a) => !a.pass).map((a) => a.key);
  if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
  else console.log(`\n[${code === 0 ? "PASS" : code === 2 || code === 3 ? "UNAVAILABLE" : "FAIL"}] ${message}`);
  process.exitCode = code;
}

// ---- 入口（放文件末尾：main 依赖的 const 表都在上方声明，避免 TDZ）
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("用法见本文件头部注释；开关：--db <沙箱库> [--json] [--cleanup]");
  process.exitCode = 0;
} else {
  main();
}
