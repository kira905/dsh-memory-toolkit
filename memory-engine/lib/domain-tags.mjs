// 域标签补齐 —— 给存量记忆条追加「家庭 / 工作 / 健康 / 技术 / DSH生态 / 梗」这几类域标签
//
// 口径（每条都有出处，动之前先看这里）：
//   · 域标签是**追加**到 tags 尾部，绝不覆盖原有标签；
//   · 幂等键 = (条 id, 域标签集哈希)：写之前逐个 token 判重，已含就跳过。
//     别拿「批次游标」当幂等键 —— 那样重复执行会把同一批标签一遍遍往 tags 上堆；
//   · 动手前先 VACUUM INTO 快照，写坏了可以整表还原；
//   · 并发：busy_timeout + 最多 3 次重试，退避累计封顶 60 秒；
//   · 成本闸：每日 ≤20 次调用、≤150K token，触顶即停（不重试）并记账；
//   · 分批跑、可中断续跑（台账落 state 文件，逐条幂等）；
//   · 从严口径：只有 owner_user == 本机 owner 的条才送分类模型，判不出归属的跳过并记账 ——
//     宁可漏标，不可错送。
//
// 两个刻意的决定（防止将来「照字面改」踩坑）：
//   ① 模型输出只用来追加标签、不产生别的写入 ⇒ 半完成态无害；
//   ② 追加标签不动 updated_at —— 否则这批老条会被顶到召回段最前，
//      提炼窗口也会把它们误判成「新内容」。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// ── 常量 ────────────────────────────────────────────────────────────────────

// 域标签集（显示名；落库前统一小写）
export const DOMAIN_TAGS = Object.freeze(['家庭', '工作', '健康', '技术', 'DSH生态', '梗']);

// 显示名 → 落库 token；tags 一律按插件那条 normalizeTags 的口径小写化（DSH生态 → dsh生态）
export const normalizeTag = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-');

// 显示名 → 规范 token 的查表（兼容大小写与多余空白的输入写法）
export const DOMAIN_TOKEN_BY_LABEL = Object.freeze(
  Object.fromEntries(DOMAIN_TAGS.map((label) => [label, normalizeTag(label)])),
);
export const DOMAIN_TOKENS = Object.freeze(DOMAIN_TAGS.map((label) => normalizeTag(label)));

// 成本闸默认值（与提炼那条链同一档）
export const COST_LIMITS = Object.freeze({ callsPerDay: 20, tokensPerDay: 150000 });

// 并发保护默认值
export const RETRY = Object.freeze({
  busyTimeoutMs: 5000,
  maxAttempts: 3,
  backoffMs: [1000, 4000, 16000],
  totalCapMs: 60000,
});

// 分类模型默认档：记忆线统一走本鱼链，不用更贵的强推理档，也不许改回第三方
export const DEFAULT_LLM = Object.freeze({
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  credentialKey: 'DEEPSEEK_API_KEY',
  maxTokens: 2048,
  timeoutMs: 60000,
});

export const STATE_SCHEMA = 1;

// ── 小工具 ──────────────────────────────────────────────────────────────────

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const FIELD_SEP = 0x2c; // 分隔符：防 "ab"+"c" 与 "a"+"bc" 撞成同一个哈希

// 域标签集 → 短哈希（幂等键的右半）。轻量 FNV-1a：只用来比「集合变没变」，不需要密码学强度。
export const tagSetHash = (tokens) => {
  const sorted = [...new Set(tokens.map(normalizeTag).filter(Boolean))].sort();
  let h = FNV_OFFSET;
  for (const token of sorted) {
    for (let i = 0; i < token.length; i += 1) {
      h = Math.imul(h ^ token.charCodeAt(i), FNV_PRIME) >>> 0;
    }
    h = Math.imul(h ^ FIELD_SEP, FNV_PRIME) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, '0')}`;
};

// tags 文本 → token 数组（空白分隔，与插件落库形态一致）
export const tokensOf = (tags) => String(tags ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);

// 该条已经带了哪些域标签：token 级精确比较（`工作记录` 不算带了 `工作`）
export const domainTokensIn = (tags) => {
  const present = new Set(tokensOf(tags));
  return DOMAIN_TOKENS.filter((token) => present.has(token));
};

// 输入写法 → 规范 token；不在固定集合里的一律丢（模型自创词不落库）
const resolveDomainToken = (raw) => {
  const label = String(raw ?? '').trim();
  const direct = DOMAIN_TOKEN_BY_LABEL[label];
  if (direct) return direct;
  const normalized = normalizeTag(label);
  return DOMAIN_TOKENS.find((token) => token === normalized) ?? null;
};

// 追加域标签（幂等）：只往尾部补缺席的那些，返回新文本 + 实际新增 / 已存在的清单
export const appendDomainTags = (existingTags, domainLabelsOrTokens) => {
  const tokens = tokensOf(existingTags);
  const present = new Set(tokens);
  const wanted = [];
  const picked = new Set();
  for (const raw of domainLabelsOrTokens) {
    const token = resolveDomainToken(raw);
    if (!token || picked.has(token)) continue;
    picked.add(token);
    wanted.push(token);
  }
  const added = wanted.filter((token) => !present.has(token));
  const alreadyPresent = wanted.filter((token) => present.has(token));
  return { tags: tokens.concat(added).join(' '), added, alreadyPresent, wanted };
};

// ── 库操作 ──────────────────────────────────────────────────────────────────

// 打开库：默认只读；write:true 时带 busy_timeout。node:sqlite 的第二参不吃 undefined ⇒ 分支显式构造
export const openDb = (dbPath, { write = false } = {}) => {
  const db = write ? new DatabaseSync(dbPath) : new DatabaseSync(dbPath, { readOnly: true });
  if (write) db.exec(`PRAGMA busy_timeout = ${RETRY.busyTimeoutMs}`);
  return db;
};

// 一次事务尝试：BEGIN → 体 → COMMIT；体里或提交时出错都回滚，并把原始错误往外抛
const attemptTransaction = (db, fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 回滚也失败就保持原始错误（第二个错误没有诊断价值）
    }
    throw err;
  }
};

/**
 * 带重试的写事务执行器：busy 才等，其它错误立刻收手；超限不抛错，返回 {ok:false, error}。
 * @param {object} db - 写连接
 * @param {() => any} fn - 事务体
 * @param {{sleep?:Function, now?:Function}} [deps] - 单测注入用（不真等）
 */
export const withBusyRetry = async (db, fn, deps = {}) => {
  const nap = deps.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const t0 = Date.now();
  let waited = 0;
  let lastError = null;

  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt += 1) {
    try {
      return { ok: true, value: attemptTransaction(db, fn), attempts: attempt, waitedMs: waited };
    } catch (err) {
      lastError = err;
      const text = String(err && err.message ? err.message : err);
      if (!/busy|locked/i.test(text) || attempt === RETRY.maxAttempts) break;

      const backoff = RETRY.backoffMs[Math.min(attempt - 1, RETRY.backoffMs.length - 1)];
      const wouldOverrun = waited + backoff > RETRY.totalCapMs || Date.now() - t0 + backoff > RETRY.totalCapMs;
      if (wouldOverrun) {
        return {
          ok: false,
          attempts: attempt,
          error: `${text}（退避将超 ${RETRY.totalCapMs}ms 上限，停止重试）`,
          waitedMs: waited,
        };
      }
      await nap(backoff);
      waited += backoff;
    }
  }

  return {
    ok: false,
    attempts: RETRY.maxAttempts,
    error: String(lastError && lastError.message ? lastError.message : lastError),
    waitedMs: waited,
  };
};

// 读待处理条目（只读连接）：老库没有 owner_user 列时如实标记，由调用方按本机 owner 处理
export const readCandidates = (dbPath, { limit = 0, maxCharsPerItem = 240 } = {}) => {
  const db = openDb(dbPath);
  try {
    const columns = db.prepare('PRAGMA table_info(memories)').all().map((row) => row.name);
    const withOwner = columns.includes('owner_user');
    const projection = withOwner ? 'id, text, tags, owner_user, visibility' : 'id, text, tags';
    const rows = db.prepare(`SELECT ${projection} FROM memories ORDER BY id`).all();
    const items = rows.map((row) => {
      const text = String(row.text ?? '');
      return {
        id: row.id,
        text,
        tags: String(row.tags ?? ''),
        ownerUser: withOwner ? row.owner_user : null,
        visibility: withOwner ? row.visibility : null,
        textTruncated: text.length > maxCharsPerItem,
        textForModel: text.slice(0, maxCharsPerItem),
        existingDomains: domainTokensIn(row.tags),
      };
    });
    return { items: limit > 0 ? items.slice(0, limit) : items, ownerColumn: withOwner, columns };
  } finally {
    db.close();
  }
};

// ── 凭证与模型调用 ──────────────────────────────────────────────────────────

// 从 .credentials.yaml 读一个键：去引号、去行尾注释与 flow-map 逗号
export const readCredential = (keyName, credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml')) => {
  let text;
  try {
    text = fs.readFileSync(credFile, 'utf8');
  } catch {
    return null;
  }
  const hit = text.match(new RegExp(`^\\s*${keyName}\\s*:\\s*(.+?)\\s*$`, 'm'));
  if (!hit) return null;

  let value = hit[1].trim();
  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  if (quoted) value = value.slice(1, -1);
  value = value.replace(/\s+#.*$/, '').replace(/,\s*$/, '').trim();
  return value.length > 0 ? value : null;
};

// 分类提示词（system）：只许从固定集合里挑，只许输出 JSON
export const buildSystemPrompt = () => [
  '你是一个中文记忆条目的域分类器。给定若干条记忆（编号 + 正文），为每条从下列固定集合里选出适用的域标签：',
  `集合：${DOMAIN_TAGS.join(' / ')}`,
  '规则：',
  '1. 每条可给 0~3 个标签；不适用就返回空数组，不要硬凑。',
  '2. 只允许上面集合里的标签，逐字照抄（含大小写），不得自创、不得翻译、不得加解释。',
  '3. 判据看正文主旨：家人/家庭事务→家庭；工作/职场/公司/项目交付→工作；身体/睡眠/就医/健康习惯→健康；',
  '   编程/系统/工具/踩坑/技术方案→技术；DSH 生态自身的机制/插件/大管家/同步/生图栈→DSH生态；',
  '   段子/梗/玩笑/表情包/口癖→梗。一条可同时属技术与DSH生态。',
  `4. 输出**严格 JSON**，形如 {"items":[{"id":6,"domains":["技术"]}, {"id":7,"domains":[]}]}；`,
  '   不要输出 markdown 代码围栏、不要输出解释文字、不要遗漏输入的每一条。',
].join('\n');

// 分类提示词（user 侧）：批量正文，一行一条
export const buildUserPrompt = (items) => {
  const lines = items.map((item) => `[${item.id}] ${item.textForModel.replace(/\s+/g, ' ').trim()}`);
  return `共 ${items.length} 条，请逐条分类并按要求输出 JSON：\n\n${lines.join('\n')}`;
};

// 从模型回复里抠 JSON：容忍代码围栏与前后废话；抠不出来就 null（不抛）
export const extractJson = (content) => {
  const text = String(content ?? '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = fenced ? fenced[1] : text;
  const head = payload.indexOf('{');
  const tail = payload.lastIndexOf('}');
  if (head < 0 || tail <= head) return null;
  try {
    return JSON.parse(payload.slice(head, tail + 1));
  } catch {
    return null;
  }
};

// 呼叫体：分类任务不需要思考链，显式关掉省 token
const classifierRequestBody = ({ model, items, maxTokens }) => ({
  model,
  messages: [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(items) },
  ],
  thinking: { type: 'disabled' },
  temperature: 0.1,
  max_tokens: maxTokens,
  stream: false,
});

/** 调一次分类模型。`fetchImpl` 可注入 ⇒ 单测不真发网络。 */
export const callClassifier = async ({
  items,
  apiKey,
  baseUrl = DEFAULT_LLM.baseUrl,
  model = DEFAULT_LLM.model,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_LLM.timeoutMs,
  maxTokens = DEFAULT_LLM.maxTokens,
}) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(classifierRequestBody({ model, items, maxTokens })),
      signal: abort.signal,
    });

    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };

    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: `响应不是 JSON：${err.message}`, raw: text.slice(0, 300) };
    }

    const content = envelope?.choices?.[0]?.message?.content ?? '';
    const usage = envelope?.usage ?? {};
    const parsed = extractJson(content);
    if (!parsed) return { ok: false, error: '模型输出里找不到可解析的 JSON', raw: String(content).slice(0, 300), usage };

    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : null;
    if (!list) return { ok: false, error: 'JSON 结构不含 items 数组', raw: String(content).slice(0, 300), usage };
    return { ok: true, items: list, usage, content };
  } catch (err) {
    return { ok: false, error: `请求失败：${err && err.message ? err.message : err}` };
  } finally {
    clearTimeout(timer);
  }
};

// 保守估算一次批量调用的 token（中文约 1.4 字/token，另留输出余量），调用前用它预判成本闸
export const estimateTokens = (items) => {
  const bodyChars = items.reduce((sum, item) => sum + item.textForModel.length + 8, 0);
  return Math.ceil((bodyChars + buildSystemPrompt().length) / 1.4) + 300;
};

// ── state：可中断续跑 + 记账 ────────────────────────────────────────────────

const zeroCost = (day) => ({ date: day, calls: 0, promptTokens: 0, completionTokens: 0 });

export const defaultState = (dbPath, nowIso) => ({
  schemaVersion: STATE_SCHEMA,
  dbPath,
  updatedAt: nowIso,
  cost: zeroCost(String(nowIso).slice(0, 10)),
  processed: {},
  skipped: {},
  stats: { batches: 0, tagged: 0, noTag: 0, skippedOwner: 0, skippedUnknownDomain: 0, runs: 0 },
  lastDailyLine: null,
});

export const readState = (stateFile, dbPath, nowIso) => {
  const day = String(nowIso).slice(0, 10);
  const fresh = defaultState(dbPath, nowIso);
  let stored;
  try {
    if (!fs.existsSync(stateFile)) return fresh;
    stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return fresh; // 坏文件回落默认，绝不抛
  }
  const merged = {
    ...fresh,
    ...stored,
    cost: { ...fresh.cost, ...(stored.cost ?? {}) },
    stats: { ...fresh.stats, ...(stored.stats ?? {}) },
  };
  // 跨日 ⇒ 当日成本归零（成本闸是「每日」口径）
  if (merged.cost.date !== day) merged.cost = zeroCost(day);
  return merged;
};

export const writeState = (stateFile, state) => {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, stateFile);
  } catch {
    fs.copyFileSync(tmp, stateFile);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时件删不掉也无害
    }
  }
  return stateFile;
};

// 成本闸：还能不能再调一次（次数 / 已用 token / 本批估算三关）
export const costGate = (state, estimatedTokens, limits = COST_LIMITS) => {
  const calls = Number(state.cost.calls ?? 0);
  const spent = Number(state.cost.promptTokens ?? 0) + Number(state.cost.completionTokens ?? 0);
  if (calls >= limits.callsPerDay) return { ok: false, reason: `当日调用数已达上限 ${limits.callsPerDay} 次` };
  if (spent >= limits.tokensPerDay) return { ok: false, reason: `当日 token 已达上限 ${limits.tokensPerDay}` };
  if (spent + estimatedTokens > limits.tokensPerDay) {
    return { ok: false, reason: `本批估算 ${estimatedTokens} token 会超过当日上限（已用 ${spent}/${limits.tokensPerDay}）` };
  }
  return { ok: true };
};

// ── 快照 ────────────────────────────────────────────────────────────────────

// VACUUM INTO 快照（只读连接打开源库；目标存在就先删掉）
export const vacuumInto = (srcDbPath, destFile) => {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  if (fs.existsSync(destFile)) fs.rmSync(destFile);
  const db = openDb(srcDbPath);
  try {
    db.exec(`VACUUM INTO '${String(destFile).replace(/\\/g, '/').replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  if (!fs.existsSync(destFile)) throw new Error(`VACUUM INTO 未产出快照：${destFile}`);
  return destFile;
};

// ── 写回 ────────────────────────────────────────────────────────────────────

/**
 * 把一批分类结果写回（幂等 + 事务 + 重试）。只改 tags，不动 updated_at / created_at。
 * @returns {{written:number, unchanged:number, addedTokens:string[], details:Array}}
 */
export const applyResults = async (db, results, deps = {}) => {
  const outcome = await withBusyRetry(db, () => {
    const details = [];
    const addedTokens = [];
    let written = 0;
    let unchanged = 0;
    const readTags = db.prepare('SELECT tags FROM memories WHERE id = ?');
    const writeTags = db.prepare('UPDATE memories SET tags = ? WHERE id = ?');

    for (const result of results) {
      const row = readTags.get(result.id);
      if (!row) {
        details.push({ id: result.id, action: 'missing' });
        continue;
      }
      const merged = appendDomainTags(row.tags, result.domains);
      if (!merged.added.length) {
        unchanged += 1;
        details.push({
          id: result.id,
          action: merged.wanted.length ? 'already' : 'no-tag',
          tags: merged.tags,
          alreadyPresent: merged.alreadyPresent,
        });
        continue;
      }
      writeTags.run(merged.tags, result.id);
      written += 1;
      addedTokens.push(...merged.added);
      details.push({ id: result.id, action: 'tagged', tags: merged.tags, added: merged.added });
    }
    return { written, unchanged, details, addedTokens };
  }, deps);

  const done = outcome.value;
  return {
    ...outcome,
    written: done?.written ?? 0,
    unchanged: done?.unchanged ?? 0,
    addedTokens: done?.addedTokens ?? [],
    details: done?.details ?? [],
  };
};

// ── 日报一行（幂等段替换，口径同日报其它段） ─────────────────────────────────

export const DAILY_SECTION_TITLE = '## 🏷 记忆域标签（memory-domain-tags）';

// 一行摘要：模式 / 本轮批次 / 标签统计 / 跳过统计 / 当日成本，必要时补停机原因与台账条数
export const renderDailyLine = ({ mode, stats, cost, state, limits = COST_LIMITS, stoppedReason = null }) => {
  const spent = Number(cost.promptTokens ?? 0) + Number(cost.completionTokens ?? 0);
  const fields = [
    ['模式', mode],
    ['本轮批次', stats.batches ?? 0],
    ['新增标签条数', stats.tagged ?? 0],
    ['无标签', stats.noTag ?? 0],
    ['跳过(非本机owner)', stats.skippedOwner ?? 0],
    ['当日调用', `${cost.calls ?? 0}/${limits.callsPerDay}`],
    ['当日 token', `${spent}/${limits.tokensPerDay}`],
  ];
  const parts = fields.map(([label, value]) => `${label} ${value}`);
  if (stoppedReason) parts.push(`停机原因：${stoppedReason}`);
  if (state?.processedCount !== undefined) parts.push(`幂等台账 ${state.processedCount} 条`);
  return parts.join(' · ');
};

/** 日报里做「段级替换」：有同名段就换掉段体，没有就追加到文件尾；文件不存在则不新建。 */
export const updateDailySection = ({ file, line, dryRun = false }) => {
  if (!fs.existsSync(file)) return { ok: false, reason: '日报不存在（不新建）', file };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((row) => row.trim() === DAILY_SECTION_TITLE);
  const block = [DAILY_SECTION_TITLE, '', `> ${line}`, ''];

  let next;
  if (at < 0) {
    next = lines.concat(block);
  } else {
    // 段体 = 标题之后到下一个二级标题之前（紧跟标题的空行不算结束）
    let stop = at + 1;
    while (stop < lines.length && !(lines[stop].startsWith('## ') && stop > at + 1)) stop += 1;
    next = [...lines.slice(0, at), ...block, ...lines.slice(stop)];
  }

  if (!dryRun) fs.writeFileSync(file, next.join('\n'), 'utf8');
  return { ok: true, replaced: at >= 0, file };
};

// 当日日报路径：<docsDir>/管家报告/<YYYY-MM-DD>-<host>.md（与日报其它段同口径）
export const dailyReportPath = ({ docsDir = path.join(process.cwd(), 'docs'), host = null, now = Date.now() } = {}) => {
  const when = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  return path.join(docsDir, '管家报告', `${date}-${host || os.hostname()}.md`);
};
