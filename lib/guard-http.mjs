// ============================================================
//  guard-http.mjs · 守护鱼/分身「HTTP 存活判据」单一真源（H1 · 2026-09-22）
//  ------------------------------------------------------------
//  ⚠️ 本模块**纯函数、零依赖、零 IO**（不 import 任何东西、不碰网络/进程/文件）：
//     传输层（curl 调用形态）仍留在各消费者里（guard.mjs / repair.mjs），
//     本模块只回答一个问题 —— **"这个 HTTP 响应算不算'服务活着'"**。
//
//  为什么需要它（2026-09-17 升级硬前置 · 实测钉死）：
//    0.1.5-rc.2 起 dsh web 加了 cookie token 认证门：无 token 访问
//    `http://127.0.0.1:<port>/` → **401**（带 token → 303 落 cookie）。
//    旧判据 = 「必须 HTTP 200」（`(r.stdout||'').trim() === '200'`）⇒ 401 被判
//    "服务没起来" ⇒ KILL → 拉起 → 再杀 的死循环：主包一升 0.1.5，守护鱼就会
//    把生产 dsh 打进 KILL/CRASH。
//
//  口径（H1）：「**有 HTTP 应答即活**」，同时**保持 0.1.1-rc.2 线行为等价**
//  （200 仍判活、真死仍判死）。逐码取择与理由：
//    ┌ 状态码        判   理由
//    │ 2xx (200/204) 活   原有唯一判活值，必须保持不变（0.1.1 线 200）
//    │ 3xx (301/303) 活   0.1.5 带 token 访问 `/` = 303（重定向落 cookie）；
//    │                   重定向 = 应用在正常处理请求，不是"没起来"
//    │ 401           活   **本次改造核心**：token 认证门 —— 服务在监听，
//    │                   并主动拒绝未认证请求（响应体 "dsh web authentication required"）
//    │ 403           活   同属"授权类拒绝"：HTTP 服务确实在应答，只是不给内容；
//    │                   与 401 同类（认得出的是"HTTP 服务在"，不是"内容对不对"）
//    │ 404 等其它 4xx 死   0.1.1 与 0.1.5 的 `/` 都不会 404 ⇒ 出现 404 说明 3080 上的
//    │                   监听者不是 dsh 本体（如端口被别的进程占了）⇒ 正需要"卡死→重启"；
//    │                   取择 = 与旧口径一致（宁可误杀重拉，也不把"不是 dsh"当健康）
//    │ 5xx           死   服务进程在但应用层报错/未就绪：保留旧"再探 → 必要时重启"语义，
//    │                   并避免 START 阶段在 bundle 未就绪时过早判 OK
//    │ 无应答/超时    死   与旧口径等价（curl 无输出/000/失败）
//    │ 解析不了(abc) 死   fail-closed：宁可多探一轮，不把未知当健康
//    └
//
//  消费者（H1 收敛后的全部读点，改口径只需改本文件）：
//    ① 守护进程 guard.mjs   probeHttp() → waitHttpReady(START 路径) + 主循环 httpOk
//                          （→ guard-core.mjs 的 STUCK?/kill-dsh 判据）
//    ② 自愈分身 repair.mjs  probeHttp() → 现场诊断 ev.dsh.httpOk + relaunch 后就绪等待
// ============================================================

/** 口径版本（写进日志与报告，便于事后对照哪一版判据在跑） */
export const RULE_VERSION = 'h1-20260922';

/** 判活的状态码集合（唯一口径，别在消费者里另写判断） */
export const ALIVE_CODES = [200, 204, 301, 302, 303, 307, 308, 401, 403];

/** 判活规则文字说明（报告 / 日志 / 帮助文本共用） */
export const ALIVE_RULE_TEXT = '2xx/3xx/401/403 = 活；404 等其它 4xx、5xx、无应答 = 不活';

/**
 * 把 curl `-w '%{http_code}'` 的原始输出解析成状态码。
 * 取择：**严格三位数字**才算解析成功（curl 无应答时输出 `000`，非数字输出如 `abc`/空串一律 null）。
 * @param {unknown} raw
 * @returns {number|null} 0=无应答（000）… 599；null=解析不了
 */
export function parseHttpCode(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{3}$/.test(s)) return null;
  return Number(s);
}

/**
 * 判活 + 给理由（消费者的唯一入口）。
 * @param {unknown} raw curl 输出的状态码原串
 * @returns {{ code: number|null, alive: boolean, reason: string, rule: string }}
 *   reason ∈ ok-2xx | redirect-3xx | auth-401 | auth-403 | not-found-404 |
 *            client-4xx | server-5xx | no-answer | unparsable
 */
export function judgeHttp(raw) {
  const code = parseHttpCode(raw);
  if (code === null) return { code: null, alive: false, reason: 'unparsable', rule: RULE_VERSION };
  if (code === 0) return { code: 0, alive: false, reason: 'no-answer', rule: RULE_VERSION };
  if (code >= 200 && code <= 299) return { code, alive: true, reason: 'ok-2xx', rule: RULE_VERSION };
  if (code >= 300 && code <= 399) return { code, alive: true, reason: 'redirect-3xx', rule: RULE_VERSION };
  if (code === 401) return { code, alive: true, reason: 'auth-401', rule: RULE_VERSION };
  if (code === 403) return { code, alive: true, reason: 'auth-403', rule: RULE_VERSION };
  if (code === 404) return { code, alive: false, reason: 'not-found-404', rule: RULE_VERSION };
  if (code >= 400 && code <= 499) return { code, alive: false, reason: 'client-4xx', rule: RULE_VERSION };
  if (code >= 500 && code <= 599) return { code, alive: false, reason: 'server-5xx', rule: RULE_VERSION };
  return { code, alive: false, reason: 'unparsable', rule: RULE_VERSION };
}

/** 只要布尔（沿用旧 `probeHttp` 的返回形状，便于调用方最小改动） */
export function isHttpAlive(raw) {
  return judgeHttp(raw).alive;
}

/** 日志用一行描述，例如 `code=401 (auth-401)` / `no-answer` */
export function describeHttp(raw) {
  const j = judgeHttp(raw);
  if (j.code === null) return `${j.reason}`;
  if (j.code === 0) return 'no-answer (code=000)';
  return `code=${j.code} (${j.reason})`;
}
