// 离线层：文档扫描面 + markdown 结构解析 + 索引条切分（方案 §3.2）
//
// 口径（照方案，别自己发挥）：
//   · 扫描面 = `<docsRoot>/**/*.md`，缺省 `<cwd>/docs`
//   · 排除四类目录：技术变更流水 / 日报报告 / 坑目录 / `_archive`（流水类噪音大且天天变）
//   · `path` 列一律是**相对 dshRoot** 的路径
//   · 粒度：短文档（不到 2 万字）1 条；长文档按 `##` 小节聚成 2~5 条，多条时主键写 `path#§N`
import fs from 'node:fs';
import path from 'node:path';

// docs 根（可注入；不写死机器名 —— 换宿主只改调用方）
export const DEFAULT_DOCS_ROOT = path.join(process.cwd(), 'docs');
// `path` 列的前缀锚（缺省就是当前工作目录）
export const DEFAULT_DSH_ROOT = process.cwd();

// 排除目录按「路径段」匹配，不按子串 —— 否则文件名里带这四个字会被误伤
export const EXCLUDE_DIRS = '变更流水,管家报告,坑库,_archive'.split(',');

// 长/短文档分界：短文档不到 2 万字 ⇒ 1 条
export const LONG_DOC_CHARS = 20000;
// 长文档分条区间 2~5
export const MIN_LONG_ROWS = 2;
export const MAX_LONG_ROWS = 5;
// 每条摘要上限 500 字
export const SUMMARY_MAX_CHARS = 500;

// 首期要索引的 10 篇常用文档：判据是文档总索引里「最常用的 15 份」那张人工表的头 10 条
// （顺序即优先级，由主人与本鱼共同维护）。全量两百多篇不在这一批范围内。
const FIRST_BATCH_TEXT = `docs/主人使用手册.md
docs/DSH目录规范.md
docs/开发顺序统筹-20260914.md
docs/大管家-主人视角-一页纸-20260913.md
docs/大管家-开关矩阵与放行判据-20260913.md
docs/插件升级决策表.md
docs/插件魔改维护清单.md
docs/升级方案-2026-09-10.md
docs/自愈与回滚-验收缺口与整改方案-20260911.md
docs/gitee备份使用说明.md`;

export const FIRST_BATCH = FIRST_BATCH_TEXT.split('\n').map((line) => line.trim()).filter(Boolean);

// 首期清单的出处（写进 state 与报告，省得日后没人知道这 10 篇哪来的）
export const FIRST_BATCH_SOURCE = 'docs/文档总索引.md §一「最常用的 15 份」（人工段）前 10 条';

/** 反斜杠一律归一成 `/`（`path` 列口径） */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** 相对 dshRoot 的 path 口径（扫描面在 docs 下 ⇒ 结果以 `docs/` 打头） */
export function toRelPath(absPath, dshRoot = DEFAULT_DSH_ROOT) {
  return toPosix(path.relative(dshRoot, absPath));
}

/** 是否落在排除面内：只看「目录段」，顶层文件永远不算排除 */
export function isExcludedRel(relPath) {
  const segs = toPosix(relPath).split('/');
  segs.pop(); // 去掉文件名那一段
  return segs.some((seg) => EXCLUDE_DIRS.includes(seg));
}

/**
 * 递归扫描扫描面（只读；mtime 过滤交给差分逻辑，这里不过滤）。
 * @param {string} docsRoot
 * @param {{dshRoot?:string, maxFiles?:number}} [opts]
 * @returns {Array<{rel:string, abs:string, mtime:number, size:number}>}
 */
export function scanDocs(docsRoot = DEFAULT_DOCS_ROOT, opts = {}) {
  const dshRoot = opts.dshRoot ?? DEFAULT_DSH_ROOT;
  const collected = [];
  const todo = [docsRoot];

  while (todo.length > 0) {
    const dir = todo.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录读不动就跳过：fail-open，别拖垮整轮扫描
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDE_DIRS.includes(entry.name)) todo.push(abs); // 整棵剪掉
        continue;
      }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      const rel = toRelPath(abs, dshRoot);
      if (isExcludedRel(rel)) continue;
      collected.push({ rel, abs, mtime: Math.trunc(stat.mtimeMs), size: stat.size });
    }
  }

  collected.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
  return opts.maxFiles ? collected.slice(0, opts.maxFiles) : collected;
}

/** 读文档并算字符数（粒度判定与摘要生成都要它） */
export function readDoc(absPath) {
  const text = fs.readFileSync(absPath, 'utf8');
  return { text, chars: text.length };
}

// ---------------------------------------------------------------- 结构解析

// 清洗流水线：顺序即语义（先去代码块，再去内联标记，最后压空白）
const MD_CLEANUP = [
  [/```[\s\S]*?```/g, ' '],
  [/`([^`]*)`/g, '$1'],
  [/!\[[^\]]*\]\([^)]*\)/g, ' '],
  [/\[([^\]]*)\]\([^)]*\)/g, '$1'],
  [/\*\*([^*]*)\*\*/g, '$1'],
  [/(^|\s)[*_](\S[^*_]*)[*_]/g, '$1$2'],
  [/^\s*>\s?/gm, ''],
  [/\s+/g, ' '],
];

/** 去掉 markdown 内联标记（摘要里不要留 `**`、反引号、链接语法） */
export function stripMd(s) {
  let text = String(s);
  for (const [pattern, replacement] of MD_CLEANUP) text = text.replace(pattern, replacement);
  return text.trim();
}

// 首句候选：中文句读 / 英文句点后跟空白 / 实在没有就整段。
// ⚠ 刻意不认分号：中文文档里分号常切出「主人 = 用户」这种半截短语，反而丢信息。
const FIRST_SENTENCE_RE = /^(.{4,}?[。！？!?]|.{4,}?\.\s|.{4,})/;
const TRAILING_STOP_RE = /[。！？!?]\s*$/;

/** 取首句（上限 maxChars 字，超长按字截断并加省略号） */
export function firstSentence(text, maxChars = 80) {
  const plain = stripMd(text);
  if (!plain) return '';
  const hit = FIRST_SENTENCE_RE.exec(plain);
  let sentence = (hit ? hit[1] : plain).trim();
  sentence = sentence.replace(TRAILING_STOP_RE, '').trim();
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 1)}…` : sentence;
}

// 正文里这几类行不算正文：章节标题、分隔线、代码围栏、引用块/表格、以及模板头（维护人/更新日期…）
const FENCE_LINE_RE = /^```/;
const HEADING_LINE_RE = /^#{1,6}\s/;
const RULE_LINE_RE = /^[-*_]{3,}$/;
const QUOTE_LINE_RE = /^[>|]/;
const BULLET_LINE_RE = /^[-*+]\s/;
const META_PREFIX_RE = /^(?:维护人|创建|最近更新|最后更新|最后修订|更新时间|文件位置|路径口径|版本)\s*[:：]/;

/**
 * 取一节的正文首段：跳过引用块 / 表格 / 标题 / 代码块，去掉列表符号。
 * 为什么非跳不可：文档头部普遍是 `> ↑本主题总纲见 …` 这类模板引用块，
 * 直接取首句会让每篇索引条的说明完全雷同（实测过），对召回毫无区分度。
 */
export function pickParagraph(body, maxChars = 400) {
  const picked = [];
  for (const rawLine of String(body ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (picked.length > 0) break; // 空行 = 段落收尾
      continue;
    }
    if (FENCE_LINE_RE.test(line)) break;
    if (HEADING_LINE_RE.test(line)) continue;
    if (RULE_LINE_RE.test(line)) continue;
    if (picked.length === 0 && META_PREFIX_RE.test(line)) continue; // 模板头/元信息：往后找真正文
    if (QUOTE_LINE_RE.test(line)) continue;
    if (BULLET_LINE_RE.test(line)) {
      if (picked.length > 0) break;
      picked.push(line.replace(/^[-*+]\s+/, ''));
    } else {
      picked.push(line);
    }
    if (picked.join(' ').length > maxChars) break;
  }
  return picked.join(' ').trim();
}

/** 章节标题瘦身（摘要里每节只留辨识度最高的前 maxChars 字） */
export function shortTitle(t, maxChars = 28) {
  const plain = stripMd(t);
  return plain.length > maxChars ? `${plain.slice(0, maxChars - 1)}…` : plain;
}

const H1_RE = /^#\s+(.+?)\s*$/;
const H2_RE = /^##\s+(.+?)\s*$/;

/**
 * 解析 markdown 结构：H1 标题、引言段、`##` 小节（其下的 `###` 归入所属小节）。
 * 只认 `##`（方案：按 `##` 小节聚合）。
 * @returns {{title:string, intro:string, sections:Array<{title:string,chars:number,body:string}>}}
 */
export function parseStructure(text) {
  const lines = String(text).split(/\r?\n/);

  // 首个 H1 = 文档标题
  let title = '';
  let introFrom = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const hit = H1_RE.exec(lines[i]);
    if (!hit) continue;
    title = stripMd(hit[1]);
    introFrom = i + 1;
    break;
  }
  if (!title) {
    // 没有 H1：拿第一行非空文本兜底，摘要头不至于开天窗
    const headLine = lines.find((line) => line.trim());
    title = firstSentence(headLine || '', 60);
    introFrom = 0;
  }

  const raw = [];
  const introLines = [];
  let openSection = null;
  for (let i = introFrom; i < lines.length; i += 1) {
    const line = lines[i];
    const head = H2_RE.exec(line);
    if (head) {
      if (openSection) raw.push(openSection);
      openSection = { title: stripMd(head[1]), body: [] };
      continue;
    }
    if (openSection) openSection.body.push(line);
    else introLines.push(line);
  }
  if (openSection) raw.push(openSection);

  return {
    title,
    intro: introLines.join('\n').trim(),
    sections: raw.map((section) => {
      const bodyText = section.body.join('\n').trim();
      return { title: section.title, chars: section.title.length + bodyText.length, body: bodyText };
    }),
  };
}

/** 目标分条数：2 万字以内 1 条；超出按规模升到 2~5 条，且不超过 `##` 小节数 */
export function planRowCount(chars, sectionCount) {
  if (chars < LONG_DOC_CHARS) return 1;
  const bySize = Math.round(chars / LONG_DOC_CHARS) + 1;
  const target = Math.max(MIN_LONG_ROWS, Math.min(MAX_LONG_ROWS, bySize));
  if (sectionCount < MIN_LONG_ROWS) return 1; // 没有可聚合的小节 ⇒ 只能 1 条
  return Math.min(target, sectionCount);
}

/** 按 section 个数均分（确定性、可复现；组数恰为 k，多出来的并进最后一组） */
export function splitSections(sections, k) {
  const total = sections.length;
  if (k <= 1 || total <= 1) return [sections];

  const base = Math.floor(total / k);
  const extra = total % k;
  const groups = [];
  let cursor = 0;
  let group = 0;
  while (group < k) {
    const take = base + (group < extra ? 1 : 0);
    group += 1;
    if (take === 0) continue;
    groups.push(sections.slice(cursor, cursor + take));
    cursor += take;
  }
  if (cursor < total) groups[groups.length - 1] = groups[groups.length - 1].concat(sections.slice(cursor));
  return groups;
}

/**
 * 把一篇文档切成索引条计划。
 * @param {{rel:string, chars:number, structure:ReturnType<typeof parseStructure>}} doc
 * @returns {Array<{key:string, index:number, total:number, sections:Array, intro:string}>}
 */
export function planRows(doc) {
  const { rel, chars, structure } = doc;
  const wanted = planRowCount(chars, structure.sections.length);
  if (wanted <= 1) {
    return [{ key: rel, index: 0, total: 1, sections: structure.sections, intro: structure.intro }];
  }
  const groups = splitSections(structure.sections, wanted);
  return groups.map((group, i) => ({
    key: `${rel}#§${i + 1}`,
    index: i,
    total: groups.length,
    sections: group,
    // 文档引言只挂在第 1 段（免得 2~5 条里重复同一段话）
    intro: i === 0 ? structure.intro : '',
  }));
}
