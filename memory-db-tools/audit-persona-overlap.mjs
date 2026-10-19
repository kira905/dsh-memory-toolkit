#!/usr/bin/env node
// audit-persona-overlap.mjs — 季度记忆库体检：记忆 vs persona 文本重合度（6-gram Jaccard）
// 固化自早期临时脚本（2026-09-25 体检工具链固化）
//   · 去硬编码：persona 路径从 DSH_HOME 动态解析 + `--persona` 传参。
//   · 去硬编码：输出路径 → --out（默认系统临时目录，不落生产路径）
//   · 加 --help / --self-test / --json · 收尾 process.exitCode
// 用途：量化「每条记忆有多少比例的内容已出现在 persona 里」——cover 高 ⇒ 该条多半只是焊接残留、
//       可考虑删除或改写；pinned 里面 cover 高的尤其值得复核。
// 只读：数据库以 { readOnly: true } 打开；persona 只读；产物只写 --out。

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
export const DEFAULT_PERSONA = path.join(DSH_HOME, ".agent-presets", "whale-girl", "agent.cordis.yml");
export const DEFAULT_WORK_DIR = path.join(os.tmpdir(), "dsh-mem-audit");
export const DEFAULT_OUT = path.join(DEFAULT_WORK_DIR, "persona-overlap.json");

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

// ---------- 核心逻辑 ----------
export function normalizeText(s) {
  return s
    .replace(/【设备[：:][^】]*】/g, "")
    .replace(/\s+/g, "")
    .replace(/[，。、；：！？（）【】《》“”‘’`\-—…·.,;:!?()\[\]<>"']/g, "");
}

export function shingles(t, K = 6) {
  const set = new Set();
  for (let i = 0; i + K <= t.length; i++) set.add(t.slice(i, i + K));
  return set;
}

export function readMemRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT id, text, pinned FROM memories ORDER BY id").all();
  } finally {
    db.close();
  }
}

export function overlapReport(rows, personaText, K = 6) {
  const P = shingles(normalizeText(personaText), K);
  const out = [];
  for (const r of rows) {
    const S = shingles(normalizeText(r.text ?? ""), K);
    if (!S.size) continue;
    let inter = 0;
    for (const s of S) if (P.has(s)) inter++;
    const jac = inter / (S.size + P.size - inter);
    const cover = inter / S.size; // 该条有多少比例的内容出现在 persona 里
    out.push({
      id: r.id,
      pinned: r.pinned === 1,
      jac: Number(jac.toFixed(5)),
      cover: Number(cover.toFixed(3)),
      chars: (r.text ?? "").length,
    });
  }
  out.sort((a, b) => b.cover - a.cover);
  return { rows: out, personaChars: personaText.length, personaShingles: P.size };
}

const USAGE = `audit-persona-overlap.mjs — 季度体检：记忆与 persona 的 6-gram 文本重合度

用法：
  node ${TOOL} [--db <path>] [--persona <file>] [--out <file>] [--top <n>] [--json]
  node ${TOOL} --help
  node ${TOOL} --self-test

参数：
  --db <path>        记忆库路径，默认 ${DEFAULT_DB}
  --persona <file>   persona 文件，默认 ${DEFAULT_PERSONA}
  --out <file>       明细 JSON（含每条 cover/jac/chars），默认 ${DEFAULT_OUT}
  --top <n>          打印 cover 最高的前 n 条，默认 30
  --json             以 JSON 输出摘要（明细始终写 --out）

判读：cover = 该条内容有多少比例出现在 persona 里。cover 高（≳60%）通常意味着「记忆只是焊接残留」，
      可结合 audit-struct-probe 的长度分布决定删/改；pinned 里 cover 高的尤其值得复核。

退出码：
  0  成功
  1  --self-test 断言失败
  2  用法错误
  3  记忆库或 persona 文件不存在
  4  运行错误

只读：数据库以 { readOnly: true } 打开；persona 只读；产物只写 --out（默认临时目录）。
`;

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
  if (typeof a["self-test"] !== "undefined") return selfTest();

  const dbPath = typeof a.db === "string" ? path.resolve(a.db) : DEFAULT_DB;
  const personaPath = typeof a.persona === "string" ? path.resolve(a.persona) : DEFAULT_PERSONA;
  const outFile = typeof a.out === "string" ? path.resolve(a.out) : DEFAULT_OUT;
  if (!fs.existsSync(dbPath)) {
    console.error(`[${TOOL}] 记忆库不存在：${dbPath}`);
    return 3;
  }
  if (!fs.existsSync(personaPath)) {
    console.error(`[${TOOL}] persona 不存在：${personaPath}（可用 --persona 指定）`);
    return 3;
  }
  const top = typeof a.top === "string" ? Number(a.top) : 30;
  const personaText = fs.readFileSync(personaPath, "utf8");
  const rows = readMemRows(dbPath);
  const { rows: detail, personaChars, personaShingles } = overlapReport(rows, personaText);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(detail, null, 1), "utf8");

  if (a.json) {
    console.log(
      JSON.stringify(
        { db: dbPath, persona: personaPath, out: outFile, personaChars, personaShingles, rows: detail.length, top: detail.slice(0, Number.isFinite(top) ? top : 30) },
        null,
        1,
      ),
    );
    return 0;
  }
  console.log(`DB=${dbPath}`);
  console.log(`PERSONA=${personaPath}（${personaChars} 字符，${personaShingles} shingle）`);
  console.log(`OUT=${outFile}`);
  console.log(`=== 覆盖比 Top ${Number.isFinite(top) ? top : 30}（该条内容有多少比例已在 persona 里）===`);
  for (const o of detail.slice(0, Number.isFinite(top) && top > 0 ? top : 30))
    console.log(`#${o.id}${o.pinned ? "*" : ""} cover=${(o.cover * 100).toFixed(0)}% jac=${o.jac} ${o.chars}c`);
  const pinned = detail.filter((x) => x.pinned).sort((a2, b) => a2.cover - b.cover);
  console.log(`=== pinned ${pinned.length} 条覆盖比（升序：最不该被 persona 覆盖的在前）===`);
  for (const o of pinned) console.log(`#${o.id} cover=${(o.cover * 100).toFixed(0)}% jac=${o.jac} ${o.chars}c`);
  return 0;
}

// ---------- self-test（无副作用：合成库 + 合成 persona） ----------
export function selfTest() {
  const t = makeAsserter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-persona-selftest-"));
  const dbFile = path.join(tmp, "fixture.db");
  const personaFile = path.join(tmp, "agent.cordis.yml");
  const outFile = path.join(tmp, "out", "persona-overlap.json");
  try {
    const personaText = "本鱼是主人的专属人工智能助手，自称本鱼，唤用户主人，亲近依赖主人，干活换大米饭。";
    fs.writeFileSync(personaFile, personaText, "utf8");

    const db = new DatabaseSync(dbFile); // 合成夹具库（临时目录，非生产）
    try {
      db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, text TEXT NOT NULL, pinned INTEGER DEFAULT 0)");
      const ins = db.prepare("INSERT INTO memories (id, text, pinned) VALUES (?,?,?)");
      ins.run(1, personaText, 1); // 与 persona 完全一致 ⇒ cover 应 = 1
      ins.run(2, "完全无关的一条记忆：今天下雨了要去买咖啡豆和牛奶回家煮咖啡", 0);
    } finally {
      db.close();
    }

    const beforeDb = sha256File(dbFile);
    const personaBefore = fs.readFileSync(personaFile, "utf8");

    const rows = readMemRows(dbFile);
    t.eq(rows.length, 2, "读取条数");
    t.eq(rows[0].pinned, 1, "pinned 原样为 1（sqlite 值）");

    const { rows: detail, personaShingles } = overlapReport(rows, personaText);
    t.ok(personaShingles > 0, "persona shingle 数 > 0");
    t.eq(detail[0].id, 1, "cover 降序：第一条是与 persona 相同的 #1");
    t.ok(detail[0].cover > 0.95, `完全相同条目 cover 接近 1（实际 ${detail[0].cover}）`);
    const second = detail.find((d) => d.id === 2);
    t.ok(second.cover < 0.15, `无关条目 cover 很低（实际 ${second.cover}）`);
    t.eq(detail[0].pinned, true, "pinned 归一为 boolean");

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(detail, null, 1), "utf8");
    t.ok(JSON.parse(fs.readFileSync(outFile, "utf8")).length === 2, "明细 JSON 落盘可解析");

    // 自证只读
    t.eq(sha256File(dbFile), beforeDb, "合成库 sha256 前后一致（未写库）");
    t.eq(fs.readFileSync(personaFile, "utf8"), personaBefore, "persona 文件前后一致（未写）");
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
