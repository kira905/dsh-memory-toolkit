// 部署前的三道机械闸：参数白名单、逃逸 import 静态扫、按部署位置冒烟 import。
//
// 为什么非得有这三道（一次真实事故换来的）：
//   ① 某个部署脚本收到一个它不认识的参数，静默忽略了 —— 操作者以为在跑只读检查，
//      脚本却照旧做了真备份、真写入，还顺手触发了重启。→ 参数必须 fail-closed。
//   ② 同一批被装进去的模块用了相对路径跨包 import：在仓库里层级恰好对得上，装到目标
//      位置后就指向不存在的邻居包，宿主一启动就报模块找不到，连崩几次只能靠自愈拉起。
//      → `node --check` 只查语法，查不出**解析期**失败，得按部署位置真 import 一遍。
//
// 三个导出（纯函数为主，只有冒烟那一步会起子进程）：
//   parseArgs(argv, known)             白名单解析参数，认不出的原样报出来
//   findEscapingImports(srcDir, opts)  静态扫"相对 import 解析后跑出实体根"的写法
//   smokeImportAll(entityDir, libSpec) 以部署位置为解析上下文，逐个模块真 import
//
// 退出码约定（调用方照抄）：0 = 通过 · 1 = 门禁没过 · 2 = 用法/参数错误
//
// 本文件不写盘、不联网；唯一的外部动作是冒烟时起的那些子进程。

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const EXIT = {
  OK: 0,
  GATE: 1,
  USAGE: 2,
};

// 递归时永远不进的目录名：依赖闭包、版本库元数据、历史与临时产物、构建产物。
// 依赖目录在这台机器上常常是链接，跟进去会跑到盘外扫几十个包。
const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.hg', '.svn', '_archive', '_tmp',
  'dist', 'build', 'coverage', '.cache', '.dsh', '.venv',
  '__pycache__', 'snapshots', 'backups',
]);

// 参与扫描的扩展名
const CODE_EXTS = new Set(['.mjs', '.js', '.cjs']);

// 冒烟时默认跳过的文件名（浏览器 bundle 在 node 里 import 必然报错，不该算部署失败）
const SKIP_SMOKE_FILES = [
  /^client\.js$/,
  /\.browser\.js$/,
  /\.min\.js$/,
];

// ── 1) 参数白名单 ────────────────────────────────────────────────────────────

// 编译白名单：字符串 = 布尔开关；对象 = 可取值开关（`--src X` 或 `--src=X` 都认）。
// 表用无原型对象 —— token 叫 `--constructor` 之类的时候不会撞上继承来的属性。
function compileSpec(known) {
  const table = Object.create(null);
  for (const item of known) {
    if (typeof item === 'string') {
      table[item] = { wantsValue: false };
      continue;
    }
    if (!item || !item.flag) continue;
    const wantsValue = Boolean(item.takesValue);
    table[item.flag] = { wantsValue };
    if (item.alias) table[item.alias] = { wantsValue, aliasOf: item.flag };
  }
  return table;
}

/**
 * 解析命令行参数，只认白名单里的 token。
 * @param {string[]} argv 一般是 process.argv.slice(2)
 * @param {Array<string|{flag:string, takesValue?:boolean, alias?:string}>} known
 *        字符串 = 布尔开关；对象 = 可取值参数（同时可带 alias）
 * @returns {{ok:boolean, unknown:string[], flags:Record<string,boolean>,
 *            values:Record<string,string>, positionals:string[]}}
 *          ok=false 时 unknown 里是全部不认识的 token（调用方负责打出来并以 rc=2 退出）
 */
export function parseArgs(argv, known = []) {
  const spec = compileSpec(known);
  const flags = {};
  const values = {};
  const unknown = [];
  const positionals = [];
  let at = 0;

  while (at < argv.length) {
    const token = argv[at];

    // 首字符不是 '-' 就是位置参数：这几个脚本一个位置参数都不吃，静默吞掉正是事故形态
    if (token.charCodeAt(0) !== 45) {
      positionals.push(token);
      at += 1;
      continue;
    }

    const eq = token.indexOf('=');
    const head = eq > 0 ? token.slice(0, eq) : token;
    const entry = spec[head];
    if (!entry) {
      unknown.push(token);
      at += 1;
      continue;
    }

    const canonical = entry.aliasOf ?? head;

    if (entry.wantsValue) {
      let value = eq > 0 ? token.slice(eq + 1) : null;
      if (value === null) {
        value = argv[at + 1] ?? null;
        at += 1; // 取值同样消费掉下一个 token（与老行为一致，别改成"留着继续解析"）
      }
      values[canonical] = value;
      flags[canonical] = true;
      at += 1;
      continue;
    }

    if (eq > 0) {
      // 布尔开关带 =值 是写错了，要响一声，不能当开关静默放行
      unknown.push(token);
      at += 1;
      continue;
    }

    flags[canonical] = true;
    at += 1;
  }

  unknown.push(...positionals);
  return { ok: unknown.length === 0, unknown, flags, values, positionals };
}

/** 把不认识的参数渲染成人话（调用方后面自己接"只读模式请用 X"的尾巴） */
export function describeUnknown(unknown, known) {
  const allowed = known.map((item) => (typeof item === 'string' ? item : item.flag)).join(' ');
  return `不认识的参数：${unknown.join(' ')}（本脚本只认 ${allowed}）`;
}

// ── 2) 路径归一化 ────────────────────────────────────────────────────────────

/**
 * 归一化：能解析到的部分取真实路径，解析不到的尾巴接回去。
 * 两边都得归一 —— 工作区里目录链接很常见，只归一一边会把同一棵树比成"越过上级"，
 * 于是合法的相邻 import 也被判成逃逸（踩过）。
 * @param {string} target
 * @returns {string}
 */
export function normalizePath(target) {
  const unresolved = [];
  let probe = resolve(target);

  for (;;) {
    let real = null;
    try {
      real = realpathSync.native ? realpathSync.native(probe) : realpathSync(probe);
    } catch {
      real = null;
    }
    if (real !== null) {
      if (!unresolved.length) return real;
      return join(real, ...unresolved.reverse());
    }
    const parent = dirname(probe);
    if (parent === probe) return resolve(target);
    unresolved.push(basename(probe));
    probe = parent;
  }
}

// ── 3) 去注释 ────────────────────────────────────────────────────────────────

/**
 * 把注释抹成空格（换行与列位置都保留），引号里的内容原样留着。
 * 为什么必须抹：注释里常写着示例路径，不抹掉静态扫会把它当真 import。
 * 状态机够用就行：`//`、块注释整段变空格；`'…'` / `"…"` / 反引号串内不动
 * （模板串里的 `${}` 不再细分 —— 漏掉的情况由后面那道真 import 兜底）。
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  const kept = [];
  const length = text.length;
  let pos = 0;
  let mode = 'code';
  let quoteChar = '';

  while (pos < length) {
    const ch = text[pos];

    if (mode === 'block') {
      if (ch === '*' && text[pos + 1] === '/') {
        kept.push('  ');
        pos += 2;
        mode = 'code';
        continue;
      }
      kept.push(ch === '\n' ? '\n' : ' ');
      pos += 1;
      continue;
    }

    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code';
        kept.push(ch);
        pos += 1;
        continue;
      }
      kept.push(' ');
      pos += 1;
      continue;
    }

    if (mode === 'quote') {
      if (ch === '\\') {
        kept.push(ch, text[pos + 1] ?? '');
        pos += 2;
        continue;
      }
      kept.push(ch);
      pos += 1;
      if (ch === quoteChar) {
        mode = 'code';
        quoteChar = '';
      }
      continue;
    }

    if (ch === '/' && text[pos + 1] === '*') {
      kept.push('  ');
      pos += 2;
      mode = 'block';
      continue;
    }
    if (ch === '/' && text[pos + 1] === '/') {
      kept.push('  ');
      pos += 2;
      mode = 'line';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quoteChar = ch;
      kept.push(ch);
      pos += 1;
      mode = 'quote';
      continue;
    }
    kept.push(ch);
    pos += 1;
  }

  return kept.join('');
}

// 只认四种说明符形态：`import/export … from '…'`、`import '…'`、`import('…')`、`require('…')`。
// 前面那个字符类是为了躲开 `x.import(...)`、`$require(...)` 这类属性名/标识符写法。
const IMPORT_PATTERNS = [
  /(?:^|[^\w$.])(?:import|export)\b[^;]*?\bfrom\s*(['"])([^'"]+)\1/,
  /(?:^|[^\w$.])import\s*(['"])([^'"]+)\1/,
  /(?:^|[^\w$.])import\s*\(\s*(['"])([^'"]+)\1\s*\)/,
  /(?:^|[^\w$.])require\s*\(\s*(['"])([^'"]+)\1\s*\)/,
];

// 一行里出现的全部说明符（同一行同一个只记一次，顺序按上面四种形态的先后）
function moduleSpecsOf(line) {
  const specs = [];
  for (const pattern of IMPORT_PATTERNS) {
    const matched = pattern.exec(line);
    if (!matched || !matched[2]) continue;
    if (!specs.includes(matched[2])) specs.push(matched[2]);
  }
  return specs;
}

/**
 * 列出目录下全部 js/mjs/cjs（递归、排序、跳过黑名单目录与链接）。
 * @param {string} root
 * @param {{excludeDirs?:Set<string>, exts?:Set<string>}} [opts]
 * @returns {string[]} 绝对路径，字典序
 */
export function listJsFiles(root, opts = {}) {
  const { excludeDirs = SKIP_DIR_NAMES, exts = CODE_EXTS } = opts;
  const found = [];
  const pending = [root];

  while (pending.length > 0) {
    const dir = pending.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 读不动的目录跳过，不影响其余
    }
    for (const dent of entries) {
      // 链接/junction 一律不跟随：跨盘闭包、盘外目录都在它后面
      if (dent.isSymbolicLink()) continue;
      const full = join(dir, dent.name);
      if (dent.isDirectory()) {
        if (!excludeDirs.has(dent.name)) pending.push(full);
        continue;
      }
      if (exts.has(extname(dent.name))) found.push(full);
    }
  }

  return found.sort();
}

/**
 * 静态扫：srcDir 下 js/mjs/cjs 里"相对 import 解析后跑出 root"的写法。
 * @param {string} srcDir 扫描起点 —— 只该扫「会被复制进实体的那部分」（通常是 lib/）。
 *        传整个插件根会把部署/回滚脚本一起扫进来，它们向上引用是合法姿势、又根本不进
 *        目标位置，只会自报假警（踩过）。
 * @param {{root?:string}} [opts] root = 逃逸判定的边界，即实体被装好之后的那层目录。
 *        原地部署、整棵树一起搬的插件可以放宽到树根。两侧都走 normalizePath（链接坑）。
 *        跨目录引用的正解是用 `file:///…` 绝对 URL —— 绝对路径不计逃逸。
 * @returns {{root:string, scanned:number, specs:number, absolute:number,
 *            bad:Array<{file:string,line:number,spec:string,resolved:string,text:string}>}}
 */
export function findEscapingImports(srcDir, opts = {}) {
  const root = opts.root ?? srcDir;
  const rootReal = normalizePath(root);
  const files = listJsFiles(srcDir, opts);
  const bad = [];
  let relativeSpecs = 0;
  let absoluteSpecs = 0;

  for (const file of files) {
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue; // 读不动就跳过（权限/竞态），不猜
    }
    const rawLines = raw.split(/\r?\n/);
    const codeLines = stripComments(raw).split(/\r?\n/);

    for (let index = 0; index < codeLines.length; index += 1) {
      const line = codeLines[index];
      if (!/import|require/.test(line)) continue;

      for (const spec of moduleSpecsOf(line)) {
        if (isAbsolute(spec)) {
          absoluteSpecs += 1; // 绝对路径是推荐的跨目录姿势，不算逃逸
          continue;
        }
        if (!spec.startsWith('.')) continue; // 裸包名交给 node 自己的解析
        relativeSpecs += 1;

        const resolved = resolve(dirname(file), spec);
        const inside = relative(rootReal, normalizePath(resolved));
        if (!inside.startsWith('..') && !isAbsolute(inside)) continue;

        bad.push({
          file: relative(srcDir, file),
          line: index + 1,
          spec,
          resolved,
          text: rawLines[index].trim().slice(0, 200),
        });
      }
    }
  }

  return { root, scanned: files.length, specs: relativeSpecs, absolute: absoluteSpecs, bad };
}

// ── 4) 按部署位置冒烟 import（子进程隔离） ──────────────────────────────────

// 子进程里跑的两段脚本：代码走 stdin、路径走环境变量 —— 省掉引号与转义那一堆坑。
// 批量版一次进程 import 全部模块，结果打成一行、带前缀（为了容忍被 import 的模块自己
// 往 stdout 打印日志）。
const BATCH_SNIPPET = `
const files = JSON.parse(process.env.DG_BATCH_FILES || '[]');
const report = [];
for (const item of files) {
  try {
    await import(item.url);
    report.push({ file: item.file, ok: true });
  } catch (cause) {
    report.push({ file: item.file, ok: false, err: String((cause && (cause.message || cause)) || cause) });
  }
}
process.stdout.write('\\nDG_RESULT:' + JSON.stringify(report) + '\\n');
if (process.env.DG_EXIT_AFTER === '1') process.exit(0);
`;

// 单模块版：失败时精确定位到文件，并把"解析失败"与"解析成功但进程不退出"分开。
const SINGLE_SNIPPET = `
const target = process.env.DG_TARGET_URL;
try {
  await import(target);
} catch (cause) {
  process.stderr.write('DG_IMPORT_FAIL: ' + String((cause && (cause.message || cause)) || cause));
  process.exitCode = 1;
}
if (!process.exitCode && process.env.DG_EXIT_AFTER === '1') process.exit(0);
`;

const BATCH_MARKER = 'DG_RESULT:';
const FAILURE_MARKER = 'DG_IMPORT_FAIL: ';

// 起一个子进程跑 stdin 脚本：超时、隐藏窗口、环境变量拼装都收在这一处
function runChildScript(script, extraEnv, timeoutMs) {
  return spawnSync(process.execPath, ['--input-type=module'], {
    input: script,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
}

function probeModule(file, timeoutMs, exitAfterImport) {
  return runChildScript(SINGLE_SNIPPET, {
    DG_TARGET_URL: pathToFileURL(file).href,
    DG_EXIT_AFTER: exitAfterImport ? '1' : '0',
  }, timeoutMs);
}

function probeBatch(items, timeoutMs) {
  return runChildScript(BATCH_SNIPPET, {
    DG_BATCH_FILES: JSON.stringify(items),
    DG_EXIT_AFTER: '1', // 批量只回答"能不能全部解析"，import 完立刻收尾（别被定时器拖住）
  }, timeoutMs);
}

// 从（可能混着模块日志的）stdout 里取最后一条批量结果
function readBatchReport(stdout) {
  const text = stdout ?? '';
  const started = text.lastIndexOf(BATCH_MARKER);
  if (started < 0) return null;
  const payload = text.slice(started + BATCH_MARKER.length).split(/\r?\n/)[0];
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

// 从 stderr 里取第一行有效错误信息（截到 300 字，够定位就行）
function readFailureText(stderr) {
  const text = stderr ?? '';
  const started = text.indexOf(FAILURE_MARKER);
  const body = started >= 0 ? text.slice(started + FAILURE_MARKER.length) : text;
  const firstLine = body.split(/\r?\n/).find((row) => row.trim()) ?? '';
  return firstLine.trim().slice(0, 300);
}

// 快路径：整批 import。判据从严 —— 只有"整批都说 ok"才算通过，否则交给慢路径确认。
// 理由：批量只会误报失败（模块之间互相干扰），不会误报成功（每个模块都真 import 过）。
function attemptBatch(files, libDir, timeoutMs) {
  const manifest = files.map((file) => ({
    file: relative(libDir, file),
    url: pathToFileURL(file).href,
  }));
  const run = probeBatch(manifest, timeoutMs);
  const report = readBatchReport(run.stdout);
  if (!report || report.length !== files.length) return null;
  if (!report.every((row) => row.ok)) return null;
  return report.map((row) => ({ file: row.file, ok: true, ms: 0, hung: null }));
}

// 慢路径：一个模块一个进程。三态 —— 通过 / 能解析但把事件循环挂住了 / 解析失败（带原因）
function inspectModule(file, timeoutMs) {
  const first = probeModule(file, timeoutMs, false);
  if (!(first.error || first.signal)) {
    if (first.status === 0) return { resolved: true, hung: false };
    return {
      resolved: false,
      timeout: false,
      err: readFailureText(first.stderr ?? '') || `exit ${first.status}`,
    };
  }

  // 第一次没跑完未必是解析失败：模块 import 成功后也可能挂着定时器/监听器。
  // 让它 import 完主动收尾再试一次，两种原因就分开了。
  const second = probeModule(file, timeoutMs, true);
  if (second.status === 0) return { resolved: true, hung: true };
  if (!(second.error || second.signal)) {
    return {
      resolved: false,
      timeout: false,
      err: readFailureText(second.stderr ?? '') || `exit ${second.status}`,
    };
  }

  // 两次都没跑完：仍按"卡住"报，附带第一次拿到的信号/错误码
  return {
    resolved: false,
    timeout: true,
    err: `${first.error?.code ?? first.signal ?? '超时'}：${timeoutMs}ms 内未结束（import 后进程既不退出也不报错）`,
  };
}

/**
 * 以**部署位置**为解析上下文，把 lib 里的模块逐个 import 一遍。
 * 关键点：import 的是实体目录里的那个文件（file URL），模块自己的相对 import 才会按
 * 部署后的位置解析 —— 这正是"仓库里跑得通、装到目标位置就崩"的暴露面。
 * 每个模块单独一个子进程：模块有副作用或挂着事件循环，也污染不到部署进程。
 * @param {string} entityDir 部署实体目录（必须真实存在；原地部署的插件传源码目录自身）
 * @param {string|{dir?:string, skip?:RegExp[], timeoutMs?:number}} [libSpec='lib']
 * @param {{dir?:string, skip?:RegExp[], timeoutMs?:number, only?:RegExp,
 *          batchTimeoutMs?:number, batch?:boolean}} [opts]
 * @returns {{dir:string, error:string|null, mode:string|null, total:number, skipped:number,
 *            bad:Array<{file:string,err:string,timeout:boolean}>,
 *            results:Array<{file:string,ok:boolean,ms:number,hung:boolean|null}>}}
 */
export function smokeImportAll(entityDir, libSpec = 'lib', opts = {}) {
  const cfg = typeof libSpec === 'string' ? { ...opts, dir: libSpec } : { ...opts, ...libSpec };
  const {
    skip = SKIP_SMOKE_FILES,
    timeoutMs = 20000,
    batchTimeoutMs = 90000,
    batch = true,
    only = null,
  } = cfg;

  const entityRoot = resolve(entityDir);
  const requestedDir = cfg.dir ?? 'lib';
  const libDir = isAbsolute(requestedDir) ? requestedDir : join(entityRoot, requestedDir);
  const empty = { dir: libDir, error: null, mode: null, total: 0, skipped: 0, bad: [], results: [] };

  if (!existsSync(entityRoot)) return { ...empty, error: `实体目录不存在：${entityRoot}` };
  if (!existsSync(libDir)) return { ...empty, error: `实体下没有 lib 目录：${libDir}` };

  // 解析上下文必须落在实体内部：lib 跑到实体外面，等于拿源码目录冒充部署位置
  const containment = relative(normalizePath(entityRoot), normalizePath(libDir));
  if (containment.startsWith('..') || isAbsolute(containment)) {
    return { ...empty, error: `lib 目录不在实体目录内（解析上下文错位）：${libDir}` };
  }

  const discovered = listJsFiles(libDir).filter((file) => !only || only.test(relative(libDir, file)));
  const targets = discovered.filter((file) => !skip.some((pattern) => pattern.test(relative(libDir, file))));
  const skipped = discovered.length - targets.length;

  // 快路径：一个进程 import 全部（模块一多就快一个数量级）
  if (batch && targets.length > 1) {
    const overview = attemptBatch(targets, libDir, batchTimeoutMs);
    if (overview) {
      return {
        dir: libDir,
        error: null,
        mode: 'batch',
        total: targets.length,
        skipped,
        bad: [],
        results: overview,
      };
    }
  }

  // 慢路径：逐模块（能精确定位到文件，也能分辨"解析失败"与"import 成功后挂着不退出"）
  const bad = [];
  const results = [];
  for (const file of targets) {
    const label = relative(libDir, file);
    const startedAt = Date.now();
    const outcome = inspectModule(file, timeoutMs);
    const spent = Date.now() - startedAt;
    if (outcome.resolved) {
      results.push({ file: label, ok: true, ms: spent, hung: outcome.hung });
      continue;
    }
    bad.push({ file: label, err: outcome.err, timeout: outcome.timeout });
    results.push({ file: label, ok: false, ms: spent, hung: false });
  }

  return {
    dir: libDir,
    error: null,
    mode: 'per-module',
    total: targets.length,
    skipped,
    bad,
    results,
  };
}
