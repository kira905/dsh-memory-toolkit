#!/usr/bin/env node
// audit-analyze.mjs — 季度记忆库体检 · 第 2 站：六项分析（消费 memories.json）
// 固化自早期临时脚本（2026-09-25 体检工具链固化）
//   · 去硬编码：输入/输出目录改为 --in <memories.json> / --out <dir>，默认落系统临时目录，不再写死 _tmp
//   · 加 --help / --self-test / --json · 收尾 process.exitCode
// 产物（6 个）：list-lines.txt（首行清单）· list-nodev.txt（含机器特征词却无【设备：】的候选）·
//              dup-pairs.txt（重复对，6-gram Jaccard）· keyword-hits.txt（过期关键词命中）·
//              pinned-full.txt（pinned 全文）· stats.json（统计）
// 只读：只读 memories.json；不碰 memory.db；产物只写 --out（默认临时目录）。

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

// ---------- 体检口径常量 ----------
// 「含机器特征词」判据（用于找漏标设备的记忆）。跨机通用：盘符绝对路径 / 用户目录 泛匹配。
export const MACHINE_RE =
  /([A-Za-z]:[\\/]|[\\/]Users[\\/][^\\/]+|\.dsh|dsh-|guard|守护鱼|30[89][0-9])/;

// 「过期关键词」扫描表 —— 季度体检口径，过期项增减改这里（真源说明见 README）。
export const STALE_KEYWORDS = [
  ["百度盘同步", /百度/],
  ["坚果云", /坚果云/],
  ["H盘测试根", /H:[\\/]DSH-test/],
  ["hold-zstd", /hold-zstd/],
  ["旧计划任务", /schtasks|计划任务/],
  ["browser-skill可用", /browser[-_ ]skill/],
  ["789条旧数", /789/],
  ["539条旧数", /539/],
  ["204条旧数", /合并.*204|204 条/],
  ["百度Sync", /BaiduSync/],
  ["IPAdapter锁脸", /IPAdapter/],
  ["LoRA女仆A", /LoRA|女仆A/],
  ["F盘测试根", /F:[\\/]DSH-test/],
  ["0.1.1旧主包", /0\.1\.1-rc/],
  ["3081手机", /3081/],
  ["Tailscale", /Tailscale/],
  ["whale-drag补丁", /re-patch-whale-client/],
  ["notifyRecentWindow旧", /notifyRecentWindow/],
  ["用户目录下的 .dsh", /[\\/]Users[\\/][^\\/]+[\\/]\.dsh/g],
];

export function normalizeText(s) {
  return s
    .replace(/【设备[：:][^】]*】/g, "")
    .replace(/\s+/g, "")
    .replace(/[，。、；：！？（）【】《》“”‘’`\-—…·.,;:!?()\[\]<>"']/g, "");
}

// ---------- 核心逻辑：纯函数，返回 { files, summary } ----------
export function analyze(mems, opts = {}) {
  const K = opts.shingle ?? 6;
  const minShared = opts.minShared ?? 6;
  const jacThreshold = opts.jacThreshold ?? 0.15;
  const byId = new Map(mems.map((m) => [m.id, m]));
  const files = {};

  // 1) 首行清单
  const lines = mems.map((m) => {
    const first = m.text.split("\n")[0].replace(/\s+/g, " ").slice(0, 96);
    return `#${m.id}${m.pinned ? "*" : ""} ${String(m.text.length).padStart(5)}c ${first}`;
  });
  files["list-lines.txt"] = lines.join("\n");

  // 2) 设备标缺失（含机器特征词却无【设备：】）
  const nodev = mems.filter((m) => !/【设备[：:]/.test(m.text) && MACHINE_RE.test(m.text));
  files["list-nodev.txt"] = nodev
    .map((m) => `#${m.id} ${m.text.length}c | ${m.text.split("\n")[0].replace(/\s+/g, " ").slice(0, 110)}`)
    .join("\n");

  // 3) 重复对（倒排 + Jaccard）
  const shingles = new Map();
  for (const m of mems) {
    const t = normalizeText(m.text);
    const set = new Set();
    for (let i = 0; i + K <= t.length; i++) set.add(t.slice(i, i + K));
    if (t.length < K) set.add(t);
    shingles.set(m.id, set);
  }
  const inv = new Map();
  for (const [id, set] of shingles) {
    for (const s of set) {
      let arr = inv.get(s);
      if (!arr) inv.set(s, (arr = []));
      if (arr.length < 25) arr.push(id);
    }
  }
  const pairCount = new Map();
  for (const arr of inv.values()) {
    if (arr.length < 2) continue;
    for (let i = 0; i < arr.length; i++)
      for (let j = i + 1; j < arr.length; j++) {
        const key = arr[i] < arr[j] ? `${arr[i]}|${arr[j]}` : `${arr[j]}|${arr[i]}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
  }
  const pairs = [];
  for (const [key, c] of pairCount) {
    if (c < minShared) continue;
    const [a, b] = key.split("|").map(Number);
    const A = shingles.get(a),
      B = shingles.get(b);
    let inter = 0;
    for (const s of A) if (B.has(s)) inter++;
    const jac = inter / (A.size + B.size - inter);
    if (jac >= jacThreshold) pairs.push({ a, b, jac: Number(jac.toFixed(3)), inter });
  }
  pairs.sort((x, y) => y.jac - x.jac);
  files["dup-pairs.txt"] = pairs
    .map((p) => {
      const A = byId.get(p.a),
        B = byId.get(p.b);
      return `${p.jac} #${p.a}(${A.text.length}c${A.pinned ? ",P" : ""}) <> #${p.b}(${B.text.length}c${B.pinned ? ",P" : ""}) | ${A.text.split("\n")[0].slice(0, 60)} || ${B.text.split("\n")[0].slice(0, 60)}`;
    })
    .join("\n");

  // 4) 过期关键词扫描
  const hits = [];
  for (const [name, re] of STALE_KEYWORDS) {
    const ids = mems.filter((m) => re.test(m.text)).map((m) => m.id);
    hits.push(`${name} (${ids.length}): ${ids.join(",")}`);
  }
  files["keyword-hits.txt"] = hits.join("\n\n");

  // 5) pinned 全文
  const pinned = mems.filter((m) => m.pinned);
  files["pinned-full.txt"] = pinned.map((m) => `=== #${m.id} (${m.text.length}c) ===\n${m.text}`).join("\n\n");

  // 6) 统计
  const stats = {
    total: mems.length,
    pinned: pinned.length,
    chars: mems.reduce((s, m) => s + m.text.length, 0),
    pinnedChars: pinned.reduce((s, m) => s + m.text.length, 0),
    nodevCount: nodev.length,
    dupPairCount: pairs.length,
    topDup: pairs.slice(0, 40),
    pinnedSizes: pinned.map((m) => ({ id: m.id, chars: m.text.length })),
    longNonPinned: mems
      .filter((m) => !m.pinned)
      .sort((a, b) => b.text.length - a.text.length)
      .slice(0, 15)
      .map((m) => ({ id: m.id, chars: m.text.length, head: m.text.split("\n")[0].slice(0, 70) })),
  };
  files["stats.json"] = JSON.stringify(stats, null, 1);

  const summary = {
    lines: lines.length,
    nodev: nodev.length,
    dupPairs: pairs.length,
    pinned: pinned.length,
    pinnedChars: stats.pinnedChars,
    topDup: pairs.slice(0, 10).map((p) => `${p.jac}:${p.a}<>${p.b}`),
  };
  return { files, summary, stats };
}

const USAGE = `audit-analyze.mjs — 季度记忆库体检 · 第 2 站：六项分析（消费 memories.json）

用法：
  node ${TOOL} [--in <memories.json>] [--out <dir>] [--json] [--quiet]
  node ${TOOL} --help
  node ${TOOL} --self-test

参数：
  --in <file>    记忆导出 JSON，默认 ${DEFAULT_IN}（由 audit-export.mjs 产出）
  --out <dir>    6 个产物的输出目录，默认 = --in 所在目录
  --json         以 JSON 输出摘要
  --quiet        不打印摘要

产物（写在 --out 下）：
  list-lines.txt   全部条目首行清单
  list-nodev.txt   含机器特征词但无【设备：】的漏标候选
  dup-pairs.txt    重复对（6-gram Jaccard ≥ 0.15）
  keyword-hits.txt 19 组过期关键词命中 id
  pinned-full.txt  pinned 全文
  stats.json       统计（总数/pinned/字符数/最长非 pinned/topDup）

退出码：
  0  成功
  1  --self-test 断言失败
  2  用法错误
  3  输入文件不存在
  4  运行错误（JSON 解析失败等）

只读：只读 memories.json，不碰 memory.db；产物只写 --out（默认临时目录，不落生产路径）。
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
  const outDir = typeof a.out === "string" ? path.resolve(a.out) : path.dirname(inFile);
  const mems = JSON.parse(fs.readFileSync(inFile, "utf8"));
  const { files, summary } = analyze(mems);

  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), content, "utf8");

  if (a.json) {
    console.log(JSON.stringify({ in: inFile, outDir, ...summary }, null, 1));
    return 0;
  }
  if (a.quiet !== true) {
    console.log(`IN=${inFile}  OUT=${outDir}`);
    console.log(
      `lines=${summary.lines} nodev=${summary.nodev} dupPairs=${summary.dupPairs} pinned=${summary.pinned} pinnedChars=${summary.pinnedChars}`,
    );
    console.log("top dup: " + summary.topDup.join(" "));
  }
  return 0;
}

// ---------- self-test（无副作用：合成 JSON + 临时输出目录） ----------
export function selfTest() {
  const t = makeAsserter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-analyze-selftest-"));
  const inFile = path.join(tmp, "memories.json");
  const outDir = path.join(tmp, "out");
  try {
    const base = "【设备：ROG】重复内容判定用长文本片段甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥";
    const DRV = path.parse(process.cwd()).root;
    const mems = [
      { id: 1, text: base, pinned: true, tags: "", created_at: 1, updated_at: 1 },
      { id: 2, text: base + "尾巴", pinned: false, tags: "", created_at: 1, updated_at: 1 },
      { id: 3, text: `无设备标但提到 ${DRV}work 与 3080 的条目`, pinned: false, tags: "", created_at: 1, updated_at: 1 },
      { id: 4, text: "这是一条提到坚果云的过期记忆", pinned: false, tags: "", created_at: 1, updated_at: 1 },
    ];
    fs.writeFileSync(inFile, JSON.stringify(mems), "utf8");
    const before = fs.readFileSync(inFile, "utf8");

    const { files, summary } = analyze(mems);
    t.eq(summary.lines, 4, "首行清单条数");
    t.eq(summary.pinned, 1, "pinned 条数");
    t.eq(files["list-lines.txt"].split("\n").length, 4, "list-lines 行数");
    t.ok(files["list-nodev.txt"].includes("#3"), "漏标候选命中 #3（含盘符绝对路径）");
    t.ok(!files["list-nodev.txt"].includes("#1"), "已带设备标的 #1 不入漏标候选");
    t.ok(summary.dupPairs >= 1, "近似重复对 >= 1");
    t.ok(files["dup-pairs.txt"].includes("#1") && files["dup-pairs.txt"].includes("#2"), "重复对指向 #1<>#2");
    t.ok(/坚果云 \(1\): 4/.test(files["keyword-hits.txt"]), "过期关键词「坚果云」命中 #4");
    t.ok(files["pinned-full.txt"].includes("=== #1"), "pinned 全文含 #1");
    const stats = JSON.parse(files["stats.json"]);
    t.eq(stats.total, 4, "stats.total");
    t.eq(stats.pinnedChars, base.length, "stats.pinnedChars");

    // 写产物（临时目录）并验证
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), content, "utf8");
    t.eq(fs.readdirSync(outDir).length, 6, "产物文件数 = 6");

    // 自证只读
    t.eq(fs.readFileSync(inFile, "utf8"), before, "输入 JSON 前后字节一致（未写输入）");
    const src = fs.readFileSync(SELF, "utf8");
    const body = src.split("// ---------- self-test")[0];
    t.ok(!/fs\.writeFileSync/.test(body.split("export function analyze")[0]), "核心分析函数之前不含 fs.writeFileSync");
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
