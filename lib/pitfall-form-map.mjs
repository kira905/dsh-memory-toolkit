// 错误码 / 签名 → 建议形态：查表在前，启发式在后。
//
// 一个坑反复踩，就得替它挑一个"以后怎么才能不再踩"的落点，形态只有三种：
//   check    —— 能脚本化判定的，做成自动检查项（最优：坑不再有第二次机会）
//   skill    —— 只在动手那一刻要看到的，内联进相关技能（加载即见）
//   persona  —— 真正全局、反复踩的铁律级，才值得动 persona
//
// 为什么不能全靠文本特征猜：成因确定的坑，文本里往往只留下表象。举例来说，
// "写保护区没先走审计"这种坑的文本里会带一串路径，按文本猜出来就成了"路径存在性预检"，
// 方向完全错了。已知错误码的坑，成因是确定的 —— 先让表说话；表里没有，再交回启发式。
//
// 判定顺序（命中即返回，不往下走）：
//   ① 错误码：pitfall.code → sigKey 的第 2 段 → normText 里出现的 SCREAMING_SNAKE
//   ② 签名正则：没有稳定错误码、只能靠文本特征认的坑走这条
//   ③ 都没命中 → 返回 null，由调用方回落到原来的启发式
//
// 本件是纯数据 + 纯函数：不读状态、不写盘、没有副作用。
// 加一个坑只需要加一条规则（列表里加一项就行），面板与渲染侧不用改。

export const FORM_MAP_VERSION = '0.1.0';

// 规则工厂：按固定字段顺序拼出规则对象，缺的可选字段不占位（保持对象形状干净）
function rule({ id, codes, sigRe, form, why }) {
  const built = { id };
  if (codes) built.codes = codes;
  if (sigRe) built.sigRe = sigRe;
  built.form = form;
  built.why = why;
  return built;
}

export const FORM_RULES = [
  rule({
    id: 'audit-not-passed', codes: ['AUDIT_NOT_PASSED'], form: 'skill',
    why: '流程类（不是路径问题）：写 persona / 技能 / 核心启动链前必须「先落临时文件 → butler-audit-cli 审计 → 用 write 写同一内容」；建议内联进 persona-maintain / P5 写入守门人相关技能',
  }),
  rule({
    id: 'audit-hash-mismatch', codes: ['AUDIT_HASH_MISMATCH'], form: 'skill',
    why: '流程类：审计凭证与被写内容 hash 绑定——一处一审计、改完再验 hash，staged 内容必须与写入内容逐字节一致；建议内联进 persona-maintain 技能',
  }),
  rule({
    id: 'fs-not-observed', codes: ['FS_NOT_OBSERVED'], form: 'persona',
    why: '铁律级（全局、高频）：改/覆盖已存在文件前必须先 read；已进 persona【铁律·edit/write 必须先读】，此处不再新增检查项',
  }),
  rule({
    id: 'fs-stale-version', codes: ['FS_STALE_VERSION'], form: 'persona',
    why: '铁律级（全局）：junction 路径与同文件多处修改必须重读后**串行 edit**（并行 edit 会互相刷新 mtime）；已进 persona 对应铁律',
  }),
  rule({
    id: 'search-failed', codes: ['SEARCH_FAILED'], form: 'check',
    why: '路径假设类：rg/grep/glob 目标不存在或不可达，可做成"搜索前先验路径存在"的只读检查项',
  }),
];

// 码 → 规则（大小写不敏感；后注册者覆盖前者，与表内顺序一致）
const RULE_BY_CODE = new Map();
for (const entry of FORM_RULES) {
  for (const code of entry.codes ?? []) RULE_BY_CODE.set(String(code).toUpperCase(), entry);
}

/** SCREAMING_SNAKE 形态的错误码（至少一个下划线 —— 免得把 FsError 这类类名当码） */
export const ERROR_CODE_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

// 拿不到 code 时签名里写的占位，不是真错误码
const PLACEHOLDER_CODES = new Set(['NO_CODE']);

// 单个码的"像不像码"判据（提取与查表口径一致：大写 + 恰好的形态）
const CODE_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

function asCode(value) {
  const upper = String(value ?? '').toUpperCase().trim();
  if (!upper) return null;
  if (PLACEHOLDER_CODES.has(upper)) return null;
  return CODE_SHAPE.test(upper) ? upper : null;
}

/**
 * 按优先级把这条坑里出现的错误码捞出来。
 * @param {object} pitfall
 * @returns {string[]} 去重后的候选码，越靠前越权威
 */
export function extractErrorCodes(pitfall) {
  const found = [];
  const remember = (value) => {
    const code = asCode(value);
    if (code && !found.includes(code)) found.push(code);
  };

  remember(pitfall?.code);

  const signature = String(pitfall?.sigKey ?? '');
  if (signature) {
    remember(signature.split('|')[1]);
    for (const hit of signature.matchAll(ERROR_CODE_RE)) remember(hit[1]);
  }

  const body = String(pitfall?.normText ?? '');
  if (body) {
    for (const hit of body.matchAll(ERROR_CODE_RE)) remember(hit[1]);
  }
  return found;
}

// 命中结果的统一形状（why 前面挂规则 id，便于日志里直接看出"哪条规则判的"）
function mapped(entry, via, matched) {
  return { form: entry.form, why: `【映射表 ${entry.id}】${entry.why}`, ruleId: entry.id, via, matched };
}

/**
 * 查表：错误码优先，其次签名正则。
 * @param {object} pitfall
 * @returns {{form:'check'|'skill'|'persona', why:string, ruleId:string, via:'code'|'sig', matched:string}|null}
 *   未命中返回 null（调用方回落启发式）
 */
export function lookupFormByMap(pitfall) {
  for (const code of extractErrorCodes(pitfall)) {
    const entry = RULE_BY_CODE.get(code);
    if (entry) return mapped(entry, 'code', code);
  }

  const haystack = [pitfall?.name, pitfall?.code, pitfall?.sigKey, pitfall?.normText]
    .map((part) => String(part ?? ''))
    .join('|');
  for (const entry of FORM_RULES) {
    if (!entry.sigRe) continue;
    if (!entry.sigRe.test(haystack)) continue;
    return mapped(entry, 'sig', String(entry.sigRe));
  }
  return null;
}

/** 这个码表里有没有（面板 / 调试用） */
export function isMappedCode(code) {
  return RULE_BY_CODE.has(String(code ?? '').toUpperCase());
}

/** 表内全部错误码，字典序（单测断言用） */
export function mappedCodes() {
  return [...RULE_BY_CODE.keys()].sort();
}
