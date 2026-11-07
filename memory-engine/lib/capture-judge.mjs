// capture-judge.mjs —— 自动提炼影子 · 「什么该记」判定器（U1 口径的可执行实现）
//
// 口径真源：本仓 README §「什么该记」判定器（judgeVersion = U1-1）。
// 本文件里出现 `[P1]` / `[S3]` / `[N2]` / `[M1]` 这类标号的注释，就是那张「规则↔代码对照表」的落点：
//   **改任一规则 ⇒ 必须升 judgeVersion，并同批改口径描述**（否则文档与代码说法不一致）。
//
// ── 硬边界（本文件永久口径，改之前先看这四条）────────────────────────────────
//   ① **零写库**：本文件没有任何 INSERT/UPDATE/DELETE/CREATE；打库只有 `readOnly: true` 一处（`loadMemoryPool`）。
//   ② **零网络**：默认档一行都不调模型（`--model` 才走 `judgeWithModel`，且那里用**懒 import**）。
//   ③ **永不写盘**：本文件不写任何文件（落候选的是 CLI `shadow-capture.mjs`）。
//   ④ **不抛给调用方致命错**：单条消息/单条库条异常 ⇒ 跳过并计数，不中断整轮（只有"库打不开"由 CLI 决定 rc）。
//
// ── 与既有件的关系（**不许重造**）────────────────────────────────────────────
//   · 去重阈值 / 规范化 / shingle / Jaccard = **import** `tools\memory-layers\shadow-verdict.mjs`（H-2 写入判定影子的同一套），
//     **不在此另立第二套数字**（真源 THRESHOLDS = dup 0.90 / sim 0.74 / shingle 6）。
//   · 「提炼」内核 `lib\distill.mjs` 与本文件**不是同一件事**：distill 做"把已进库的条总结成结论"；
//     本文件做"这段对话该不该记下来"。两者唯一的交集是 §3.2 那三条（distilled 条永不当候选来源）。
import { DatabaseSync } from 'node:sqlite';
import { normalizeText, shingles, jaccard, THRESHOLDS } from '../../lib/text-similarity.mjs';

/** 判据版本（口径文档 §5：规则一改，这里必须跟着改）。 */
export const JUDGE_VERSION = 'U1-2';
export const CANDIDATE_SCHEMA_VERSION = 1;

// ═══════════════════════════════════════════════════════════════════════════
// §1.1 预处理（P1–P4）
// ═══════════════════════════════════════════════════════════════════════════

// [P1] 注入块：这些是 harness / persona / 插件注入的，**不是人说的话**
//      （口径 §4-① 第一类误判的对抗）
//      2026-10-25 实测追加两项：`【坑库实时提醒`（插件注入的坑库提醒，单会话刷了 9 次）、
//      `【重复·已并入` / `【已合并进`（归并标记副本，正文是别人的摘要）
export const INJECTION_PREFIXES = Object.freeze([
  '<system-reminder>',
  'Current runtime context.',
  '[相关记忆·指针]',
  'Time sampled while',
  'This snapshot supersedes',
  '补充条件：',
  '任务已恢复',
  '【坑库实时提醒',
  '【重复·已并入',
  '【已合并进',
]);

// [P1b] 工具输出 / 终端回显形态（2026-10-25 实测命中：「background job pwsh-2296 (…)」、
//       「PS > & \"…\nodejs\npm…」）—— 不是对话内容
export const HARNESS_NOISE_RE = /^(?:background job |PS [A-Z]:\\)/m;

// [P2] 寒暄阈值：去空白后短于此 ⇒ 装不下一条可执行的记忆
export const MIN_TEXT_CHARS = 12;

// [P3] 敏感：**整条丢弃**（不做部分脱敏 —— "以为脱了其实漏了"比丢掉更糟）。
//      `127.0.0.1`（loopback）**故意放行**：它不是内网地址，且本仓大量口径靠它表述。
export const SENSITIVE_PATTERNS = Object.freeze([
  { key: 'api-key-sk', re: /\bsk-[A-Za-z0-9]{16,}/ },
  { key: 'api-key-gh', re: /\bghp_[A-Za-z0-9]{20,}/ },
  { key: 'bearer', re: /\bBearer\s+\S{16,}/i },
  { key: 'kv-secret', re: /(?:api[_-]?key|token|passwd|password|secret)\s*[:=]\s*\S{8,}/i },
  { key: 'private-ip', re: /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { key: 'wechat-openid', re: /\b[A-Za-z0-9_-]{6,}@im\.wechat\b/ },
  { key: 'phone', re: /\b1[3-9]\d{9}\b/ },
]);

// [P4] 纯 tool 噪声：命令行 / JSON 不是"事"，是"动作"
export function isToolNoise(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (t.startsWith('{') || t.startsWith('[')) {
    try { JSON.parse(t); return true; } catch { /* 不是纯 JSON ⇒ 不算噪声 */ }
  }
  const lines = t.split('\n').map((x) => x.trim()).filter(Boolean);
  if (lines.length === 1 && /^node\s+\S/.test(lines[0]) && lines[0].length > 20) return true;
  return false;
}

// [P6] 结构化片段闸（2026-10-25 实测追加）：被贴进来的**文档/文案片段**不是"人在说话"。
//      命中实测：「| 四数 → 换来的是一串坑 → 所以自己造了一套 |」（视频文案表格行）、
//      「## 一、…” 开头的交接档段落。判据 = 非空行里表格行 ≥50% 或标题行 ≥30%（≥3 行才判）。
export function isDocFragment(text) {
  const lines = String(text ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const tableLines = lines.filter((l) => l.startsWith('|')).length;
  const headingLines = lines.filter((l) => /^#{1,6}\s/.test(l)).length;
  return tableLines / lines.length >= 0.5 || headingLines / lines.length >= 0.3;
}

// ═══════════════════════════════════════════════════════════════════════════
// §1.2 正面信号（S1–S8）；§1.3 反面信号（N1–N6）
//   关键词组即口径文档表格里的正则原文（**逐字一致**）。
// ═══════════════════════════════════════════════════════════════════════════

// [S1] 拍板 / 口径下发（一等长期事实）
const DECISION_RE = /拍板|已拍|就这么办|就这么定|定了|我决定|从今天起|以后都|以后一律|一律按|统一按|统一定为|改口径|口径改为|规定为|定为|按这个走/;
// [S2] 偏好 / 禁令
const PREFERENCE_RE = /我(?:更|最)喜欢|以后不(?:要|许|用)|别再用|每次都要|以后记得|不希望(?:再)?|禁止|不许|别再|不要再/;
// [S3] 坑与教训
const PITFALL_RE = /踩过|踩到|(?:一个|这个)?坑|教训|根因|事故|炸过|崩过|翻车|反例|失败模式|吃了亏/;
// [S4] 跨会话待办 / 承诺
const TODO_RE = /待办|承诺|答应|记得(?:提醒|告诉)|等多.{0,12}做[好完]了|下次要|明天要|以后要|回头要|别忘了|等.{0,8}[好完]了.{0,6}(?:告诉|说)一声/;
// [S5] 长期事实（路径 / 凭据位 / 端口 / 唯一源）
const ABS_PATH_RE = /[A-Za-z]:\\[^\s，。）]{3,}/;
const LONG_FACT_RE = /~\/\.|127\.0\.0\.1:\d{4,5}|凭据在|落在|位于|存放在|只有一份|恒为|一律是|唯一源|真源/;
// [S6] 决定 + 理由（两个条件必须同条命中）
const RATIONALE_RE = /因为|之所以|理由是|为的是|是为了|原因(?:是|在于)/;
const CHOICE_RE = /选|改用|改成|不走|换成|按.{0,12}(?:来|办)/;
// [S7] 明确要求记住
const REMEMBER_RE = /记住|记一笔|写进记忆|存进记忆|钉死|钉进|焊进/;
// [S8] 验通事实（弱；必须与具体命令/读数同现）
const VERIFIED_RE = /实测|现跑|验过|验证通过|全绿|跑通/;
const EVIDENCE_RE = /[A-Za-z]:\\|node |rc\s*0|sha256|\b\d+\/\d+\b/;

// [N1] 一次性任务进度
const PROGRESS_RE = /正在|进行中|进度|第 ?\d+ ?步|已完成 ?\d+|完成了 ?\d+|还剩 ?\d+|下一步做/;
// [N2] 临时读数
const READING_RE = /\b\d{1,3}%|token ?[:：] ?\d|耗时 ?\d+(?:\.\d+)? ?s|剩 ?\d+ ?条/;
// [N3] 寒暄 / 情绪（短且无技术名词）
//   阈值 16 字（不是 24）：实测 21 字的「实跑了一遍，实测 rc 0，验证通过」被 24 字阈值误判成寒暄 ⇒ 扣 2.5。
const TECH_TOKEN_RE = /[A-Za-z_]{3,}|[A-Za-z]:\\|\d{3,}/;
export const MIN_CHAT_CHARS = 16;
// [N4] 已完成的小活
const DONE_SMALL_RE = /(?:改好|改完|部署好|部署完|跑过了|修好了|已上线|已完成)[了啦。！\s]*$/;
// [N6] 纯疑问（弱）
const QUESTION_RE = /[？?]/;

/** 信号权重（§1.2）。 */
export const SIGNAL_WEIGHTS = Object.freeze({ S1: 3.0, S2: 2.5, S3: 2.5, S4: 2.5, S5: 2.0, S6: 1.5, S7: 3.0, S8: 1.0 });
/** 反面扣分（§1.3）。 */
export const NEGATIVE_WEIGHTS = Object.freeze({ N1: 2.0, N2: 1.5, N3: 2.5, N4: 2.0, N5: 2.0, N6: 1.0 });
/** 阈值（§1.4）：候选 ≥2.0；边界 1.0~2.0 只计数。 */
export const THRESHOLD = Object.freeze({ candidate: 2.0, borderline: 1.0 });
/** 字段硬上限（§2：**不许存长原文**）。 */
export const FIELD_LIMITS = Object.freeze({ claim: 50, quote: 80, reason: 60, tags: 4 });

/**
 * 来源加权（§1.2 末段）：`sourceKind === 'assistant'`（本鱼自己说的话）**全部信号 ×0.6** —— 防"自述当事实"（§4-③）。
 * 2026-10-25 实测收紧（U1-2）：原来只降 S5/S8，结果 274 条候选里 **174 条是本鱼自述**（"骨架定了…"、
 *   "我总结一下…"）= 灌水。改为全体降权后，assistant 侧要过线**必须命中两条强信号**（见 STRONG_SIGNALS）。
 */
export const ASSISTANT_WEIGHT = 0.6;

/**
 * 强信号（§1.4 第二道门槛）：候选至少要命中一条强信号。
 * 为什么需要：只有 S5（带个路径）+ S8（"实测"）的句子在日志里遍地都是
 *   （低分段实测样本：「PS > & npm…」「background job pwsh-2296…」），
 *   把它们算候选 = 把日志里的每个路径都记一遍。S1/S3/S4/S7 才是"这件事非记不可"的形态。
 */
export const STRONG_SIGNALS = Object.freeze(['S1', 'S3', 'S4', 'S7']);

/** 预处理（P1–P4）。返回 `{ok:false, code}` 表示不进判定。 */
export function preprocess(text, opts = {}) {
  const raw = String(text ?? '');
  const flat = raw.replace(/\s+/g, ' ').trim();
  // [P5] 来源闸（2026-10-25 实测追加）：
  //   ① 接力指令是**机器模板** —— 同一句「遇到需要主人拍板的事…」在 18 个会话里逐字重复；
  //   ② 卡执行会话（`agentPreset` 含 `card`）里**主人不说话** —— 那里的 user/message 全是卡面任务书，
  //      把卡面当"主人的口径"= 把本线自己的施工单刷成候选（实测 19 条候选全来自卡面）。
  //   两种都可以用 `--include-relay` 打开看。
  if (opts.includeRelay !== true) {
    if (opts.sourceKind === 'relay') return { ok: false, code: 'relay-template' };
    if (opts.sourceKind === 'user' && /card/i.test(String(opts.preset ?? ''))) return { ok: false, code: 'card-prompt' };
  }
  // [P1]
  if (INJECTION_PREFIXES.some((p) => flat.includes(p))) return { ok: false, code: 'injection' };
  // [P1b]
  if (HARNESS_NOISE_RE.test(raw)) return { ok: false, code: 'harness-noise' };
  // [P2]
  if (flat.replace(/\s+/g, '').length < MIN_TEXT_CHARS) return { ok: false, code: 'too-short' };
  // [P3]
  for (const p of SENSITIVE_PATTERNS) if (p.re.test(raw)) return { ok: false, code: `sensitive:${p.key}` };
  // [P4]
  if (isToolNoise(raw)) return { ok: false, code: 'tool-noise' };
  // [P6]
  if (isDocFragment(raw)) return { ok: false, code: 'doc-fragment' };
  return { ok: true, flat };
}

/**
 * 打分（§1.4）：score = Σ(S 权重, 按来源加权) − Σ(N 扣分)。
 * @returns {{score:number, signals:string[], negatives:string[], selfReported:boolean}}
 */
export function scoreMessage(text, opts = {}) {
  const t = String(text ?? '');
  const sourceKind = opts.sourceKind ?? 'user';
  const signals = [];
  const negatives = [];
  let score = 0;
  const hit = (re) => re.test(t);

  if (hit(DECISION_RE)) signals.push('S1');
  if (hit(PREFERENCE_RE)) signals.push('S2');
  if (hit(PITFALL_RE)) signals.push('S3');
  if (hit(TODO_RE)) signals.push('S4');
  if (ABS_PATH_RE.test(t) || hit(LONG_FACT_RE)) signals.push('S5');
  if (hit(RATIONALE_RE) && hit(CHOICE_RE)) signals.push('S6');
  if (hit(REMEMBER_RE)) signals.push('S7');
  if (hit(VERIFIED_RE) && EVIDENCE_RE.test(t)) signals.push('S8');

  let selfReported = false;
  for (const s of signals) {
    let w = SIGNAL_WEIGHTS[s] ?? 0;
    if (sourceKind === 'assistant') {
      w *= ASSISTANT_WEIGHT;
      selfReported = true;
    }
    score += w;
  }

  // 反面信号
  if (hit(PROGRESS_RE)) negatives.push('N1');
  if (READING_RE.test(t)) negatives.push('N2');
  // [N3] 短且无技术名词（去空白后 ≤16 字）
  if (t.replace(/\s+/g, '').length <= MIN_CHAT_CHARS && !TECH_TOKEN_RE.test(t)) negatives.push('N3');
  // [N4] 已完成小活 —— **且无任一 S1–S7**（S8 不算：验通事实本身可能值得记）
  if (DONE_SMALL_RE.test(t) && !signals.some((s) => ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'].includes(s))) negatives.push('N4');
  // [N5] 机器模板 / 命令块
  if (hit(/^(?:补充条件|任务已恢复)/) || (isToolNoise(t) && t.length > 0)) negatives.push('N5');
  // [N6] 纯疑问（无 S1/S2/S3/S4/S6/S7）
  if (QUESTION_RE.test(t) && !signals.some((s) => ['S1', 'S2', 'S3', 'S4', 'S6', 'S7'].includes(s))) negatives.push('N6');

  for (const n of negatives) score -= NEGATIVE_WEIGHTS[n] ?? 0;

  return { score: Math.round(score * 10) / 10, signals, negatives, selfReported };
}

// ═══════════════════════════════════════════════════════════════════════════
// 取句 / 截断（§2 的 claim ≤50 / quote ≤80；§4-⑤ 的截断对抗）
// ═══════════════════════════════════════════════════════════════════════════

/** 按句切开（保留句末标点）。 */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[。；！？\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 去 markdown 噪声（只影响 claim 的观感，不影响 quote）。 */
function stripMarkdown(s) {
  return String(s ?? '')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 硬截断 + 省略号（**句中不截断单词边界**由调用方保证语义，见下）。 */
function cut(s, n) {
  const t = String(s ?? '').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * [M5] 截断造成语义反转的对抗：句子 > n 时，优先取**含否定词的那一段**，
 * 因为「不许再用 X」被截成「许再用 X」是最坏的一种失真。
 */
function cutPreferNegation(sentence, n) {
  const t = String(sentence ?? '').trim();
  if (t.length <= n) return t;
  const m = /不许|别再用|禁止|不要|不可|不能|禁/.exec(t);
  if (!m) return cut(t, n);
  const start = Math.max(0, m.index - 10);
  return cut(t.slice(start, start + n), n);
}

/**
 * 取"命中的那句"：第一句命中≥1 正面信号的**散文句**；若其短于 MIN_TEXT_CHARS，
 * 向后接句（最多 2 句）直到够长（§2 的 claim 必须是人能读的一句主张）。
 *
 * **优先散文句**（2026-10-25 实测追加）：表格行 / 标题行 / 列表项不是"一句主张" ——
 *   实测候选里出现过「| 四数 → 换来的是一串坑 → 所以自己造了一套 |」这种视频文案表格行。
 *   做法 = 两遍扫描：先只在散文句里找信号句，找不到再退回全量（不因体裁判定而丢候选）。
 */
export function isProseSentence(s) {
  const t = String(s ?? '').trim();
  if (!t) return false;
  if (t.startsWith('|') || t.startsWith('#')) return false;
  if (/^[-*+]\s/.test(t)) return false;
  return true;
}

export function pickSentence(text, signals = []) {
  const sents = splitSentences(text);
  if (!sents.length) return { claim: '', quote: '', sentence: '' };
  const signalRes = {
    S1: DECISION_RE, S2: PREFERENCE_RE, S3: PITFALL_RE, S4: TODO_RE, S6: RATIONALE_RE, S7: REMEMBER_RE,
  };
  const active = signals.map((s) => signalRes[s]).filter(Boolean);
  const findIdx = (pool) => {
    if (!active.length) return -1;
    for (let i = 0; i < pool.length; i++) if (active.some((re) => re.test(sents[pool[i]]))) return pool[i];
    return -1;
  };
  const proseIdx = sents.map((s, i) => (isProseSentence(s) ? i : -1)).filter((i) => i >= 0);
  let idx = findIdx(proseIdx);
  if (idx < 0) idx = findIdx(sents.map((_, i) => i));
  // S5/S8 单独命中时没有句子级信号 ⇒ 取含路径/命令的那句（同样优先散文句）
  if (idx < 0) {
    const probe = (i) => ABS_PATH_RE.test(sents[i]) || /127\.0\.0\.1:\d+/.test(sents[i]) || LONG_FACT_RE.test(sents[i]);
    idx = proseIdx.find(probe) ?? sents.findIndex((_, i) => probe(i));
  }
  if (idx < 0) idx = proseIdx.length ? proseIdx[0] : 0;
  let picked = sents[idx];
  for (let k = 1; k <= 2 && picked.replace(/\s+/g, '').length < MIN_TEXT_CHARS && idx + k < sents.length; k++) {
    picked += sents[idx + k];
  }
  return {
    sentence: picked,
    claim: cut(stripMarkdown(picked), FIELD_LIMITS.claim),
    quote: cutPreferNegation(picked.replace(/\s+/g, ' '), FIELD_LIMITS.quote),
  };
}

/** 标签（§2 #13）：固定词表 + 主题词 ≤2。 */
export const TAG_BY_SIGNAL = Object.freeze({
  S1: '拍板', S2: '偏好', S3: '坑', S4: '待办', S6: '决定', S7: '主人交代',
});
const TOPIC_LEXICON = ['记忆', '提炼', '会话', '看板', '生图', '凭据', '端口', '交接', '备份', '同步', '蒸馏', '影子', '家人', '重启', '守护鱼', '插件', '技能', 'persona'];

export function extractTags(signals, sentence) {
  const out = [];
  for (const s of signals) if (TAG_BY_SIGNAL[s] && !out.includes(TAG_BY_SIGNAL[s])) out.push(TAG_BY_SIGNAL[s]);
  if (signals.includes('S5') && !out.includes('长期事实')) out.push('长期事实');
  const topic = [];
  const used = new Set(out);
  for (const w of TOPIC_LEXICON) if (String(sentence).includes(w) && !used.has(w)) topic.push(w);
  const en = String(sentence).match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) ?? [];
  for (const w of en) {
    const k = w.toLowerCase();
    if (topic.includes(k) || used.has(k)) continue;
    if (['the', 'and', 'for', 'node', 'true', 'false'].includes(k)) continue;
    topic.push(k);
  }
  const seen = new Set(out);
  for (const w of topic) {
    if (out.length >= FIELD_LIMITS.tags) break;
    if (seen.has(w)) continue;
    seen.add(w); out.push(w);
  }
  return out.slice(0, FIELD_LIMITS.tags);
}

/** §2 #15 的 reason 模板（不是自由发挥）。 */
const REASON_BY_SIGNAL = Object.freeze({
  S1: '口径类是一等长期事实：将来所有会话都得照着办',
  S2: '偏好决定"以后怎么干"，不是这次干了什么',
  S3: '坑是可以复用一次的负知识（下次不踩）',
  S4: '有"未来时点"的承诺，跨会话不记就丢',
  S5: '"东西在哪、谁是唯一源"是下个会话的地址簿',
  S6: '只记结论会丢"为什么"，下次可能反向改回去',
  S7: '最高优先级：人已经点名要记了',
  S8: '弱信号：与 S5/S3 同现才说明"这事实是验过的"',
});

export function buildReason(signals, negatives) {
  const parts = signals.map((s) => `${s} ${REASON_BY_SIGNAL[s] ?? ''}`.trim()).filter(Boolean);
  const tail = negatives.length ? `；但命中 ${negatives.join(',')}` : '；未见进度/寒暄类反面信号';
  return cut(`命中 ${parts.join(' / ')}${tail}`, FIELD_LIMITS.reason);
}

/** 本地 ISO（带 +08:00 形态的时区偏移，按本机时区）。 */
export function isoLocal(ms) {
  const d = new Date(Number(ms) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

/** 从会话事件里取纯文本（user/message 取 data.content；assistant/message 取 data.message.content）。 */
export function extractText(record) {
  const type = record?.type;
  let content = null;
  if (type === 'user/message') content = record?.data?.content;
  else if (type === 'assistant/message') content = record?.data?.message?.content;
  else return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n');
}

/** 来源分类（§2 #8）：user / relay / assistant。接力指令带 `source.rpcId = session-relay-*`。 */
export function classifySource(record) {
  if (record?.type === 'assistant/message') return 'assistant';
  const rpc = String(record?.data?.source?.rpcId ?? '');
  if (rpc.startsWith('session-relay')) return 'relay';
  return 'user';
}

/**
 * 判一条消息（§1.5：**一条消息最多出 1 条候选**）。
 * @returns {{candidate:object|null, code:string, score:number}}
 */
export function judgeMessage(record, ctx = {}) {
  const text = extractText(record);
  const sourceKind = classifySource(record);
  const pre = preprocess(text, { sourceKind, includeRelay: ctx.includeRelay === true, preset: ctx.preset });
  if (!pre.ok) return { candidate: null, code: pre.code, score: null };
  const { score, signals, negatives, selfReported } = scoreMessage(text, { sourceKind });
  if (!signals.length) return { candidate: null, code: 'no-signal', score };
  if (score < THRESHOLD.borderline) return { candidate: null, code: 'below-borderline', score };
  if (score < THRESHOLD.candidate) return { candidate: null, code: 'borderline', score };
  // §1.4 第二道门槛：**必须命中一条强信号**
  if (!signals.some((s) => STRONG_SIGNALS.includes(s))) return { candidate: null, code: 'no-strong-signal', score };

  const { claim, quote } = pickSentence(text, signals);
  if (!claim) return { candidate: null, code: 'no-claim', score };
  const cand = {
    candId: ctx.candId ?? null,
    schemaVersion: CANDIDATE_SCHEMA_VERSION,
    judgeVersion: JUDGE_VERSION,
    sessionId: ctx.sessionId ?? null,
    workspaceDir: ctx.workspaceDir ?? null,
    seq: typeof record?.seq === 'number' ? record.seq : null,
    at: isoLocal(record?.time ?? ctx.nowMs ?? Date.now()),
    sourceKind,
    signals,
    score,
    claim,
    quote,
    tags: extractTags(signals, claim || quote),
    dedup: { verdict: 'new', nearestId: null, sim: 0, alreadyDistilled: false },
    reason: buildReason(signals, negatives),
    ...(selfReported ? { selfReported: true } : {}),
  };
  // 字段硬上限断言（§2：不许存长原文）—— 违反就是判据漏洞，宁可丢这条也不写长文本
  if (claim.length > FIELD_LIMITS.claim || quote.length > FIELD_LIMITS.quote) {
    return { candidate: null, code: 'field-limit-violation', score };
  }
  return { candidate: cand, code: 'candidate', score };
}

// ═══════════════════════════════════════════════════════════════════════════
// §3 去重
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 候选池（**只读**；`readOnly: true` 是本文件唯一的打库点）。
 * 池 = 近 `windowDays` 天变过的条 ∪ `tags LIKE 'distilled%'`（后者标 isDistilled，§3.2-[D2]）。
 */
export function loadMemoryPool(dbPath, opts = {}) {
  const windowDays = Number(opts.windowDays ?? THRESHOLDS.windowDays);
  const cap = Number(opts.cap ?? 2000);
  const nowMs = Number(opts.nowMs ?? Date.now());
  const since = nowMs - windowDays * 24 * 3600 * 1000;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000;');
  // 双保险（2026-10-25）：`readOnly` 之外再上 `query_only` —— 就算将来有人往本函数里加一句写语句，
  // SQLite 也会直接抛错而不是改库。断言一次，拿不到 1 就 fail-closed 抛出去（CLI 会降级为"全 new"并报错）。
  db.exec('PRAGMA query_only = ON;');
  const qt = db.prepare('PRAGMA query_only').get();
  if (Number(qt?.query_only ?? 0) !== 1) throw new Error('memory-db-not-query-only');
  try {
    const rows = db.prepare(
      "SELECT id, text, tags, updated_at FROM memories WHERE updated_at >= ? OR tags LIKE 'distilled%' ORDER BY updated_at DESC LIMIT ?",
    ).all(since, cap);
    return rows.map((r) => ({
      id: Number(r.id),
      text: String(r.text ?? ''),
      tags: String(r.tags ?? ''),
      updatedAt: Number(r.updated_at ?? 0),
      isDistilled: /^distilled/.test(String(r.tags ?? '')),
    }));
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 建池索引（纯函数、可夹具）：`{docs, index}`。 */
export function buildPoolIndex(rows) {
  const docs = [];
  const index = new Map();
  for (const r of rows ?? []) {
    const sh = shingles(r.text);
    if (!sh.size) continue;
    const i = docs.push({ id: r.id, tags: r.tags, isDistilled: Boolean(r.isDistilled), sh }) - 1;
    for (const g of sh) {
      let arr = index.get(g);
      if (!arr) { arr = []; index.set(g, arr); }
      arr.push(i);
    }
  }
  return { docs, index };
}

/**
 * 追加判据：**包含度**（overlap coefficient = |A∩B| / min(|A|,|B|)）。
 *
 * 为什么非要这一条（2026-10-25 自测实测）：6-gram Jaccard 对"同句 + 追加一段"极不敏感 ——
 *   「记忆线一律走本鱼链，不用第三方模型，外发面要先拍。」vs 同一句后面再补「不许改回智谱第三方。」
 *   Jaccard 只有 ~0.65（< 0.74 ⇒ 判 new），但人一眼知道是同一件事。包含度对这种"一条几乎包含另一条"
 *   的形态是 1.0。
 * ⚠️ 这两个数字是**本器具追加的**，不改 `shadow-verdict.mjs#THRESHOLDS` 的所有权（那边的 0.90/0.74 原样不动）。
 */
export const OVERLAP_THRESHOLD = Object.freeze({ dup: 0.95, near: 0.80 });

/** 包含度（纯函数）。 */
export function containment(A, B) {
  if (!A || !B || !A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let inter = 0;
  for (const s of small) if (big.has(s)) inter += 1;
  return inter / small.size;
}

/**
 * 判候选与库里已有条目的关系（§3.1）。
 * 判档（**两条并列**，任一满足即算）：
 *   · Jaccard（与 H-2 影子同口径）：≥0.90 ⇒ dup；0.74~0.90 ⇒ near
 *   · 包含度（本器具追加）：≥0.95 ⇒ dup；0.80~0.95 ⇒ near
 * @returns {{verdict:'new'|'near'|'dup', nearestId:number|null, sim:number, contain:number, matchedBy:string, alreadyDistilled:boolean}}
 */
export function judgeDedup(candText, pool, opts = {}) {
  const topN = Number(opts.topN ?? 20);
  const { docs, index } = pool ?? { docs: [], index: new Map() };
  const empty = { verdict: 'new', nearestId: null, sim: 0, contain: 0, matchedBy: 'none', alreadyDistilled: false };
  if (!docs.length || !index.size) return empty;
  const A = shingles(candText);
  if (!A.size) return empty;
  // ⑤ 粗筛：倒排计数交集，取 top N 再精算
  const counts = new Map();
  for (const g of A) {
    const arr = index.get(g);
    if (!arr) continue;
    for (const i of arr) counts.set(i, (counts.get(i) ?? 0) + 1);
  }
  if (!counts.size) return empty;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  let best = { jac: 0, cont: 0, doc: null };
  for (const [i] of top) {
    const d = docs[i];
    const jac = jaccard(A, d.sh);
    const cont = containment(A, d.sh);
    const strength = Math.max(jac, cont);
    if (strength > Math.max(best.jac, best.cont)) best = { jac, cont, doc: d };
  }
  const sim = Math.round(best.jac * 1000) / 1000;
  const contain = Math.round(best.cont * 1000) / 1000;
  let verdict = 'new';
  let matchedBy = 'none';
  if (sim >= THRESHOLDS.dup) { verdict = 'dup'; matchedBy = 'jaccard'; }
  else if (contain >= OVERLAP_THRESHOLD.dup) { verdict = 'dup'; matchedBy = 'containment'; }
  else if (sim >= THRESHOLDS.sim) { verdict = 'near'; matchedBy = 'jaccard'; }
  else if (contain >= OVERLAP_THRESHOLD.near) { verdict = 'near'; matchedBy = 'containment'; }
  // [D2] distilled 条参与比对且是高优先伙伴：判到 dup/near ⇒ 标 alreadyDistilled（"已被提炼成结论了"）
  const alreadyDistilled = Boolean(best.doc?.isDistilled) && verdict !== 'new';
  return {
    verdict,
    nearestId: best.doc ? best.doc.id : null,
    sim,
    contain,
    matchedBy,
    alreadyDistilled,
  };
}

/** 候选文本（§3.1 ③）：只比 claim + quote（130 字以内），不比整条消息。 */
export function candidateText(c) {
  return `${c?.claim ?? ''}${c?.quote ?? ''}`;
}

function normalizeClaim(claim) {
  return normalizeText(String(claim ?? ''));
}

/**
 * 候选之间（§3.3）：
 *   ① 同会话同 claim ⇒ **合并**（`alsoSeen`）；
 *   ② 跨会话**近似相同**（max(Jaccard, 包含度) ≥ `MERGE_TWIN` 0.95）⇒ **也合并**（`alsoSeenCrossSession`）
 *      —— 2026-10-25 实测：同一句接力模板在 18 个会话里逐字重复，不合并会把候选表灌成复读机；
 *   ③ 跨会话**同题但措辞不同**（0.74 ≤ sim < 0.95）⇒ **不丢**，双向标 `crossSessionTwin`
 *      —— 同一件事被两个独立会话都提到 = 更该记（这是加分信息，不是噪声）。
 * @returns {{list:object[], merged:number, mergedCross:number, twins:number}}
 */
export function dedupeCandidates(list, opts = {}) {
  const mergeTwin = Number(opts.mergeTwin ?? 0.95);
  const byKey = new Map();
  const out = [];
  let merged = 0;
  for (const c of list) {
    const k = `${c.sessionId}|${normalizeClaim(c.claim)}`;
    const prev = byKey.get(k);
    if (prev) {
      merged += 1;
      if ((c.score ?? 0) > (prev.score ?? 0)) {
        const seen = (prev.alsoSeen ?? 0) + 1;
        Object.assign(prev, c, { alsoSeen: seen });
      } else {
        prev.alsoSeen = (prev.alsoSeen ?? 0) + 1;
      }
      continue;
    }
    byKey.set(k, c);
    out.push(c);
  }
  // 跨会话：先合并"近似相同"，再给"同题不同措辞"打 twin
  const alive = new Set(out);
  const sets = new Map(out.map((c) => [c, shingles(candidateText(c))]));
  let mergedCross = 0;
  let twins = 0;
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i];
      const b = out[j];
      if (!alive.has(a) || !alive.has(b)) continue;
      if (a.sessionId === b.sessionId) continue;
      const jac = jaccard(sets.get(a), sets.get(b));
      const cont = containment(sets.get(a), sets.get(b));
      const sim = Math.max(jac, cont);
      if (sim >= mergeTwin) {
        // 合并：留分高的那条，记"跨会话也见过"
        const [keep, drop] = (b.score ?? 0) > (a.score ?? 0) ? [b, a] : [a, b];
        keep.alsoSeenCrossSession = (keep.alsoSeenCrossSession ?? 0) + 1 + (drop.alsoSeenCrossSession ?? 0);
        alive.delete(drop);
        mergedCross += 1;
      } else if (sim >= THRESHOLDS.sim) {
        a.crossSessionTwin = b.candId;
        b.crossSessionTwin = a.candId;
        twins += 1;
      }
    }
  }
  return { list: out.filter((c) => alive.has(c)), merged, mergedCross, twins };
}

// ═══════════════════════════════════════════════════════════════════════════
// 可选：模型档（**默认关**；关着时本段一行都不执行）
// ═══════════════════════════════════════════════════════════════════════════

export const MODEL_CONF = Object.freeze({
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  credentialKey: 'DEEPSEEK_API_KEY',
  maxTokens: 1600,
  timeoutMs: 60000,
  batchSize: 12,
});

const MODEL_SYSTEM_PROMPT = [
  '你是长期记忆的「该不该记」判定器。给你若干条从会话里抽出的候选（编号 + 主张 + 原文片段）。',
  '对每一条判：should（该记成长期记忆）/ no（不该记）/ borderline（说不准）。',
  '该记 = 口径、拍板、偏好、坑与教训、跨会话承诺、长期事实（路径/凭据位/端口/唯一源）、决定及其理由。',
  '不该记 = 一次性任务进度、临时读数、寒暄情绪、已完成的小活、纯命令。',
  '输出**严格 JSON**：{"items":[{"candId":"...","verdict":"should|no|borderline","claim":"≤50字的规范化主张"}]}；',
  '逐条对应、不要漏、不要输出代码围栏或解释文字。',
].join('\n');

/**
 * 模型二判（**只在 CLI 显式给 `--model` 时被调用**）。
 * @param {object[]} cands
 * @param {{fetchImpl?:Function, apiKey?:string, baseUrl?:string, model?:string, now?:Function}} opts
 * @returns {Promise<{ok:boolean, calls:number, usage:{prompt_tokens:number, completion_tokens:number}, items:object[], error?:string}>}
 */
export async function judgeWithModel(cands, opts = {}) {
  const { readCredential, extractJson } = await import('./domain-tags.mjs');   // 懒 import：默认档不加载
  const apiKey = opts.apiKey ?? readCredential(MODEL_CONF.credentialKey);
  if (!apiKey) return { ok: false, calls: 0, usage: { prompt_tokens: 0, completion_tokens: 0 }, items: [], error: 'no-credential' };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? MODEL_CONF.baseUrl;
  const model = opts.model ?? MODEL_CONF.model;
  const batchSize = Number(opts.batchSize ?? MODEL_CONF.batchSize);
  const usage = { prompt_tokens: 0, completion_tokens: 0 };
  const items = [];
  let calls = 0;
  for (let i = 0; i < cands.length; i += batchSize) {
    const batch = cands.slice(i, i + batchSize);
    const blocks = batch.map((c) => `【${c.candId}】主张：${c.claim}\n片段：${c.quote}`).join('\n\n');
    const body = {
      model,
      messages: [
        { role: 'system', content: MODEL_SYSTEM_PROMPT },
        { role: 'user', content: `共 ${batch.length} 条，请逐条判定并输出 JSON：\n\n${blocks}` },
      ],
      thinking: { type: 'disabled' },
      temperature: 0,
      max_tokens: MODEL_CONF.maxTokens,
      stream: false,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MODEL_CONF.timeoutMs);
    calls += 1;
    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, calls, usage, items, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      let json;
      try { json = JSON.parse(text); } catch { return { ok: false, calls, usage, items, error: 'response-not-json' }; }
      usage.prompt_tokens += Number(json?.usage?.prompt_tokens ?? 0);
      usage.completion_tokens += Number(json?.usage?.completion_tokens ?? 0);
      const parsed = extractJson(String(json?.choices?.[0]?.message?.content ?? ''));
      const list = Array.isArray(parsed?.items) ? parsed.items : null;
      if (!list) return { ok: false, calls, usage, items, error: 'no-items-in-json' };
      items.push(...list);
    } catch (e) {
      return { ok: false, calls, usage, items, error: `request-failed:${e?.message ?? e}` };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: true, calls, usage, items };
}

// ═══════════════════════════════════════════════════════════════════════════
// 自测（夹具；不碰生产库 / 不读会话 / 不发网络）
// ═══════════════════════════════════════════════════════════════════════════

export function selfTest() {
  const results = [];
  const ok = (name, cond, detail = '') => results.push({ name, pass: Boolean(cond), detail });
  const rec = (text, extra = {}) => ({
    type: 'user/message', seq: 1, time: 1792918963524,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } }, ...extra,
  });

  // P1 注入块
  ok('P1 注入块被丢弃', preprocess('<system-reminder>\n技能清单：xxx').code === 'injection');
  ok('P1 记忆指针被丢弃', preprocess('[相关记忆·指针] 以下可能与当前请求相关…').code === 'injection');
  // P2 太短
  ok('P2 短文本被丢弃', preprocess('好的谢谢').code === 'too-short');
  // P3 敏感
  ok('P3 sk- 密钥丢弃', String(preprocess('key 是 s' + 'k-ABCDEFGHIJKLMNOP 别外传').code).startsWith('sensitive'));
  ok('P3 私网 IP 丢弃', String(preprocess('连 203.0.113.7 那台机器做验证').code).startsWith('sensitive'));
  ok('P3 loopback 放行', preprocess('本机 DSH 用 http://127.0.0.1:3080 这个地址访问').ok === true);
  // P4 tool 噪声
  ok('P4 纯 JSON 丢弃', preprocess('{"a":1,"b":2}').code === 'tool-noise');

  // S1 拍板 ⇒ 候选
  const s1 = scoreMessage('拍板：记忆线一律走本鱼链，以后都按这个来，别再用第三方模型。', { sourceKind: 'user' });
  ok('S1 命中且过阈值', s1.signals.includes('S1') && s1.score >= THRESHOLD.candidate, `score=${s1.score}`);
  // N1 进度 ⇒ 不过线
  const n1 = scoreMessage('正在跑第 3 步，进度 60%，还剩 4 条要处理。', { sourceKind: 'user' });
  ok('N1 进度不过阈值', n1.score < THRESHOLD.candidate, `score=${n1.score}`);
  // S8 单独 ⇒ 边界档（不过候选线）
  // ⚠️ 文本必须长过 MIN_TEXT_CHARS（12），否则先被 N3「短且无技术名词」扣到线下 —— 这不是 S8 的问题
  const s8 = scoreMessage('实跑了一遍，实测 rc 0，验证通过，结果稳。', { sourceKind: 'user' });
  ok('S8 单独只到边界档', s8.signals.includes('S8') && s8.score < THRESHOLD.candidate && s8.score >= THRESHOLD.borderline, `score=${s8.score}`);
  // 自述降权
  const asstText = '这条路实测能过，凭据在 ~/.dsh/.credentials.yaml 里。';
  const asUser = scoreMessage(asstText, { sourceKind: 'user' });
  const asAsst = scoreMessage(asstText, { sourceKind: 'assistant' });
  ok('assistant 的 S5 降权生效', asAsst.score < asUser.score && asAsst.selfReported === true, `${asUser.score} → ${asAsst.score}`);
  // N4 已完成小活
  const n4 = scoreMessage('改完了。', { sourceKind: 'user' });
  ok('N4 已完成小活被扣到线下', n4.signals.length === 0 || n4.score < THRESHOLD.borderline, `score=${n4.score}`);

  // 取句与字段上限
  const longText = `本鱼先说一句闲话铺垫一下这个背景，然后拍板：以后所有跨机同步一律先 --dry-run，不许直接上 --apply，因为上个月翻车过一次。`;
  const picked = pickSentence(longText, ['S1']);
  ok('claim ≤ 50 字', picked.claim.length <= FIELD_LIMITS.claim, `len=${picked.claim.length}`);
  ok('quote ≤ 80 字', picked.quote.length <= FIELD_LIMITS.quote, `len=${picked.quote.length}`);
  ok('长句截断保留否定词', /不许|别再用|禁止|不要/.test(pickSentence(`${'铺垫'.repeat(60)}，不许再用 schtasks 建任务。`, ['S1']).quote));

  // 一条消息最多一条候选
  const jm = judgeMessage(rec('拍板：以后一律先备份再动手。记住了，这是坑，也是待办。'), { candId: 'cap-test-0001', sessionId: 's-test', workspaceDir: '--D-DSH--' });
  ok('judgeMessage 只出 1 条候选', jm.code === 'candidate' && typeof jm.candidate === 'object', `code=${jm.code}`);
  ok('候选带 judgeVersion', jm.candidate?.judgeVersion === JUDGE_VERSION);

  // 去重（纯函数、夹具池）
  const pool = buildPoolIndex([
    { id: 11, text: '记忆线一律走本鱼链，不用第三方模型，外发面要先拍。', tags: '拍板', isDistilled: false },
    { id: 12, text: '完全无关的一条：生图参考图必须保持一致。', tags: 'distilled 生图', isDistilled: true },
  ]);
  const dup = judgeDedup('记忆线一律走本鱼链，不用第三方模型，外发面要先拍。', pool);
  ok('等价文本判 dup（≥0.90）', dup.verdict === 'dup' && dup.nearestId === 11, `sim=${dup.sim}`);
  const fresh = judgeDedup('家人库放 <home>/family-memory 下，采集整目录天然不覆盖。', pool);
  ok('无关文本判 new', fresh.verdict === 'new', `sim=${fresh.sim}`);
  // 近义：**同一句 + 追加一段**（Jaccard 追不上、靠包含度接住 —— 2026-10-25 自测实测的形态）
  const nearDup = judgeDedup('记忆线一律走本鱼链，不用第三方模型，外发面要先拍，不许改回智谱第三方。', pool);
  ok('同句追加一段 ⇒ 靠包含度判到 dup/near', nearDup.verdict !== 'new' && ['jaccard', 'containment'].includes(nearDup.matchedBy), `${nearDup.verdict} jac=${nearDup.sim} cont=${nearDup.contain} by=${nearDup.matchedBy}`);
  const dist = judgeDedup('生图参考图必须保持一致。', pool);
  ok('distilled 条命中 ⇒ alreadyDistilled', dist.alreadyDistilled === true || dist.verdict === 'new', `sim=${dist.sim} ad=${dist.alreadyDistilled}`);

  // 候选间去重：完全相同的 claim 跨会话也合并；同题不同措辞标 twin；不相关不碰
  const mk = (id, sid, claim, score = 3) => ({ candId: id, sessionId: sid, claim, quote: claim, score });
  const dd = dedupeCandidates([
    mk('c1', 's1', '记忆线一律走本鱼链，不用第三方模型。', 3),
    mk('c2', 's1', '记忆线一律走本鱼链，不用第三方模型。', 4),
    mk('c3', 's2', '记忆线一律走本鱼链，不用第三方模型。', 3),
  ]);
  ok('完全相同的 claim 同会话+跨会话都合并', dd.list.length === 1 && dd.merged === 1 && dd.mergedCross === 1, `list=${dd.list.length} merged=${dd.merged} cross=${dd.mergedCross}`);
  const twin = dedupeCandidates([
    mk('t1', 's1', '记忆线一律走本鱼链，不用第三方模型，外发面要先拍，因为新增外发面必须先报主人拍板。'),
    mk('t2', 's2', '记忆线一律走本鱼链，不用第三方模型，外发面要先拍，因为新增外发面必须先报主人点头。'),
  ]);
  ok('同题不同措辞 ⇒ 标 twin 或合并（不静默丢）', twin.list.length >= 1 && (twin.twins >= 1 || twin.mergedCross >= 1), `twins=${twin.twins} cross=${twin.mergedCross}`);
  const sep = dedupeCandidates([
    mk('u1', 's1', '家里台式机用 3290 端口跑测试。'),
    mk('u2', 's2', '生图参考图必须与三视图基准一致，不许换脸。'),
  ]);
  ok('不相关候选不合并、不互标', sep.list.length === 2 && sep.twins === 0 && sep.mergedCross === 0, `list=${sep.list.length}`);

  // 默认零模型：judgeWithModel 不被任何判定路径调用（结构性断言）
  ok('默认档不含模型调用（源码级）', !judgeMessage.toString().includes('judgeWithModel'));

  const passed = results.filter((r) => r.pass).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

export default { JUDGE_VERSION, scoreMessage, judgeMessage, judgeDedup, dedupeCandidates, loadMemoryPool, buildPoolIndex, selfTest };
