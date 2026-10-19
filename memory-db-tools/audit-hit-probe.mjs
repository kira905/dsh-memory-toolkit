#!/usr/bin/env node
// audit-hit-probe.mjs — 季度记忆库体检：机器特征词命中探针（给「漏标设备」判据兜底）
// 固化自早期临时脚本（2026-09-25 体检工具链固化）
//   · 去硬编码：原来写死 15 个 id → 改为 --ids 传参；数据源 --in（默认系统临时目录）
//   · 去硬编码：用户名/盘符一律泛匹配（跨机通用）。
//   · 加 --help / --self-test / --json · 收尾 process.exitCode
// 用途：对给定 id 逐条列出「命中了哪些机器特征词」，用于自证 list-nodev 的漏标判据站得住。
// 只读：只读 memories.json，不写任何文件、不碰 memory.db。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function parseIds(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\s]+/);
  return parts
    .flatMap((s) => String(s).split(/[,\s]+/))
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger);
}

// ---------- 机器特征词表（跨机通用，用户名泛匹配） ----------
export const MACHINE_PATTERNS = [
  ["盘符绝对路径", /[A-Za-z]:[\\/]/g],
  ["用户目录", /[\\/]Users[\\/][^\\/]+/g],
  ["临时/测试根", /(?:dsh-offsync|DSH-test|_tmp)/g],
  ["ComfyUI", /ComfyUI/g],
  ["3080/3090/3092", /30[89][0-9]/g],
  [".dsh", /\.dsh/g],
  ["guard/守护鱼", /guard|守护鱼/g],
  ["dsh-", /dsh-/g],
];

// ---------- 核心逻辑 ----------
export function hitReport(mems, ids) {
  const out = [];
  for (const id of ids) {
    const m = mems.find((x) => x.id === id);
    if (!m) {
      out.push({ id, missing: true, hits: [], head: "" });
      continue;
    }
    const hits = MACHINE_PATTERNS.filter(([, re]) => {
      re.lastIndex = 0;
      return re.test(m.text);
    }).map(([n]) => n);
    out.push({ id, missing: false, hits, head: m.text.split("\n")[0].slice(0, 46) });
  }
  return out;
}

const USAGE = `audit-hit-probe.mjs — 季度体检：给定 id 看命中了哪些机器特征词

用法：
  node ${TOOL} --ids 40,46,67 [--in <memories.json>] [--json]
  node ${TOOL} --help
  node ${TOOL} --self-test

参数：
  --ids <a,b,c>  要检查的记忆 id（逗号或空格分隔；必填）
  --in <file>    记忆导出 JSON，默认 ${DEFAULT_IN}（由 audit-export.mjs 产出）
  --json         以 JSON 输出

退出码：
  0  成功
  1  --self-test 断言失败
  2  用法错误（未给 id）
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

  const ids = parseIds(a.ids ?? a._);
  if (!ids.length) {
    console.error(`[${TOOL}] 未提供 id。用法见 --help（示例：node ${TOOL} --ids 40,46）`);
    return 2;
  }
  const inFile = typeof a.in === "string" ? path.resolve(a.in) : DEFAULT_IN;
  if (!fs.existsSync(inFile)) {
    console.error(`[${TOOL}] 输入不存在：${inFile}（先跑 audit-export.mjs，或用 --in 指定）`);
    return 3;
  }
  const mems = JSON.parse(fs.readFileSync(inFile, "utf8"));
  const report = hitReport(mems, ids);
  if (a.json) {
    console.log(JSON.stringify({ in: inFile, report }, null, 1));
    return 0;
  }
  for (const r of report) {
    if (r.missing) console.log(`#${r.id} [未找到]`);
    else console.log(`#${r.id} [${r.hits.join(", ")}] ${r.head}`);
  }
  return 0;
}

// ---------- self-test（无副作用：合成 JSON 落临时目录） ----------
export function selfTest() {
  const t = makeAsserter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-hit-selftest-"));
  const fix = path.join(tmp, "memories.json");
  try {
    const DRV = path.parse(process.cwd()).root;
    const mems = [
      { id: 1, text: "纯文本，不含任何机器特征", pinned: false },
      { id: 2, text: `在 ${DRV}work 下干活，用户 ${DRV}Users${path.sep}alice`, pinned: false },
      { id: 3, text: "提到 guard 守护鱼与 .dsh 目录和 3080 端口", pinned: false },
    ];
    fs.writeFileSync(fix, JSON.stringify(mems), "utf8");
    const before = fs.readFileSync(fix, "utf8");
    const data = JSON.parse(fs.readFileSync(fix, "utf8"));

    const r = hitReport(data, [1, 2, 3, 99]);
    t.eq(r.length, 4, "返回条数（含未找到）");
    t.eq(r[0].hits.length, 0, "#1 无命中");
    t.ok(r[1].hits.includes("盘符绝对路径"), "#2 命中盘符绝对路径");
    t.ok(r[1].hits.includes("用户目录"), "#2 命中用户目录（用户名泛匹配）");
    t.ok(r[1].hits.includes("临时/测试根") === false, "#2 不含测试根词");
    t.ok(r[2].hits.includes("guard/守护鱼"), "#3 命中 guard/守护鱼");
    t.ok(r[2].hits.includes(".dsh"), "#3 命中 .dsh");
    t.ok(r[2].hits.includes("3080/3090/3092"), "#3 命中端口号");
    t.eq(r[3].missing, true, "#99 未找到标记");
    t.eq(parseIds("1,2").length, 2, "parseIds 逗号分隔");

    // 自证只读
    t.eq(fs.readFileSync(fix, "utf8"), before, "输入 JSON 前后字节一致（未写输入）");
    const src = fs.readFileSync(SELF, "utf8");
    const body = src.split("// ---------- self-test")[0];
    t.ok(!/fs\.writeFileSync/.test(body), "主体逻辑段不含 fs.writeFileSync");
    t.ok(!/new DatabaseSync\(/.test(body), "主体逻辑段不开放任何数据库（纯 JSON 只读）");
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
