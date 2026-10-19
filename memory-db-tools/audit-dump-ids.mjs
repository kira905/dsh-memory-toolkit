#!/usr/bin/env node
// audit-dump-ids.mjs — 季度记忆库体检：按 id 取全文（分批精读用）
// 固化自早期临时脚本（2026-09-25 体检工具链固化）
//   · 去硬编码：输出目录改为 --out <file>（默认系统临时目录），库路径改为 --db（默认动态解析）
//   · 加 --help / --self-test / --stdout · 收尾 process.exitCode
// 用途：把指定 id 的记忆全文批量写成文本（或打印），规避大段中文走 stdout 的编码/截断坑。
// 只读：数据库以 { readOnly: true } 打开，绝不写库；产物只写 --out 指定文件。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const SELF = fileURLToPath(import.meta.url);
export const TOOL = path.basename(SELF);

export function resolveDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(process.env.USERPROFILE || os.homedir(), ".dsh");
}
export const DSH_HOME = resolveDshHome();
export const DEFAULT_DB = path.join(DSH_HOME, "memory", "memory.db");
export const DEFAULT_WORK_DIR = path.join(os.tmpdir(), "dsh-mem-audit");

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

export function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").toUpperCase();
}

export function parseIds(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\s]+/);
  return parts
    .flatMap((s) => String(s).split(/[,\s]+/))
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger);
}

// ---------- 核心逻辑 ----------
export function dumpIds(dbPath, ids) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const ph = ids.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, text, pinned FROM memories WHERE id IN (${ph}) ORDER BY id`).all(...ids);
    const text = rows
      .map((r) => `=== #${r.id} [pinned=${r.pinned === 1 ? "Y" : "-"}] ===\n${r.text}`)
      .join("\n\n");
    return { rows, text, chars: rows.reduce((s, r) => s + r.text.length, 0) };
  } finally {
    db.close();
  }
}

const USAGE = `audit-dump-ids.mjs — 季度体检：按 id 取记忆全文（分批精读）

用法：
  node ${TOOL} --ids 1,2,3 [--out <file>] [--db <path>]
  node ${TOOL} --ids 1 2 3 --stdout
  node ${TOOL} --help
  node ${TOOL} --self-test

参数：
  --ids <a,b,c>  要取全文的记忆 id（逗号或空格分隔；也可用位置参数：node ${TOOL} 1 2 3）
  --out <file>   输出文件，默认 ${DEFAULT_WORK_DIR}\\dump-ids-<时间戳>.txt
  --stdout       直接打印到标准输出（小批量方便；大批量仍建议 --out 防截断）
  --db <path>    记忆库路径，默认 ${DEFAULT_DB}
  --json         以 JSON 输出（含路径与条数）

退出码：
  0  成功
  1  --self-test 断言失败
  2  用法错误（未给任何 id）
  3  记忆库不存在
  4  运行错误

只读：数据库以 { readOnly: true } 打开；产物只写 --out（默认临时目录，不落生产路径）。
`;

export function defaultOut(now = new Date()) {
  // 用本地时间命名（不用 toISOString：那是 UTC，本地 01:21 会写成前一天的 17:21，看着像旧文件）
  const p = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return path.join(DEFAULT_WORK_DIR, `dump-ids-${ts}.txt`);
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
  if (typeof a["self-test"] !== "undefined") return selfTest();

  const ids = parseIds(a.ids ?? a._);
  if (!ids.length) {
    console.error(`[${TOOL}] 未提供 id。用法见 --help（示例：node ${TOOL} --ids 1,2,3）`);
    return 2;
  }
  const dbPath = typeof a.db === "string" ? path.resolve(a.db) : DEFAULT_DB;
  if (!fs.existsSync(dbPath)) {
    console.error(`[${TOOL}] 记忆库不存在：${dbPath}`);
    return 3;
  }

  const { rows, text, chars } = dumpIds(dbPath, ids);
  if (a.stdout === true) {
    console.log(text);
    console.error(`[${TOOL}] ${rows.length} 条 / ${chars} 字符（stdout）`);
    return 0;
  }
  const outFile = typeof a.out === "string" ? path.resolve(a.out) : defaultOut();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text, "utf8");
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (a.json) console.log(JSON.stringify({ db: dbPath, out: outFile, rows: rows.length, chars, missing }, null, 1));
  else {
    console.log(`OUT=${outFile}`);
    console.log(`${rows.length} 条 / ${chars} 字符${missing.length ? "｜未找到 id: " + missing.join(",") : ""}`);
  }
  return 0;
}

// ---------- self-test（无副作用：合成临时库） ----------
export function selfTest() {
  const t = makeAsserter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-dumpids-selftest-"));
  const dbFile = path.join(tmp, "fixture.db");
  const outFile = path.join(tmp, "out", "ids.txt");
  try {
    const db = new DatabaseSync(dbFile); // 合成夹具库（临时目录，非生产）
    try {
      db.exec(
        "CREATE TABLE memories (id INTEGER PRIMARY KEY, text TEXT NOT NULL, tags TEXT, pinned INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER)",
      );
      const ins = db.prepare("INSERT INTO memories (id, text, tags, pinned, created_at, updated_at) VALUES (?,?,?,?,?,?)");
      ins.run(7, "第七条记忆全文·甲乙丙", "t", 1, 1000, 1000);
      ins.run(8, "第八条记忆全文·丁戊己", "", 0, 2000, 2000);
      ins.run(9, "第九条记忆全文·庚辛壬", "", 0, 3000, 3000);
    } finally {
      db.close();
    }

    const before = sha256File(dbFile);
    t.eq(parseIds("7,8").length, 2, "parseIds 逗号分隔");
    t.eq(parseIds("7 8").length, 2, "parseIds 空格分隔");
    t.eq(parseIds(["7", "8"]).length, 2, "parseIds 数组");
    t.eq(parseIds("abc").length, 0, "parseIds 过滤非数字");

    const { rows, text, chars } = dumpIds(dbFile, [7, 9]);
    t.eq(rows.length, 2, "取到条数");
    t.eq(chars, "第七条记忆全文·甲乙丙".length + "第九条记忆全文·庚辛壬".length, "字符合计");
    t.ok(text.includes("=== #7 [pinned=Y] ==="), "pinned 标记 Y");
    t.ok(text.includes("第九条记忆全文·庚辛壬"), "全文内容写入");

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, text, "utf8");
    t.eq(fs.readFileSync(outFile, "utf8"), text, "落盘内容与返回值一致");
    t.ok(
      /dump-ids-20260925-010203\.txt$/.test(defaultOut(new Date(2026, 8, 25, 1, 2, 3))),
      "默认文件名用本地时间戳（YYYYMMDD-HHmmss）",
    );

    // 自证只读
    t.eq(sha256File(dbFile), before, "合成库 sha256 前后一致（未写库）");
    const src = fs.readFileSync(SELF, "utf8");
    const calls = src.split("// ---------- self-test")[0].match(/new DatabaseSync\([^)]*\)/g) ?? [];
    t.ok(calls.length > 0, "主体逻辑段确实打开了数据库（探针真的在读库）");
    t.ok(calls.every((s) => /readOnly: true/.test(s)), "主体逻辑段每次 new DatabaseSync( 都带 readOnly: true");
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
