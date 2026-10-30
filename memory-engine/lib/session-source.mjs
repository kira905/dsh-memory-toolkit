// 会话日志 → 候选结论条（零依赖）。
//
// 一个纯文本 .jsonl 进去，一批「能回指来源」的候选出来：
//   每条候选都带 `sourceRef = {sessionId, file, line, offset, anchor}`，
//   anchor 是原文前 48 个字 —— 将来任何人拿到这条记忆，都能回原文把这一句找出来对质。
//
// 为什么不做摘要式写入：摘要是推断，回指才是证据。本模块**只挑句子、不改写句子**，
// 模型那一层（session-distill.mjs）才允许合成，且合成时必须报出自己引用了哪几条候选。
//
// 抽不抽的口径（全部是确定性的、可复现的规则，不是"感觉像结论就抽"）：
//   抽：明确的决定 / 结论 / 口径 / 偏好 / 修复方案，且长度落在 [minChars, maxChars]；
//   不抽：寒暄、疑问句、过程叙述（先/然后/接着…）、推测（我觉得/可能/大概…）、
//         工具与图片段、超过 maxChars 的整段转述、以及归一化后与本批已有的重复句。
//   每一条被挡下的都按原因计数，跑完一次性报出来 —— 让你看得见"抽了多少、漏了什么"。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const SOURCE_SCHEMA = 1;

/** 抽句的缺省旋钮。调它们会改「抽出来的东西」，所以只做显式旋钮，不改代码。 */
export const DEFAULTS = Object.freeze({
  minChars: 12,
  maxChars: 240,
  anchorChars: 48,
  maxCandidates: 200,
});

/** `.zstd` 的两种后缀（DSH 的会话日志是 `.jsonl.zstd`）。 */
export const ZSTD_SUFFIXES = Object.freeze(['.zstd', '.zst']);

/** 压缩日志读不动时给的人话（既当提示也当报错正文，绝不静默吞掉）。 */
export const ZSTD_HINT = [
  '这是 zstd 压缩日志，不是一行一个事件的纯文本 .jsonl。',
  '请先解压再喂，例如：',
  '  zstd -d 会话.jsonl.zstd -o 会话.jsonl',
  '（本机没装 zstd 的话，node 22.15+ / 24 自带 zstd，本工具会自己逐帧解；解不开就是文件坏了或不是 zstd。）',
].join('\n');

// ── zstd：零依赖读压缩输入 ──────────────────────────────────────────────────
// node 内置 zstd 只解**第一帧**就停（DSH 的会话日志每次追加写一帧 ⇒ 多帧）。
// 所以这里自己走一遍帧结构算每帧长度，再逐帧交给 zstd 解，拼起来才是完整日志。

const FRAME_MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;

function looksZstdName(file) {
  const lower = String(file).toLowerCase();
  return ZSTD_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function hasZstdApi() {
  return typeof zlib.zstdDecompressSync === 'function';
}

/**
 * 逐帧算出 zstd 文件里每帧的 [start, end)。
 * 只读帧头与块头（都不压缩），不解内容 —— 所以又快又准。
 */
export function zstdFrameSpans(buf) {
  const spans = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const magic = buf.readUInt32LE(at);
    if ((magic & SKIPPABLE_MASK) === SKIPPABLE_MAGIC) {
      if (at + 8 > buf.length) return { ok: false, reason: `skippable 帧头不完整（偏移 ${at}）` };
      const size = buf.readUInt32LE(at + 4);
      spans.push({ start: at, end: at + 8 + size, kind: 'skippable' });
      at += 8 + size;
      continue;
    }
    if (magic !== FRAME_MAGIC) return { ok: false, reason: `偏移 ${at} 不是 zstd 帧头（magic=${magic.toString(16)}）` };

    const descriptor = buf[at + 4];
    if ((descriptor & 0x08) !== 0) return { ok: false, reason: `偏移 ${at} 的帧头把保留位置了 1，按规范应视为损坏` };
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const hasChecksum = (descriptor >> 2) & 1;
    const dictFlag = descriptor & 3;

    let cursor = at + 5;
    if (!singleSegment) cursor += 1; // Window_Descriptor
    cursor += [0, 1, 2, 4][dictFlag]; // Dictionary_ID
    const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
    cursor += fcsBytes;

    for (;;) {
      if (cursor + 3 > buf.length) return { ok: false, reason: '块头越界（文件被截断？）' };
      const header = buf[cursor] | (buf[cursor + 1] << 8) | (buf[cursor + 2] << 16);
      const isLast = header & 1;
      const blockType = (header >> 1) & 3;
      const blockSize = header >>> 3;
      cursor += 3;
      if (blockType === 3) return { ok: false, reason: '出现保留块类型（文件损坏）' };
      // RLE 块只有 1 字节内容；raw / compressed 都是 blockSize 字节
      cursor += blockType === 1 ? 1 : blockSize;
      if (isLast) break;
    }
    if (hasChecksum) cursor += 4;
    if (cursor > buf.length) return { ok: false, reason: '帧尾越界（文件被截断？）' };
    spans.push({ start: at, end: cursor, kind: 'frame' });
    at = cursor;
  }
  return { ok: true, spans };
}

/** 解 zstd（多帧逐帧解）。失败一律抛带人话的错误 —— 调用方看得见，不会拿到半截数据。 */
export function decompressZstd(buf) {
  if (!hasZstdApi()) {
    const error = new Error(`当前 node（${process.version}）没有内置 zstd API，无法直接读压缩日志。\n${ZSTD_HINT}`);
    error.code = 'ZSTD_UNSUPPORTED';
    throw error;
  }
  const walked = zstdFrameSpans(buf);
  if (!walked.ok) {
    const error = new Error(`zstd 帧结构读不动：${walked.reason}\n${ZSTD_HINT}`);
    error.code = 'ZSTD_CORRUPT';
    throw error;
  }
  if (!walked.spans.length) {
    const error = new Error(`文件里没有 zstd 帧（0 字节？）\n${ZSTD_HINT}`);
    error.code = 'ZSTD_EMPTY';
    throw error;
  }
  const chunks = [];
  let frames = 0;
  for (const span of walked.spans) {
    if (span.kind === 'skippable') continue;
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(span.start, span.end)));
      frames += 1;
    } catch (failure) {
      const error = new Error(`第 ${frames + 1} 帧解压失败（偏移 ${span.start}）：${failure && failure.message ? failure.message : failure}\n${ZSTD_HINT}`);
      error.code = 'ZSTD_CORRUPT';
      throw error;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), frames, spans: walked.spans.length };
}

/**
 * 读输入文件：普通文本原样读；zstd（按后缀或按帧头认）逐帧解。
 * @returns {{ text:string, compressed:boolean, frames:number, note:string|null }}
 */
export function readSourceText(file) {
  if (!fs.existsSync(file)) {
    const error = new Error(`输入文件不存在：${file}`);
    error.code = 'SOURCE_MISSING';
    throw error;
  }
  const buf = fs.readFileSync(file);
  const magicZstd = buf.length >= 4 && buf.readUInt32LE(0) === FRAME_MAGIC;
  const compressed = looksZstdName(file) || magicZstd;
  if (!compressed) return { text: buf.toString('utf8'), compressed: false, frames: 0, note: null };
  const out = decompressZstd(buf);
  return {
    text: out.text,
    compressed: true,
    frames: out.frames,
    note: `输入是 zstd 压缩日志：已用 node 内置 zstd 逐帧解开（${out.frames} 帧 / ${out.spans} 段），按解压后的文本抽句。`,
  };
}

// ── 逐行切（带行号 + 字节偏移） ──────────────────────────────────────────────

/** 切成「非空行」清单；offset 是该行首字节在解压后文本里的字节偏移。 */
export function splitSourceLines(text) {
  const lines = [];
  let cursor = 0;
  let lineNo = 0;
  let byteOffset = 0;
  const source = String(text ?? '');
  while (cursor <= source.length) {
    const nl = source.indexOf('\n', cursor);
    const end = nl === -1 ? source.length : nl;
    const raw = source.slice(cursor, end).replace(/\r$/, '');
    lineNo += 1;
    if (raw.trim()) lines.push({ line: lineNo, offset: byteOffset, raw });
    byteOffset += Buffer.byteLength(source.slice(cursor, end), 'utf8') + (nl === -1 ? 0 : 1);
    if (nl === -1) break;
    cursor = nl + 1;
  }
  return lines;
}

// ── 事件里的正文：认几种常见形态，工具/图片段一律跳过 ──────────────────────

const SKIP_BLOCK_TYPES = /tool|image|thinking|reasoning|attachment/i;

function collectTexts(node, sink, depth = 0) {
  if (node === null || node === undefined || depth > 5) return;
  if (typeof node === 'string') {
    if (node.trim()) sink.push(node);
    return;
  }
  if (typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectTexts(item, sink, depth + 1);
    return;
  }
  const kind = String(node.type ?? '');
  if (SKIP_BLOCK_TYPES.test(kind)) return; // 工具调用 / 工具结果 / 图片 / 思考流，不是结论
  for (const key of ['text', 'content', 'message', 'parts', 'body']) {
    if (node[key] !== undefined) collectTexts(node[key], sink, depth + 1);
  }
}

/** 从一个事件对象里挖出正文段落（顺序按字段顺序，够稳定可复现）。 */
export function textsOfEvent(event) {
  const sink = [];
  collectTexts(event, sink);
  const role = String(event?.role ?? event?.message?.role ?? event?.author?.role ?? '').toLowerCase();
  return { role, texts: sink };
}

// ── 判句：抽什么、不抽什么 ──────────────────────────────────────────────────

/** 结论类线索词 → kind。命中即认；同一句命中多族时按「规则 > 决定 > 修复 > 偏好」排。 */
const CUE_FAMILIES = Object.freeze([
  {
    kind: 'rule',
    words: ['一律', '必须', '不许', '禁止', '只能', '统一', '约定', '口径', '判据', '默认', '铁律', '宁可不', '不要用'],
  },
  {
    kind: 'decision',
    words: ['决定', '定了', '拍板', '改成', '采用', '定为', '结论', '方案是', '取舍', '选它', '先用', '就按', '整批', '按批', '别一条条'],
  },
  {
    kind: 'fix',
    words: ['根因', '修复', '修掉', '根治', '绕过', '补上', '罪魁', '坑在'],
  },
  {
    kind: 'preference',
    words: ['喜欢', '不喜欢', '习惯', '偏好', '我更想', '别给我', '我要的是'],
  },
]);

const SOCIAL_HEAD = /^(你好|您好|谢谢|多谢|辛苦|哈哈|呵呵|嘿嘿|好的|好呀|收到|嗯|行吧|在吗|晚安|早安|早上好|晚上好|没事)/;
const PROCESS_HEAD = /^(先|然后|接着|之后|于是|所以我就|现在我先|下面我)/;
// 「我先把…然后…接着…最后…」这种流水账：即便句尾偶然撞上"决定/结论"也是过程叙述，不是结论。
// 只认「然后 + 接着/随后/最后」这种连着三段的走法，避免把"先跑测试再提交"这类真规则误杀。
const PROCESS_BODY = /然后[^。]{0,30}(接着|随后|最后)|先[^。]{0,20}然后[^。]{0,30}最后/;
const SPECULATION = /(我觉得|我感觉|我猜|可能|也许|大概|估计|应该是|似乎|好像|说不定)/;

/**
 * 判一句：能不能当候选。
 * @returns {{ok:boolean, kind:string|null, reason:string|null, hits:string[]}}
 */
export function judgeSentence(text, opts = {}) {
  const limits = { ...DEFAULTS, ...opts };
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, kind: null, reason: 'empty', hits: [] };
  if (body.length < limits.minChars) return { ok: false, kind: null, reason: 'too-short', hits: [] };
  if (body.length > limits.maxChars) return { ok: false, kind: null, reason: 'too-long', hits: [] };
  if (/[？?]$/.test(body)) return { ok: false, kind: null, reason: 'question', hits: [] };
  if (SOCIAL_HEAD.test(body)) return { ok: false, kind: null, reason: 'social', hits: [] };
  if (PROCESS_HEAD.test(body)) return { ok: false, kind: null, reason: 'process', hits: [] };
  if (PROCESS_BODY.test(body)) return { ok: false, kind: null, reason: 'process', hits: [] };

  const hits = [];
  for (const family of CUE_FAMILIES) {
    for (const word of family.words) {
      if (body.includes(word) && !hits.includes(word)) hits.push(word);
    }
  }
  if (!hits.length) {
    return { ok: false, kind: null, reason: SPECULATION.test(body) ? 'speculation' : 'no-cue', hits: [] };
  }
  if (SPECULATION.test(body) && !(CUE_FAMILIES[0].words.some((word) => body.includes(word)) || CUE_FAMILIES[1].words.some((word) => body.includes(word)))) {
    // 光有"可能/我觉得"、没有规则或决定词撑着 ⇒ 是推测，不是结论
    return { ok: false, kind: null, reason: 'speculation', hits };
  }
  const kind = CUE_FAMILIES.find((family) => family.words.some((word) => hits.includes(word)))?.kind ?? 'rule';
  return { ok: true, kind, reason: null, hits };
}

/** 句子级切分：按句末标点与换行切，保留原序（偏移靠累加还原）。 */
export function splitSentences(paragraph) {
  const source = String(paragraph ?? '');
  const out = [];
  let cursor = 0;
  for (let at = 0; at < source.length; at += 1) {
    if (/[。！!？?；;\n]/.test(source[at])) {
      const piece = source.slice(cursor, at + 1);
      out.push({ text: piece, at: cursor });
      cursor = at + 1;
    }
  }
  if (cursor < source.length) out.push({ text: source.slice(cursor), at: cursor });
  return out.map((item) => ({ ...item, text: item.text.trim() })).filter((item) => item.text);
}

const normalize = (text) => String(text ?? '').replace(/[\s，。！？；：、,.!?;:'"“”‘’()（）]/g, '');

/**
 * 主入口：读一个 .jsonl（或 .zstd），返回候选条 + 逐类计数。
 *
 * @param {{file?:string, text?:string, sessionId?:string, defaults?:object, now?:number}} input
 * @returns {{ok:boolean, sessionId:string, file:string|null, compressed:boolean, note:string|null,
 *   candidates:Array, lines:number, events:number, skipped:object, warnings:string[]}}
 */
export function extractCandidates(input = {}) {
  const limits = { ...DEFAULTS, ...(input.defaults ?? {}) };
  const warnings = [];
  let text = input.text;
  let compressed = false;
  let note = null;
  const file = input.file ? path.resolve(input.file) : null;

  if (text === undefined) {
    if (!file) throw new Error('extractCandidates 需要 file 或 text 其中之一');
    const read = readSourceText(file);
    text = read.text;
    compressed = read.compressed;
    note = read.note;
  }

  const lines = splitSourceLines(text);
  const skipped = {
    'bad-json': 0, 'tool-event': 0, 'no-text': 0, 'too-short': 0, 'too-long': 0,
    question: 0, social: 0, process: 0, speculation: 0, 'no-cue': 0, duplicate: 0, 'over-cap': 0,
  };
  const candidates = [];
  const seen = new Set();
  let sessionId = String(input.sessionId ?? '');
  let events = 0;
  let badSample = null;

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line.raw);
    } catch {
      skipped['bad-json'] += 1;
      if (!badSample) badSample = line.raw.slice(0, 80);
      continue;
    }
    events += 1;
    if (!sessionId && event?.type === 'session' && event?.id) sessionId = String(event.id);
    if (event?.type === 'session' && event?.id && !input.sessionId) sessionId = String(event.id);

    const { role, texts } = textsOfEvent(event);
    if (role === 'tool' || role === 'system') {
      skipped['tool-event'] += 1;
      continue;
    }
    if (!texts.length) {
      skipped['no-text'] += 1;
      continue;
    }

    for (const paragraph of texts) {
      for (const sentence of splitSentences(paragraph)) {
        const verdict = judgeSentence(sentence.text, limits);
        if (!verdict.ok) {
          skipped[verdict.reason] = Number(skipped[verdict.reason] ?? 0) + 1;
          continue;
        }
        const fingerprint = normalize(sentence.text);
        if (!fingerprint || seen.has(fingerprint)) {
          skipped.duplicate += 1;
          continue;
        }
        seen.add(fingerprint);
        if (candidates.length >= limits.maxCandidates) {
          skipped['over-cap'] += 1;
          continue;
        }
        candidates.push({
          text: sentence.text,
          kind: verdict.kind,
          chars: sentence.text.length,
          cues: verdict.hits,
          sourceRef: {
            sessionId: sessionId || 'unknown',
            file,
            line: line.line,
            offset: line.offset,
            charOffset: sentence.at,
            anchor: sentence.text.slice(0, limits.anchorChars),
            role: role || 'unknown',
          },
        });
      }
    }
  }

  if (!sessionId) {
    sessionId = 'unknown';
    warnings.push('日志里没有 type=session 的事件、也没给 --session-id ⇒ 来源一律标 unknown（回指会退化成"文件名+行号"）');
  }
  if (badSample) warnings.push(`有 ${skipped['bad-json']} 行不是合法 JSON（首例：${badSample}）——这些行整行跳过，没有静默当成正文`);
  if (skipped['over-cap']) warnings.push(`候选超过上限 ${limits.maxCandidates} 条：多出来的 ${skipped['over-cap']} 条没进本批（调 --max-candidates 才能放宽）`);
  for (const item of candidates) item.sourceRef.sessionId = sessionId;

  return {
    ok: true,
    sessionId,
    file,
    compressed,
    note,
    candidates,
    lines: lines.length,
    events,
    skipped,
    warnings,
  };
}

/** 给报告/人话用的计数一行（空类不占位）。 */
export function summarizeSkipped(skipped) {
  const parts = Object.entries(skipped ?? {})
    .filter(([, count]) => Number(count) > 0)
    .map(([reason, count]) => `${reason} ${count}`);
  return parts.length ? parts.join(' · ') : '无';
}
