#!/usr/bin/env node
// audit-export.mjs — 季度记忆库体检 · 第 1 站：只读导出
// 固化自早期临时脚本（2026-09-25 体检工具链固化）
//   · 去硬编码：USERPROFILE / ~\.dsh → DSH_HOME 环境变量或家目录动态解析（见 resolveDshHome）
//   · 输出可传参：--out <file>，默认落系统临时目录（不是生产路径）
//   · 加 --help / --self-test · 收尾一律 process.exitCode（禁 process.exit）
// 用途：把 memory.db 的 memories 表全量导出为 memories.json —— 下游探针（audit-analyze / audit-struct-probe /
//       audit-hit-probe / audit-verify-unchanged）的唯一数据源。
// 只读：以 { readOnly: true } 打开生产库，绝不写库；产物只写 --out 指定文件。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const SELF = fileURLToPath(import.meta.url);
export const TOOL = path.basename(SELF);

// ---------- 路径基准（全部动态，无写死盘符 / 用户名） ----------
export function resolveDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(process.env.USERPROFILE || os.homedir(), ".dsh");
}
export const DSH_HOME = resolveDshHome();
export const DEFAULT_DB = path.join(DSH_HOME, "memory", "memory.db");
export const DEFAULT_WORK_DIR = path.join(os.tmpdir(), "dsh-mem-audit");
export const DEFAULT_OUT = path.join(DEFAULT_WORK_DIR, "memories.json");

// ---------- 通用小工具 ----------
export function isMainEntry() {
  const a = process.argv[1];
  if (!a) return false;
  try {
    return fs.realpathSync(a) === fs.realpathSync(SELF);
  } catch {
    return false;
  }
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const k = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out[k] = next;
          i++;
        } else out[k] = true;
      }
    } else out._.push(a);
  }
  return out;
}

export function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").toUpperCase();
}

export function makeAsserter() {
  let pass = 0,
    total = 0;
  const fails = [];
  return {
    ok(cond, label) {
      total++;
      if (cond) pass++;
      else fails.push(label);
    },
    eq(actual, expected, label) {
      this.ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
    },
    skip(label) {
      console.log(`  · SKIP ${label}`);
    },
    report() {
      if (fails.length) {
        console.log(`[self-test] FAIL  ${pass}/${total}`);
        for (const f of fails) console.log(`  - ${f}`);
        return 1;
      }
      console.log(`[self-test] PASS  ${pass}/${total}`);
      return 0;
    },
  };
}

// ---------- 核心逻辑（可被 import，供 self-test 复用） ----------
export function readMemories(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT id, text, tags, pinned, created_at, updated_at FROM memories ORDER BY id")
      .all();
    return rows.map((r) => ({
      id: r.id,
      text: r.text ?? "",
      tags: r.tags ?? "",
      pinned: r.pinned === 1,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  } finally {
    db.close();
  }
}

export function deviceStats(rows) {
  const dev = { ROG: 0, TUF: 0, NONE: 0, OTHER: 0, DOUBLE: 0 };
  for (const r of rows) {
    const m = r.text.match(/【设备[：:]\s*([^】]*)】/g);
    if (!m) dev.NONE++;
    else if (m.length > 1) dev.DOUBLE++;
    else if (/ROG/.test(m[0])) dev.ROG++;
    else if (/TUF/.test(m[0])) dev.TUF++;
    else dev.OTHER++;
  }
  return dev;
}

export function summarize(rows) {
  return {
    total: rows.length,
    pinned: rows.filter((r) => r.pinned).length,
    chars: rows.reduce((s, r) => s + r.text.length, 0),
    dev: deviceStats(rows),
    pinnedIds: rows.filter((r) => r.pinned).map((r) => r.id),
    tsSampleFirst: rows.slice(0, 2).map((r) => [r.id, r.created_at, r.updated_at]),
    tsSampleLast: rows.slice(-2).map((r) => [r.id, r.created_at, r.updated_at]),
  };
}

export function writeExport(dbPath, outFile) {
  const rows = readMemories(dbPath);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(rows), "utf8");
  return { rows, stats: summarize(rows) };
}

// ---------- CLI ----------
const USAGE = `audit-export.mjs — 季度记忆库体检 · 第 1 站：只读导出 memory.db → memories.json

用法：
  node ${TOOL} [--db <path>] [--out <file>] [--force] [--json] [--quiet]
  node ${TOOL} --help
  node ${TOOL} --self-test

参数：
  --db <path>      记忆库路径，默认 ${DEFAULT_DB}
  --out <file>     导出目标文件，默认 ${DEFAULT_OUT}
                   （默认落系统临时目录；季度体检建议显式传 --out 到自己建的体检目录）
  --force          目标文件已存在时允许覆盖（默认拒绝，保护基线快照）
  --json           以 JSON 输出统计（含路径）
  --quiet          不打印统计明细

退出码：
  0  成功
  1  --self-test 断言失败
  2  用法错误
  3  记忆库不存在 / 输出文件已存在且未加 --force
  4  运行错误（SQLite 读取或 JSON 写出失败）

只读保证：数据库一律以 { readOnly: true } 打开，本工具绝不写入记忆库。
`;

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
  if (typeof a["self-test"] !== "undefined") return selfTest();

  const dbPath = typeof a.db === "string" ? path.resolve(a.db) : DEFAULT_DB;
  const outFile = typeof a.out === "string" ? path.resolve(a.out) : DEFAULT_OUT;
  if (!fs.existsSync(dbPath)) {
    console.error(`[${TOOL}] 记忆库不存在：${dbPath}（可用 --db 指定）`);
    return 3;
  }
  if (fs.existsSync(outFile) && a.force !== true) {
    console.error(`[${TOOL}] 输出文件已存在：${outFile}`);
    console.error("  拒绝覆盖（该文件是 audit-verify-unchanged 的基线快照）——加 --force 覆盖，或用 --out 换路径。");
    return 3;
  }

  const { stats } = writeExport(dbPath, outFile);
  if (a.json) {
    console.log(JSON.stringify({ db: dbPath, out: outFile, ...stats }, null, 1));
  } else if (a.quiet !== true) {
    console.log(`DB=${dbPath}`);
    console.log(`OUT=${outFile}`);
    console.log(`TOTAL=${stats.total} PINNED=${stats.pinned} CHARS=${stats.chars}`);
    console.log("DEV=" + JSON.stringify(stats.dev));
    console.log("PINNED_IDS=" + stats.pinnedIds.join(","));
    console.log("TS_SAMPLE=" + JSON.stringify(stats.tsSampleFirst));
    console.log("TS_SAMPLE_LAST=" + JSON.stringify(stats.tsSampleLast));
  }
  return 0;
}

// ---------- self-test（无副作用：合成临时库 + 临时目录） ----------
export function selfTest() {
  const t = makeAsserter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-export-selftest-"));
  const dbFile = path.join(tmp, "fixture.db");
  const outFile = path.join(tmp, "out", "memories.json");
  try {
    const db = new DatabaseSync(dbFile); // 合成夹具库（临时目录，非生产）
    try {
      db.exec(
        "CREATE TABLE memories (id INTEGER PRIMARY KEY, text TEXT NOT NULL, tags TEXT, pinned INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER)",
      );
      const ins = db.prepare(
        "INSERT INTO memories (id, text, tags, pinned, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      );
      ins.run(1, "【设备：本机】第一条测试记忆，路径 <workspace>", "t1", 1, 1000, 1000);
      ins.run(2, "【设备：TUF】第二条测试记忆", "t2", 0, 2000, 2000);
      ins.run(3, "第三条无设备标记忆", "", 0, 3000, 3000);
    } finally {
      db.close();
    }

    const before = sha256File(dbFile);
    const { rows, stats } = writeExport(dbFile, outFile);

    t.eq(rows.length, 3, "导出条数");
    t.eq(rows[0].pinned, true, "pinned 归一为 boolean");
    t.eq(stats.pinned, 1, "pinned 计数");
    t.eq(stats.dev.ROG, 1, "设备标 ROG 计数");
    t.eq(stats.dev.TUF, 1, "设备标 TUF 计数");
    t.eq(stats.dev.NONE, 1, "无设备标计数");
    t.ok(fs.existsSync(outFile), "产物文件已生成（含自动 mkdir 父目录）");
    const back = JSON.parse(fs.readFileSync(outFile, "utf8"));
    t.eq(back.length, 3, "产物 JSON 可解析且条数一致");
    t.eq(back[2].text, "第三条无设备标记忆", "产物内容一致");

    // 自证只读
    t.eq(sha256File(dbFile), before, "合成库 sha256 前后一致（未写库）");
    const src = fs.readFileSync(SELF, "utf8");
    const calls = src.split("// ---------- self-test")[0].match(/new DatabaseSync\([^)]*\)/g) ?? [];
    t.ok(calls.length > 0, "主体逻辑段确实打开了数据库（探针真的在读库）");
    t.ok(calls.every((s) => /readOnly: true/.test(s)), "主体逻辑段每次 new DatabaseSync( 都带 readOnly: true");
    if (fs.existsSync(DEFAULT_DB)) t.ok(true, `生产库可 stat（只读探测）：${DEFAULT_DB}`);
    else t.skip(`生产库不存在（换机 / 测试环境正常）：${DEFAULT_DB}`);
  } catch (e) {
    t.ok(false, `self-test 抛错：${e?.message ?? e}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return t.report();
}

if (isMainEntry()) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(`[${TOOL}] 运行错误：${e?.stack ?? e}`);
    process.exitCode = 4;
  }
}
