import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import zlib from "node:zlib";

// 只读记忆简报：列全部记忆的 id / pinned / 标题，pinned 条自动附全文，供新会话开场过全貌用。
// 用法：node list-memory-summary.mjs   （dsh 运行中也可安全执行，WAL 模式只读无冲突）
//
// 【2026-10-10 · 记忆引擎 A3 · 第 8 步接线】末尾「坑库 Top 3」段改为 **向量召回优先 + 固定 Top3 兜底**：
//   · 目标：按「当前会话上下文」做向量召回坑库条目（替代与本次任务无关的固定 Top3 —— 233 条里永远只看最高 3 条）。
//   · 硬要求 **fail-open**（本段绝不让简报报错、绝不让简报卡住）：
//       无上下文 / 向量库缺失 / 坑向量 0 条 / 编码桥不可达 / 整段超时 / 零命中 / 任何异常
//       ⇒ 一律回落原有 `topN(pitfalls, 3)` **固定 Top3**（固定 Top3 的代码**原样保留，绝不删**）。
//   · 超时：整段召回硬预算 `--recall-timeout-ms`（默认 **900ms**）；编码桥单次 ≤300ms；超时即回落。
//     不起子进程、不写任何生产文件（向量库/记忆库一律**只读**打开、无 DDL、无 meta 写）。
//   · 注入参数（隔离测试用，**均不影响生产默认**）：--home / --memory-db / --vectors-db / --pitfalls-file
//     / --session / --query / --bridge-port / --top-k / --no-recall / --debug
// ── --help（纯文本，不读任何库） ─────────────────────────────────────────────
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  const usage = [
    "list-memory-summary.mjs — 新会话开工简报（只读，dsh 运行中也可安全执行）",
    "",
    "用法：node list-memory-summary.mjs [选项]",
    "",
    "  --home <dir>            DSH home（缺省 $DSH_HOME 或 ~/.dsh）",
    "  --memory-db <file>     记忆库路径（缺省 <home>/memory/memory.db）",
    "  --vectors-db <file>    向量库路径（缺省 <home>/memory-vectors/vectors.db）",
    "  --pitfalls-file <file> 坑库文件（缺省 <home>/butler-pitfalls.json）",
    "  --session <id>         指定会话 id（缺省读 DSH_SESSION_ID）",
    "  --query <text>         直接给召回查询文本（缺省取会话上下文）",
    "  --top-k <n>            坑库显示条数（默认 3）",
    "  --no-recall            跳过向量召回，直接用固定 TopN",
    "  --recall-timeout-ms <n> 召回整段硬预算（默认 900ms）",
    "  --bridge-port <port>   编码桥端口（默认 8201）",
    "  --debug                打印召回诊断",
    "  -h, --help             本帮助",
    "",
    "说明：输出含真实记忆正文 ⇒ 属于你的私有数据，只在本机打印，本工具不做任何网络请求。",
  ].join("\n");
  process.stdout.write(usage + "\n", () => process.exit(0));
}
const ARGS = parseArgs(process.argv.slice(2));
const HOME = normPath(ARGS.home || process.env.DSH_HOME || `${process.env.USERPROFILE ?? process.env.HOME ?? ""}/.dsh`);
const MEMORY_DB = ARGS["memory-db"] || `${HOME}/memory/memory.db`;
const PITFALLS_FILE = ARGS["pitfalls-file"] || `${HOME}/butler-pitfalls.json`;
const VECTORS_DB = ARGS["vectors-db"] || `${HOME}/memory-vectors/vectors.db`;
const BRIDGE_PORT = numOr(ARGS["bridge-port"] ?? process.env.MEMORY_ENGINE_BRIDGE_PORT, 8201);
const RECALL_BUDGET_MS = numOr(ARGS["recall-timeout-ms"], 900);
const BRIDGE_TIMEOUT_MS = Math.min(450, RECALL_BUDGET_MS);
/** 召回尝试次数上限：桥偶发慢/连接冷启动时给一次重试（**只对异常/超时重试**；零命中是确定结果，不重试） */
const RECALL_ATTEMPTS = 2;
const TOP_K = numOr(ARGS["top-k"], 3);
const NO_RECALL = ARGS["no-recall"] === true;
const DEBUG = ARGS.debug === true;
const SESSION_ID = typeof ARGS.session === "string" ? ARGS.session : (process.env.DSH_SESSION_ID ?? "");
const EXPLICIT_QUERY = typeof ARGS.query === "string" ? ARGS.query : "";
/** 喂给编码桥的查询文本上限（bge-small-zh 的 max_length=512 token ⇒ 中文按 1 字 ≈ 1 token 取 500 字封顶） */
const QUERY_MAX_CHARS = 500;
/** 记忆引擎模块缓存（懒加载；**必须声明在使用点之前** —— 顶层 await 会先跑到坑库段，`let` 落在后面会撞 TDZ） */
let _mods = null;

// ===== 当前设备识别 =====
// 本鱼新会话开工必跑本简报 → 把「当前在哪台机」打在最前面，防写记忆/流水时标错设备。
// 设备名直接读环境变量即可（任何进程都能取，不需要开机脚本预写文件）。
// 新增设备：在 HOST_ROLES 里补一行（键用大写主机名）。
const hostName = process.env.COMPUTERNAME || "UNKNOWN";
/** 坑库文档目录（仅用于打印；可经 DSH_PITFALLS_DOC_DIR 覆盖） */
const PITFALLS_DOC_DIR = process.env.DSH_PITFALLS_DOC_DIR || "docs/坑库";
const HOST_ROLES = (() => {
  try { return JSON.parse(process.env.MEMORY_HOST_ROLES || "{}"); } catch { return {}; }
})();
const hostRole = HOST_ROLES[hostName.toUpperCase()] ?? "未登记设备（可用环境变量 MEMORY_HOST_ROLES 补一行）";
console.log(`当前设备：${hostName} — ${hostRole}｜用户 ${process.env.USERNAME ?? "?"}`);

// ===== 插电保护状态行（2026-10-16 加）=====
// 为什么加：新会话开工第一眼必须能看见「现在在不在保护中、该按哪套纪律走」。
// 起因（2026-10-16 主人反馈）：新建的主会话在「要不要自己交接 / 小活要不要建卡」上犹豫、等主人发话，
//   主人以为是"没开整夜模式" —— 实测保护已连开 8 天没关。**真根因 = 会话看不见保护态**：
//   persona 的自主授权全是「整夜模式期间…」的条件句，而这个条件恰恰不在开工面上 ⇒ 会话无从判断
//   ⇒ 保守走常规口径、等主人发话。⇒ 把"条件"打进入口，比"再提醒一次"治本。
// 为什么用「读状态文件」而不是跑 `overnight-mode.mjs status`（2026-10-16 实测）：
//   `status` 要逐方案核 4×7 项 + 屏保 3 项 + WU + job，本机实测 **15.7s / 17.0s**（技能里旧记的"~1s"已过期），
//   塞进开工简报 = 每个会话开场白都要等 17 秒 ⇒ 不可接受。改用**状态文件轻判据**（<10ms）：
//   `~/.dsh/overnight-mode-<host>.json` 有 `createdAt` 且无 `restoredAt` ⇒ 上次 on 之后没被 off 过。
//   ⚠️ 本行给的是「口径」不是「体检」：它不核电源设置是否真还在（历史出现过屏保单独漂回 ⇒ 假绿）。
//      健康核对归周期 job（`overnight-guard` 每日自检）与「插电保护」本体，**不阻塞开工**。
// 纪律：① fail-open（任何异常只打一行提示，绝不报错、绝不卡住简报）② 只读、不写任何文件
// 真源（口径别在这抄第二份）：persona【铁律·插电保护禁停与自动交棒】（2026-10-16 由「整夜模式禁停与自动交棒」改名，语义不变）
//   + `docs\整夜模式-自主推进与自动交接口径-20260925.md`（档名保留历史名，不随称呼改）
//   + 判据面改由 `auto` 常驻维持（`dsh-start.ps1` 3f 段 + tickd job `plug-guard` 10 分钟一轮）
await printPowerGuardLine();

const db = new DatabaseSync(MEMORY_DB, { readOnly: true });
const rows = db.prepare("SELECT id, text, tags, pinned FROM memories ORDER BY id").all();
console.log(`TOTAL: ${rows.length}  pinned: ${rows.filter(r => r.pinned === 1).length}`);
for (const r of rows) {
  const firstLine = r.text.split("\n")[0].slice(0, 80);
  console.log(`#${String(r.id).padStart(3)} [pinned=${r.pinned === 1 ? "Y" : "-"}] ${firstLine}`);
}
const pinned = rows.filter(r => r.pinned === 1);
if (pinned.length) {
  console.log("\n===== PINNED 全文 =====");
  for (const r of pinned) {
    console.log(`\n--- #${r.id} ---\n${r.text}`);
  }
}
db.close();

// ===== 坑库段（向量召回优先 · 失败回落固定 Top 3）=====
// 说明：数据源仍是 `~/.dsh/butler-pitfalls.json`（P4 tick 每 30 分钟增量更新）；
// 走向量召回时，除该 json（用于把召回命中的 refId 映射成可读条目）外只读 `vectors.db`（source='pitfall'）。
try {
  await runPitfallSection();
} catch (e) {
  console.log(`\n[坑库 Top3 读取失败（不影响简报其余部分）：${e?.message ?? e}]`);
}

/** 坑库段主流程：读 json → 试向量召回 → 成功打印召回段，否则回落固定 Top3（永不抛到调用方） */
async function runPitfallSection() {
  const st = readJsonSafe(PITFALLS_FILE);
  if (!st) return; // 与改动前一致：坑库文件不存在时本段整体不打印
  const pitfalls = Array.isArray(st.pitfalls) ? st.pitfalls : [];
  const nowMs = Date.now();

  let recall = { ok: false, reason: NO_RECALL ? "--no-recall（本次强制固定 Top 3）" : null };
  if (!NO_RECALL) recall = await tryVectorRecall();

  if (recall.ok) {
    const byId = new Map(pitfalls.filter((p) => p && p.id != null).map((p) => [String(p.id), p]));
    printRecallSection(recall, byId, st);
  } else {
    const diag = recall.reason ? `${recall.reason}${recall.detail ? ` · ${recall.detail}` : ""}` : null;
    await printTopFallback(pitfalls, nowMs, st, diag);
  }
}

/**
 * 试向量召回坑库（**fail-open**：任何异常/超时都返回 `{ok:false, reason}`，不抛）。
 *
 * 为什么不 spawn `cli\recall.mjs`：① 提示词要「禁止无超时的子进程等待」，库内直调可精确控超时
 * ② 不起子进程 = 不弹黑窗、不碰 EDR 口子 ③ 失败只在 catch 里落一行，带不崩简报。
 */
async function tryVectorRecall() {
  const t0 = performance.now();
  let db = null;
  try {
    if (!fs.existsSync(VECTORS_DB)) return { ok: false, reason: "无向量库", detail: VECTORS_DB };

    const qc = await buildQueryContext();
    if (DEBUG) console.log(`  [debug] 查询上下文来源=${qc.source} 取到 ${qc.text.length} 字：${qc.text.slice(0, 140)}`);
    if (!qc.text) return { ok: false, reason: qc.reason || "无可用查询上下文" };

    const mods = await importRecallModules();
    // ⚠️ 只读打开：不用 openVectorsStore（它会建库/建表/写 meta，且 busy_timeout=5s 会拖住简报）
    db = new DatabaseSync(VECTORS_DB, { readOnly: true });
    const index = mods.buildVectorIndex(db, { source: "pitfall" });
    if (!index.count) return { ok: false, reason: "坑源无向量", detail: "vectors.db 里 source='pitfall' 为 0 条" };

    const budgetLeft = RECALL_BUDGET_MS - (performance.now() - t0);
    if (budgetLeft < 150) return { ok: false, reason: "超时（预算已用尽）", detail: `已用 ${(performance.now() - t0).toFixed(0)}ms` };

    let lastFail = null;
    for (let attempt = 1; attempt <= RECALL_ATTEMPTS; attempt += 1) {
      const left = RECALL_BUDGET_MS - (performance.now() - t0);
      if (left < 120) { lastFail = lastFail ?? { reason: "超时（重试前预算已用尽）", detail: `已用 ${(performance.now() - t0).toFixed(0)}ms` }; break; }
      const embedder = mods.createHttpEmbedder({
        host: "127.0.0.1",
        port: BRIDGE_PORT,
        timeoutMs: Math.min(BRIDGE_TIMEOUT_MS, Math.max(80, left - 150)), // 留 150ms 给余弦+打印
      });
      const res = await withTimeout(
        mods.recall({
          query: qc.text,
          store: { db },
          source: makePitfallSourceStub(), // 坑源只被用到 pinnedIds()/ftsSearch()，见 stub 注释
          embedder,
          index,
          sourceName: "pitfall",
          vectorTopK: 20,
          ftsTopK: 0,
          resultTopK: TOP_K,
          log: () => {},
        }),
        left,
      );
      if (res.ok && res.triggered && res.hits.length) {
        return {
          ok: true,
          hits: res.hits,
          query: qc.text,
          querySource: qc.source,
          queryChars: qc.text.length,
          queryMs: qc.ms,
          indexSize: index.count,
          model: Array.isArray(index.models) ? index.models[0] ?? null : null,
          attempts: attempt,
          totalMs: performance.now() - t0,
        };
      }
      lastFail = res.ok
        ? { reason: res.triggered ? "召回零命中" : `查询未触发召回（${res.reason}）` }
        : { reason: `召回异常（第 ${attempt} 次）`, detail: res.detail ?? res.reason };
      if (res.ok) break; // 零命中/未触发 = 确定结果，重试无意义
    }
    return { ok: false, ...(lastFail ?? { reason: "召回失败" }) };
  } catch (e) {
    return { ok: false, reason: "召回异常", detail: String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 140) };
  } finally {
    if (db) { try { db.close(); } catch { /* ignore */ } }
  }
}

/** 动态 import 记忆引擎模块（缺件/装坏 ⇒ 抛错由 tryVectorRecall 兜住 ⇒ 回落固定 Top3） */
async function importRecallModules() {
  if (_mods) return _mods;
  const [recallMod, embedderMod] = await Promise.all([
    import("../memory-engine/lib/recall.mjs"),
    import("../memory-engine/lib/embedder.mjs"),
  ]);
  _mods = {
    recall: recallMod.recall,
    buildVectorIndex: recallMod.buildVectorIndex,
    createHttpEmbedder: embedderMod.createHttpEmbedder,
  };
  return _mods;
}

/**
 * 坑源 stub（**形状与 `memory-engine\lib\pitfall-source.mjs` 的契约一致**，只实现召回真正会用到的方法）。
 * 依据：`lib\recall.mjs` 对 source 只用两处 —— `pinnedIds()`（坑库无置顶 ⇒ 空集）
 * 与 `ftsSearch()`（坑库无 FTS5 ⇒ 返回 `{error}` 对象走降级、**不能返回数组**）。
 * 不读 `butler-pitfalls.json` 第二遍（条目映射在本文件里已由 st 完成）。
 */
function makePitfallSourceStub() {
  return {
    sourceName: "pitfall",
    readOnly: true,
    pinnedIds: () => [],
    ftsSearch: () => ({ error: "坑库无 FTS5（pitfall source 无 FTS 补位路）" }),
    close: () => {},
  };
}

/**
 * 组装「当前会话上下文」查询文本（**同步读、有上限、失败即空**）。
 * 优先级：显式 `--query` ＞ 会话日志尾部最近真实用户消息 ＞ projcache（上轮请求/标题/首条用户消息）。
 * ⚠️ 只认 `data.source.kind === 'user'` 的 `user/message`（插件注入/技能目录/AGENTS.md 也走 user/message，必须排除）。
 */
async function buildQueryContext() {
  const t0 = performance.now();
  if (EXPLICIT_QUERY.trim()) {
    return { text: clipText(EXPLICIT_QUERY, QUERY_MAX_CHARS), source: "--query 显式传入", ms: performance.now() - t0 };
  }
  if (!SESSION_ID) {
    return { text: "", source: "none", reason: "无查询上下文（无 --query，且环境无 DSH_SESSION_ID）", ms: 0 };
  }
  const parts = [];
  parts.push(...(await readRecentUserMessages()));
  const pc = readProjcacheContext();
  if (pc.lastTurnPrompt) parts.push(pc.lastTurnPrompt);
  if (pc.title) parts.push(pc.title);
  if (pc.firstUser) parts.push(pc.firstUser);

  const uniq = dedupeParts(parts);
  const text = clipText(uniq.join(" ／ "), QUERY_MAX_CHARS);
  if (!text) return { text: "", source: "none", reason: "会话上下文为空", ms: performance.now() - t0 };
  return { text, source: `会话上下文（${uniq.length} 段）`, ms: performance.now() - t0 };
}

/** 会话日志尾部最近的真实用户消息（只读、限 512KB 尾部、只解完整帧；任何失败返回 []） */
async function readRecentUserMessages() {
  try {
    const mods = await import("../lib/zstd-frames.mjs");
    const pickMod = await import("../lib/session-file-name.mjs");
    const id = String(SESSION_ID).replace(/^session-/, "");
    const root = `${HOME}/sessions`;
    let dir = null;
    for (const d of fs.readdirSync(root)) {
      const cand = `${root}/${d}/session-${id}`;
      if (fs.existsSync(cand)) { dir = cand; break; }
    }
    if (!dir) return [];
    const file = pickMod.pickSessionFileInDir(dir); // 认全世代（session[.vN].jsonl.zstd）
    if (!file) return [];
    const size = fs.statSync(file).size;
    const readLen = Math.min(512 * 1024, size);
    const buf = Buffer.alloc(readLen);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, readLen, size - readLen);
    } finally {
      fs.closeSync(fd);
    }
    const { frames } = mods.scanZstdFrames(buf); // 尾部切片可能撕裂首帧 ⇒ 该帧被丢弃，其余帧照解
    const out = [];
    for (const f of frames) {
      let txt;
      try {
        txt = zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
      } catch {
        continue;
      }
      for (const ln of txt.split(/\r?\n/)) {
        if (!ln.trim()) continue;
        let o = null;
        try { o = JSON.parse(ln); } catch { continue; }
        if (o.type !== "user/message") continue;
        if (o?.data?.source?.kind !== "user") continue; // 排除 AGENTS.md / 技能目录 / 插件快照等注入
        const text = Array.isArray(o.data.content)
          ? o.data.content.filter((c) => c && c.type === "text").map((c) => c.text).join(" ")
          : "";
        if (text.trim()) out.push(text);
      }
    }
    return out.slice(-2); // 只要最近 2 条真实用户消息（越近越贴当前任务）
  } catch {
    return [];
  }
}

/** projcache 里的轻量上下文（标题 / 上一轮请求 / 首条用户消息；读不到返回 {}） */
function readProjcacheContext() {
  try {
    const p = `${HOME}/storages/session_projcache/sessions/${SESSION_ID}.json`;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const r = j?.record?.rows ?? {};
    const val = (k) => r[k]?.val;
    const title = typeof val("title") === "string" ? val("title") : "";
    const ti = val("titleInput");
    const firstUser = typeof ti?.first?.text === "string" ? ti.first.text : "";
    const outline = val("turnOutline");
    const turns = Array.isArray(outline?.turns) ? outline.turns : [];
    const lastTurnPrompt = turns.length ? String(turns[turns.length - 1]?.prompt ?? "") : "";
    return { title, firstUser, lastTurnPrompt };
  } catch {
    return {};
  }
}

/** 打印向量召回段（标题保留「坑库 Top N」字样，便于既有 grep/文档指针继续命中） */
function printRecallSection(r, byId, st) {
  console.log(`\n===== 坑库 Top ${r.hits.length}（向量召回 · 按本会话上下文）=====`);
  r.hits.forEach((h, i) => {
    const p = byId.get(String(h.refId));
    if (p) {
      const sessionCount = Number(p.sessionCount ?? (Array.isArray(p.sessions) ? p.sessions.length : 0));
      const tag = p.source === "seed" ? "（seed）" : "";
      console.log(
        `  ${i + 1}. [${p.category ?? "?"}] ${p.name ?? ""}|${p.code ?? ""} — ${p.count ?? 0} 次/${sessionCount} 会话，召回 ${Number(h.score).toFixed(4)}${tag}`,
      );
      console.log(`     ${String(p.normText ?? "").replace(/\s+/g, " ").slice(0, 110)}`);
    } else {
      console.log(`  ${i + 1}. [坑库中已不存在 ${String(h.refId).slice(0, 12)}…] 召回 ${Number(h.score).toFixed(4)}（可能是被合并/淘汰的旧条目）`);
    }
  });
  console.log(
    `  查询来源：${r.querySource} · ${r.queryChars} 字｜坑向量 ${r.indexSize} 条${r.model ? ` · ${r.model}` : ""}｜耗时 ${r.totalMs.toFixed(0)}ms${r.attempts > 1 ? `（第 ${r.attempts} 次尝试成功）` : ""}`,
  );
  console.log(`  主题坑库：${PITFALLS_DOC_DIR} ｜ 数据更新：${st.updatedAt ?? "?"}`);
}

/** 固定 Top 3（**改动前原样**，除回落诊断行外输出逐字不变） */
async function printTopFallback(pitfalls, nowMs, st, diag) {
  const mod = await import("../lib/pitfall-score.mjs");
  const top = mod.topN(pitfalls ?? [], TOP_K, nowMs);
  if (top.length) {
    console.log(`\n===== 坑库 Top ${TOP_K}（P4 自动，动手前先看）=====`);
    for (const p of top) {
      const tag = p.likelyFixed ? "（疑似已修复）" : p.stage === "candidate" ? "（升级候选）" : "";
      console.log(`  [${p.category}] ${p.name}|${p.code} — ${p.count} 次/${p.sessionCount} 会话，score ${p.score}${tag}`);
      console.log(`     ${String(p.normText ?? "").replace(/\s+/g, " ").slice(0, 110)}`);
    }
    console.log(`  主题坑库：${PITFALLS_DOC_DIR} ｜ 数据更新：${st.updatedAt ?? "?"}`);
  }
  if (diag) console.log(`  （向量召回未启用：${diag} ⇒ 已回落固定 Top ${TOP_K}）`);
  if (DEBUG && !top.length) console.log("  （坑库无可用条目）");
}

// ===== 小工具 =====
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !String(next).startsWith("--")) { out[key] = String(next); i += 1; }
    else out[key] = true;
  }
  return out;
}
function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function normPath(p) {
  return String(p).replaceAll("\\", "/").replace(/\/+$/, "");
}
function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function clipText(s, n) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}
/** 去重：丢掉空串，以及「已被已有段包含 / 已包含已有段」的重复段 */
function dedupeParts(arr) {
  const out = [];
  for (const raw of arr) {
    const s = clipText(raw, 1200);
    if (!s) continue;
    if (out.some((o) => o.includes(s) || s.includes(o))) continue;
    out.push(s);
  }
  return out;
}
/** 超时闸：`ms` 内没 settle 就返回 `{ok:false, reason:'超时'}`（不抛、不中断已发出的 fetch —— 桥侧自带 AbortController） */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, reason: "超时", detail: `${Math.round(ms)}ms 预算内未返回` });
    }, Math.max(1, ms));
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: true, ...v }); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, reason: "异常", detail: String(e?.message ?? e).slice(0, 140) }); } },
    );
  });
}

/** 打印「插电保护」口径行（只读状态文件，微秒级；失败只提示，永不抛到调用方 —— 同坑库段的 fail-open 纪律） */
async function printPowerGuardLine() {
  try {
    const st = readJsonSafe(`${HOME}/overnight-mode-${hostName.toLowerCase()}.json`);
    if (!st) {
      console.log("🛡 插电保护：⚪ 无记录（从没开过）｜口径 = 常规：要拍板的攒清单问主人");
      return;
    }
    const offRaw = String(st.restoredAt ?? "").trim();
    const onAt = fmtUtc(st.createdAt);
    if (!offRaw) {
      console.log(`🛡 插电保护：🟢 保护期（自 ${onAt ?? "?"} 起未恢复）｜口径 = 保护期口径（原「整夜口径」· 2026-10-16 改名）：禁停 · 甲档自拍（建卡/run/交接自己做）· 到点自己跑 relay 交棒`);
    } else {
      console.log(`🛡 插电保护：⚪ 未在保护（${fmtUtc(offRaw) ?? "已恢复"}）｜口径 = 常规：要拍板的攒清单问主人`);
    }
  } catch (e) {
    console.log(`🛡 插电保护：状态读取失败（不影响简报其余部分）：${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 120)}`);
  }
}

/**
 * 把状态文件里的 **UTC** 时间戳转成本地可读串（认两种来源格式，认不出返回 null ⇒ 调用方显示 `?`，绝不猜）：
 *  · `createdAt` = `"10/08/2026 03:54:59"` —— 工具自己格式化的 UTC、**无时区标记**（直接 new Date 会被当本地时间，差 8 小时）
 *  · `restoredAt` = ISO 带 `Z`（如 `"2026-10-16T03:32:47.485Z"`）
 * 实测锚点：文件 `createdAt` = 10/08 03:54:59Z ↔ `status` 打印「上次开启：2026/10/8 11:54:59」= 本地 UTC+8。
 */
function fmtUtc(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  try {
    let dt = null;
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(s);
    if (m) dt = new Date(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}T${m[4].padStart(2, "0")}:${m[5]}:${m[6]}Z`);
    else if (/Z$|[+-]\d{2}:?\d{2}$/.test(s)) dt = new Date(s);
    if (!dt || Number.isNaN(dt.getTime())) return null;
    return dt.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch {
    return null;
  }
}
