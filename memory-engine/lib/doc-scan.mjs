// 记忆引擎 v2 · 离线层 —— 文档扫描面 + 结构解析 + 粒度切分（方案 §3.2）
//
// 口径（逐条照方案，勿自行发挥）：
//   · 扫描面 = `<docsRoot>/**/*.md`（默认 `<cwd>/docs`）
//   · **排除** = `变更流水/`、`管家报告/`、`坑库/`、`_archive`（流水类噪音大且频繁变更）
//   · `path` 列 = **相对 `dshRoot` 的路径**
//   · 粒度：短文档（<2 万字）1 条；长文档按 `##` 小节聚合 **2~5 条**；长文档多条以 `path#§N` 作主键
import fs from 'node:fs';
import path from 'node:path';

/** docs 根（可注入；不写死机器名，方案 §4 宿主迁移契约）。 */
export const DEFAULT_DOCS_ROOT = path.join(process.cwd(), 'docs');
/** `path` 列的前缀锚（默认 = 当前工作目录）。 */
export const DEFAULT_DSH_ROOT = process.cwd();

/** 排除目录名（按路径"目录段"匹配，不按子串——否则 `_archive` 会误伤文件名）。 */
export const EXCLUDE_DIRS = ['变更流水', '管家报告', '坑库', '_archive'];

/** 长/短文档分界（方案 §3.2：短文档 < 2 万字 1 条）。 */
export const LONG_DOC_CHARS = 20000;
/** 长文档分条数区间（方案 §3.2：2~5 条）。 */
export const MIN_LONG_ROWS = 2;
export const MAX_LONG_ROWS = 5;
/** 每条摘要上限（方案 §3.2：≤500 字）。 */
export const SUMMARY_MAX_CHARS = 500;

/**
 * 首期 10 篇「最常用文档」——判据出处：`docs\文档总索引.md` §一「最常用的 15 份」**人工段**，
 * 取该表前 10 条（1→10，顺序即优先级）。**不是随手挑的**：这一节由主人与本鱼共同维护，
 * 是新会话的高频入口清单；首期先索引这 10 篇试水（方案 §3.2「中间态」+ §10 T2 全量触发器）。
 * ⚠️ 全量 270+ 篇**不在本卡范围**（属 §10 T2 触发器事项，需主人拍）。
 */
export const FIRST_BATCH = [
  'docs/主人使用手册.md',
  'docs/DSH目录规范.md',
  'docs/开发顺序统筹-20260914.md',
  'docs/大管家-主人视角-一页纸-20260913.md',
  'docs/大管家-开关矩阵与放行判据-20260913.md',
  'docs/插件升级决策表.md',
  'docs/插件魔改维护清单.md',
  'docs/升级方案-2026-09-10.md',
  'docs/自愈与回滚-验收缺口与整改方案-20260911.md',
  'docs/gitee备份使用说明.md',
];

/** 首期清单的判据出处（写进 state 与交付报告，避免"这 10 篇哪来的"无处可查）。 */
export const FIRST_BATCH_SOURCE = 'docs/文档总索引.md §一「最常用的 15 份」（人工段）前 10 条';

/** 统一 `/` 分隔（Windows 反斜杠一律归一；`path` 列口径）。 */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** 相对 `dshRoot` 的 path 口径（扫描面在 docs 下 ⇒ 结果以 `docs/` 开头）。 */
export function toRelPath(absPath, dshRoot = DEFAULT_DSH_ROOT) {
  return toPosix(path.relative(dshRoot, absPath));
}

/** 是否落在排除面内（只看**目录段**；顶层文件永不被排除）。 */
export function isExcludedRel(relPath) {
  const parts = toPosix(relPath).split('/');
  const dirs = parts.slice(0, -1); // 去掉文件名
  return dirs.some((d) => EXCLUDE_DIRS.includes(d));
}

/**
 * 递归扫描扫描面（只读；不做 mtime 过滤——过滤交给差分逻辑）。
 * @param {string} docsRoot
 * @param {{dshRoot?:string, maxFiles?:number}} [opts]
 * @returns {Array<{rel:string, abs:string, mtime:number, size:number}>}
 */
export function scanDocs(docsRoot = DEFAULT_DOCS_ROOT, opts = {}) {
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT;
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不可读 → 跳过（fail-open，不打断别的扫描）
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.includes(e.name)) continue; // 目录整棵排除
        walk(abs);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        const rel = toRelPath(abs, dshRoot);
        if (isExcludedRel(rel)) continue;
        out.push({ rel, abs, mtime: Math.trunc(st.mtimeMs), size: st.size });
      }
    }
  };
  walk(docsRoot);
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return opts.maxFiles ? out.slice(0, opts.maxFiles) : out;
}

/** 读文档并算字符数（用于粒度判定与摘要生成）。 */
export function readDoc(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  return { text, chars: text.length };
}

// ---------------------------------------------------------------- 结构解析

/** 去掉 markdown 内联标记（摘要里不要出现 `**`/反引号/链接语法）。 */
export function stripMd(s) {
  return String(s)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*_](\S[^*_]*)[*_]/g, '$1$2')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取首句（中文句读 + 英文句点；上限 maxChars 字，超长按字截断）。
 *  ⚠️ 刻意**不含分号**：中文文档里分号常切出"主人 = 用户"这种半截短语，反而没信息量。 */
export function firstSentence(text, maxChars = 80) {
  const t = stripMd(text);
  if (!t) return '';
  const m = /^(.{4,}?[。！？!?]|.{4,}?\.\s|.{4,})/.exec(t);
  let s = (m ? m[1] : t).trim();
  s = s.replace(/[。！？!?]\s*$/, '').trim();
  if (s.length > maxChars) s = `${s.slice(0, maxChars - 1)}…`;
  return s;
}

/** 引言/章节的头几行里，这类"模板头 / 元信息"不算正文（否则每篇索引条都长一个样）。 */
const META_LINE_RE = /^(?:\s*[>|])|^(?:维护人|创建|最近更新|最后更新|最后修订|更新时间|文件位置|路径口径|版本)\s*[:：]/;

/**
 * 取一节的正文首段（**跳过引用块 / 表格 / 标题 / 代码块**，去掉列表符号）。
 * 为什么需要它：文档头部普遍是 `> ↑本主题总纲见 …` 这类模板引用块，
 * 直接取首句会让所有索引条的"说明"完全雷同（实测），对召回毫无区分度。
 */
export function pickParagraph(body, maxChars = 400) {
  const buf = [];
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) {
      if (buf.length) break; // 段落结束
      continue;
    }
    if (/^```/.test(l)) break;
    if (/^#{1,6}\s/.test(l)) continue;
    if (/^[-*_]{3,}$/.test(l)) continue; // 分隔线（--- / *** / ___）不是正文
    if (META_LINE_RE.test(l) && !buf.length) continue; // 元信息/引用块：跳过继续找真正文
    if (/^[>|]/.test(l)) continue;
    if (/^[-*+]\s/.test(l)) {
      if (buf.length) break;
      buf.push(l.replace(/^[-*+]\s+/, ''));
    } else {
      buf.push(l);
    }
    if (buf.join(' ').length > maxChars) break;
  }
  return buf.join(' ').trim();
}

/** 章节标题瘦身（摘要里每节只留辨识度最高的前 28 字）。 */
export function shortTitle(t, maxChars = 28) {
  const s = stripMd(t);
  return s.length > maxChars ? `${s.slice(0, maxChars - 1)}…` : s;
}

/**
 * 解析 markdown 结构：`#` 标题、引言段、`##` 小节（含其下三级及正文）。
 * 只认 `##`（方案 §3.2「按 `##` 小节聚合」）；`###` 归入所属 `##`。
 * @returns {{title:string, intro:string, sections:Array<{title:string,chars:number,body:string}>}}
 */
export function parseStructure(text) {
  const lines = String(text).split(/\r?\n/);
  let title = '';
  let introStart = 0;
  let i = 0;
  // 首个 H1 = 文档标题
  for (; i < lines.length; i += 1) {
    const m = /^#\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      title = stripMd(m[1]);
      introStart = i + 1;
      break;
    }
  }
  if (!title) {
    // 无 H1：用第一行非空文本兜底（摘要头不至于空）
    const firstLine = lines.find((l) => l.trim());
    title = firstSentence(firstLine || '', 60);
    introStart = 0;
  }
  const sections = [];
  let introLines = [];
  let cur = null;
  for (let j = introStart; j < lines.length; j += 1) {
    const line = lines[j];
    const m2 = /^##\s+(.+?)\s*$/.exec(line);
    if (m2) {
      if (cur) sections.push(cur);
      cur = { title: stripMd(m2[1]), body: [] };
      continue;
    }
    if (cur) cur.body.push(line);
    else introLines.push(line);
  }
  if (cur) sections.push(cur);
  const normalized = sections.map((s) => {
    const body = s.body.join('\n').trim();
    return { title: s.title, chars: s.title.length + body.length, body };
  });
  return { title, intro: introLines.join('\n').trim(), sections: normalized };
}

/** 目标分条数：2 万字内 1 条；超出按字符规模升到 2~5 条，且不超过 `##` 小节数。 */
export function planRowCount(chars, sectionCount) {
  if (chars < LONG_DOC_CHARS) return 1;
  const bySize = Math.round(chars / LONG_DOC_CHARS) + 1;
  const target = Math.max(MIN_LONG_ROWS, Math.min(MAX_LONG_ROWS, bySize));
  if (sectionCount < MIN_LONG_ROWS) return 1; // 没有可聚合的小节 ⇒ 只能 1 条
  return Math.min(target, sectionCount);
}

/** 按 section **个数**均分（确定性、可复现；组数恰为 k）。 */
export function splitSections(sections, k) {
  const n = sections.length;
  if (k <= 1 || n <= 1) return [sections];
  const base = Math.floor(n / k);
  const rem = n % k;
  const groups = [];
  let idx = 0;
  for (let g = 0; g < k; g += 1) {
    const take = base + (g < rem ? 1 : 0);
    if (take === 0) continue;
    groups.push(sections.slice(idx, idx + take));
    idx += take;
  }
  if (idx < n) groups[groups.length - 1] = groups[groups.length - 1].concat(sections.slice(idx));
  return groups;
}

/**
 * 把一篇文档切成索引条计划。
 * @param {{rel:string, chars:number, structure:ReturnType<typeof parseStructure>}} doc
 * @returns {Array<{key:string, index:number, total:number, sections:Array, intro:string}>}
 */
export function planRows(doc) {
  const { rel, chars, structure } = doc;
  const k = planRowCount(chars, structure.sections.length);
  if (k <= 1) {
    return [{ key: rel, index: 0, total: 1, sections: structure.sections, intro: structure.intro }];
  }
  const groups = splitSections(structure.sections, k);
  return groups.map((sections, i) => ({
    key: `${rel}#§${i + 1}`,
    index: i,
    total: groups.length,
    sections,
    // 文档引言只在第 1 段带（避免 2~5 条里重复同一段话）
    intro: i === 0 ? structure.intro : '',
  }));
}
