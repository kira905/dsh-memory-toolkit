#!/usr/bin/env node
// tools/memory-db-tools/memory-schema-migrate.mjs
//
// ⑤ 包 §3.3 / P2 §3.8「两列」迁移 CLI（施工卡 ⑤-3 交付）。
//
// 做什么：给 `memories` 表补 `owner_user` + `visibility` 两列（+ visibility 索引）。
// 怎么保证安全：
//   · 默认 **dry-run**（只读规划，零写入）；
//   · `--apply` 打到**生产库**必须显式 `--allow-production`，否则拒绝（exit 2）；
//   · 打生产还必须过**停机窗口判据**（3080 无监听 + 无非空 -wal 残留），否则拒绝（fail-closed）；
//   · 打生产必须显式给 `--snapshot <dir>`（先 VACUUM INTO 快照 + 落 snapshot.json），否则拒绝；
//   · 幂等：列已存在就跳过（靠 `PRAGMA table_info`，不用 `CREATE TABLE IF NOT EXISTS` —— §3.8 明文）。
//
// 用法：
//   node memory-schema-migrate.mjs                                   # dry-run（默认生产路径，只读）
//   node memory-schema-migrate.mjs --db <path>                        # dry-run 指定库（沙箱）
//   node memory-schema-migrate.mjs --db <path> --apply                # 真改（非生产路径无需额外开关）
//   node memory-schema-migrate.mjs --allow-production --apply --snapshot <dir>   # 生产（需停机窗口）
//   node memory-schema-migrate.mjs --db <path> --json                 # 机器可读（stdout 只有 JSON）
//
// `--home <dir>` = DSH home（即 `.dsh` 目录），默认 `~/.dsh`；库 = `<home>/memory/memory.db`。
// `--users <file>` 显式指定身份表（缺省 `<home>/secretary-users.json`）。
// 退出码：0 = 就绪 / 已迁移（幂等）；1 = 有异常（被拒或复核未过）；2 = 用法错；3 = 环境不可用。

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import {
  MEMORIES_TABLE,
  NEW_COLUMNS,
  applyMigration,
  describeDb,
  isProductionDb,
  migrationPlan,
  productionDbPath,
  readIdentityTable,
  resolveDefaultOwner,
  sha256File,
} from "./lib/memory-scope.mjs";

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
const argOf = (name, def = null) => {
  const v = argRaw(name);
  return v === null ? def : v;
};
const flag = (name) => argv.includes(name);
const JSON_OUT = flag("--json");
const log = (...a) => {
  if (!JSON_OUT) console.log(...a);
};

if (flag("--help") || flag("-h")) {
  console.log("用法见本文件头部注释；关键开关：--db --home --users --apply --allow-production --snapshot <dir> --json");
  process.exitCode = 0;
} else {
  main().catch((e) => {
    if (JSON_OUT) console.log(JSON.stringify({ ok: false, exitCode: 1, message: `未捕获异常：${e && e.stack ? e.stack : e}` }, null, 2));
    else console.error(`未捕获异常：${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
}

async function main() {
  const homeOpt = argOf("--home", null); // = .dsh 目录
  const dbOpt = argRaw("--db");
  const usersOpt = argRaw("--users");
  const apply = flag("--apply");
  const allowProd = flag("--allow-production");
  const snapshotDir = argRaw("--snapshot");

  const result = {
    at: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run",
    ok: false,
    exitCode: 0,
    steps: [],
    warnings: [],
  };
  if (homeOpt === true || dbOpt === true || usersOpt === true || snapshotDir === true) {
    return finish(result, 2, "参数错：--home / --db / --users / --snapshot 都需要一个值");
  }

  const dshDir = homeOpt ? path.resolve(String(homeOpt)) : path.dirname(path.dirname(productionDbPath()));
  const dbPath = dbOpt ? path.resolve(String(dbOpt)) : path.join(dshDir, "memory", "memory.db");
  const usersFile = usersOpt ? path.resolve(String(usersOpt)) : path.join(dshDir, "secretary-users.json");
  const isProd = isProductionDb(dbPath);
  result.db = dbPath;
  result.isProduction = isProd;

  if (!fs.existsSync(dbPath)) return finish(result, 3, `环境不可用：库不存在 ${dbPath}`);

  // ---- 身份表（§3.3-3：默认值取自身份表；取不到回落常量并在自检里报一行）
  const identity = readIdentityTable(usersFile);
  const resolved = resolveDefaultOwner(identity);
  result.identity = { path: identity.path, exists: identity.exists, ok: identity.ok, owner: identity.owner, userids: identity.userids, error: identity.error };
  result.ownerDefault = { user: resolved.ownerUser, source: resolved.source };
  for (const n of resolved.notes) result.warnings.push(n);
  if (identity.ok) log(`✓ 身份表：${identity.userids.length} 个 userid · owner = ${resolved.ownerUser}（${identity.path}）`);
  else log(`⚠️ 身份表不可用（${identity.exists ? identity.error : "不存在"}：${identity.path}）→ owner_user 默认值回落 '${resolved.ownerUser}'`);

  // ---- 只读规划
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  let plan;
  let before;
  try {
    before = describeDb(ro);
    plan = migrationPlan(ro, { identity });
  } finally {
    ro.close();
  }
  result.before = { columns: before.columns, count: before.count, visibilityIndex: before.visibilityIndex };
  result.plan = { missing: plan.missing, present: plan.present, statements: plan.statements };

  log(`库：${dbPath}${isProd ? "（**生产库**）" : "（沙箱/副本）"}`);
  log(`现状：${before.columns.length} 列 · ${before.count} 条 · visibility 索引 ${before.visibilityIndex ? "在" : "缺"}`);
  log(`待办：缺列 [${plan.missing.join(", ") || "无"}] · 已有 [${plan.present.join(", ") || "无"}] · 语句 ${plan.statements.length} 条`);
  for (const s of plan.statements) log(`  · ${s}`);

  if (plan.statements.length === 0) {
    result.ok = true;
    result.steps.push("幂等：两列与索引均已在位，无需任何写入");
    return finish(result, 0, "已是目标结构（幂等）");
  }
  if (!apply) {
    result.ok = true;
    result.steps.push("dry-run：未写入任何内容（源库只读打开）");
    return finish(result, 0, "计划已列出（dry-run）");
  }

  // ---- 真改前的闸门
  if (isProd && !allowProd) {
    return finish(result, 2, "拒绝：目标是生产库，必须显式 --allow-production（未获停机窗口时不许跑）");
  }
  if (isProd) {
    if (typeof snapshotDir !== "string") {
      return finish(result, 2, "拒绝：打生产必须先给 --snapshot <dir>（VACUUM INTO 快照落回滚点）");
    }
    const win = await checkStopWindow([3080]);
    result.stopWindow = win;
    if (!win.ok) return finish(result, 1, `拒绝：停机窗口判据未过（${win.reasons.join("；")}）—— 请先停 DSH 再跑`);
    log(`✓ 停机窗口：3080 未监听 · -wal ${win.walBytes} 字节`);
  }

  // ---- 快照（先 VACUUM INTO，再动手）
  if (typeof snapshotDir === "string") {
    const snapDir = path.resolve(snapshotDir);
    const snapPath = path.join(snapDir, "memory.db");
    fs.mkdirSync(snapDir, { recursive: true });
    if (fs.existsSync(snapPath)) fs.rmSync(snapPath);
    const src = new DatabaseSync(dbPath, { readOnly: true });
    try {
      src.exec(`VACUUM INTO '${snapPath.replace(/\\/g, "/")}'`);
    } finally {
      src.close();
    }
    const snapDb = new DatabaseSync(snapPath, { readOnly: true });
    let snapInfo;
    try {
      snapInfo = describeDb(snapDb);
    } finally {
      snapDb.close();
    }
    const meta = {
      at: new Date().toISOString(),
      source: dbPath,
      sourceSha256: sha256File(dbPath),
      sourceCount: before.count,
      snapshot: snapPath,
      snapshotSha256: sha256File(snapPath),
      snapshotCount: snapInfo.count,
      snapshotColumns: snapInfo.columns,
      restoresTo: `${before.columns.length} 列（改前结构）`,
    };
    fs.writeFileSync(path.join(snapDir, "snapshot.json"), JSON.stringify(meta, null, 2), "utf8");
    result.snapshot = meta;
    if (snapInfo.count !== before.count) return finish(result, 1, `拒绝：快照条数 ${snapInfo.count} ≠ 源库 ${before.count}（快照不可信）`);
    log(`✓ 快照：${snapPath} · ${snapInfo.count} 条 · sha ${String(meta.snapshotSha256).slice(0, 16)}`);
    result.steps.push("VACUUM INTO 快照已落（含 snapshot.json）");
  } else {
    result.warnings.push("未给 --snapshot：本次未留 VACUUM INTO 快照（沙箱演练可接受，生产不允许）");
  }

  // ---- 执行迁移
  const rw = new DatabaseSync(dbPath);
  try {
    const ran = applyMigration(rw, plan);
    result.statementsRan = ran;
    result.steps.push(`已执行 ${ran.length} 条 DDL（事务内）`);
  } catch (e) {
    try {
      rw.close();
    } catch {
      /* ignore */
    }
    return finish(result, 1, `迁移失败：${e.message}`);
  }
  try {
    rw.close();
  } catch {
    /* ignore */
  }

  // ---- 复核
  const chk = new DatabaseSync(dbPath, { readOnly: true });
  let after;
  let dist;
  try {
    after = describeDb(chk);
    dist = chk
      .prepare(`SELECT owner_user AS owner, visibility AS vis, COUNT(*) AS c FROM ${MEMORIES_TABLE} GROUP BY 1, 2 ORDER BY 1, 2`)
      .all();
  } finally {
    chk.close();
  }
  result.after = { columns: after.columns, count: after.count, visibilityIndex: after.visibilityIndex, distribution: dist };
  const missingAfter = NEW_COLUMNS.filter((c) => !after.columns.includes(c.name)).map((c) => c.name);
  const countOk = after.count === before.count;
  log(`复核：${after.columns.length} 列 · ${after.count} 条 · 索引 ${after.visibilityIndex ? "在" : "缺"}`);
  for (const d of dist) log(`  · ${d.owner} / ${d.vis} = ${d.c} 条`);
  if (missingAfter.length || !countOk || !after.visibilityIndex) {
    return finish(result, 1, `复核未过：缺列 [${missingAfter.join(",")}] · 条数一致 ${countOk} · 索引 ${after.visibilityIndex}`);
  }
  result.ok = true;
  result.steps.push("复核通过：两列 + 索引在位、条数未变");
  return finish(result, 0, "迁移完成");
}

/** 停机窗口判据：3080（及调用方给的端口）无监听 **且** `memory.db-wal` 无非空残留。 */
export async function checkStopWindow(ports = [3080]) {
  const reasons = [];
  const walPath = `${productionDbPath()}-wal`;
  let walBytes = 0;
  if (fs.existsSync(walPath)) {
    try {
      walBytes = fs.statSync(walPath).size;
    } catch {
      walBytes = -1;
    }
  }
  if (walBytes > 0) reasons.push(`memory.db-wal 非空（${walBytes} 字节，疑似有未落盘事务）`);
  const live = [];
  for (const p of ports) if (await probePort(p)) live.push(p);
  if (live.length) reasons.push(`端口 ${live.join(",")} 在监听（DSH 在跑）`);
  return { ok: reasons.length === 0, reasons, walBytes, listening: live, checkedPorts: ports };
}

/** TCP 探活（loopback）。 */
export function probePort(port, host = "127.0.0.1", timeout = 800) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    let done = false;
    const end = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    sock.setTimeout(timeout);
    sock.on("connect", () => end(true));
    sock.on("timeout", () => end(false));
    sock.on("error", () => end(false));
  });
}

function finish(result, code, message) {
  result.exitCode = code;
  result.message = message;
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n[${code === 0 ? "OK" : "STOP"}] ${message}`);
    for (const s of result.steps) console.log(`  ✓ ${s}`);
    for (const w of result.warnings) console.log(`  ⚠️ ${w}`);
  }
  process.exitCode = code;
}
