// 记忆引擎 v2 · 离线层 —— **policy 只读数据源**（方案 §4 B 点 · 落地判据向量化）
//
// 为什么需要它：候选池里「这条坑的防复发措施到底落地没有」原来靠**一次性人工核对** 59 条
//   （`docs\坑库\P4候选分类与落地核对-20260920.md`）。B 点把「落地处」编成 `source='policy'`
//   的向量库（persona 铁律段 + 技能段 + 值得当判据的文档段），用候选的 `normText` 去查相似度
//   ⇒ 自动产出「疑似已落地 / 确属新根 / 中性（需人看）」的**建议**。
//
// 铁的边界（方案 §4 B.1 写死，本文件照此实现）：
//   **向量判据只产出建议，不自动改候选池 status、不自动采纳、永不自动改 persona/技能。**
//
// 接口契约：与 `memory-source.mjs` / `pitfall-source.mjs` **同形状**（sync/sweep/recall 按方法名硬调用）。
//   ⚠️ `segment()` / `incrementalPage()` 返回行**必须含 `id / text / updated_at`**
//      （`sweep.mjs:77` 读 `.text`、`:110` 取 `.updated_at`；缺了不报错，只会把 undefined 写进向量）。
//
// 段化规则（方案 §4 B.2 第 1 行）：按 markdown 标题 / 【…】 标记切段，**每段 ≤400 字**，超长段落再按句切。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 每段硬切上限（方案 §4 B.2：「每段 ≤400 字，超长段落再按句切」） */
export const POLICY_MAX_CHARS = 400;
/** 段文本哈希（与 `hashes.mjs#textHash` 同算法：sha256 hex ⇒ 增量同步的跳过判据可复用） */
export function policyTextHash(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}
/** 段身份锚（16 位 hex，与坑库 id 同形）：**只由「文件 + 段锚 + 分片号」决定**，与正文无关
 *  ⇒ 正文改了是**同一条 ref_id 换 text_hash**（增量重编码），不会产生孤儿行。 */
export function policyRefId(relPath, anchor, chunkIndex = 1) {
  return crypto
    .createHash('sha1')
    .update(`${relPath}\u0000${anchor}\u0000${chunkIndex}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/** 路径统一为「正斜杠 + 小写盘符」的逻辑形式（跨机/跨平台可复现；policy 库不同步，本机自用） */
export function normalizeDocPath(p) {
  const s = String(p).replace(/\\/g, '/');
  return s.length > 1 && s[1] === ':' ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * 从 `agent.cordis.yml` 里抽出 persona 段（YAML 块标量 `prefix: |` / `|-` / `>` 的内容）。
 * 抽不到 ⇒ 返回整份文件文本（**不抛错**：宁可编粗一点，也不要让整条 policy 链断在这里）。
 */
export function extractPersonaText(yamlText) {
  const lines = String(yamlText ?? '').split(/\r?\n/);
  let start = -1;
  let markerIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)(?:prefix|persona|text)\s*:\s*[|>][-+]?\s*$/);
    if (m) {
      start = i + 1;
      markerIndent = m[1].length;
      break;
    }
  }
  if (start < 0) return String(yamlText ?? '');
  const body = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      body.push('');
      continue;
    }
    const indent = line.length - line.replace(/^[ \t]*/, '').length;
    if (indent <= markerIndent) break; // 块结束
    body.push(line);
  }
  // 去掉块标量的公共缩进（YAML 默认 = 首行缩进）
  const firstNonEmpty = body.find((l) => l.trim());
  const base = firstNonEmpty ? firstNonEmpty.length - firstNonEmpty.replace(/^[ \t]*/, '').length : 0;
  return body.map((l) => (l.trim() ? l.slice(Math.min(base, l.length)) : '')).join('\n').trim();
}

/** 按「行首标记」切块：标记 = 正则；返回 [{ title, body }] */
function splitByLineMarker(text, markerRe) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let cur = null;
  let preamble = [];
  for (const line of lines) {
    const m = line.match(markerRe);
    if (m) {
      if (cur) blocks.push(cur);
      else if (preamble.join('').trim()) blocks.push({ title: '(前言)', body: preamble.join('\n').trim() });
      preamble = [];
      cur = { title: m[0].trim(), body: [line] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (cur) blocks.push(cur);
  else if (preamble.join('').trim()) blocks.push({ title: '(前言)', body: preamble.join('\n').trim() });
  return blocks.map((b) => ({ title: b.title, body: Array.isArray(b.body) ? b.body.join('\n').trim() : String(b.body).trim() }));
}

/** 超长段按句切（句末标点 + 换行），仍超长则硬切 */
function chunkText(text, maxChars) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  if (s.length <= maxChars) return [s];
  const parts = s.split(/(?<=[。！？；\n])/u).filter((x) => x.trim());
  const out = [];
  let buf = '';
  for (const p of parts.length ? parts : [s]) {
    if ((buf + p).length > maxChars && buf) {
      out.push(buf.trim());
      buf = '';
    }
    if (p.length > maxChars) {
      if (buf) {
        out.push(buf.trim());
        buf = '';
      }
      for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars).trim());
    } else {
      buf += p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/** 单份文本 → 段（按 kind 选切法）。返回 [{ anchor, section, chunkIndex, text }]（顺序稳定：文件出现序） */
export function segmentText(text, { kind = 'markdown', maxChars = POLICY_MAX_CHARS } = {}) {
  // persona 段：**行首 【…】 或 `- 【…】` 都算新段起点**。
  //   为什么必须带 `- ` 前缀这一支：persona 的协作偏好是「列表式」的
  //   （每条写作 `- 【规矩名】…`）—— 只认行首 `【` 会把整节当一块、再硬切成几十个无意义碎片
  //   （实测粗切 = 12 个"小节"、124 段；细切后与方案 §B.5 的 123 个标记口径对齐）。
  const markerRe = kind === 'persona' ? /^\s*-?\s*【[^】]*】.*$/u : /^#{2,3}\s+.*$/u;
  const blocks = splitByLineMarker(text, markerRe);

  // 无标记大块（例：另一个 preset 的 persona 完全没有 【】）先按**空行段**拆，
  // 再对仍超长的段落做句级硬切 —— 避免把一整份 19 KB 文本切成一串半句碎片。
  const pre = [];
  for (const b of blocks) {
    const title = b.title || '(无标题)';
    const body = String(b.body ?? '');
    if (body.length > maxChars * 4) {
      const paras = body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
      if (paras.length > 1) {
        paras.forEach((p, i) => pre.push({ base: title, sub: i + 1, body: p }));
        continue;
      }
    }
    pre.push({ base: title, sub: 0, body });
  }

  const seen = new Map();
  const out = [];
  for (const b of pre) {
    const k = (seen.get(b.base) ?? 0) + 1;
    seen.set(b.base, k);
    const anchor = b.sub ? `${b.base}#${k}.${b.sub}` : `${b.base}#${k}`;
    const chunks = chunkText(b.body, maxChars);
    chunks.forEach((c, i) => {
      // 段展示名：`<标题>` / `<标题> (part k)`；段内换行折成 ' · '，让 `docPath#section` 可读
      const head = b.body.trim().split('\n')[0].slice(0, 40).replace(/\s+/g, ' ').trim();
      const label = b.base.startsWith('(') ? `${b.base} ${head}` : b.base;
      out.push({
        anchor,
        section: chunks.length > 1 ? `${label} (part ${i + 1})` : label,
        chunkIndex: i + 1,
        text: c,
      });
    });
  }
  return out;
}

/** 递归收集文件（跳过 node_modules / 隐藏目录；只取指定后缀） */
function walkFiles(dir, { ext = null, out = [], maxFiles = 2000 } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (out.length >= maxFiles) break;
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, { ext, out, maxFiles });
    else if (!ext || e.name.toLowerCase().endsWith(ext)) out.push(full);
  }
  return out;
}

/**
 * 扫描 policy 语料 ⇒ 段清单（只读，零写入）。
 *
 * 语料三份（方案 §4 B.3-1，**按判据强度排序**；MVP 只做前两份，第三份默认空）：
 *   ① persona 铁律段：`.agent-presets\**\agent.cordis.yml` 的 persona 文本 → 按 `【…】` 切
 *   ② 技能段：`skills\*\SKILL.md` → 按 `##` 小节切
 *   ③ 文档段（可选/后置）：`docsRoots` 里被点名的少数几篇 —— **不做全量 docs**（那是 doc-index 的活）
 *
 * @param {object} p
 * @param {string[]} [p.personaPaths] 显式 persona 文件（缺省 = 扫 personaDir 下的 agent.cordis.yml）
 * @param {string} [p.personaDir]
 * @param {string} [p.skillsRoot]
 * @param {string[]} [p.docsPaths]
 * @param {number} [p.maxChars]
 * @returns {Array<{refId:string, docPath:string, relPath:string, section:string, text:string, mtime:number, textHash:string}>}
 */
export function scanPolicySources({
  personaPaths = null,
  personaDir = null,
  skillsRoot = null,
  docsPaths = null,
  maxChars = POLICY_MAX_CHARS,
  maxFiles = 2000,
} = {}) {
  const files = [];
  if (Array.isArray(personaPaths) && personaPaths.length) {
    for (const p of personaPaths) files.push({ file: path.resolve(String(p)), kind: 'persona' });
  } else if (personaDir && fs.existsSync(personaDir)) {
    for (const f of walkFiles(personaDir, { ext: '.yml', maxFiles })) {
      if (path.basename(f).toLowerCase() === 'agent.cordis.yml') files.push({ file: f, kind: 'persona' });
    }
  }
  if (skillsRoot && fs.existsSync(skillsRoot)) {
    for (const f of walkFiles(skillsRoot, { ext: null, maxFiles })) {
      if (path.basename(f).toLowerCase() === 'skill.md') files.push({ file: f, kind: 'markdown' });
    }
  }
  for (const d of Array.isArray(docsPaths) ? docsPaths : []) {
    if (!d) continue;
    const resolved = path.resolve(String(d));
    if (!fs.existsSync(resolved)) continue;
    if (fs.statSync(resolved).isDirectory()) {
      for (const f of walkFiles(resolved, { ext: '.md', maxFiles })) files.push({ file: f, kind: 'markdown' });
    } else {
      files.push({ file: resolved, kind: 'markdown' });
    }
  }

  const segments = [];
  for (const { file, kind } of files) {
    let raw;
    let mtime = 0;
    try {
      raw = fs.readFileSync(file, 'utf8');
      mtime = Math.round(fs.statSync(file).mtimeMs);
    } catch {
      continue; // 读不到就跳过（不阻断整条链）
    }
    const relPath = normalizeDocPath(file);
    const text = kind === 'persona' ? extractPersonaText(raw) : raw;
    if (!String(text).trim()) continue;
    for (const seg of segmentText(text, { kind, maxChars })) {
      segments.push({
        refId: policyRefId(relPath, seg.anchor, seg.chunkIndex),
        docPath: normalizeDocPath(file),
        relPath,
        section: seg.section,
        text: seg.text,
        mtime,
        textHash: policyTextHash(seg.text),
      });
    }
  }
  // 稳定排序（段序 = 文件名字典序 × 文件内出现序；refId 单调游标依赖它）
  segments.sort((a, b) => (a.docPath < b.docPath ? -1 : a.docPath > b.docPath ? 1 : 0)
    || (a.mtime - b.mtime)
    || (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0));
  return segments;
}

function cursorKey(updatedAt, id) {
  return `${String(updatedAt).padStart(16, '0')}|${id}`;
}

/**
 * 把段清单包成**与 memory-source 同形状**的只读数据源（供 `sync --source policy` / `sweep` / `recall` 直接消费）。
 * @param {{segments:Array, dbPath?:string}} p
 */
export function openPolicySource({ segments = [], dbPath = null } = {}) {
  const rows = segments
    .map((s) => ({
      id: String(s.refId),
      text: s.text,
      tags: s.section || '',
      pinned: 0,
      updated_at: Number(s.mtime) || 0,
      docPath: s.docPath,
      section: s.section,
      textHash: s.textHash,
    }))
    .sort((a, b) => a.updated_at - b.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byId = new Map(rows.map((r) => [r.id, r]));
  let closed = false;

  return {
    dbPath: dbPath || '(scanned:policy)',
    readOnly: true,
    sourceName: 'policy',
    n: rows.length,
    /** 原始段对象（triage 侧要 docPath/section 做「出处可追溯」） */
    segments,

    count() {
      return rows.length;
    },
    maxUpdatedAt() {
      let m = 0;
      for (const r of rows) if (r.updated_at > m) m = r.updated_at;
      return m;
    },
    idRange() {
      if (!rows.length) return { lo: null, hi: null, n: 0 };
      return { lo: 0, hi: rows.length - 1, n: rows.length };
    },
    pinnedIds() {
      return [];
    },
    incrementalPage(sinceTs, afterId, limit) {
      const since = Number(sinceTs) || 0;
      const lim = Number(limit) || 0;
      if (!rows.length || lim <= 0) return [];
      const cur = afterId == null || afterId === '' ? null : String(afterId);
      let floor = '';
      if (cur != null) {
        const hit = byId.get(cur);
        floor = hit ? cursorKey(hit.updated_at, hit.id) : cursorKey(0, cur);
      }
      const out = [];
      for (const r of rows) {
        if (r.updated_at < since) continue;
        if (floor && cursorKey(r.updated_at, r.id) <= floor) continue;
        out.push({ ...r });
        if (out.length >= lim) break;
      }
      return out;
    },
    segment(lo, hi) {
      const a = Number(lo);
      const b = Number(hi);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
      return rows.slice(Math.max(0, a), Math.max(0, b) + 1).map((r) => ({ ...r }));
    },
    getById(id) {
      const r = byId.get(String(id));
      return r ? { ...r } : null;
    },
    allTexts() {
      return rows.map((r) => ({ id: r.id, text: r.text }));
    },
    allTags() {
      return rows.map((r) => ({ id: r.id, tags: r.tags }));
    },
    /** policy 段无 FTS5 ⇒ 必须返回对象（`recall.mjs:167` 期望对象；返回数组才会走补位路） */
    ftsSearch() {
      return { error: 'policy 段源无 FTS5（policy source 无 FTS 补位路）' };
    },
    close() {
      if (closed) return;
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}

/** 便捷：扫描 + 打包一步到位 */
export function openPolicySourceFromDisk(opts = {}) {
  return openPolicySource({ segments: scanPolicySources(opts), dbPath: opts.dbPath || null });
}
