// 离线层 —— policy 只读段源（把「判据落地处」编成可检索的段）
//
// 用途：候选池里那条坑「防复发措施到底落地没」原本只能人工翻文档。这里把落地处
//   （persona 铁律段 + 技能段 + 少数指定文档段）切成段，候选正文拿去比相似度，
//   产出「疑似已落地 / 确实是新根 / 中性待看」的**建议**。
//
// 边界（写死，别越）：只出建议，不改候选状态、不自动采纳、永不改 persona 或技能文件。
//
// 接口形状与记忆源 / 坑源保持一致（同步、清扫、召回都是按方法名直接调的）：
//   segment() / incrementalPage() 返回的每一行都必须带 id / text / updated_at 三个字段，
//   缺了不会报错，只会把 undefined 悄悄写进向量库。
//
// 段化口径：按 markdown 标题或 【…】 标记切段，每段 ≤400 字，超长段落再按句子切。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 每段硬上限（超长先按句切，单句还超长就硬截）
export const POLICY_MAX_CHARS = 400;

// 段身份锚里的分隔符：用 NUL，保证不会跟正文内容撞
const ANCHOR_SEP = '\u0000';

// 段文本哈希（sha256 hex，与增量同步的跳过判据同一套算法）
export const policyTextHash = (text) =>
  crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

// 段身份锚（16 位 hex，与坑库 id 同形）：只由「文件 + 段锚 + 分片号」决定，与正文无关。
// ⇒ 正文改了是同一条 ref_id 换 text_hash（增量重编码），不会留孤儿行。
export const policyRefId = (relPath, anchor, chunkIndex = 1) =>
  crypto.createHash('sha1').update([relPath, anchor, chunkIndex].join(ANCHOR_SEP), 'utf8').digest('hex').slice(0, 16);

// 路径归一：反斜杠转正斜杠 + 盘符小写（跨平台可复现；policy 库本机自用、不参与同步）
export const normalizeDocPath = (p) => {
  const slashed = String(p).replace(/\\/g, '/');
  if (slashed.length < 2 || slashed[1] !== ':') return slashed;
  return slashed[0].toLowerCase() + slashed.slice(1);
};

// ── persona 块标量抽取 ──────────────────────────────────────────────────────

// 块起始行：`prefix: |` / `persona: >-` 这类写法都认
const BLOCK_MARK = /^(\s*)(?:prefix|persona|text)\s*:\s*[|>][-+]?\s*$/;

const indentWidth = (line) => line.length - line.replace(/^[ \t]*/, '').length;

/**
 * 从 agent.cordis.yml 里抽出 persona 段（YAML 块标量的内容）。
 * 抽不到就返回整份文本 —— 宁可编粗一点，也不让整条链断在这。
 */
export const extractPersonaText = (yamlText) => {
  const source = String(yamlText ?? '');
  const lines = source.split(/\r?\n/);
  const at = lines.findIndex((line) => BLOCK_MARK.test(line));
  if (at < 0) return source;

  const markerIndent = indentWidth(lines[at]);
  const kept = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      kept.push('');
      continue;
    }
    if (indentWidth(line) <= markerIndent) break; // 缩进退回标记行 ⇒ 块结束
    kept.push(line);
  }

  // 去掉块标量的公共缩进（YAML 默认取首行缩进）
  const firstKept = kept.find((line) => line.trim());
  const base = firstKept ? indentWidth(firstKept) : 0;
  return kept.map((line) => (line.trim() ? line.slice(Math.min(base, line.length)) : '')).join('\n').trim();
};

// ── 切块 ────────────────────────────────────────────────────────────────────

// 按「行首标记」切块，返回 [{title, body}]；第一个标记之前的非空内容归到 (前言)
const splitBlocks = (text, markRe) => {
  const lines = String(text ?? '').split(/\r?\n/);
  const groups = [];
  let current = null;
  let loose = [];

  for (const line of lines) {
    if (markRe.test(line)) {
      if (current) groups.push(current);
      else if (loose.join('').trim()) groups.push({ title: '(前言)', body: loose });
      loose = [];
      current = { title: line.trim(), body: [line] };
      continue;
    }
    (current ? current.body : loose).push(line);
  }
  if (current) groups.push(current);
  else if (loose.join('').trim()) groups.push({ title: '(前言)', body: loose });

  return groups.map((group) => ({ title: group.title, body: group.body.join('\n').trim() }));
};

// 超长文本按句切（句末标点与换行都算断点）；单句仍超长就按上限硬截
const sliceLong = (text, maxChars) => {
  const whole = String(text ?? '').trim();
  if (!whole) return [];
  if (whole.length <= maxChars) return [whole];

  const sentences = whole.split(/(?<=[。！？；\n])/u).filter((piece) => piece.trim());
  const slices = [];
  let buffer = '';

  for (const sentence of sentences.length ? sentences : [whole]) {
    if (buffer && (buffer + sentence).length > maxChars) {
      slices.push(buffer.trim());
      buffer = '';
    }
    if (sentence.length > maxChars) {
      for (let at = 0; at < sentence.length; at += maxChars) slices.push(sentence.slice(at, at + maxChars).trim());
      continue;
    }
    buffer += sentence;
  }
  if (buffer.trim()) slices.push(buffer.trim());
  return slices.filter(Boolean);
};

// 块太大（超过上限 4 倍）且内部有空行分段 ⇒ 按空行先拆开，免得切出一串半句碎片
const splitOversized = (blocks, maxChars) => {
  const pieces = [];
  for (const block of blocks) {
    const base = block.title || '(无标题)';
    const body = String(block.body ?? '');
    if (body.length > maxChars * 4) {
      const paras = body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
      if (paras.length > 1) {
        paras.forEach((para, i) => pieces.push({ base, sub: i + 1, body: para }));
        continue;
      }
    }
    pieces.push({ base, sub: 0, body });
  }
  return pieces;
};

// 段展示名：`<标题>`；前言块后面补首行摘要，段内换行折成空格，让 docPath#section 可读
const sectionLabel = (piece) => {
  const firstLine = piece.body.trim().split('\n')[0];
  const head = firstLine.slice(0, 40).replace(/\s+/g, ' ').trim();
  return piece.base.startsWith('(') ? `${piece.base} ${head}` : piece.base;
};

// persona 段：行首 【…】 与列表式 `- 【…】` 都算新段起点（协作偏好写成列表，只认行首 【 会切不动）
const PERSONA_MARK = /^\s*-?\s*【[^】]*】.*$/u;
const HEADING_MARK = /^#{2,3}\s+.*$/u;

/** 单份文本 → 段清单（顺序稳定：文件出现序；同名小节用 #N 区分） */
export const segmentText = (text, { kind = 'markdown', maxChars = POLICY_MAX_CHARS } = {}) => {
  const markRe = kind === 'persona' ? PERSONA_MARK : HEADING_MARK;
  const pieces = splitOversized(splitBlocks(text, markRe), maxChars);
  const occurrences = new Map();
  const segments = [];

  for (const piece of pieces) {
    const nth = (occurrences.get(piece.base) ?? 0) + 1;
    occurrences.set(piece.base, nth);
    const anchor = piece.sub ? `${piece.base}#${nth}.${piece.sub}` : `${piece.base}#${nth}`;
    const slices = sliceLong(piece.body, maxChars);
    const label = sectionLabel(piece);
    slices.forEach((chunk, i) => {
      segments.push({
        anchor,
        section: slices.length > 1 ? `${label} (part ${i + 1})` : label,
        chunkIndex: i + 1,
        text: chunk,
      });
    });
  }
  return segments;
};

// ── 文件遍历与扫描 ──────────────────────────────────────────────────────────

// 递归收文件（跳过隐藏目录与 node_modules；ext 为空表示不过滤后缀）
const collectFiles = (dir, { ext = null, out = [], maxFiles = 2000 } = {}) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录读不动就跳过，不阻断整条链
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (out.length >= maxFiles) break;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, { ext, out, maxFiles });
    else if (!ext || entry.name.toLowerCase().endsWith(ext)) out.push(full);
  }
  return out;
};

// ① persona 铁律段：显式给的文件优先，否则扫目录里的 agent.cordis.yml
const personaEntries = ({ personaPaths, personaDir, maxFiles }) => {
  if (Array.isArray(personaPaths) && personaPaths.length) {
    return personaPaths.map((p) => ({ file: path.resolve(String(p)), kind: 'persona' }));
  }
  if (!personaDir || !fs.existsSync(personaDir)) return [];
  return collectFiles(personaDir, { ext: '.yml', maxFiles })
    .filter((file) => path.basename(file).toLowerCase() === 'agent.cordis.yml')
    .map((file) => ({ file, kind: 'persona' }));
};

// ② 技能段：每个技能的 SKILL.md，按 ## 小节切
const skillEntries = ({ skillsRoot, maxFiles }) => {
  if (!skillsRoot || !fs.existsSync(skillsRoot)) return [];
  return collectFiles(skillsRoot, { ext: null, maxFiles })
    .filter((file) => path.basename(file).toLowerCase() === 'skill.md')
    .map((file) => ({ file, kind: 'markdown' }));
};

// ③ 文档段：只收点名的少数几篇（不做全量 docs —— 那是文档索引的活）
const docEntries = ({ docsPaths, maxFiles }) => {
  const picked = [];
  for (const item of Array.isArray(docsPaths) ? docsPaths : []) {
    if (!item) continue;
    const resolved = path.resolve(String(item));
    if (!fs.existsSync(resolved)) continue;
    if (fs.statSync(resolved).isDirectory()) {
      for (const file of collectFiles(resolved, { ext: '.md', maxFiles })) picked.push({ file, kind: 'markdown' });
    } else {
      picked.push({ file: resolved, kind: 'markdown' });
    }
  }
  return picked;
};

/**
 * 扫描 policy 语料 ⇒ 段清单（只读、零写入）。
 * @returns {Array<{refId:string, docPath:string, relPath:string, section:string, text:string, mtime:number, textHash:string}>}
 */
export const scanPolicySources = ({
  personaPaths = null,
  personaDir = null,
  skillsRoot = null,
  docsPaths = null,
  maxChars = POLICY_MAX_CHARS,
  maxFiles = 2000,
} = {}) => {
  const files = [
    ...personaEntries({ personaPaths, personaDir, maxFiles }),
    ...skillEntries({ skillsRoot, maxFiles }),
    ...docEntries({ docsPaths, maxFiles }),
  ];

  const segments = [];
  for (const { file, kind } of files) {
    let raw;
    let mtime = 0;
    try {
      raw = fs.readFileSync(file, 'utf8');
      mtime = Math.round(fs.statSync(file).mtimeMs);
    } catch {
      continue; // 读不到就跳过 —— 一份文件坏掉不该拖死整条链
    }

    const text = kind === 'persona' ? extractPersonaText(raw) : raw;
    if (!String(text).trim()) continue;

    const relPath = normalizeDocPath(file);
    for (const seg of segmentText(text, { kind, maxChars })) {
      segments.push({
        refId: policyRefId(relPath, seg.anchor, seg.chunkIndex),
        docPath: relPath,
        relPath,
        section: seg.section,
        text: seg.text,
        mtime,
        textHash: policyTextHash(seg.text),
      });
    }
  }

  // 稳定排序：文件名（字典序）× 文件内出现序 —— 增量游标依赖这个顺序
  segments.sort(
    (a, b) =>
      (a.docPath < b.docPath ? -1 : a.docPath > b.docPath ? 1 : 0) ||
      a.mtime - b.mtime ||
      (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0),
  );
  return segments;
};

// 游标键：updated_at 左补零后拼 id，字符串比较即等价于 (时间, id) 的字典序
const cursorOf = (updatedAt, id) => `${String(updatedAt).padStart(16, '0')}|${id}`;

/**
 * 把段清单包成与记忆源同形状的只读数据源（同步 / 清扫 / 召回按方法名直接消费）。
 * @param {{segments?:Array, dbPath?:string}} [p]
 */
export const openPolicySource = ({ segments = [], dbPath = null } = {}) => {
  const rows = segments
    .map((seg) => ({
      id: String(seg.refId),
      text: seg.text,
      tags: seg.section || '',
      pinned: 0,
      updated_at: Number(seg.mtime) || 0,
      docPath: seg.docPath,
      section: seg.section,
      textHash: seg.textHash,
    }))
    .sort((a, b) => a.updated_at - b.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const byId = new Map(rows.map((row) => [row.id, row]));
  let shut = false;

  return {
    dbPath: dbPath || '(scanned:policy)',
    readOnly: true,
    sourceName: 'policy',
    n: rows.length,
    // 原始段对象（分诊侧要 docPath / section 做「出处可追溯」）
    segments,

    count: () => rows.length,

    maxUpdatedAt: () => {
      let high = 0;
      for (const row of rows) if (row.updated_at > high) high = row.updated_at;
      return high;
    },

    idRange: () => (rows.length ? { lo: 0, hi: rows.length - 1, n: rows.length } : { lo: null, hi: null, n: 0 }),

    pinnedIds: () => [],

    // 增量页：先按 since 过滤，再按游标（时间, id）往后取，最多 lim 条
    incrementalPage: (sinceTs, afterId, limit) => {
      const since = Number(sinceTs) || 0;
      const lim = Number(limit) || 0;
      if (!rows.length || lim <= 0) return [];

      const cursorId = afterId == null || afterId === '' ? null : String(afterId);
      let floor = '';
      if (cursorId != null) {
        const anchorRow = byId.get(cursorId);
        floor = anchorRow ? cursorOf(anchorRow.updated_at, anchorRow.id) : cursorOf(0, cursorId);
      }

      const page = [];
      for (const row of rows) {
        if (row.updated_at < since) continue;
        if (floor && cursorOf(row.updated_at, row.id) <= floor) continue;
        page.push({ ...row });
        if (page.length >= lim) break;
      }
      return page;
    },

    // 按序号取一段（含 lo、hi 两端）
    segment: (lo, hi) => {
      const from = Number(lo);
      const to = Number(hi);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
      return rows.slice(Math.max(0, from), Math.max(0, to) + 1).map((row) => ({ ...row }));
    },

    getById: (id) => {
      const row = byId.get(String(id));
      return row ? { ...row } : null;
    },

    allTexts: () => rows.map((row) => ({ id: row.id, text: row.text })),

    allTags: () => rows.map((row) => ({ id: row.id, tags: row.tags })),

    // 段源没有 FTS5：必须回对象（召回侧期望对象；回数组才会被当成「有补位路」）
    ftsSearch: () => ({ error: 'policy 段源无 FTS5（policy source 无 FTS 补位路）' }),

    close: () => {
      shut = true;
    },

    get closed() {
      return shut;
    },
  };
};

// 便捷口：扫描 + 打包一步到位
export const openPolicySourceFromDisk = (opts = {}) =>
  openPolicySource({ segments: scanPolicySources(opts), dbPath: opts.dbPath || null });
