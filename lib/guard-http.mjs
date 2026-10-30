// HTTP「还活着吗」的判据 —— 纯函数，零依赖，不读盘、不联网、不起进程。
//
// 它只回答一个问题：一次探测拿回来的状态码，能不能当作"服务在监听"。
// 传输怎么探测（用 curl 还是内置 http、超时给多少）留在各自的调用方，本件不插嘴。
//
// 为什么不能只认 200：带 cookie token 认证的构建，匿名访问根路径会回 401 ——
// 那恰恰证明 HTTP 层还站着、还在应答、只是拒绝没凭证的请求。若判据是"必须 200"，
// 一个健康的进程会被当成死掉，杀死、拉起、再杀死，越修越坏。
//
// 定下的口径（按顺序取第一条命中的）：
//   2xx          活 —— 最老的口径，必须继续认
//   3xx          活 —— 认证通过后落到 cookie 的跳转；重定向本身就是应用在处理请求
//   401 / 403    活 —— 授权类拒绝，说明"有个 HTTP 服务在答话"
//   404          不活 —— 正常部署下根路径不该 404；出现了说明占着端口的是别的东西
//   其它 4xx     不活 —— 与老口径保持一致：宁可多探一轮重拉，也不把陌生应答当健康
//   5xx          不活 —— 进程在但应用层还没就绪，保留"再探、必要时重启"
//   000 / 非数字  不活 —— 无应答、超时、解析不了，一律不算活（未知不当健康）
//
// 状态码判定只写在这里：调用方拿 judgeHttp 的结果，别在业务代码里再写一遍整数比较。

/** 口径版本：写进日志与报告，事后能对上"当时跑的是哪一版判据" */
export const RULE_VERSION = 'h1-20260922';

/** 判活的状态码集合（对外公布的一份，供文档与别的工具复用） */
export const ALIVE_CODES = [200, 204, 301, 302, 303, 307, 308, 401, 403];

/** 判活规则的一句话说明（报告 / 日志 / 帮助文本共用） */
export const ALIVE_RULE_TEXT = '2xx/3xx/401/403 = 活；404 等其它 4xx、5xx、无应答 = 不活';

const DIGITS_3 = /^\d{3}$/;

// 判定表：自上而下取第一条命中的。顺序本身是语义 —— 401/403/404 必须排在
// "其它 4xx" 之前，否则永远轮不到它们。
const VERDICT_TABLE = [
  { reason: 'ok-2xx', alive: true, accept: (code) => code >= 200 && code <= 299 },
  { reason: 'redirect-3xx', alive: true, accept: (code) => code >= 300 && code <= 399 },
  { reason: 'auth-401', alive: true, accept: (code) => code === 401 },
  { reason: 'auth-403', alive: true, accept: (code) => code === 403 },
  { reason: 'not-found-404', alive: false, accept: (code) => code === 404 },
  { reason: 'client-4xx', alive: false, accept: (code) => code >= 400 && code <= 499 },
  { reason: 'server-5xx', alive: false, accept: (code) => code >= 500 && code <= 599 },
];

/** 统一的结果形状 —— 四个字段恒定，不按分支增减 */
function report(code, alive, reason) {
  return { code, alive, reason, rule: RULE_VERSION };
}

/**
 * 解析探测命令打印出来的状态码。
 * 只认严格的三个数字：无应答时的 `000` 会解析成 0，`abc`、空串、`20x` 这类一律 null。
 * @param {unknown} raw
 * @returns {number|null}
 */
export function parseHttpCode(raw) {
  const text = String(raw ?? '').trim();
  if (!DIGITS_3.test(text)) return null;
  return Number(text);
}

/**
 * 判活并给出理由（消费者只需要这一个入口）。
 * @param {unknown} raw 探测输出里的状态码原串
 * @returns {{ code: number|null, alive: boolean, reason: string, rule: string }}
 *   reason ∈ ok-2xx | redirect-3xx | auth-401 | auth-403 | not-found-404 |
 *            client-4xx | server-5xx | no-answer | unparsable
 */
export function judgeHttp(raw) {
  const code = parseHttpCode(raw);
  if (code === null) return report(null, false, 'unparsable');
  if (code === 0) return report(0, false, 'no-answer');
  for (const row of VERDICT_TABLE) {
    if (row.accept(code)) return report(code, row.alive, row.reason);
  }
  // 三位数字但落在 1xx / 6xx 之后：没见过的区间，交给"未知不算活"
  return report(code, false, 'unparsable');
}

/** 只要一个布尔值（与老的探测函数返回形状对齐，调用方改一行就能接上） */
export function isHttpAlive(raw) {
  return judgeHttp(raw).alive;
}

/** 一行日志描述：`code=401 (auth-401)` / `no-answer (code=000)` / `unparsable` */
export function describeHttp(raw) {
  const judged = judgeHttp(raw);
  if (judged.code === null) return judged.reason;
  if (judged.code === 0) return 'no-answer (code=000)';
  return `code=${judged.code} (${judged.reason})`;
}
