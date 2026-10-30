// 会话日志文件名：认得哪几个世代、以及从名字里读出代际（零依赖的单一真源）。
//
// 文件名换过好几代：旧的是 `session.jsonl.zstd`，后来加了版本号 `session.vN.jsonl.zstd`，
// 当前写入侧写的是 v4。归档树里旧名的文件还成堆躺着，活跃树里又都是新名 ——
// 只要有一处判据写成"精确比较当前文件名"，那一处就对着另一半文件整条失明。
//
// 三条规则（写死，别临场发挥）：
//   ① 读取侧一律走 isSessionFileName() / sessionFileGeneration()：前缀 + 代际，认出任意 vN，
//      以后换代也不用回来改判据；
//   ② 需要"第几代"就从文件名里提取（旧名 = 0，`session.vN...` = N），不要在调用处硬编码；
//   ③ 写入侧真要落文件名时用 SESSION_FILE_NAME_CURRENT。
//
// 跨语言提醒：脚本侧（PowerShell 之类）没法 import 本模块，那边有一份等价判据。
// 改这里必须同批改那边，否则两边会各认一半世代。
//
// 另一个已知坑：换代后新世代文件可能只是个"补写壳"（只有会话头一小段），完整对话还在
// 旧名文件里。所以"当前那份"不等于"内容最全的那份" —— 要读内容的调用方必须把
// rankSessionFilesInDir / collectSessionFilesByDir 给出的整条候选链走完；只做扫描或
// 搬迁的调用方取第一个就够。
import fs from 'node:fs';
import path from 'node:path';

/** 旧世代文件名（更早的版本；归档树里大量存在） */
export const SESSION_FILE_NAME_LEGACY = 'session.jsonl.zstd';

/** 带 v3 的世代名（更早的一次换代；仍必须认得） */
export const SESSION_FILE_NAME_V3 = 'session.v3.jsonl.zstd';

/** 当前世代文件名 */
export const SESSION_FILE_NAME_V4 = 'session.v4.jsonl.zstd';

/** 写入侧该用的名字（当前世代） */
export const SESSION_FILE_NAME_CURRENT = SESSION_FILE_NAME_V4;

/** 全部认得的世代名（顺序 = 旧 → 新） */
export const SESSION_FILE_NAMES = [SESSION_FILE_NAME_LEGACY, SESSION_FILE_NAME_V3, SESSION_FILE_NAME_V4];

/** 宽匹配模式：给 shell / 复制工具 / 目录枚举当过滤器用（读取侧） */
export const SESSION_FILE_GLOB = 'session*.jsonl.zstd';

/**
 * 读取侧判据：前缀 `session` + 可选的 `.vN` + `.jsonl.zstd`。
 * 命中：`session.jsonl.zstd` / `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd` / 未来的 `session.v5...`。
 * 不命中：明文 `session.jsonl`、备份 `session.jsonl.zstd.bak`、以及其它任何文件。
 */
export const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/** 是不是会话日志文件（读取侧唯一判据，别在调用处另写一套） */
export function isSessionFileName(name) {
  return SESSION_FILE_RE.test(String(name));
}

/**
 * 从文件名读代际：旧名 = 0；`session.vN.jsonl.zstd` = N；不是会话文件 = null。
 * @param {string} name
 * @returns {number|null}
 */
export function sessionFileGeneration(name) {
  const matched = SESSION_FILE_RE.exec(String(name));
  if (!matched) return null;
  return matched[1] ? Number(matched[1]) : 0;
}

// 目录枚举统一走"可注入的 fs"：测试塞夹具时不必碰真盘
function ioOf(opts) {
  return opts?.fs ?? fs;
}

/**
 * 列出一个目录里的会话文件（不递归）。
 * @param {string} dir
 * @param {{fs?:object}} [opts]
 * @returns {{file:string,name:string,generation:number,bytes:number,mtimeMs:number}[]}
 */
export function listSessionFilesInDir(dir, opts = {}) {
  const io = ioOf(opts);
  let entries;
  try {
    entries = io.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const rows = [];
  for (const dent of entries) {
    if (!dent.isFile()) continue;
    if (!isSessionFileName(dent.name)) continue;
    const file = path.join(dir, dent.name);
    let info;
    try {
      info = io.statSync(file);
    } catch {
      continue; // 枚举与 stat 之间被删掉：跳过，不当异常
    }
    rows.push({
      file,
      name: dent.name,
      generation: sessionFileGeneration(dent.name),
      bytes: info.size,
      mtimeMs: Math.round(info.mtimeMs),
    });
  }
  return rows;
}

/**
 * 同一会话目录里的候选文件，按"先取哪一份"排好序（第一个就是当前那份）：
 *   mtime 最新 → 平局取代际大的 → 再平局取名字典序小的（最后的平局也要确定，不能靠运气）。
 * 要读内容时别只看第一个：两代并存时新世代可能只是补写壳，得顺着整条链继续往下看。
 * @returns {{file:string,name:string,generation:number,bytes:number,mtimeMs:number}[]}
 */
export function rankSessionFilesInDir(dir, opts = {}) {
  return listSessionFilesInDir(dir, opts).sort((left, right) => (
    right.mtimeMs - left.mtimeMs
    || right.generation - left.generation
    || (left.name < right.name ? -1 : 1)
  ));
}

/**
 * 挑出"当前那份"会话文件的绝对路径。
 * @param {string} dir
 * @param {{fs?:object}} [opts]
 * @returns {string|null} 目录不存在 / 目录里没有会话文件 → null
 */
export function pickSessionFileInDir(dir, opts = {}) {
  const [best] = rankSessionFilesInDir(dir, opts);
  return best ? best.file : null;
}

/**
 * 递归收集"每个会话目录一条"（不逐文件摊平）。
 * 用途：归档这类按目录当单位处理的场景 —— current 是当前那份，files 是该目录全部世代
 * （搬运校验、尾部判据、内容回落都要用到全量）。
 * @param {string} root
 * @param {{fs?:object}} [opts]
 * @returns {{dir:string, current:string, files:object[]}[]} 按目录名字典序（确定性）
 */
export function collectSessionFilesByDir(root, opts = {}) {
  const io = ioOf(opts);
  const buckets = [];
  const pending = [root];

  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = io.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 读不动的目录直接跳过（权限/竞态删除），不影响其余
    }

    const subdirs = [];
    let holdsLog = false;
    for (const dent of entries) {
      if (dent.isDirectory()) {
        subdirs.push(path.join(dir, dent.name));
        continue;
      }
      if (dent.isFile() && isSessionFileName(dent.name)) holdsLog = true;
    }
    pending.push(...subdirs);
    if (!holdsLog) continue;

    const files = rankSessionFilesInDir(dir, opts);
    if (files.length > 0) buckets.push({ dir, current: files[0].file, files });
  }

  buckets.sort((left, right) => (left.dir < right.dir ? -1 : 1));
  return buckets;
}

/** 递归收集「每个目录当前那份」的绝对路径（collectSessionFilesByDir 的扁平形态） */
export function collectSessionFilesInTree(root, opts = {}) {
  return collectSessionFilesByDir(root, opts).map((bucket) => bucket.current);
}
