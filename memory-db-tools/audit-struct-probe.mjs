#!/usr/bin/env node
// audit-struct-probe.mjs — 季度记忆库体检：结构探针（设备标注异常 + 长度分布）
// 固化自早期临时脚本（2026-09-25 体检工具链固化）
//   · 数据源改为 --in <memories.json>（默认系统临时目录，不再写死 _tmp 路径）
//   · 加 --help / --self-test / --json · 收尾 process.exitCode
// 用途：看两类结构异常 —— ①【设备：X】写了但 X 不在「已知设备名」清单里（OTHER）
//       ②一条里写了两个设备标（DOUBLE）；
//       顺带给出 pinned 各条字符数与最长的非 pinned 条目（persona 瘦身候选）。
// 已知设备名不是硬编码：见 lib/known-devices.mjs（配置 memory-engine/config/audit-devices.json
//   / 环境变量 MEMORY_DB_AUDIT_DEVICES / 内置中性示例名 alpha、beta）。
// 只读：只读 memories.json，不碰 memory.db，不写任何文件（stdout only）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_DEVICES, isKnownDeviceTag, loadKnownDevices } from "./lib/known-devices.mjs";

export const SELF = fileURLToPath(import.meta.url);
export const TOOL = path.basename(SELF);

export function resolveDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return path.join(process.env.USERPROFILE || os.homedir(), ".dsh");
}
export const DSH_HOME = resolveDshHome();
export const DEFAULT_WORK_DIR = path.join(os.tmpdir(), "dsh-mem-audit");
export const DEFAULT_IN = path.join(DEFAULT_WORK_DIR, "memories.json");

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

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---------- 核心逻辑 ----------
export function structReport(mems, topLong = 12, devices = loadKnownDevices().devices) {
  const other = [];
  const dbl = [];
  for (const m of mems) {
    const g = m.text.match(/【设备[：:]\s*([^】]*)】/g) ?? [];
    if (g.length > 1) {
      dbl.push(`${m.id}: ${g.map((s) => s.trim()).join(" ")}`);
      continue;
    }
    if (g.length === 1 && !isKnownDeviceTag(g[0], devices)) other.push(`${m.id}: ${g[0]}`);
  }
  const pinnedChars = mems.filter((m) => m.pinned).map((m) => `${m.id}:${m.text.length}`);
  const topLongNonPinned = mems
    .filter((m) => !m.pinned)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, topLong)
    .map((m) => `${m.id}:${m.text.length}`);
  return { total: mems.length, other, dbl, pinnedChars, topLongNonPinned };
}

const USAGE = `audit-struct-probe.mjs — 季度体检：设备标注异常（OTHER / DOUBLE）+ 长度分布

用法：
  node ${TOOL} [--in <memories.json>] [--top <n>] [--json]
  node ${TOOL} --help
  node ${TOOL} --self-test

参数：
  --in <file>   记忆导出 JSON，默认 ${DEFAULT_IN}（由 audit-export.mjs 产出）
  --top <n>     列出最长的非 pinned 条目条数，默认 12
  --json        以 JSON 输出

退出码：
  0  成功
  1  --self-test 断言失败
  2  用法错误
  3  输入文件不存在
  4  运行错误（JSON 解析失败等）

只读：仅读 memories.json，不写任何文件、不触碰 memory.db。
`;

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
  if (typeof a["self-test"] !== "undefined") return selfTest();

  const inFile = typeof a.in === "string" ? path.resolve(a.in) : DEFAULT_IN;
  if (!fs.existsSync(inFile)) {
    console.error(`[${TOOL}] 输入不存在：${inFile}（先跑 audit-export.mjs，或用 --in 指定）`);
    return 3;
  }
  const top = typeof a.top === "string" ? Number(a.top) : 12;
  // 已知设备名：配置 / 环境变量 / 中性缺省（见 lib/known-devices.mjs）。警告走 stderr，不动 stdout 结构。
  const known = loadKnownDevices();
  for (const w of known.warnings) console.error(`[${TOOL}] 警告：${w}`);
  const mems = readJson(inFile);
  const r = structReport(mems, Number.isFinite(top) && top > 0 ? top : 12, known.devices);

  if (a.json) {
    console.log(JSON.stringify({ in: inFile, ...r }, null, 1));
    return 0;
  }
  console.log(`IN=${inFile}  TOTAL=${r.total}`);
  console.log(`OTHER(${r.other.length}) = ${r.other.join(" | ")}`);
  console.log(`DOUBLE(${r.dbl.length}) = ${r.dbl.join(" | ")}`);
  console.log("PINNED_CHARS = " + r.pinnedChars.join(" "));
  console.log("TOP_LONG_NONPINNED = " + r.topLongNonPinned.join(" "));
  return 0;
}

// ---------- self-test（无副作用：合成 JSON 落临时目录） ----------
// 夹具自带的「已知设备名」= 中性示例名，且显式传给被测函数：自检不与机器配置耦合。
export const FIXTURE_DEVICES = Object.freeze(["alpha", "beta"]);

export function selfTest() {
  const t = makeAsserter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-struct-selftest-"));
  const fix = path.join(tmp, "memories.json");
  try {
    const mems = [
      { id: 1, text: "普通条目", pinned: false, tags: "", created_at: 1, updated_at: 1 },
      { id: 2, text: "【设备：alpha】正常条目", pinned: true, tags: "", created_at: 1, updated_at: 1 },
      { id: 3, text: "【设备：某个不在名单里的名字】异常设备标", pinned: false, tags: "", created_at: 1, updated_at: 1 },
      {
        id: 4,
        text: "【设备：alpha】\n【设备：beta】双标条目" + "x".repeat(300),
        pinned: false,
        tags: "",
        created_at: 1,
        updated_at: 1,
      },
    ];
    fs.writeFileSync(fix, JSON.stringify(mems), "utf8");
    const before = fs.readFileSync(fix, "utf8");

    const r = structReport(readJson(fix), 12, FIXTURE_DEVICES);
    t.eq(r.total, 4, "总条数");
    t.eq(r.other.length, 1, "OTHER 命中数");
    t.eq(r.other[0].split(":")[0], "3", "OTHER 命中 id");
    t.eq(r.dbl.length, 1, "DOUBLE 命中数");
    t.eq(r.dbl[0].split(":")[0], "4", "DOUBLE 命中 id");
    t.eq(r.pinnedChars.length, 1, "pinned 字符数条目数");
    t.eq(r.topLongNonPinned[0].split(":")[0], "4", "最长非 pinned 是 #4");

    // 自证只读
    t.eq(fs.readFileSync(fix, "utf8"), before, "输入 JSON 前后字节一致（未写输入）");
    const src = fs.readFileSync(SELF, "utf8");
    const body = src.split("// ---------- self-test")[0];
    t.ok(!/fs\.writeFileSync/.test(body), "主体逻辑段（self-test 之前）不含 fs.writeFileSync");
    t.ok(!/new DatabaseSync\(/.test(body), "主体逻辑段不开放任何数据库（纯 JSON 只读）");

    // 「已知设备名」接入：判据跟着名单走，不靠改代码
    const widened = structReport(mems, 12, ["某个不在名单里的名字"]);
    t.eq(widened.other.length, 1, "换一套名单 ⇒ OTHER 仍是 1 条");
    t.eq(widened.other[0].split(":")[0], "2", "换名单后轮到 #2 算 OTHER（判据真的跟着名单走，不是写死的）");
    t.eq(widened.dbl.length, 1, "换名单不影响 DOUBLE 判据");
    t.eq(
      loadKnownDevices({ env: {}, config: { devices: [] } }).devices.join(","),
      BUILTIN_DEVICES.join(","),
      "空名单 ⇒ 退回内置中性缺省（不是「全都算 OTHER」）",
    );
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
