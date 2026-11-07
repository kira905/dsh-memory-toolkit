#!/usr/bin/env node
// 记忆分类 v1 —— 给每条记忆打一个「主类」标签，**只写旁挂 JSONL，绝不写 memory.db**
//
// 口径真源：docs\口径-记忆分类v1-20261026.md
// 上游：docs\交付报告-记忆衰减补强-H4标定-20261023.md（0.479 ⇒ 判据换轨）
//       docs\方案-记忆衰减二期-半衰期与召回留痕-20261023.md（P1 留痕 → P2 排序 → P3 分类）
//
// 红线（写死在代码里）：
//   · 库连接一律 readOnly；本文件没有任何 UPDATE/INSERT/DELETE 语句
//   · 模型档默认关；开了必须过与 memory-distill 同一份成本闸（~/.dsh/butler-distill-state.json）
//     · 每批 ≤40 条 · 每批报 token · 每批落盘 · **没有 --gate-override**
//
// 用法：
//   node classify-memories.mjs                       # dry-run（默认，零写入）
//   node classify-memories.mjs --apply               # 写旁挂 JSONL（幂等：同 id 同 srcHash 不重判）
//   node classify-memories.mjs --report              # 现状报表（读 JSONL，不跑分类）
//   node classify-memories.mjs --sample <输出目录> --per-class 20   # 导出抽检样本
//   node classify-memories.mjs --rollback            # dry-run 列本工具写入的行数
//   node classify-memories.mjs --rollback --apply    # 真删（按 at 时间戳）
//   node classify-memories.mjs --apply --model       # 规则先跑，conf<0.7 的才走模型（带闸）
//   其它：--limit N · --ids 1,2,3 · --out <jsonl> · --state <distill-state> · --batch 40 · --json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// ── R-065 · 删除/搬移三件套（回滚重写时用；与 lib/distill.mjs 同一份共享件）────────
const PG_DESTRUCTIVE = await import('../lib/production-guard.mjs').catch(() => null);
function destructiveGate({ targets, whitelist, op = '删', reason = 'R-065' }) {
  if (!PG_DESTRUCTIVE) { console.error('[R-065] 拒绝：删除/搬移共享件不可用 ⇒ fail-closed'); return { ok: false, code: 'guard-unavailable' }; }
  const g = PG_DESTRUCTIVE.gateDestructive({
    targets, whitelist, op, scope: ['file'], requires: ['file'], dryRun: false,
    allowProduction: true, allowReparse: false, ledgerBypass: false, reason,
  });
  if (!g.ok) { console.error(PG_DESTRUCTIVE.renderDestructive(g)); return { ok: false, code: g.code, exitCode: g.exitCode }; }
  return { ok: true, gate: g };
}

// ── 常量 ────────────────────────────────────────────────────────────────────
export const CLASSES = Object.freeze(['canon', 'pitfall', 'device', 'pref', 'progress', 'stale']);
export const CLASS_LABEL = Object.freeze({
  canon: '口径/铁律', pitfall: '活坑', device: '设备/环境事实',
  pref: '偏好/习惯', progress: '过程/进度', stale: '疑似过时',
});
export const GATE_BATCH_MAX = 40;              // 模型档每批上限（口径 §4，不可调高）
export const DEFAULT_OUT = path.join(os.homedir(), '.dsh', 'memory-classify.jsonl');
export const RUNS_MANIFEST = path.join(os.homedir(), '.dsh', 'memory-classify-runs.jsonl');
export const CONF_NEED_MODEL = 0.7;            // 低于此值才算"模糊"（口径 §2.3）

// ── 规则表（口径 §3）────────────────────────────────────────────────────────
// tag 强信号（作者亲手打的元数据，可信度最高）
const TAG_PITFALL = ['坑', '工具坑', '事故', '教训', '陷阱', '踩坑', '排障', '假绿', '撞车'];
const TAG_CANON = ['口径', '铁律', '规矩', '纪律', '禁令', '主人令', '判据口径', '标准', '规范'];
const TAG_PREF = ['user-preference', 'preference', '偏好', '习惯', '梗', 'meme', '叫法', '口味', '人味'];
const TAG_PROGRESS = ['交付', '验收', '进度', '在途', '看板卡', '冲刺', '待拍板', '收尾', '销账'];
const TAG_STALE = ['过时', '已废弃', 'obsolete', 'superseded'];
// 机器名不在开源版内置：多机用户按自己的机器名往这里补（追加在前，越大越像专名）
const TAG_DEVICE = ['跨机', '端口', '路径', '设备'];

// 正文信号（打分制：按"写作目的"累分，权重见口径 §2.2 / §3）
// stale 只认**本条自己**被作废（讲"别人的旧路径作废"不算 —— 那是 canon）
const RE_STALE_STRONG = /本(条|记忆|口径|结论|说法)(已)?\s*(作废|过时|失效|过期)|(这条|该条|此条)(已)?(作废|过时|失效)|本条已被[^。；\n]{0,24}(取代|替代)|不再适用/;

// 交付/进度：动词（否定前缀不算）+ 交付上下文
const RE_DELIVERY_VERB = /(?<![未没不])(?:已\s*(?:交付|验收|收官|闭环|接线|接入|落地|上线|部署|收编|建成|实现|完成|产出|建档|建立|统筹|复盘|焊接|焊入|收口|销账)|立项|建档|建成|落地|验收\s*done)/g;
const RE_DELIVERY_CTX = /卡\s*`?[0-9a-f]{6,}|真源|第\s*\d+\s*棒|rev\s*\d+|验收\s*done|交付报告/g;
const TITLE_PROGRESS = /清单|产物|方案|收尾|移交|收官|交付|第\s*\d+\s*棒|复盘|进度|销账|统筹|立项/;

// 活坑：强坑词（"有坑即坑" —— 条目的写作目的就是记这个坑）
const RE_PIT_STRONG_WORD = /根因|真凶|踩到|踩坑|实测踩|避雷|教训|修法|翻车|炸过|假绿|静默失效|两连坑/;
// 中档坑词只加分不短路；**单字「坑」不计** —— 它太常见（"记录坑""踩了坑"），会把一切标签成坑
const RE_PIT_WORD = /根因|真凶|踩到|踩坑|实测踩|避雷|教训|修法|翻车|炸过|假绿|假结算|静默失效|报错|失败|失效|不一致|锁住|占用|冲突|事故|症状|卡死|死锁|不返回|ReferenceError|TypeError|bug/g;
const TITLE_PITFALL = /坑|避雷|教训|排障|事故|别再|别用|两连坑|形态/;

// 口径/铁律：规范句式（只在前 300 字算 —— 散落在长文里的"必须"不算写作目的）
const RE_CANON_WORD = /口径\s*[:：=]|铁律|主人令|主人(决定|拍板|批准)|纪律|一律|禁止|不许|不得|必须|规矩|规则|原则|判据\s*[:：=]|优先级\s*[:：=]/g;
const TITLE_CANON = /口径|铁律|规矩|规则|纪律|约定|原则|必读|定义|判据|决策|拍板|规程|技巧|方法/;

// 偏好
const RE_PREF_WORD = /主人(喜欢|偏好|习惯|不爱|讨厌|要)|偏好|习惯上|别叫我|称呼|叫法|口味|人味/g;

// 设备事实
const RE_DEVICE_WORD = /【设备[:：]|\bD:\\DSH|[A-Z]:\\[^\s]{4,}\.(mjs|ps1|cmd|json|md|db|yml|js|txt)|127\.0\.0\.1[:：]\d+|localhost[:：]\d+|\bpid\s*[=：]\d+|v\d+\.\d+\.\d+|sha256|\b(?:POST|GET|PUT|DELETE)\s+\/|\/api\//gi;
const TITLE_DEVICE = /设备|环境|读数|机制|考据|版本|配置|部署|硬件|基线|来源/;

const sha16 = (s) => crypto.createHash('sha256').update(String(s ?? ''), 'utf8').digest('hex').slice(0, 16);

function tagsOf(row) {
  return String(row.tags ?? '').toLowerCase().split(/[,\s]+/).filter(Boolean);
}
function hasAnyTag(set, list) {
  for (const t of list) if (set.includes(t.toLowerCase())) return t;
  return null;
}

/**
 * 单条判定（纯函数，可单测）。
 * 规则 = **tag 硬短路**（作者元数据可信度最高）+ **无 tag 时打分**（按"写作目的"累分）。
 * 顺序链与权重见口径 §2.2 / §3。
 * @returns {{cls:string, conf:number, reason:string}}
 */
export function classifyOne(row) {
  const text = String(row.text ?? '');
  const head = text.slice(0, 1500);
  const title = text.slice(0, 100);
  const ts = tagsOf(row);
  const hitTag = (list) => { for (const t of list) if (ts.includes(t)) return t; return null; };
  const count2 = (str, re) => { re.lastIndex = 0; return (String(str).match(re) || []).length; };
  const count = (re) => count2(head, re);

  const tagPit = hitTag(TAG_PITFALL);
  const tagCanon = hitTag(TAG_CANON);
  const tagPref = hitTag(TAG_PREF);
  const tagProg = hitTag(TAG_PROGRESS);
  const tagStale = hitTag(TAG_STALE);
  const tagDev = hitTag(TAG_DEVICE);
  const isMachine = ts.some((x) => x.startsWith('machine:'));

  // ── tag 硬短路（作者亲手打的标签：坑 > 口径 > 偏好；过时最前）──────────────
  if (tagStale) return { cls: 'stale', conf: 0.95, reason: `tag:${tagStale}` };
  if (tagPit) {
    // 交叉：tag 打了「坑」，但开头 200 字在写"已交付/已完成/已落地"且没有坑词 ⇒ 那是落地记录（作者标签偏了）
    const z = text.slice(0, 200);
    const dv0 = (z.match(RE_DELIVERY_VERB) || []).length;
    const pv0 = (z.match(RE_PIT_WORD) || []).length;
    if (dv0 >= 1 && pv0 === 0) return { cls: 'progress', conf: 0.75, reason: `tag:${tagPit}+正文:交付动词x${dv0}` };
    return { cls: 'pitfall', conf: 0.95, reason: `tag:${tagPit}` };
  }
  if (tagCanon) return { cls: 'canon', conf: 0.95, reason: `tag:${tagCanon}` };
  if (tagPref) return { cls: 'pref', conf: 0.95, reason: `tag:${tagPref}` };

  // ── 无强 tag ⇒ 打分 ────────────────────────────────────────────────────────
  const s = { canon: 0, pitfall: 0, device: 0, pref: 0, progress: 0, stale: 0 };
  const why = { canon: [], pitfall: [], device: [], pref: [], progress: [], stale: [] };
  const add = (cls, n, label) => { if (n > 0) { s[cls] += n; if (!why[cls].includes(label)) why[cls].push(label); } };
  const canonZone = text.slice(0, 300);   // 规范词只在前 300 字算（散落在长文里的"必须"不代表写作目的）
  const zone200 = text.slice(0, 200);

  // stale：明确"本条已作废" ⇒ 状态优先，直接定
  if (RE_STALE_STRONG.test(text)) return { cls: 'stale', conf: 0.85, reason: '正文:本条已作废句' };

  // pitfall 硬短路：**标题**直接写着坑/避雷/教训/形态 ⇒ 写作目的就是坑
  if (TITLE_PITFALL.test(title)) return { cls: 'pitfall', conf: 0.8, reason: '标题:坑/避雷/教训' };
  // 坑词**出现在开头 200 字**（写作目的就是坑）或**通篇密集 ≥4 次**
  const pitAll = count2(head, RE_PIT_WORD);
  const pitZone = count2(zone200, RE_PIT_STRONG_WORD) + (count2(zone200, RE_PIT_WORD) >= 2 ? 1 : 0);
  if (pitZone >= 1 || pitAll >= 4) {
    return { cls: 'pitfall', conf: 0.85, reason: `正文:坑词前置/密集x${pitAll}` };
  }

  // progress：交付动词 + 交付上下文（上下文 ≥2 条时本身也够强）
  const dv = count(RE_DELIVERY_VERB);
  if (dv) add('progress', Math.min(10, 4 + dv * 2), `正文:交付动词x${dv}`);
  const dc = count(RE_DELIVERY_CTX);
  if (dv && dc) add('progress', 4, `正文:交付上下文x${dc}`);
  if (!dv && dc >= 2) add('progress', 4, `正文:交付上下文x${dc}`);
  if (tagProg) add('progress', 4, `tag:${tagProg}`);
  if (TITLE_PROGRESS.test(title)) add('progress', 5, '标题:清单/方案/交付');

  // pitfall：只剩标题信号（正文坑词已经在上面短路，这里不重复计分）
  if (TITLE_PITFALL.test(title)) add('pitfall', 5, '标题:坑/避雷/教训');

  // canon：规范句式（仅前 300 字）
  const cv = count2(canonZone, RE_CANON_WORD);
  if (cv) add('canon', Math.min(8, cv * 2), `正文:规范词x${cv}`);
  if (TITLE_CANON.test(title)) add('canon', 5, '标题:口径/铁律/定义');

  // pref：偏好句式
  const fv = count(RE_PREF_WORD);
  if (fv) add('pref', Math.min(6, fv * 2), `正文:偏好词x${fv}`);

  // device：机器 tag + 设备读数（权重压低 —— 路径/版本几乎每篇都有，不代表写作目的）
  if (tagDev) add('device', 2, `tag:${tagDev}`);
  if (isMachine) add('device', 2, 'tag:machine:*');
  const ev = count(RE_DEVICE_WORD);
  if (ev) add('device', Math.min(4, ev), `正文:设备读数x${ev}`);
  if (TITLE_DEVICE.test(title)) add('device', 2, '标题:设备/机制/配置');

  const ORDER = ['stale', 'pitfall', 'progress', 'canon', 'pref', 'device'];
  let best = null;
  for (const c of ORDER) if (best === null || s[c] > s[best]) best = c;
  const s1 = s[best];
  const s2 = Math.max(...ORDER.filter((c) => c !== best).map((c) => s[c]));
  if (s1 === 0) return { cls: 'device', conf: 0.5, reason: '兜底:无强特征' };
  const conf = s1 >= 10 ? 0.95 : s1 - s2 >= 4 ? 0.85 : s1 - s2 >= 2 ? 0.75 : 0.65;
  return { cls: best, conf, reason: why[best].join('+') };
}

// ── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i += 1; }
  }
  return flags;
}
const flagNum = (v, d) => (v === undefined || v === true ? d : Number(v));

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 坏行忽略（不阻断） */ }
  }
  return out;
}

function writeJsonlAtomic(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  const g = destructiveGate({ targets: [tmp, file], whitelist: [path.dirname(file)], op: '搬移', reason: 'classify: JSONL 原子重写' });
  if (!g.ok) throw new Error(`R-065 拒绝：${g.code ?? 'blocked'}`);
  try { fs.renameSync(tmp, file); } catch {
    fs.copyFileSync(tmp, file);
    const gd = destructiveGate({ targets: [tmp], whitelist: [path.dirname(file)], op: '删', reason: 'classify: 清临时件' });
    if (gd.ok) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
  }
}

function defaultDbPath() {
  return path.join(os.homedir(), '.dsh', 'memory', 'memory.db');
}
function defaultStatePath() {
  return path.join(os.homedir(), '.dsh', 'butler-distill-state.json');
}

// ── 库（只读）──────────────────────────────────────────────────────────────
export function readRows(dbPath, { limit = 0, ids = [] } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    let rows;
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      rows = db.prepare(`SELECT id, text, tags, pinned, created_at, updated_at FROM memories WHERE id IN (${ph}) ORDER BY id`).all(...ids);
    } else {
      rows = db.prepare('SELECT id, text, tags, pinned, created_at, updated_at FROM memories ORDER BY id').all();
    }
    const count = Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n);
    if (limit > 0) rows = rows.slice(0, limit);
    return { rows, dbCount: count };
  } finally {
    db.close();
  }
}

/** 库指纹（sha256 + size + mtime）：用 ReadWrite 共享打开，绕开别的进程的独占句柄。 */
export function dbFingerprint(dbPath) {
  const st = fs.statSync(dbPath);
  const fd = fs.openSync(dbPath, 'r');
  const h = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(1 << 20);
  let n;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return { sha256: h.digest('hex'), bytes: st.size, mtime: st.mtime.toISOString() };
}

// ── 抽样导出（供人工标定）─────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function exportSamples(results, dir, perClass, seed = 20261026) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const cls of CLASSES) {
    const pool = results.filter((r) => r.cls === cls);
    // 抽检必须覆盖弱证据：先取 conf < 0.95 的（最多一半），再随机补足
    const weak = pool.filter((r) => r.conf < 0.95);
    const rnd = mulberry32(seed + CLASSES.indexOf(cls));
    const pickWeak = weak.slice(0, Math.min(weak.length, Math.ceil(perClass / 2)));
    const rest = pool.filter((r) => !pickWeak.includes(r));
    for (let i = rest.length - 1; i > 0; i -= 1) {          // 固定种子洗牌
      const j = Math.floor(rnd() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const chosen = [...pickWeak, ...rest].slice(0, perClass);
    const lines = [
      `# 抽检样本 · ${cls}（${CLASS_LABEL[cls]}） · ${chosen.length} 条`,
      '',
      `> 每类 ${perClass} 条；优先含 conf<0.95 的弱证据条目。判定：同意 / 不同意（不同意请写一句为什么）。`,
      '',
      '| # | id | 判为 | 置信 | 理由 | 正文前 120 字 |',
      '|---|---|---|---|---|---|',
    ];
    chosen.forEach((r, i) => {
      const head = String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 120).replace(/\|/g, '\\|');
      lines.push(`| ${i + 1} | ${r.id} | ${r.cls} | ${r.conf} | ${String(r.reason).replace(/\|/g, '\\|')} | ${head} |`);
    });
    const file = path.join(dir, `sample-${cls}.md`);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    written.push({ cls, file, n: chosen.length, pool: pool.length });
  }
  return written;
}

// ── 模型档（默认关 · 同闸 · 分批 ≤40 · 报 token）────────────────────────────
function buildModelPrompt(items) {
  const sys = [
    '你是记忆分类器。给每条记忆打一个主类，只输出 JSON 数组，不要解释。',
    '可选类（必须原样用英文键）：',
    'canon=口径/铁律（主人令、规矩、判据口径，永远该遵守）',
    'pitfall=活坑（还会再踩的报错/坑，带现象）',
    'device=设备/环境事实（哪台机、端口、路径、版本读数）',
    'pref=偏好/习惯（主人或助手的稳定偏好、叫法）',
    'progress=过程/进度（一次性任务进度、当时读数、未定型的计划）',
    'stale=疑似过时（被后文明确覆盖、已作废）',
    '输出格式：[{"id":123,"cls":"pitfall","reason":"一句话依据"}]',
  ].join('\n');
  const user = items.map((it) => `[${it.id}] ${String(it.text ?? '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
  return { sys, user };
}

async function callModel({ items, apiKey, baseUrl, model }) {
  const { sys, user } = buildModelPrompt(items);
  const body = {
    model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.1,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60000);
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status} ${String(await resp.text()).slice(0, 200)}` };
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content ?? '';
    let parsed;
    try {
      const m = content.match(/\[[\s\S]*\]/);
      parsed = JSON.parse(m ? m[0] : content);
    } catch { return { ok: false, error: `响应不是 JSON 数组：${String(content).slice(0, 120)}` }; }
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : null);
    if (!arr) return { ok: false, error: '响应里没有数组' };
    return { ok: true, items: arr, usage: json?.usage ?? null };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally { clearTimeout(timer); }
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const log = (...a) => console.log(...a);
  const asJson = Boolean(flags.json);

  if (flags.help) {
    log('用法见文件头注释；--dry-run 默认，--apply 写旁挂，--rollback 回滚，--sample 导样本，--model 开模型档（带闸）');
    return 0;
  }
  // 🔴 红线：不存在 gate override 这条路
  if (flags['gate-override'] !== undefined) {
    console.error('[拒绝] 本工具不支持 --gate-override（模型档必须过与 memory-distill 同一份成本闸）');
    return 2;
  }

  const dbPath = flags.db ? path.resolve(String(flags.db)) : defaultDbPath();
  const outFile = flags.out ? path.resolve(String(flags.out)) : DEFAULT_OUT;
  const stateFile = flags.state ? path.resolve(String(flags.state)) : defaultStatePath();
  if (!fs.existsSync(dbPath)) { console.error(`记忆库不存在：${dbPath}`); return 3; }
  const nowIso = new Date().toISOString();

  // ── 回滚分支 ───────────────────────────────────────────────────────────────
  if (flags.rollback) {
    const manifest = readJsonl(RUNS_MANIFEST);
    const rows = readJsonl(outFile);
    let targets;
    if (flags.since) {
      const since = String(flags.since);
      const until = flags.until ? String(flags.until) : null;
      targets = rows.filter((r) => String(r.at) >= since && (!until || String(r.at) <= until));
      log(`按时间区间回滚：${since} .. ${until ?? '(now)'}`);
    } else {
      const last = manifest[manifest.length - 1];
      if (!last) { log(`无回滚记录（${RUNS_MANIFEST} 为空）—— 零动作`); return 0; }
      targets = rows.filter((r) => String(r.at) === String(last.runAt));
      log(`按最后一次运行回滚：runAt=${last.runAt}（tool=${last.tool}）`);
    }
    const keep = rows.length - targets.length;
    if (!flags.apply) {
      log(`[DRY-RUN] 本工具将删除 ${targets.length} 行；保留 ${keep} 行（文件 ${outFile}，共 ${rows.length} 行）`);
      if (asJson) console.log(JSON.stringify({ mode: 'rollback-dry-run', deleteRows: targets.length, keepRows: keep, file: outFile }, null, 2));
      return 0;
    }
    writeJsonlAtomic(outFile, rows.filter((r) => !targets.includes(r)));
    log(`✓ 已删 ${targets.length} 行，保留 ${keep} 行 → ${outFile}`);
    return 0;
  }

  // ── --report：只读现状 ─────────────────────────────────────────────────────
  if (flags.report) {
    const rows = readJsonl(outFile);
    const { dbCount } = readRows(dbPath, { limit: 1 });
    const byCls = {};
    const byBy = { rule: 0, model: 0 };
    for (const r of rows) { byCls[r.cls] = (byCls[r.cls] ?? 0) + 1; byBy[r.by] = (byBy[r.by] ?? 0) + 1; }
    const uniq = new Set(rows.map((r) => r.id)).size;
    const rep = {
      file: outFile, rows: rows.length, uniqueIds: uniq, dbCount,
      coverage: dbCount ? Number((uniq / dbCount * 100).toFixed(2)) : 0,
      byCls, byBy, lowConf: rows.filter((r) => r.conf < 0.7).length,
      runs: readJsonl(RUNS_MANIFEST).length,
    };
    if (asJson) { console.log(JSON.stringify(rep, null, 2)); return 0; }
    log(`旁挂   : ${outFile}`);
    log(`库条数 : ${dbCount} · 旁挂覆盖 ${uniq} 条（${rep.coverage}%）· 行数 ${rows.length}`);
    log(`来源   : rule ${byBy.rule ?? 0} · model ${byBy.model ?? 0} · conf<0.7 ${rep.lowConf}`);
    log('分布   :');
    for (const c of CLASSES) log(`  ${c.padEnd(9)} ${String(byCls[c] ?? 0).padStart(5)}  ${CLASS_LABEL[c]}`);
    log(`运行记录: ${rep.runs} 次`);
    return 0;
  }

  // ── 分类主流程 ─────────────────────────────────────────────────────────────
  const limit = flagNum(flags.limit, 0);
  const ids = flags.ids ? String(flags.ids).split(',').map((s) => Number(s.trim())).filter(Number.isFinite) : [];
  const apply = Boolean(flags.apply);
  const fpBefore = dbFingerprint(dbPath);
  const { rows, dbCount } = readRows(dbPath, { limit, ids });

  // 幂等基线：同 id 同 srcHash 已有判定 ⇒ 不重判
  const existing = new Map();
  for (const r of readJsonl(outFile)) existing.set(String(r.id), r);
  const results = [];
  let skippedIdem = 0;
  const pending = [];
  for (const row of rows) {
    const h = sha16(row.text);
    const prev = existing.get(String(row.id));
    if (prev && String(prev.srcHash) === h) {
      // 幂等命中 ⇒ 不重判。**例外**：--model 下、上一轮是规则判且低置信 ⇒ 允许模型补判
      //（否则"幂等"会把模型档锁死：全量判过一遍后再想补判低置信条目永远无事可做）
      const needModel = Boolean(flags.model) && prev.by === 'rule' && Number(prev.conf) < CONF_NEED_MODEL;
      if (!needModel) {
        skippedIdem += 1;
        results.push({ id: row.id, cls: prev.cls, conf: prev.conf, reason: prev.reason, by: prev.by, text: row.text, srcHash: h, reused: true });
        continue;
      }
      const rec = { id: row.id, cls: prev.cls, conf: prev.conf, reason: prev.reason, by: 'rule', text: row.text, srcHash: h };
      results.push(rec);
      pending.push(rec);
      continue;
    }
    const v = classifyOne(row);
    const rec = { id: row.id, cls: v.cls, conf: v.conf, reason: v.reason, by: 'rule', text: row.text, srcHash: h };
    results.push(rec);
    if (v.conf < CONF_NEED_MODEL) pending.push(rec);
  }

  // 模型档
  let modelInfo = null;
  if (flags.model) {
    if (!pending.length) {
      log(`[model] 无低置信条目（conf<${CONF_NEED_MODEL}）⇒ 不调模型`);
      modelInfo = { batches: 0, calls: 0, tokens: 0, upgraded: 0 };
    } else {
      const [{ readState, writeState, costGate, COST_LIMITS, DEFAULT_LLM, localDateIso }, dt] = await Promise.all([
        import('./lib/distill.mjs'), import('./lib/domain-tags.mjs'),
      ]);
      const batchSize = Math.min(flagNum(flags.batch, GATE_BATCH_MAX), GATE_BATCH_MAX);
      if (flagNum(flags.batch, GATE_BATCH_MAX) > GATE_BATCH_MAX) log(`⚠️ --batch 上限 ${GATE_BATCH_MAX}（口径 §4），已截到 ${batchSize}`);
      const apiKey = process.env[DEFAULT_LLM.credentialKey] || dt.readCredential(DEFAULT_LLM.credentialKey);
      if (!apiKey) { console.error(`环境不可用：找不到 ${DEFAULT_LLM.credentialKey}`); return 6; }
      const state = readState(stateFile, dbPath, nowIso);
      const estimate = (items) => Math.ceil(items.reduce((n, it) => n + String(it.text).length, 0) / 1.5) + 400;
      const batches = Math.ceil(pending.length / batchSize);
      log(`[model] 待判 ${pending.length} 条 · ${batches} 批（每批 ≤${batchSize}）· 闸 ${stateFile}（当日 ${state.cost.calls}/${COST_LIMITS.callsPerDay} 次 · ${Number(state.cost.promptTokens) + Number(state.cost.completionTokens)}/${COST_LIMITS.tokensPerDay} token）`);
      let calls = 0; let tokens = 0; let upgraded = 0; let stopped = null;
      if (!apply) {
        log(`[model][DRY-RUN] 预演：将调 ${batches} 次 · 每批估算 ~${estimate(pending.slice(0, batchSize))} token ⇒ 合计 ~${estimate(pending)} token（未实际调用、未写 state）`);
        modelInfo = { batches, calls: 0, tokens: 0, upgraded: 0, dryRunEstimated: estimate(pending) };
      } else {
        for (let b = 0; b < batches; b += 1) {
          const slice = pending.slice(b * batchSize, (b + 1) * batchSize);
          const est = estimate(slice);
          const gate = costGate(state, est, COST_LIMITS);
          if (!gate.ok) { stopped = gate.reason; log(`[model][STOP] 成本闸：${gate.reason}（超限即停，不重试）`); break; }
          const resp = await callModel({ items: slice, apiKey, baseUrl: DEFAULT_LLM.baseUrl, model: DEFAULT_LLM.model });
          if (!resp.ok) { stopped = `模型调用失败（第 ${b + 1} 批）：${resp.error}`; log(`[model][STOP] ${stopped}`); break; }
          const pt = Number(resp.usage?.prompt_tokens ?? 0);
          const ct = Number(resp.usage?.completion_tokens ?? 0);
          state.cost.calls = Number(state.cost.calls ?? 0) + 1;
          state.cost.promptTokens = Number(state.cost.promptTokens ?? 0) + pt;
          state.cost.completionTokens = Number(state.cost.completionTokens ?? 0) + ct;
          state.cost.date = localDateIso(Date.now());
          writeState(stateFile, state);      // 每批落盘 ⇒ 可中断续跑
          calls += 1; tokens += pt + ct;
          const byId = new Map(slice.map((r) => [Number(r.id), r]));
          for (const it of resp.items ?? []) {
            const id = Number(it?.id);
            const rec = byId.get(id);
            const cls = String(it?.cls ?? '').trim();
            if (!rec || !CLASSES.includes(cls)) continue;
            rec.cls = cls;
            rec.conf = 0.75;
            rec.reason = `model:${String(it?.reason ?? '').slice(0, 60) || '低置信补判'}`;
            rec.by = 'model';
            upgraded += 1;
          }
          log(`  [model] 批 ${b + 1}/${batches}: ${slice.length} 条 · prompt ${pt} · completion ${ct} · 累计 ${tokens} token · 当日 ${state.cost.calls}/${COST_LIMITS.callsPerDay} 次`);
        }
      }
      modelInfo = { batches, calls, tokens, upgraded, stopped, stateFile };
    }
  }

  // 分布汇总
  const byCls = {}; const byBy = { rule: 0, model: 0 };
  for (const r of results) { byCls[r.cls] = (byCls[r.cls] ?? 0) + 1; byBy[r.by] = (byBy[r.by] ?? 0) + 1; }
  const newRows = results.filter((r) => !r.reused);

  // 样本导出
  let samples = null;
  if (flags.sample) {
    samples = exportSamples(results, path.resolve(String(flags.sample)), flagNum(flags['per-class'], 20));
  }

  // 写入（默认 dry-run）
  let written = 0;
  if (apply && newRows.length) {
    const runAt = nowIso;
    const lines = newRows.map((r) => JSON.stringify({ id: r.id, cls: r.cls, conf: r.conf, reason: r.reason, by: r.by, at: runAt, srcHash: r.srcHash }));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.appendFileSync(outFile, lines.join('\n') + '\n', 'utf8');
    fs.appendFileSync(RUNS_MANIFEST, JSON.stringify({
      runAt, tool: 'classify-memories.mjs', card: '记忆分类v1', rows: lines.length,
      dbCount, byRule: byBy.rule ?? 0, byModel: byBy.model ?? 0,
      model: Boolean(flags.model), tokens: modelInfo?.tokens ?? 0,
    }) + '\n', 'utf8');
    written = lines.length;
  }
  const fpAfter = dbFingerprint(dbPath);

  const summary = {
    mode: apply ? 'apply' : 'dry-run', at: nowIso, db: dbPath, out: outFile,
    dbCount, scanned: rows.length, skippedIdempotent: skippedIdem, judged: newRows.length,
    written, byCls, byBy, lowConf: results.filter((r) => r.conf < CONF_NEED_MODEL).length,
    model: modelInfo, samples,
    dbFingerprint: { before: fpBefore, after: fpAfter, unchanged: fpBefore.sha256 === fpAfter.sha256 && fpBefore.mtime === fpAfter.mtime },
  };

  if (asJson) { console.log(JSON.stringify({ ...summary, results: undefined }, null, 2)); return 0; }

  log(`库        : ${dbPath}（${dbCount} 条）`);
  log(`旁挂      : ${outFile}`);
  log(`模式      : ${apply ? 'apply' : 'dry-run（零写入）'}`);
  log(`扫描/判定 : ${rows.length} / ${newRows.length} 条（幂等跳过 ${skippedIdem}）`);
  log(`来源      : rule ${byBy.rule ?? 0} · model ${byBy.model ?? 0} · conf<${CONF_NEED_MODEL} ${summary.lowConf}`);
  log('分布      :');
  for (const c of CLASSES) {
    const n = byCls[c] ?? 0;
    log(`  ${c.padEnd(9)} ${String(n).padStart(5)}  ${((n / Math.max(1, results.length)) * 100).toFixed(1).padStart(5)}%  ${CLASS_LABEL[c]}`);
  }
  if (modelInfo) log(`模型档    : ${JSON.stringify(modelInfo)}`);
  if (samples) for (const s of samples) log(`  样本 ${s.cls.padEnd(9)} ${s.n} 条（池 ${s.pool}）→ ${s.file}`);
  log(`库指纹    : ${summary.dbFingerprint.unchanged ? '✓ 前后一致（未写库）' : '⚠️ 变了'} sha=${fpBefore.sha256.slice(0, 16)}… mtime ${fpBefore.mtime} → ${fpAfter.mtime}`);
  if (apply) log(`写入      : ${written} 行（新增；幂等不重写）`);
  else log(`[DRY-RUN] 未写旁挂；要写加 --apply`);
  return 0;
}

// main 守卫（junction 下 argv[1] 与 import.meta.url 可能一逻辑一物理 ⇒ 双方 realpath）
const isMain = (() => {
  try {
    const a = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    const b = fs.realpathSync(new URL(import.meta.url).pathname.replace(/^\//, ''));
    return a && b && path.resolve(a) === path.resolve(b);
  } catch { return false; }
})();
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((e) => { console.error(e); process.exitCode = 1; });
}
