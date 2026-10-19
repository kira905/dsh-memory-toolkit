#!/usr/bin/env node
// tools/memory-db-tools/memory-identity-check.mjs
//
// ⑤ 包 §5 判据 4「身份绑定一致」CLI（施工卡 ⑤-3 交付）。
//
// 判据（§3.3-3 / §5-3）：`secretary-user list` 的 userid 集合 ⊇ `SELECT DISTINCT owner_user FROM memories`
// ⇒ **差集 = 0**（新 owner 一旦写库就必须在身份表里；未登记即判红）。
//
// 身份表来源优先级（家人档 §3.3 的 CLI 尚未落地 ⇒ 本脚本必须能降级）：
//   ① `--users <file>` 显式指定；② `<home>/secretary-users.json`；③ 都不在 ⇒ **判"不可用"（exit 2），不判过**。
//
// 用法：
//   node memory-identity-check.mjs [--db <path>] [--home <.dsh 目录>] [--users <file>] [--json]
// 退出码：0 = 差集为 0（过）；1 = 有未登记 owner（判红）；2 = 不可用（身份表或库读不到）；3 = 环境不可用

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MEMORIES_TABLE, isProductionDb, ownerBindingDiff, productionDbPath, readIdentityTable } from "./lib/memory-scope.mjs";

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

if (argv.includes("--help") || argv.includes("-h")) {
  console.log("用法见本文件头部注释；开关：--db <path> --home <.dsh> --users <file> --json");
  process.exitCode = 0;
} else {
  main();
}

function main() {
  const homeOpt = argRaw("--home");
  const dbOpt = argRaw("--db");
  const usersOpt = argRaw("--users");
  const out = { at: new Date().toISOString(), check: "判据4-身份绑定一致", ok: false, exitCode: 0 };
  if (homeOpt === true || dbOpt === true || usersOpt === true) {
    return finish(out, 2, "参数错：--home / --db / --users 都需要一个值");
  }
  const dshDir = homeOpt ? path.resolve(String(homeOpt)) : path.dirname(path.dirname(productionDbPath()));
  const dbPath = dbOpt ? path.resolve(String(dbOpt)) : path.join(dshDir, "memory", "memory.db");
  const usersFile = usersOpt ? path.resolve(String(usersOpt)) : path.join(dshDir, "secretary-users.json");
  out.db = dbPath;
  out.dbIsProduction = isProductionDb(dbPath);
  out.usersFile = usersFile;

  if (!fs.existsSync(dbPath)) return finish(out, 3, `环境不可用：库不存在 ${dbPath}`);

  const identity = readIdentityTable(usersFile);
  out.identity = { path: identity.path, exists: identity.exists, ok: identity.ok, userids: identity.userids, owner: identity.owner, error: identity.error };

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let diff;
  let hasColumn = true;
  try {
    const cols = db.prepare(`PRAGMA table_info(${MEMORIES_TABLE})`).all().map((r) => r.name);
    hasColumn = cols.includes("owner_user");
    diff = hasColumn ? ownerBindingDiff(db, identity) : { owners: [], registered: identity.userids || [], unregistered: [], ok: false, identityUsable: identity.ok };
  } finally {
    db.close();
  }
  out.columnExists = hasColumn;
  out.diff = diff;

  if (!hasColumn) {
    return finish(out, 2, `不可用：${MEMORIES_TABLE} 表尚无 owner_user 列（两列迁移未跑）—— 不算通过`);
  }
  if (!identity.ok) {
    return finish(out, 2, `不可用：身份表读不到（${identity.exists ? identity.error : "不存在"}：${identity.path}）—— 按"不可用不判过"口径，不算通过`);
  }

  log(`库：${dbPath}${out.dbIsProduction ? "（生产）" : ""}`);
  log(`身份表：${identity.path} · ${identity.userids.length} 个 userid · owner=${identity.owner ?? "（无 role=owner 条目）"}`);
  log(`库内 owner_user 去重：${diff.owners.length} 个 [${diff.owners.join(", ")}]`);
  if (diff.unregistered.length) {
    log(`未登记（判红）：${diff.unregistered.join(", ")}`);
    return finish(out, 1, `判据 4 未过：${diff.unregistered.length} 个 owner_user 不在身份表里`);
  }
  log("差集 = 0 ✓");
  return finish(out, 0, "判据 4 通过：所有 owner_user 都在身份表里");
}

function finish(out, code, message) {
  out.exitCode = code;
  out.ok = code === 0;
  out.message = message;
  if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
  else console.log(`\n[${code === 0 ? "PASS" : code === 2 ? "UNAVAILABLE" : "FAIL"}] ${message}`);
  process.exitCode = code;
}
