#!/usr/bin/env node
// audit-ledger-probe.mjs — 季度记忆库体检：看板账本只读探针
// 固化自早期临时脚本（2026-09-25 体检工具链固化）
//   · 去硬编码：账本路径从 DSH_HOME 动态解析 + `--ledger` 传参。
//   · 去硬编码：关键词 /卡会话|CW-[1-7]/ → --keyword <正则> 传参（默认不筛，只出状态统计）
//   · 加 --help / --self-test / --json · 收尾 process.exitCode
// 用途：体检时顺带看一眼看板账本 —— 按关键词筛相关卡（如「体检」「记忆」），并出状态分布。
// 只读：只读账本 JSON 文件，不写任何文件、不走 Host API（要改卡请走 task-board 技能）。
// ⚠️ 看板账本是权威账本，本工具**只读**；任何建卡/移卡/删卡一律走 task-board 技能与 Host API。

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
export const DEFAULT_LEDGER = path.join(DSH_HOME, "task-board", "ledger-v2.json");

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

// ---------- 核心逻辑 ----------
export function probeLedger(ledger, keyword, limit = 50) {
  const cards = ledger.cards ?? ledger.tasks ?? [];
  const re = keyword ? new RegExp(keyword) : null;
  const hits = cards.filter((c) => (re ? re.test(`${c.title ?? ""} ${c.description ?? ""} ${c.prompt ?? ""}`) : false));
  const statusCounts = {};
  for (const c of cards) statusCounts[c.status] = (statusCounts[c.status] ?? 0) + 1;
  return {
    total: cards.length,
    revision: ledger.revision ?? null,
    keyword: keyword ?? null,
    hits: hits.slice(0, limit).map((c) => ({
      status: c.status ?? null,
      line: c.line ?? null,
      seq: c.seq ?? null,
      id: c.id ? String(c.id).slice(0, 8) : null,
      exec: (c.executions ?? []).length,
      updatedAt: c.updatedAt ?? null,
      title: c.title ?? "",
    })),
    hitCount: hits.length,
    statusCounts,
  };
}

const USAGE = `audit-ledger-probe.mjs — 季度体检：看板账本只读探针（关键词筛卡 + 状态分布）

用法：
  node ${TOOL} [--ledger <path>] [--keyword <正则>] [--limit <n>] [--json]
  node ${TOOL} --help
  node ${TOOL} --self-test

参数：
  --ledger <path>   账本 JSON，默认 ${DEFAULT_LEDGER}
  --keyword <正则>  在 title/description/prompt 上筛选（如 --keyword "体检|记忆"）；省略则只出状态统计
  --limit <n>       最多列出多少张命中卡，默认 50
  --json            以 JSON 输出

退出码：
  0  成功
  1  --self-test 断言失败
  2  用法错误（正则非法）
  3  账本文件不存在
  4  运行错误（JSON 解析失败等）

只读：只读账本文件；不改卡、不写文件、不走 Host API（改卡请用 task-board 技能）。
`;

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (a.help) {
    console.log(USAGE);
    return 0;
  }
  if (typeof a["self-test"] !== "undefined") return selfTest();

  const ledgerPath = typeof a.ledger === "string" ? path.resolve(a.ledger) : DEFAULT_LEDGER;
  if (!fs.existsSync(ledgerPath)) {
    console.error(`[${TOOL}] 账本不存在：${ledgerPath}（可用 --ledger 指定）`);
    return 3;
  }
  const keyword = typeof a.keyword === "string" ? a.keyword : null;
  if (keyword) {
    try {
      new RegExp(keyword);
    } catch (e) {
      console.error(`[${TOOL}] --keyword 不是合法正则：${e?.message ?? e}`);
      return 2;
    }
  }
  const limit = typeof a.limit === "string" ? Number(a.limit) : 50;
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  const r = probeLedger(ledger, keyword, Number.isFinite(limit) && limit > 0 ? limit : 50);

  if (a.json) {
    console.log(JSON.stringify({ ledger: ledgerPath, ...r }, null, 1));
    return 0;
  }
  console.log(`LEDGER=${ledgerPath}`);
  console.log("cards total:", r.total, "| revision:", r.revision ?? "?");
  if (keyword) {
    console.log(`--- 命中 --keyword "${keyword}"：${r.hitCount} 张（列出前 ${r.hits.length}）---`);
    for (const c of r.hits) {
      console.log(
        `[${c.status}] line=${c.line ?? "-"} seq=${c.seq ?? "-"} id=${c.id ?? "-"} exec=${c.exec} updated=${c.updatedAt ?? "-"} :: ${c.title}`,
      );
    }
  } else {
    console.log("--- 未给 --keyword，只出状态统计（加 --keyword 可筛卡）---");
  }
  console.log("--- 状态统计 ---");
  console.log(JSON.stringify(r.statusCounts));
  return 0;
}

// ---------- self-test（无副作用：合成账本落临时目录） ----------
export function selfTest() {
  const t = makeAsserter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ledger-selftest-"));
  const fix = path.join(tmp, "ledger-v2.json");
  try {
    const ledger = {
      revision: 7,
      cards: [
        { id: "aaaaaaaa-1111", title: "记忆库体检预约卡", description: "跑体检工具链", status: "todo", seq: 1, executions: [] },
        { id: "bbbbbbbb-2222", title: "无关的卡", description: "别的活", status: "done", seq: 2, executions: [{ sessionId: "s1" }] },
        { id: "cccccccc-3333", title: "CW-3 卡会话工作区", description: "卡会话独立目录", status: "review", seq: 3, executions: [] },
      ],
    };
    fs.writeFileSync(fix, JSON.stringify(ledger), "utf8");
    const before = fs.readFileSync(fix, "utf8");
    const data = JSON.parse(fs.readFileSync(fix, "utf8"));

    const all = probeLedger(data, null);
    t.eq(all.total, 3, "卡总数");
    t.eq(all.revision, 7, "revision 透出");
    t.eq(all.hitCount, 0, "无关键词时不筛卡");
    t.eq(all.statusCounts.todo, 1, "状态统计 todo");
    t.eq(all.statusCounts.done, 1, "状态统计 done");
    t.eq(all.statusCounts.review, 1, "状态统计 review");

    const hit = probeLedger(data, "体检|CW-[1-7]");
    t.eq(hit.hitCount, 2, "关键词命中数");
    t.eq(hit.hits[0].id, "aaaaaaaa", "id 截断为 8 位");
    t.eq(hit.hits[1].exec, 0, "executions 计数");
    const capped = probeLedger(data, ".", 1);
    t.eq(capped.hitCount, 3, "hitCount 不受 limit 截断");
    t.eq(capped.hits.length, 1, "limit 截断列表长度");

    // 自证只读
    t.eq(fs.readFileSync(fix, "utf8"), before, "账本文件前后字节一致（未写账本）");
    const src = fs.readFileSync(SELF, "utf8");
    const body = src.split("// ---------- self-test")[0];
    t.ok(!/fs\.writeFileSync/.test(body), "主体逻辑段不含 fs.writeFileSync");
    t.ok(!/new DatabaseSync\(/.test(body), "主体逻辑段不开放任何数据库（纯 JSON 只读）");
    t.ok(!/fetch\(|http:\/\/|https:\/\//.test(body), "主体逻辑段不含网络调用（不触 Host API）");
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
