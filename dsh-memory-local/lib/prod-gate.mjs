// lib/prod-gate.mjs —— **生产路径闸**（写入落在生产树内时，必须显式放行）
//
// 一句话：还原 / 回滚 / 清理类脚本动**生产树**里的东西之前，必须在**机器层**被拦住 ——
//   没显式 `--allow-production` ⇒ 拒跑（不是"警告后继续"）；dry-run 是第一道门（只读档零写入，不该拦计划）。
//
// 为什么需要它（本仓的来历）：上游的实现把「生产树」写死成某一台机器的具体路径，
//   结果两个洞 ——
//     ① 只比"**等于**"某个默认 home ⇒ `--target <生产树内的子目录>` 一律放行；
//     ② 只比**逻辑**字符串、不走 realpath ⇒ 目录 junction / 符号链接跨面可绕。
//   ⇒ 本文件是它的**可移植等价实现**：生产树由环境变量给出，判定一律 realpath + 逻辑路径**双比**。
//
// 判定口径：
//   · 生产树集合 = `$DSH_HOME`（缺省 `~/.dsh`）+ `$DSH_PROD_ROOTS`（多个用 `;` 或 `:` 分隔）
//   · 目标落在任一根之内（任一形态命中即算）⇒ 命中
//   · `dryRun: true` ⇒ 直接放行（第一道门，函数内判，不依赖调用方）
//   · `allowProduction: true` ⇒ 放行，但把命中项回传给调用方（便于留痕/打印）
//
// 退出码口径（与各 restore/rollback 脚本一致）：
//   ok:true = 通过 · ok:false + exitCode:2 = 缺放行（用法错）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 归一：绝对路径 + 反斜杠形态 + 小写（Windows 比较用）。 */
function normalize(p) {
  return path.resolve(String(p)).replace(/\//g, path.sep).toLowerCase();
}

/** 尽头真身（不存在或解析失败则回落逻辑路径 —— 不能因为读不到就当成"不在生产树"）。 */
function realish(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** 生产树根集合。 */
export function productionRoots(opts = {}) {
  const env = opts.env ?? process.env;
  const extra = String(env.DSH_PROD_ROOTS ?? '')
    .split(/[;:]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const home = opts.dshHome ?? env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return [home, ...extra];
}

/** 目标是否落在生产树内（双比：逻辑路径 + realpath）。 */
export function isProductionPath(target, opts = {}) {
  const roots = productionRoots(opts);
  const cands = [normalize(target), normalize(realish(target))];
  const hits = [];
  for (const root of roots) {
    for (const r of [normalize(root), normalize(realish(root))]) {
      for (const c of cands) {
        if (c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)) hits.push({ target, root });
      }
    }
  }
  return hits;
}

/**
 * 生产写闸。
 * @param {{targets?:Array<{path:string,label?:string}>, allowProduction?:boolean, dryRun?:boolean, op?:string, reason?:string}} args
 * @returns {{ok:boolean, exitCode:number, dryRun:boolean, hits:Array, message:string}}
 */
export function gateProductionWrite(args = {}) {
  const targets = Array.isArray(args.targets) ? args.targets : [];
  const dryRun = args.dryRun === true;
  const allowProduction = args.allowProduction === true;
  const op = args.op || '写入';

  // ── 第一道门：dry-run 一律放行（只读档不产生任何写） ──────────────────────
  if (dryRun) {
    return { ok: true, exitCode: 0, dryRun: true, hits: [], allowProduction, message: `dry-run：${op}计划放行（零写入）` };
  }

  const hits = [];
  for (const t of targets) {
    if (!t || !t.path) continue;
    for (const h of isProductionPath(t.path, args)) hits.push({ ...h, label: t.label || '目标' });
  }

  if (hits.length === 0) {
    return { ok: true, exitCode: 0, dryRun: false, hits: [], allowProduction, message: `${op}目标不在生产树内` };
  }
  if (allowProduction) {
    return {
      ok: true,
      exitCode: 0,
      dryRun: false,
      hits,
      allowProduction: true,
      bypassed: true,
      message: `显式放行：${op}目标在生产树内（${hits.map((h) => h.label).join('、')}）`,
    };
  }
  return {
    ok: false,
    exitCode: 2,
    dryRun: false,
    hits,
    allowProduction: false,
    message: `拒绝：${op}目标落在生产树内（${hits.map((h) => `${h.label}=${h.target}`).join('，')}）`,
  };
}

/** 人类可读的拒绝行（供 `console.error`）。 */
export function refuseLine(gate) {
  const lines = [gate.message || '拒绝'];
  if (gate.hits?.length) {
    for (const h of gate.hits) lines.push(`  命中：${h.label} → ${h.target}（生产根 ${h.root}）`);
  }
  lines.push('  怎么给：确认这是有意为之后加 `--allow-production`；只读检查请用 `--dry-run`。');
  return lines.join('\n');
}

export const EXIT = { OK: 0, GATE: 1, USAGE: 2 };
