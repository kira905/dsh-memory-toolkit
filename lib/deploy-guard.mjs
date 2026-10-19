// tools\lib\deploy-guard.mjs —— 部署门禁共享件（参数白名单 / 逃逸 import 静态扫 / 部署位置冒烟 import）
//
// ❗来由（2026-09-16 23:21 DSH 崩溃事故，2026-09-17 推广）：某 deploy.mjs 收到不认识的 `--verify`
//   被**静默忽略** → 以为在做只读检查，实际执行了真备份 + 真部署 + 内部 spawnSync dsh-restart.ps1
//   硬重启（绕开 P0 闸门）；而部署进 profile 的模块用相对路径跨包 import（仓库里层级恰好对上、
//   装进 profiles\web\node_modules 后指向不存在的包）→ dsh boot 期 ERR_MODULE_NOT_FOUND，
//   120s 内连崩 3 次唤分身。教训：`node --check` 只查**语法**，查不出**解析期**失败。
//   首版落地在 tools\dsh-butler-panel\{preflight-imports.mjs,deploy.mjs}（拷问修复·B 卡），本文件是
//   同口径的共享实现，供其余 deploy.mjs 复用。
//
// 三个导出（纯函数 + 薄 IO，零外部依赖）：
//   parseArgs(argv, known)             fail-closed 参数白名单：未知参数 → ok:false（调用方 rc=2 退出）
//   findEscapingImports(srcDir, opts)  静态扫「相对 import 解析后逃出插件根」的写法 → 命中清单
//   smokeImportAll(entityDir, libSpec) 以**部署位置**为解析上下文，逐模块冒烟 import（子进程隔离）
//
// 退出码口径（与 tools\dsh-butler-panel\deploy.mjs 对齐）：
//   0 = 通过 · 1 = 门禁未过（拒绝部署）· 2 = 用法/参数错误
//
// 用法示例见各 deploy.mjs 接入段；本文件自身不写任何文件（除子进程无副作用）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const EXIT = { OK: 0, GATE: 1, USAGE: 2 };

// 递归扫描时一律跳过的目录（node_modules 是依赖闭包、_archive/_tmp 是历史与临时产物；
// task-board-local 的 node_modules 还是 junction → 扫进去会顺着盘外闭包跑几十个包）。
const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '_archive', '_tmp', 'dist', 'build',
  'coverage', '.cache', '.dsh', '.venv', '__pycache__', 'snapshots', 'backups',
]);
const JS_EXT = new Set(['.mjs', '.js', '.cjs']);
// 前端产物：浏览器 bundle 本来就不该在 node 里 import（真 import 必报 window is not defined）。
const DEFAULT_SMOKE_SKIP = [/^client\.js$/, /\.browser\.js$/, /\.min\.js$/];

// ───────────────────────────────────────────────────────────── 1) 参数白名单

/**
 * fail-closed 解析命令行参数。
 * @param {string[]} argv           process.argv.slice(2)
 * @param {Array<string|{flag:string, takesValue?:boolean, alias?:string}>} known 白名单
 *        字符串 = 布尔开关；对象 = 可取值的参数（--src X 或 --src=X）
 * @returns {{ok:boolean, unknown:string[], flags:Record<string,boolean>,
 *            values:Record<string,string>, positionals:string[]}}
 *          ok=false 时 unknown 为全部不认识的 token（调用方负责打印 + 以 rc=2 退出）
 */
export function parseArgs(argv, known = []) {
  const spec = new Map();
  for (const k of known) {
    if (typeof k === 'string') spec.set(k, { takesValue: false });
    else if (k && k.flag) {
      spec.set(k.flag, { takesValue: !!k.takesValue });
      if (k.alias) spec.set(k.alias, { takesValue: !!k.takesValue, aliasOf: k.flag });
    }
  }
  const flags = {};
  const values = {};
  const unknown = [];
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('-')) { positionals.push(tok); continue; }
    const eq = tok.indexOf('=');
    const name = eq > 0 ? tok.slice(0, eq) : tok;
    const s = spec.get(name);
    if (!s) { unknown.push(tok); continue; }
    const key = s.aliasOf ?? name;
    if (s.takesValue) {
      let v = eq > 0 ? tok.slice(eq + 1) : null;
      if (v === null) { v = argv[i + 1] ?? null; i++; }
      values[key] = v;
      flags[key] = true;
    } else if (eq > 0) {
      unknown.push(tok); // 布尔开关不许带 =值（写错了要响，不要静默）
    } else {
      flags[key] = true;
    }
  }
  // 位置参数一律拒绝：这些 deploy 脚本都不吃位置参数，静默吞掉正是事故形态。
  unknown.push(...positionals);
  return { ok: unknown.length === 0, unknown, flags, values, positionals };
}

/** 把 unknown 渲染成人话（各脚本拼自己的「只读模式请用 X」尾巴）。 */
export function describeUnknown(unknown, known) {
  const all = known.map((k) => (typeof k === 'string' ? k : k.flag)).join(' ');
  return `不认识的参数：${unknown.join(' ')}（本脚本只认 ${all}）`;
}

// ───────────────────────────────────────────────────── 2) 逃逸 import 静态扫

/**
 * 归一化路径：**存在的部分走 realpath，不存在的尾巴接回去**。
 * ⚠️ 必须两边都归一 —— 工作区里的目录 junction 很常见：只 realpath 一边会把
 *    「逻辑路径 vs 物理路径」比成 ..\..\...，于是合法的 './state.js' 也被误判成逃逸（实测踩过）。
 */
export function normalizePath(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 去注释：注释内容替换成空格（保留换行与列位置），引号内原样保留。
 * 目的 = 避免把注释里写的路径当成真 import（事故文件头注里就写着示例路径）。
 * 简易状态机：支持 // 、/* *\/ 、'…'、"…"、`…`（模板串内的 ${} 不再细分，漏掉的由门禁②兜底）。
 */
export function stripComments(text) {
  const out = [];
  let i = 0;
  let inBlock = false;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inBlock) {
      if (c === '*' && n === '/') { out.push('  '); i += 2; inBlock = false; continue; }
      out.push(c === '\n' ? '\n' : ' ');
      i++;
      continue;
    }
    if (quote) {
      if (c === '\\') { out.push(c, n === undefined ? '' : n); i += 2; continue; }
      out.push(c);
      i++;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '*') { out.push('  '); i += 2; inBlock = true; continue; }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out.push(c); i++; continue; }
    out.push(c);
    i++;
  }
  return out.join('');
}

// 只认「import/export … from '…'」「import '…'」「import('…')」「require('…')」四种形态。
const SPEC_RES = [
  /(?:^|[^\w$.])(?:import|export)\b[^;]*?\bfrom\s*(['"])([^'"]+)\1/,
  /(?:^|[^\w$.])import\s*(['"])([^'"]+)\1/,
  /(?:^|[^\w$.])import\s*\(\s*(['"])([^'"]+)\1\s*\)/,
  /(?:^|[^\w$.])require\s*\(\s*(['"])([^'"]+)\1\s*\)/,
];

/** 列出目录下全部 js/mjs/cjs（递归、排序、跳过黑名单目录）。 */
export function listJsFiles(root, opts = {}) {
  const { excludeDirs = DEFAULT_EXCLUDE_DIRS, exts = JS_EXT } = opts;
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue; // junction/链接不跟随（跨盘闭包、盘外目录）
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!excludeDirs.has(e.name)) walk(full);
      } else if (exts.has(path.extname(e.name))) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 静态扫：srcDir 下 js/mjs/cjs 里「相对 import 解析后逃出 root」的写法。
 * @param {string} srcDir 扫描起点 —— **只扫「会被复制进实体的那部分」**（各插件都是 lib/）。
 *        传插件根会把工具脚本一起扫进来（deploy.mjs / restore.mjs 自己 import '../lib/dsh-home.mjs'
 *        是合法姿势、且它们根本不进 profile）→ 自报假警，实测踩过。
 * @param {{root?:string}} [opts] root = 逃逸判定的根 = **实体的根**（插件被装进 profile 后的那个目录）。
 *        原地部署、不复制进 profile 的插件（如 tools\dsh-butler：整棵 tools 树是它的搬迁单位、
 *        跨子目录引用是合法设计）可放宽到树根。两边都走 realpath 归一（junction 坑）。
 *        跨目录引用的正解是 `file:///<绝对路径>` URL（绝对路径不计逃逸）。
 * @returns {{root:string, scanned:number, specs:number, absolute:number,
 *            bad:Array<{file:string,line:number,spec:string,resolved:string,text:string}>}}
 */
export function findEscapingImports(srcDir, opts = {}) {
  const root = opts.root ?? srcDir;
  const rootReal = normalizePath(root);
  const files = listJsFiles(srcDir, opts);
  const bad = [];
  let specs = 0;
  let absolute = 0;
  for (const file of files) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = stripComments(raw).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('import') && !line.includes('require')) continue;
      const seen = new Set();
      for (const re of SPEC_RES) {
        const m = re.exec(line);
        if (!m || !m[2] || seen.has(m[2])) continue;
        seen.add(m[2]);
        const spec = m[2];
        if (path.isAbsolute(spec)) { absolute++; continue; } // 绝对路径是 B 卡推荐的跨目录姿势，不算逃逸
        if (!spec.startsWith('.')) continue;                 // 裸包名（走 node_modules 解析）
        specs++;
        const resolved = path.resolve(path.dirname(file), spec);
        const rel = path.relative(rootReal, normalizePath(resolved));
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          bad.push({
            file: path.relative(srcDir, file),
            line: i + 1,
            spec,
            resolved,
            text: raw.split(/\r?\n/)[i].trim().slice(0, 200),
          });
        }
      }
    }
  }
  return { root, scanned: files.length, specs, absolute, bad };
}

// ─────────────────────────────────────────── 3) 部署位置冒烟 import（子进程）

// 子进程内跑的两段代码（代码走 stdin，路径走 env —— 无引号/转义地狱）。
// 快路径 · 批量：一个进程 import 全部模块，结果用 `DG_RESULT:` 前缀单行输出
//   （用前缀而非裸 JSON，是为了容忍被 import 的模块自己往 stdout 打日志）。
const BATCH_CODE = [
  "const files = JSON.parse(process.env.DG_BATCH_FILES || '[]');",
  "const out = [];",
  "for (const item of files) {",
  "  try { await import(item.url); out.push({ file: item.file, ok: true }); }",
  "  catch (e) { out.push({ file: item.file, ok: false, err: String((e && (e.message || e)) || e) }); }",
  "}",
  "process.stdout.write('\\nDG_RESULT:' + JSON.stringify(out) + '\\n');",
  "if (process.env.DG_EXIT_AFTER === '1') process.exit(0);",
  "",
].join('\n');

// 慢路径 · 单模块：批量判失败（或进程崩/超时）时逐个定位，并区分「解析失败」与「挂住」。
const SMOKE_CODE = [
  "const url = process.env.DG_TARGET_URL;",
  "try {",
  "  await import(url);",
  "} catch (e) {",
  "  process.stderr.write('DG_IMPORT_FAIL: ' + String((e && (e.message || e)) || e));",
  "  process.exitCode = 1;",
  "}",
  "// 模块 import 成功但挂着事件循环（定时器/监听）时，DG_EXIT_AFTER=1 让子进程主动收尾，",
  "// 以便把「解析失败」与「解析成功但进程不退出」分开判（后者不该判 FAIL）。",
  "if (!process.exitCode && process.env.DG_EXIT_AFTER === '1') process.exit(0);",
  "",
].join('\n');

function spawnSmoke(file, timeoutMs, exitAfter) {
  return spawnSync(process.execPath, ['--input-type=module'], {
    input: SMOKE_CODE,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...process.env,
      DG_TARGET_URL: pathToFileURL(file).href,
      DG_EXIT_AFTER: exitAfter ? '1' : '0',
    },
  });
}

function runBatchFast(items, timeoutMs) {
  return spawnSync(process.execPath, ['--input-type=module'], {
    input: BATCH_CODE,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...process.env,
      DG_BATCH_FILES: JSON.stringify(items),
      DG_EXIT_AFTER: '1', // 批量模式只回答「能否全部解析」，import 完立刻收尾（免被定时器拖住）
    },
  });
}

/** 从（可能被模块日志污染的）stdout 里取最后一条 DG_RESULT 行。 */
function extractBatchResult(stdout) {
  const marker = 'DG_RESULT:';
  const i = (stdout ?? '').lastIndexOf(marker);
  if (i < 0) return null;
  const line = stdout.slice(i + marker.length).split(/\r?\n/)[0];
  try {
    const arr = JSON.parse(line);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/**
 * 以**部署位置**为解析上下文，逐个 import lib 里的模块。
 * 关键点：import 的是**实体目录里的那个文件**（file URL），模块内部的相对 import 才会按实体
 * 位置解析 —— 这正是「仓库里跑得通、装进 profile 就崩」的暴露面。子进程隔离：模块若有
 * 副作用/挂住事件循环，不会污染部署进程。
 * @param {string} entityDir 部署实体目录（必须是真实存在的路径；原地部署的插件传源码目录自身）
 * @param {string|{dir?:string, skip?:RegExp[], timeoutMs?:number}} [libSpec='lib']
 * @param {{dir?:string, skip?:RegExp[], timeoutMs?:number, only?:RegExp}} [opts]
 * @returns {{dir:string, error:string|null, total:number, skipped:number,
 *            bad:Array<{file:string,err:string,timeout:boolean}>, results:Array<{file:string,ok:boolean,ms:number}>}}
 */
export function smokeImportAll(entityDir, libSpec = 'lib', opts = {}) {
  const cfg = typeof libSpec === 'string' ? { ...opts, dir: libSpec } : { ...opts, ...libSpec };
  const {
    skip = DEFAULT_SMOKE_SKIP, timeoutMs = 20000, batchTimeoutMs = 90000,
    batch = true, only = null,
  } = cfg;
  const ent = path.resolve(entityDir);
  const libDir = path.isAbsolute(cfg.dir ?? 'lib') ? cfg.dir : path.join(ent, cfg.dir ?? 'lib');
  const empty = { dir: libDir, error: null, mode: null, total: 0, skipped: 0, bad: [], results: [] };

  if (!fs.existsSync(ent)) return { ...empty, error: '实体目录不存在：' + ent };
  if (!fs.existsSync(libDir)) return { ...empty, error: '实体下没有 lib 目录：' + libDir };
  // 解析上下文必须是实体目录里的文件：lib 不在实体之下 → 拒绝（防"扫了源码目录还以为在测实体"）
  const relLib = path.relative(normalizePath(ent), normalizePath(libDir));
  if (relLib.startsWith('..') || path.isAbsolute(relLib)) {
    return { ...empty, error: 'lib 目录不在实体目录内（解析上下文错位）：' + libDir };
  }

  const files = listJsFiles(libDir).filter((f) => !only || only.test(path.relative(libDir, f)));
  const targets = files.filter((f) => !skip.some((re) => re.test(path.relative(libDir, f))));
  const skipped = files.length - targets.length;
  const bad = [];
  const results = [];

  // 快路径：单进程批量 import 全部模块（dsh-butler 82 个模块从 ~18s 降到 ~2s）。
  // 判据严格：**只有「批量说全部 ok」才算通过**，否则一律落慢路径逐个确认 —— 批量的假失败
  // （模块间串扰）由慢路径澄清，批量的假成功不存在（每个模块都真 import 过）。
  if (batch && targets.length > 1) {
    const r = runBatchFast(
      targets.map((f) => ({ file: path.relative(libDir, f), url: pathToFileURL(f).href })),
      batchTimeoutMs,
    );
    const parsed = extractBatchResult(r.stdout ?? '');
    if (parsed && parsed.length === targets.length && parsed.every((x) => x.ok)) {
      return {
        dir: libDir, error: null, mode: 'batch', total: targets.length, skipped, bad: [],
        results: parsed.map((x) => ({ file: x.file, ok: true, ms: 0, hung: null })),
      };
    }
  }

  // 慢路径：逐模块（精确定位到文件 + 区分「解析失败」与「import 成功但挂着不退出」）
  for (const f of targets) {
    const rel = path.relative(libDir, f);
    const t0 = Date.now();
    let r = spawnSmoke(f, timeoutMs, false);
    let timeout = !!(r.error || r.signal);
    let hung = false;
    if (timeout) {
      // 第一次超时可能是「模块挂住事件循环」而非解析失败 → 用 import 完主动收尾再试一次区分。
      const r2 = spawnSmoke(f, timeoutMs, true);
      if (r2.status === 0) { r = r2; timeout = false; hung = true; }
      else if (!(r2.error || r2.signal)) { r = r2; timeout = false; }
    }
    const ms = Date.now() - t0;
    if (!timeout && r.status === 0) {
      results.push({ file: rel, ok: true, ms, hung });
      continue;
    }
    const err = timeout
      ? `${r.error?.code ?? r.signal ?? '超时'}：${timeoutMs}ms 内未结束（import 后进程既不退出也不报错）`
      : extractSmokeError(r.stderr ?? '') || `exit ${r.status}`;
    bad.push({ file: rel, err, timeout });
    results.push({ file: rel, ok: false, ms, hung: false });
  }
  return { dir: libDir, error: null, mode: 'per-module', total: targets.length, skipped, bad, results };
}

function extractSmokeError(stderr) {
  const marker = stderr.indexOf('DG_IMPORT_FAIL: ');
  let msg = marker >= 0 ? stderr.slice(marker + 'DG_IMPORT_FAIL: '.length) : stderr;
  msg = msg.split(/\r?\n/).filter((l) => l.trim())[0] ?? '';
  return msg.trim().slice(0, 300);
}
