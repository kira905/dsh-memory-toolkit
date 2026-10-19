#!/usr/bin/env node
// audit-verify-unchanged.mjs — 季度记忆库体检 · 收尾站：零改动自证（物理 sha + 逻辑指纹 + 逐条 diff）
// 固化自早期临时脚本（2026-09-25 体检工具链固化）
//   · 去硬编码：库与基线路径改为 --db / --baseline（默认系统临时目录里的 memories.json）
//   · 加 --expect-unchanged（有差异即非零退出，供体检/CI 断言）· --help / --self-test / --json
//   · 收尾 process.exitCode
// 用途：体检开始前用 audit-export.mjs 冻结基线，体检结束跑本工具 —— 若库有增删改，逐条列出来。
// 只读：数据库以 { readOnly: true } 打开；只读基线与库，不写任何文件。

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
export const DEFAULT_BASELINE = path.join(DEFAULT_WORK_DIR, "memories.json");

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

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();

export function readRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT id, text, tags, pinned, created_at, updated_at FROM memories ORDER BY id")
      .all()
      .map((r) => ({
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

// ---------- 核心逻辑 ----------
export function verifyUnchanged(dbPath, baselinePath, baselineRows) {
  const phys = sha256(fs.readFileSync(dbPath));
  const st = fs.statSync(dbPath);
  const now = readRows(dbPath);
  const logical = sha256(now.map((r) => `${r.id}\u0000${r.pinned ? 1 : 0}\u0000${r.tags}\u0000${r.text}`).join("\u0001"));
  const before = baselineRows ?? JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const beforeMap = new Map(before.map((r) => [r.id, r]));
  const added = now.filter((r) => !beforeMap.has(r.id)).map((r) => r.id);
  const removed = before.filter((r) => !now.some((x) => x.id === r.id)).map((r) => r.id);
  const changedIds = [];
  for (const r of now) {
    const b = beforeMap.get(r.id);
    if (!b) continue;
    if (b.text !== r.text || b.pinned !== r.pinned || b.tags !== r.tags) changedIds.push(r.id);
  }
  return {
    db: dbPath,
    baseline: baselinePath,
    phys,
    sizeBytes: st.size,
    mtime: st.mtime.toISOString(),
    count: now.length,
    pinned: now.filter((r) => r.pinned).length,
    logical,
    baselineCount: before.length,
    added,
    removed,
    changed: changedIds,
    unchanged: added.length === 0 && removed.length === 0 && changedIds.length === 0,
  };
}

const USAGE = `audit-verify-unchanged.mjs — 季度体检收尾站：memory.db 零改动自证

用法：
  node ${TOOL} [--db <path>] [--baseline <memories.json>] [--expect-unchanged] [--json]
  node ${TOOL} --help
  node ${TOOL} --self-test

参数：
  --db <path>         记忆库路径，默认 ${DEFAULT_DB}
  --baseline <file>   基线快照（audit-export.mjs 的产物），默认 ${DEFAULT_BASELINE}
  --expect-unchanged  有差异时以退出码 3 结束（供自动化断言）；默认只报告不判失败
  --json              以 JSON 输出

输出：物理 sha256 / 文件大小 / 最后写入时间 / 条数 / pinned / 逻辑内容指纹 / 逐条 diff（新增·缺失·内容变更）

退出码：
  0  成功（无 --expect-unchanged 时：即使有差异也算成功）
  1  --self-test 断言失败
  2  用法错误
  3  库或基线不存在；或 --expect-unchanged 下检出了差异
  4  运行错误

只读：数据库以 { readOnly: true } 打开；只读基线；不写任何文件。
`;

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
  if (typeof a["self-test"] !== "undefined") return selfTest();

  const dbPath = typeof a.db === "string" ? path.resolve(a.db) : DEFAULT_DB;
  const baselinePath = typeof a.baseline === "string" ? path.resolve(a.baseline) : DEFAULT_BASELINE;
  if (!fs.existsSync(dbPath)) {
    console.error(`[${TOOL}] 记忆库不存在：${dbPath}`);
    return 3;
  }
  if (!fs.existsSync(baselinePath)) {
    console.error(`[${TOOL}] 基线不存在：${baselinePath}（先跑 audit-export.mjs，或用 --baseline 指定）`);
    return 3;
  }
  const r = verifyUnchanged(dbPath, baselinePath);

  if (a.json) {
    console.log(JSON.stringify(r, null, 1));
  } else {
    console.log(`文件: ${r.db}`);
    console.log(`物理 sha256 = ${r.phys}`);
    console.log(`大小 = ${r.sizeBytes} B ｜ 最后写入 = ${r.mtime}`);
    console.log(`条数 = ${r.count} ｜ pinned = ${r.pinned}`);
    console.log(`逻辑内容指纹 sha256 = ${r.logical}`);
    console.log(`基线: ${r.baseline}（${r.baselineCount} 条）`);
    console.log(
      `对照基线: 新增=${r.added.length}${r.added.length ? " [" + r.added.join(",") + "]" : ""} 缺失=${r.removed.length}${r.removed.length ? " [" + r.removed.join(",") + "]" : ""} 内容变更=${r.changed.length}${r.changed.length ? " [" + r.changed.join(",") + "]" : ""}`,
    );
    console.log(r.unchanged ? "结论: 无改动（体检期间记忆库零写入）" : "结论: 检出改动（见上方逐条 diff）");
  }
  if (a["expect-unchanged"] === true && !r.unchanged) return 3;
  return 0;
}

// ---------- self-test（无副作用：合成库 + 合成基线） ----------
export function selfTest() {
  const t = makeAsserter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-verify-selftest-"));
  const dbFile = path.join(tmp, "fixture.db");
  const baseOk = path.join(tmp, "baseline-ok.json");
  const baseDrift = path.join(tmp, "baseline-drift.json");
  try {
    const db = new DatabaseSync(dbFile); // 合成夹具库（临时目录，非生产）
    try {
      db.exec(
        "CREATE TABLE memories (id INTEGER PRIMARY KEY, text TEXT NOT NULL, tags TEXT, pinned INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER)",
      );
      const ins = db.prepare("INSERT INTO memories (id, text, tags, pinned, created_at, updated_at) VALUES (?,?,?,?,?,?)");
      ins.run(1, "第一条", "t1", 1, 1000, 1000);
      ins.run(2, "第二条", "", 0, 2000, 2000);
    } finally {
      db.close();
    }
    const snap = readRows(dbFile).map((r) => ({ ...r }));
    fs.writeFileSync(baseOk, JSON.stringify(snap), "utf8");
    // 漂移基线：#2 内容不同、且多一条 #3
    const drift = snap.map((r) => (r.id === 2 ? { ...r, text: "第二条（旧）" } : r));
    drift.push({ id: 3, text: "基线多出的第三条", tags: "", pinned: false, created_at: 3000, updated_at: 3000 });
    fs.writeFileSync(baseDrift, JSON.stringify(drift), "utf8");

    const beforeDb = sha256(fs.readFileSync(dbFile));
    const beforeBaseOk = fs.readFileSync(baseOk, "utf8");
    const beforeBaseDrift = fs.readFileSync(baseDrift, "utf8");

    const ok = verifyUnchanged(dbFile, baseOk);
    t.eq(ok.count, 2, "条数");
    t.eq(ok.pinned, 1, "pinned 计数");
    t.eq(ok.unchanged, true, "一致基线 ⇒ unchanged=true");
    t.eq(ok.added.length, 0, "无新增");
    t.eq(ok.changed.length, 0, "无内容变更");
    t.ok(/^[0-9A-F]{64}$/.test(ok.phys), "物理 sha256 形状");
    t.ok(/^[0-9A-F]{64}$/.test(ok.logical), "逻辑指纹 sha256 形状");

    const drifted = verifyUnchanged(dbFile, baseDrift);
    t.eq(drifted.unchanged, false, "漂移基线 ⇒ unchanged=false");
    t.eq(drifted.removed.length, 1, "检出缺失 1 条（#3 在基线里、库里没有）");
    t.eq(drifted.removed[0], 3, "缺失 id = 3");
    t.eq(drifted.changed.length, 1, "检出内容变更 1 条");
    t.eq(drifted.changed[0], 2, "内容变更 id = 2");
    t.eq(drifted.logical, ok.logical, "迁移不影响库本身：两次逻辑指纹一致");

    // 自证只读
    t.eq(sha256(fs.readFileSync(dbFile)), beforeDb, "合成库 sha256 前后一致（未写库）");
    t.eq(fs.readFileSync(baseOk, "utf8"), beforeBaseOk, "基线文件（一致版）前后一致");
    t.eq(fs.readFileSync(baseDrift, "utf8"), beforeBaseDrift, "基线文件（漂移版）前后一致");
    const src = fs.readFileSync(SELF, "utf8");
    const calls = src.split("// ---------- self-test")[0].match(/new DatabaseSync\([^)]*\)/g) ?? [];
    t.ok(calls.length > 0, "主体逻辑段确实打开了数据库（探针真的在读库）");
    t.ok(calls.every((s) => /readOnly: true/.test(s)), "主体逻辑段每次 new DatabaseSync( 都带 readOnly: true");
    t.ok(!/fs\.writeFileSync/.test(src.split("// ---------- self-test")[0]), "主体逻辑段不含 fs.writeFileSync");
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
