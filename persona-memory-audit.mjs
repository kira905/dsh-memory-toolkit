#!/usr/bin/env node
// persona ↔ 记忆 防反弹闸门（体检 · 零依赖 · 默认只读）
//
// 用途：把「persona 正文体积」与「记忆可见率」两项指标固定下来，供日报/面板/手工调用。
// 判据来源（只读参考，不改动）：
//   · persona 正文 = <preset>/agent.cordis.yml 的 `prefix: |-` 块（每会话 100% 注入）
//   · 记忆注入 = dsh-memory 的 forPrompt + renderPrompt（lib/index.js L124-128 / L185-203）
//   · 生效预算 = <profile>/cordis.patch.yml 的 `- id: memory` 行
//
// 阈值：persona > 20000 字符 ⇒ 🔴；记忆可见率 < 5% ⇒ 🔴
// 退出码：0 = 全绿/仅黄；3 = 存在 🔴；2 = 关键读数失败
//
// 用法：
//   node persona-memory-audit.mjs [--json] [--quiet]
//        [--persona-max 20000] [--visible-min 5] [--preset whale-girl] [--profile web]
//
// 变更：2026-09-28 首版

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ARGV = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = ARGV.indexOf(name);
  return i === -1 ? dflt : ARGV[i + 1];
};
const has = (name) => ARGV.includes(name);

const PERSONA_MAX = Number(flag('--persona-max', 20000));
const VISIBLE_MIN = Number(flag('--visible-min', 5));
const PRESET = flag('--preset', 'whale-girl');
const PROFILE = flag('--profile', 'web');
const DH = process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? '.', '.dsh');

function readPersonaBody(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^ {4}prefix:\s*\|-?\s*$/.test(lines[i])) { start = i; break; }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (l.length - l.trimStart().length < 6) { end = i; break; }
  }
  const bodyLines = lines.slice(start + 1, end);
  // YAML 块标量的 6 空格缩进是语法、不进注入文本 ⇒ 口径以「剥离缩进后」为准
  // （与 `tools\validate-persona.mjs` 报的 persona text 长度一致）。
  const stripped = bodyLines.map((l) => (l.startsWith('      ') ? l.slice(6) : l));
  return {
    text: stripped.join('\n'),
    indentedChars: bodyLines.join('\n').length,
    lines: bodyLines.length,
    fileChars: raw.length,
  };
}

function readBudget(patchFile) {
  if (!fs.existsSync(patchFile)) return { found: false, promptRecentCount: 10, promptMaxChars: 2000 };
  const txt = fs.readFileSync(patchFile, 'utf8');
  const m = /- id: memory\s*\n\s*config:\s*\n([\s\S]*?)(?=\n- |\n# |\s*$)/.exec(txt);
  const seg = m ? m[1] : '';
  const num = (k, d) => {
    const r = new RegExp(`${k}:\\s*(\\d+)`).exec(seg);
    return r ? Number(r[1]) : d;
  };
  return { found: Boolean(m), promptRecentCount: num('promptRecentCount', 10), promptMaxChars: num('promptMaxChars', 2000) };
}

function safeTags(raw) {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : String(v).split(/[,\s]+/).filter(Boolean); }
  catch { return String(raw).split(/[,\s]+/).filter(Boolean); }
}

function measureMemory(dbPath, budget) {
  if (!fs.existsSync(dbPath)) return { ok: false, error: 'memory.db 不存在' };
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); }
  catch (e) { return { ok: false, error: `打不开 memory.db: ${e.message}` }; }
  try {
    const total = db.prepare('SELECT COUNT(*) n FROM memories').get().n;
    const pinnedN = db.prepare('SELECT COUNT(*) n FROM memories WHERE pinned = 1').get().n;
    const totalChars = db.prepare('SELECT SUM(LENGTH(text)) c FROM memories').get().c ?? 0;
    const records = [
      ...db.prepare('SELECT * FROM memories WHERE pinned = 1 ORDER BY updated_at DESC, id DESC').all(),
      ...db.prepare('SELECT * FROM memories WHERE pinned = 0 ORDER BY updated_at DESC, id DESC LIMIT ?').all(budget.promptRecentCount),
    ].map((r) => ({ id: r.id, pinned: Boolean(r.pinned), tags: r.tags ? safeTags(r.tags) : [], text: r.text }));

    const header = 'Memories you previously stored (use memory_search for anything not listed):\n';
    let used = 76;
    let dropped = 0;
    const kept = [];
    for (const rec of records) {
      const tags = rec.tags.length ? ` [${rec.tags.join(',')}]` : '';
      const line = `- (#${rec.id}${rec.pinned ? ', pinned' : ''})${tags} ${rec.text}`;
      if (used + line.length + 1 > budget.promptMaxChars) { dropped++; continue; }
      kept.push({ id: rec.id, pinned: rec.pinned, chars: line.length });
      used += line.length + 1;
    }
    const tail = dropped > 0 ? `\n(${dropped} more memories not shown; use memory_search)` : '';
    const injectedChars = kept.length ? 76 + kept.reduce((a, k) => a + k.chars, 0) + tail.length : 0;
    return {
      ok: true,
      total, pinnedN, totalChars,
      candidateCount: records.length,
      injectedCount: kept.length,
      injectedChars,
      dropped,
      visiblePercent: totalChars > 0 ? injectedChars / totalChars * 100 : 0,
      kept,
    };
  } finally { db.close(); }
}

function usage() {
  return `persona ↔ 记忆 体检（只读 · 零依赖）

用法：node persona-memory-audit.mjs [选项]

  --json                机读输出（JSON）
  --quiet               只输出一行结论
  --persona-max <n>     persona 正文字符阈值（默认 20000）
  --visible-min <p>     记忆可见率阈值 %（默认 5）
  --preset <name>       preset 名（默认 whale-girl；读 <DSH_HOME>/.agent-presets/<name>/agent.cordis.yml）
  --profile <name>      profile 名（默认 web；读 <DSH_HOME>/profiles/<name>/cordis.patch.yml）
  -h, --help            本帮助

环境变量：DSH_HOME（缺省 ~/.dsh）
退出码：0 = 全绿/仅黄 · 3 = 存在 🔴 · 2 = 关键读数失败`;
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return 0;
  }
  const presetFile = path.join(DH, '.agent-presets', PRESET, 'agent.cordis.yml');
  const patchFile = path.join(DH, 'profiles', PROFILE, 'cordis.patch.yml');
  const dbPath = path.join(DH, 'memory', 'memory.db');

  const persona = fs.existsSync(presetFile) ? readPersonaBody(presetFile) : null;
  const budget = readBudget(patchFile);
  const mem = measureMemory(dbPath, budget);

  const findings = [];
  if (!persona) {
    findings.push({ level: 'red', key: 'persona', text: `persona 正文读不到（${presetFile}）` });
  } else if (persona.text.length > PERSONA_MAX) {
    findings.push({
      level: 'red', key: 'persona',
      text: `persona 正文 ${persona.text.length} 字符 > 阈值 ${PERSONA_MAX} ⇒ 每会话多注入 ${persona.text.length - PERSONA_MAX} 字符`,
    });
  }
  if (!mem.ok) {
    findings.push({ level: 'red', key: 'memory', text: `记忆库读数失败：${mem.error}` });
  } else if (mem.visiblePercent < VISIBLE_MIN) {
    findings.push({
      level: 'red', key: 'visible',
      text: `记忆可见率 ${mem.visiblePercent.toFixed(2)}% < ${VISIBLE_MIN}% ⇒ 注入 ${mem.injectedCount}/${mem.total} 条（${mem.injectedChars} 字符）；pinned ${mem.pinnedN} 条/字符占用高是常见主因`,
    });
  } else if (mem.visiblePercent < VISIBLE_MIN * 2) {
    findings.push({ level: 'yellow', key: 'visible', text: `记忆可见率 ${mem.visiblePercent.toFixed(2)}% 偏低（阈值 ${VISIBLE_MIN}%）` });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    host: process.env.COMPUTERNAME ?? 'unknown',
    dshHome: DH,
    thresholds: { personaMaxChars: PERSONA_MAX, visibleMinPercent: VISIBLE_MIN },
    persona: persona ? { file: presetFile, bodyChars: persona.text.length, bodyCharsIndented: persona.indentedChars, bodyLines: persona.lines, fileChars: persona.fileChars } : { file: presetFile, error: '未找到 prefix 块' },
    memoryBudget: budget,
    memory: mem.ok ? {
      db: dbPath,
      total: mem.total, pinned: mem.pinnedN, totalChars: mem.totalChars,
      candidateCount: mem.candidateCount,
      injectedCount: mem.injectedCount, injectedChars: mem.injectedChars, dropped: mem.dropped,
      visiblePercent: Number(mem.visiblePercent.toFixed(2)),
      kept: mem.kept,
    } : { error: mem.error },
    findings,
    worst: findings.some((f) => f.level === 'red') ? 'red' : findings.length ? 'yellow' : 'green',
  };

  if (has('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report.worst === 'red' ? 3 : 0;
  }

  const icon = { red: '🔴', yellow: '🟡', green: '🟢' }[report.worst];
  if (!has('--quiet')) {
    console.log(`${icon} persona ↔ 记忆 体检（${report.host}）`);
    if (persona) console.log(`  persona 正文: ${persona.text.length} 字符 / ${persona.lines} 行（阈值 ${PERSONA_MAX}；含 YAML 缩进 ${persona.indentedChars}）`);
    else console.log('  persona 正文: 读不到');
    if (mem.ok) {
      console.log(`  记忆库: ${mem.total} 条 / ${mem.totalChars} 字符（pinned ${mem.pinnedN}）`);
      console.log(`  注入预算: promptRecentCount=${budget.promptRecentCount} / promptMaxChars=${budget.promptMaxChars}（profile 覆盖 ${budget.found ? '在位' : '未找到'}）`);
      console.log(`  本轮注入: ${mem.injectedCount} 条 / ${mem.injectedChars} 字符（丢弃 ${mem.dropped}）`);
      console.log(`  记忆可见率: ${mem.visiblePercent.toFixed(2)}%（阈值 ${VISIBLE_MIN}%）`);
    } else {
      console.log(`  记忆库: ${mem.error}`);
    }
    for (const f of findings) console.log(`  ${icon === '🟢' ? '·' : (f.level === 'red' ? '🔴' : '🟡')} ${f.text}`);
    if (!findings.length) console.log('  · 全绿：persona 未超阈值，记忆可见率达标');
  } else {
    console.log(`${icon} persona ${persona ? persona.text.length : '?'} 字符 | 记忆可见率 ${mem.ok ? mem.visiblePercent.toFixed(2) + '%' : '?'} | 注入 ${mem.ok ? mem.injectedCount : '?'} 条`);
  }
  return report.worst === 'red' ? 3 : 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error('体检失败:', e.message);
  process.exitCode = 2;
}
