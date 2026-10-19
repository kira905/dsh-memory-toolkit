// DSH / tools/lib/session-file-name.mjs —— 会话日志文件名判据 · **单一真源**（零依赖）
//
// 背景（2026-09-24 · 卡「三机同步步A-V3代际适配」）：
//   主包 0.1.5 起把会话日志改名 `session.jsonl.zstd` → `session.v3.jsonl.zstd`；
//   主包 0.2.x 起**再换代** `session.v3.jsonl.zstd` → `session.v4.jsonl.zstd`（**现行世代**）。
//   （2026-10-16 · 卡「harness · 成本与路由 · 债 D-1/D-3 收口」把**写入侧常量与文案**一并推到 v4；
//     读取侧判据本已认任意 vN，未动。真源 = 本文件。）
//   凡是「按精确文件名比较」的**读取侧**判据都会整条失明（实测 pitfall-scan 的
//   discoverSessionFiles() 活跃树覆盖 0 / 212），而归档里仍有 1040 个旧名文件、
//   活跃树 212 个全是 v3 名 ⇒ 读取侧必须**认全世代**。
//
// 三条口径（写死，别自由发挥）：
//   ① 读取侧一律用 isSessionFileName() / sessionFileGeneration()（前缀 + 代际），**禁精确字符串比较**；
//   ② 需要"代际"时从文件名提取（旧名 = 0，`session.vN....` = N），**禁硬编码**；
//   ③ 写入侧（真要写文件名时）用 SESSION_FILE_NAME_CURRENT（当前世代 = v4，0.2.x 起）。
//
// ⚠️ PowerShell 侧无法 import 本模块：`tools\dsh-backup-sessions.ps1` 内写等价 PS 判据
//   （$SessionFileFilter / Test-SessionFileName / $SessionFileNameCurrent）。**改一处必须同步另一处。**
//   已知同类读取侧判据（**★2026-09-24 收尾清账批逐处核实后重写**，原清单两处已修、又漏了一族）：
//   ✅ 已消费本模块：tools\lib\attach-refs.mjs · tools\board-ops\session-tail.mjs · tools\dsh-sessions-land.mjs ·
//      tools\dsh-butler\{session-ledger.mjs, lib\pitfall-scan.mjs, lib\session-header.mjs, lib\restart.mjs} ·
//      tools\archive-card-sessions.mjs · tools\archive-inactive-sessions.mjs · tools\dsh-archive-sessions\lib\index.js ·
//      tools\dsh-butler-panel\lib\state.js（★A2：判据 +「取哪份」取法一并统一；checks.mjs 经它复用，无第二份实现）。
//      ⚠️ restart-coordinator.mjs **无自有判据**（经 lib\restart.mjs#scanSessionLogFiles 间接同源）——原清单点名它属误记。
//   ⏳ 仍**只认旧名**的读取侧（低频/一次性工具，待各自 owner 认领；行号 = 2026-09-24 快照）：
//      tools\dsh-archive-sessions\{clean-empty-shells.mjs:78, scan-empty.mjs:48, scan-small.mjs:57} ·
//      tools\projcache-restore-archived.mjs:107 · tools\restore-shell-sessions.mjs:76 · tools\test-single-archive.mjs:21 ·
//      tools\{session-tail-for-llm.mjs:81, session-tail-audit.mjs:96, session-impact.mjs:78, session-cot.mjs:77,
//      dsh-session-tail-dump.mjs:23}。**要长期用再改**，改法照本文件（认全世代 + 需要代际时提取）。
//   ⚠️ 已知风险登记（A6 · 2026-09-24 **先登记不修**）：「两代并存」目录里新世代文件可能只是**补写壳**
//      （实测 v3 仅 2 事件 / 244 B，旧名才是完整对话 2621 事件 / 2.7 MB）⇒ **需要读内容的消费者必须走候选链**
//      （rankSessionFilesInDir / collectSessionFilesByDir 的 files），只做扫描/移动的取 current 即可。
//      当前无消费方受影响（面板只扫活跃树：231/231 全 v3、0 并存）；若将来把归档并存目录纳入扫描，先接候选链再开。
//      （插件包内为**派生副本** `lib/session-file-name.mjs`，由 tools\sync-session-file-name.mjs 生成，
//        deploy 时 fail-closed 校验副本与真源 sha 一致 —— 改真源必须同批重跑该同步器。）
import fs from 'node:fs';
import path from 'node:path';

/** 旧世代文件名（≤ 0.1.1；归档树里仍有大量此名）。 */
export const SESSION_FILE_NAME_LEGACY = 'session.jsonl.zstd';

/** v3 世代文件名（0.1.5 起；**已被 0.2.x 换代**，仍须认得）。 */
export const SESSION_FILE_NAME_V3 = 'session.v3.jsonl.zstd';

/** 当前世代文件名（0.2.x 起）。 */
export const SESSION_FILE_NAME_V4 = 'session.v4.jsonl.zstd';

/** 写入侧应使用的当前世代文件名。 */
export const SESSION_FILE_NAME_CURRENT = SESSION_FILE_NAME_V4;

/** 认得的三个世代名（读取侧清单；顺序 = 旧 → 新）。 */
export const SESSION_FILE_NAMES = [SESSION_FILE_NAME_LEGACY, SESSION_FILE_NAME_V3, SESSION_FILE_NAME_V4];

/** 宽匹配模式（shell / robocopy / Get-ChildItem -Filter 用；**读取侧**）。 */
export const SESSION_FILE_GLOB = 'session*.jsonl.zstd';

/**
 * 读取侧判据（前缀 + 代际）。命中的形态：
 *   `session.jsonl.zstd`（旧世代）· `session.v3.jsonl.zstd`（0.1.5 世代）· `session.v4.jsonl.zstd`（当前世代）
 *   · 更高的 `session.vN.jsonl.zstd`（未来世代）—— **本判据认任意 vN，换代时无需改**。
 * 不命中：`session.jsonl`（明文形态，另有判据）· `session.jsonl.zstd.bak` · 其它任意文件。
 */
export const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/** 是否会话日志文件（读取侧唯一判据）。 */
export function isSessionFileName(name) {
  return SESSION_FILE_RE.test(String(name));
}

/**
 * 从文件名提取代际：旧世代 = 0；`session.vN.jsonl.zstd` = N；非会话文件 = null。
 * @returns {number|null}
 */
export function sessionFileGeneration(name) {
  const m = SESSION_FILE_RE.exec(String(name));
  if (!m) return null;
  return m[1] ? Number(m[1]) : 0;
}

/**
 * 目录形态的会话文件清单（不递归）。
 * @returns {{file:string,name:string,generation:number,bytes:number,mtimeMs:number}[]}
 */
export function listSessionFilesInDir(dir, opts = {}) {
  const fsImpl = opts.fs ?? fs;
  let ents;
  try { ents = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of ents) {
    if (!e.isFile()) continue;
    if (!isSessionFileName(e.name)) continue;
    const full = path.join(dir, e.name);
    let st;
    try { st = fsImpl.statSync(full); } catch { continue; }
    out.push({
      file: full, name: e.name, generation: sessionFileGeneration(e.name),
      bytes: st.size, mtimeMs: Math.round(st.mtimeMs),
    });
  }
  return out;
}

/**
 * 同一会话目录内的候选文件，按优先级排序（第一个 = 「当前那份」）：
 *   mtime 最新优先 → 平局取代际大者 → 再平局取名字典序小者（确定性）。
 *
 * ⚠️ **「当前那份」≠「内容最全的那份」**（2026-09-24 实测，卡「修·V3判据④」）：
 *    换代后新世代文件可能只是"补写壳"——归档树 28 个两代并存目录里，`session.v3.jsonl.zstd`
 *    只有 2 个事件（`session` 头 + `session/end-seed`、有效内容 244 B），而旧名文件才是完整对话
 *    （2621 个事件 / 2.7 MB 解压文本）。**需要读内容的消费者必须走完候选链**（见下），
 *    只做"扫描/移动"的消费者取第一个即可。
 * @returns {{file:string,name:string,generation:number,bytes:number,mtimeMs:number}[]}
 */
export function rankSessionFilesInDir(dir, opts = {}) {
  const hits = listSessionFilesInDir(dir, opts);
  hits.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (b.generation - a.generation) || (a.name < b.name ? -1 : 1));
  return hits;
}

/**
 * 在一个会话目录里挑出"当前那份"会话文件（两代并存时的取法）：
 *   mtime 最新优先 → 平局取代际大者 → 再平局取名字典序小者（确定性）。
 * @returns {string|null} 绝对路径；目录不存在 / 无会话文件 = null
 */
export function pickSessionFileInDir(dir, opts = {}) {
  const hits = rankSessionFilesInDir(dir, opts);
  return hits.length ? hits[0].file : null;
}

/**
 * 递归收集会话目录（**每个目录聚合一次**，不做逐文件扁平化）。
 * 用途：归档器的扫描面 —— 一个会话目录 = 一个会话，两代并存时 `current` 是"当前那份"、
 * `files` 是该目录全部世代（移动校验/尾部判据/内容回落都要用到全量）。
 * @returns {{dir:string, current:string, files:object[]}[]} 按 dir 字典序（确定性）
 */
export function collectSessionFilesByDir(root, opts = {}) {
  const fsImpl = opts.fs ?? fs;
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fsImpl.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    let hasSessionFile = false;
    for (const e of ents) {
      if (e.isDirectory()) { stack.push(path.join(d, e.name)); continue; }
      if (e.isFile() && isSessionFileName(e.name)) hasSessionFile = true;
    }
    if (!hasSessionFile) continue;
    const files = rankSessionFilesInDir(d, opts);
    if (files.length) out.push({ dir: d, current: files[0].file, files });
  }
  out.sort((a, b) => (a.dir < b.dir ? -1 : 1));
  return out;
}

/** 递归收集「每目录当前那份」的绝对路径（collectSessionFilesByDir 的扁平形态）。 */
export function collectSessionFilesInTree(root, opts = {}) {
  return collectSessionFilesByDir(root, opts).map((x) => x.current);
}
