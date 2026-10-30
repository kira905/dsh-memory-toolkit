// ══ GENERATED FILE — DO NOT EDIT ══
// 本文件由 tools/sync-host-adapter.mjs 生成 —— 手工修改会在下一次同步时被覆盖，
// 且会被 tools/check-decoupling.mjs 的 R5 判为违规（副本 sha ≠ 唯一源）。改接口请改唯一源。
// source: tools/lib/host-adapter.mjs
// sourceSha256: e69900195cfd3a58efc449f9b37c75aea0d7bf76ba7c7517ab019a600393628c
// sourceVersion: 0.3.1
// format: esm
// target: memory-local-lib-esm
// ══ END HEADER ══
// tools/lib/host-adapter.mjs —— 宿主适配层（**唯一源 / single source of truth**）
//
// 方案：docs\大管家adapter能力-方案-20260914.md §3.2（接口契约）/ §3.7（唯一源 + 派生副本）
// 批次：P0 · 档 A（**等价替换，零语义变化**）
//      P1 · 收敛扩面（2026-09-15）：补 `SVC` 服务名常量表 + 补齐各包用到的 `EV` 条目 + `eventLabel()`
//          —— 依据方案 §10.2「解法 A（真收敛）」：服务名/事件名字面量收敛到本唯一源，
//          各包只写 `inject = [SVC.webServer]` / `ctx.inject([SVC.settings], cb)` / 常量比较。
//          仍守档 A：**零语义变化**（只把字面量换成同值常量，不改任何判定口径）。
//      P2-提前批 · 服务面收敛 + 能力档（2026-09-15）：
//          ① 新增 `settingsApiOf()` / `installSectionCompat()` —— settings 首装面的双线分支承载；
//          ② 新增 `serviceFace()` / `hostCapabilities()` / `capabilityProfile()` —— **只输出事实，不含策略**；
//          ③ `EV` 补 15 条 0.1.5 新增事件常量（**仅常量**，不进任何判定表、不改任何判定）；
//          ④ 新增 `CLIENT_PKG` / `clientInjectDecl()` —— 客户端 inject 声明解析（§3.4 静默跳过口径）。
//          ⚠️ **零判定变更**：`classifyTail` / `isTurnInterior` / `isSessionLevel` / `isTerminalTurnEnd` /
//             `UNKNOWN_FAMILY_POLICY` 本批**一行未改**（档 B 仍未切，见方案 §10.2 / 待拍板事项 ②）。
//             ⚠️ 订正注（2026-09-28 · 只标注不改原文）：上句「档 B 仍未切」**已过期** —— 主人 2026-09-28 11:38
//                拍板「切」，档 B 已上生产，`UNKNOWN_FAMILY_POLICY` 现为 `'open'`（见本文件该常量定义处）。
//                依据 = `docs\交付报告-adapter档B切与不切差异-20260928.md`（1554 真实会话差异 0 条 + 构造样本正向验证）。
//
// 为什么存在（一句话）：主包（@deepseek-ai/dsh*）的事件名 / 服务名 / 事件粒度会随版本变
//   （0.1.5 删 `assistant/chunk`、`tool/code-dispatch*` 改名 `tool/ptc-dispatch*`、
//    `assistant/attempt` 由"增量流"改"结算式整段流"），把**字面量散落在 7 个自研包**里，
//   升级时改点会随功能增长而增长。本文件是**全生态唯一允许出现主包事件名/服务名字面量**的地方，
//   其余代码只调这里的语义化接口（族判定 / 语义取数 / 探测 / 能力档）。
//
// 硬约束（违反即失去存在意义）：
//   1. **零依赖、纯函数、零状态** —— 不 import 任何模块（含 node: 内置），不读盘、不读环境变量、
//      不 import `@deepseek-ai/*` 运行时符号（连 `import type` 都不需要：本文件是纯 JS 判定）。
//   2. **本文件不承担"策略"** —— 只给"结构 + 事实 + 族"；"被打断会话要不要报""未闭合算不算活跃"
//      这类策略仍归调用方（面板宁少报不误报 / P2 宁多报不放过，语义不同，禁止在这里统一）。
//   3. **不得用墙钟做判据**（方案 §9.3 R3）—— 一律 `now - 事件时间` 的单调差值，
//      窗口常量集中在本文件，测试覆盖"未来时间 / 半截帧"两个既有反例。
//   4. **P0 档 A ≠ 档 B**：本文件现阶段的族判定**必须在现有样本上与旧的显式白名单逐条等价**
//      （回归差异必须为 0）。"未知族归 open"（更安全但换尺子）属**档 B**，等裸跑收尾 + 主人单独批准，
//      在本文件里以 `UNKNOWN_FAMILY_POLICY` 一处集中表达，**P0 一律 'unknown'**。
//      ⚠️ 订正注（2026-09-28 · 只标注不改原文）：上句「**P0 一律 'unknown'**」**已过期** —— 前置条件（裸跑收尾 +
//         差异量化）已满足，主人 2026-09-28 11:38 单独批准切档 B ⇒ 现行值 = `'open'`（档 B）。
//         **P1/P2 语义不变**：本文件仍只给「结构 + 事实 + 族」，策略仍归调用方（:27 第 2 条不变）。
//
// 副本策略（§3.7）：插件实体可能被单独拷到别的机器 ⇒ 不能"一个文件被 7 包共同 import"。
//   唯一源 = 本文件；派生副本 = `tools/sync-host-adapter.mjs` 幂等生成到各包 `lib/host-adapter.mjs`（含源 sha 头）；
//   守门 = `tools/check-decoupling.mjs` R5 校验副本 sha == 唯一源。
//
// 【设备：ROG】｜P0 落地 2026-09-14 ｜ P2-提前批 2026-09-15 ｜ +`SVC.clientModules`（生态面板 boot 解析修复）2026-09-23
// ｜ 2026-09-28 档 B 切（`UNKNOWN_FAMILY_POLICY`: 'unknown' → 'open'，主人单独批准）
// ｜ 2026-10-10 空会话误判治本（`classifyTail` 加「整段零回合内事件 ⇒ closed」前置判定；
//    修「新建空会话静止 10 分钟被判卡死」；真源 `docs\交付报告-卡死自愈空会话误判治本-20261010.md`）
// ｜ 2026-10-16 `eventUsage()` 补 `assistant/message` 分支（0.2.x 现行日志的 usage 落点；此前只认
//    0.1.1 `assistant/chunk` / 0.1.5 `assistant/attempt` ⇒ 现行日志命中 0、账本按天数据自 9-22 冻结）；
//    ⚠️ `HOST_ADAPTER_VERSION` **保持 0.3.1 不变** —— 组件版本登记在 `lib/version.mjs` 的 PLUGIN_COMPONENTS，
//    bump 属独立变更（须主人拍板）⇒ 本次变更以 **sha256 + 本变更史行** 为准；
//    真源 `docs\交付报告-harness成本与路由-拍板落地A组-读数修复与轻建议-20261016.md`

export const HOST_ADAPTER_VERSION = '0.3.1';
/** 唯一源标识（副本头 / R5 校验 / 报告用）。 */
export const HOST_ADAPTER_SOURCE = 'tools/lib/host-adapter.mjs';

// ══════════════════════════════════════════════════════════════════════════════
// 词表 —— 主包事件名的唯一落点
// ══════════════════════════════════════════════════════════════════════════════

/** 已取证的主包事件名（0.1.1-rc.2 现网线 / 0.1.5-rc.x 金丝雀线）。 */
export const EV = Object.freeze({
  // —— 回合边界（两线同名）
  TURN_START: 'turn/start',
  TURN_END: 'turn/end',
  // —— 会话终结标记（重启/停机时主包给当时活跃会话补写）
  SESSION_END_SEED: 'session/end-seed',
  SESSION_TITLE: 'session/title',
  // —— 模型产出（★ 两线**粒度不同**，不是简单改名）
  LEGACY_ASSISTANT_CHUNK: 'assistant/chunk', // 0.1.1：增量流（chunk 序列）
  ASSISTANT_ATTEMPT: 'assistant/attempt', // 0.1.5：结算式（一条带完整 stream[] + usage + interrupted）
  ASSISTANT_MESSAGE: 'assistant/message', // 两线共有：完整消息
  // —— 代码派发（★ 0.1.5 改名）
  LEGACY_TOOL_CODE_DISPATCH: 'tool/code-dispatch',
  LEGACY_TOOL_CODE_DISPATCH_START: 'tool/code-dispatch-start',
  TOOL_PTC_DISPATCH: 'tool/ptc-dispatch',
  TOOL_PTC_DISPATCH_START: 'tool/ptc-dispatch-start',
  // —— 常用工具事件
  TOOL_CALL: 'tool/call',
  TOOL_RESULT: 'tool/result',
  USER_MESSAGE: 'user/message',
  // —— P1 收敛补充（原先散在各包的裸字面量；两线同名）
  SESSION_EVENT: 'session/event', // 会话事件总线（订阅点，非写入事件）
  SESSION_TITLE_LLM_REQUEST: 'session/title-llm-request',
  CONNECTION_RESET: 'connection/reset', // 客户端侧连接重置
  STEP_START: 'step/start',
  REQUEST_HEADER: 'request/header',
  REQUEST_CONTEXT: 'request/context',
  PERMISSION_PRESET: 'permission/preset',
  SANDBOX_MODE: 'sandbox/mode',
  APPROVAL_POLICY: 'approval/policy',
  // —— P5 写入守门人事件（butler-panel / audit-guard 消费）
  FS_WRITE_INTENT: 'fs/write-intent',
  FS_EDIT_INTENT: 'fs/edit-intent',
  FS_OBSERVED: 'fs/observed',
  TOOLS_PRE_EXECUTE: 'tools/pre-execute',
  // —— P2：0.1.5 新增事件族（取证口径 = 两线 `lib/types/known-event-types.js` 逐行 diff，
  //    见 docs\长期库大扫除-20260914\adapter-认知缺口取证-20260915.md）。
  //    ⚠️ **只登记常量，不进任何判定表**：这些名字属"新线上可能出现的事件"，
  //    是否需要据此改判定属档 B（换尺子），本批不做。
  DELIVERABLES_PRESENTED: 'deliverables/presented',
  FEEDBACK_MESSAGE_PUT: 'feedback/message-put',
  FEEDBACK_MESSAGE_DELETE: 'feedback/message-delete',
  MODEL_SELECTION: 'model/selection',
  SESSION_LOG_DELIVERY_ACCEPTED: 'session-log-deepseek/delivery-accepted',
  SUBAGENT_CATALOG: 'subagent/catalog',
  SUBAGENT_MODEL_SELECTION_POLICY: 'subagent/model-selection-policy',
  SYSTEM_MESSAGE: 'system/message',
});

/**
 * ctx 服务名（**唯一落点**）—— 各包的静态 `inject` 声明与运行时探测一律从这里取。
 *
 * 为什么必须有这张表（方案 §10.2 解法 A · 真收敛）：
 *   `inject` 是宿主契约声明，名字本身无法用"语义调用"消除；写在各包里就是 R4 违规
 *   （裸服务名字面量），收敛到唯一源才是真收敛 —— `inject = [SVC.webServer]` 与
 *   `ctx.inject([SVC.settings], cb)` 都不再在消费包里留字面量。
 *
 * ⚠️ **双线形态**：0.1.1-rc.2（现网生产）与 0.1.5-rc.x（金丝雀）的服务名**逐条同名**
 *    （取证：两线主包 `provide('<name>')` / `reflect.provide('<name>', …)` 对照），
 *    故本表**没有 legacyName 映射**；将来某线真改名时，只需在这里补一个 `*_LEGACY` 键 +
 *    `pick(ctx, [SVC.x, SVC.x_LEGACY])`，调用方仍零改动。
 *    服务名清单口径 = `docs\自研插件运行时API登记表.md` §1.2（与 check-decoupling R4 词表同源）。
 *
 * ⚠️ **客户端侧引用不到本表**：浏览器 bundle 是 `window.__ModuleLoader__` 的 CJS 形态，
 *    由宿主按 `exports["./client"]` 单文件 serve（`/plugins/<id>/client.js`），无法 import 副本
 *    ⇒ 客户端 bundle 里的服务名/事件名字面量在当前口径下不可收敛（P1 余项，见交付报告）。
 *
 * ⚠️ **`apiProxy` 已在 0.1.5 线整体移除**（P2 取证 2026-09-15，判据 = 两线主包闭包 grep）：
 *    0.1.1 全闭包 `apiProxy` 命中 **93 处**、0.1.5 命中 **0 处**；0.1.5 的服务面换成
 *    `sessionController` / `settingsController` / `workspaceController` / `sessionFeedback` …（见 `serviceFace()`）。
 *    ⇒ 探测口径：`pick(ctx, [SVC.apiProxy]) === null` 即"该服务在本线不存在"，
 *      **不得**把它留在静态 `inject` 声明里（会让 entry 永久 pending = boot 失败，方案 §3.4 / §9.2 I3）。
 */
export const SVC = Object.freeze({
  webServer: 'webServer',
  settings: 'settings',
  settingsScope: 'settingsScope',
  commands: 'commands',
  tools: 'tools',
  skills: 'skills',
  sessionTitle: 'sessionTitle',
  llm: 'llm',
  sessions: 'sessions',
  systemPrompt: 'systemPrompt',
  /** ⚠️ **仅 0.1.1/0.1.2 存在；0.1.5 已整体移除**（探测走 `pick()`，勿进静态 inject）。 */
  apiProxy: 'apiProxy',
  agents: 'agents',
  logger: 'logger',
  locale: 'locale',
  slots: 'slots',
  connection: 'connection',
  remote: 'remote',
  workspaces: 'workspaces',
  // —— P2 新增：0.1.5 线独有的服务名（登记以便探测候选；0.1.1 上不存在 ⇒ 探测返回缺）
  sessionController: 'sessionController',
  settingsController: 'settingsController',
  workspaceController: 'workspaceController',
  sessionFeedback: 'sessionFeedback',
  workspaceFiles: 'workspaceFiles',
  documentPreviews: 'documentPreviews',
  fileUpload: 'fileUpload',
  resources: 'resources',
  webhookRuntime: 'webhookRuntime',
  /**
   * 客户端启动图服务（0.1.x 两线同名）：`ctx.clientModules.graph()` 返回的**正是服务进
   * `window.__DSH_BOOT__` 的那份图**（`{ entries, batches }`，元素含 `id`）——
   * 权威、进程内、不经 HTTP、不受 0.1.5 首页 token 门影响。
   * ⚠️ 消费方**必须动态探测**（`ctx.inject([SVC.clientModules], cb)`），**不得**写进静态
   *    `inject`：该线若无此服务 → entry 永久 pending = boot 崩（方案 §3.4 / §9.2 I3）。
   * ★2026-09-23 新增（生态面板 boot 解析修复）：取代"爬首页 HTML 猜 `__DSH_BOOT__` 字面形态"
   *     —— 那条路在 0.1.5 上永远抓不到（注入形态变更 + token 门），害得面板把活着的插件
   *     报成"未加载"。真源 `docs\交付报告-缺陷B复评-cliententry-20260923.md` §5.1。
   */
  clientModules: 'clientModules',
});

/**
 * 主包服务面在两条线上的**已知差异**（事实层；仅供 `serviceFace()` 与文档使用，**不含策略**）。
 * 取证：2026-09-15 两线主包闭包 `super(ctx, "<name>")` 全量扫描（76 个 vs 101 个服务名）。
 */
export const SVC_GONE_ON_015 = Object.freeze(['apiProxy', 'conversationEvents', 'conversationViews']);
/** 0.1.5 新增的服务名（0.1.1 无）。 */
export const SVC_NEW_ON_015 = Object.freeze([
  'credentialsController', 'directoryPickerController', 'documentPreviews', 'fileUpload', 'fileUploads',
  'resources', 'sessionController', 'sessionFeedback', 'sessionFileReferences', 'sessionSkillCatalog',
  'settingsController', 'sidebarRight', 'sidebarRightTabs', 'subagentModelSelection', 'uiConversation',
  'uiSession', 'uiWorkspace', 'webhookRuntime', 'workspaceController', 'workspaceFiles',
]);

/**
 * 回合边界事件（`turn/start` ↔ `turn/end` 配对折叠）。
 * ⚠️ 仍以 Set 形式导出：`restart-coordinator.mjs` 等处用 `.has()` 消费（保持既有公共 API 不变）。
 */
export const TURN_BOUNDARY_TYPES = new Set([EV.TURN_START, EV.TURN_END]);

/** 种子/会话终结标记（主包 dsh-session：seed 会话末尾追加）。 */
export const SESSION_END_TYPES = new Set([EV.SESSION_END_SEED]);

/** `turn/end` 的「正常收尾」reason.kind；其余（interrupted/aborted/error/…）一律当未正常收尾。 */
export const NORMAL_TURN_END_KINDS = new Set(['completed', 'stop']);

/**
 * 回合中间事件 —— **族前缀**（0.1.5 的教训：枚举事件名必死，新族会持续出现）。
 * 命中即"回合内部正在发生的事"。
 */
const TURN_INTERIOR_PREFIXES = Object.freeze([
  'assistant/', // 含 0.1.1 的 chunk/message 与 0.1.5 的 attempt
  'user/',
  'tool/', // ⚠️ `tool-workflow/…` 不落此处（第 5 字符是 '-' 不是 '/'），单独列前缀
  'step/',
  'llm/',
  'request/',
  'todo/',
  'hook/',
  'tool-workflow/',
  'team/',
  'subagent/',
  'compaction/',
  'feedback/',
  'web/',
  'agent/', // 含 `agent/inbox/spliced`；`agent-preset/selected` 不匹配（前缀不同）
]);

/** 族前缀盖不到的回合中间事件（逐个列名）。 */
const TURN_INTERIOR_EXACT = new Set([
  'session/title-llm-request', // 前缀是 session/ 但语义属回合内（标题生成请求）
  // ⚠️ `approval/` **不能整族纳入**：asked/decided 是回合内动作，而 `approval/policy`
  //    是会话级配置事件（在 OUT_OF_TURN_TYPES 里）⇒ 只能逐项列。
  'approval/asked',
  'approval/decided',
]);

/**
 * 回合中间事件显式表（0.1.1-rc.2 词表口径，含 0.1.5 改名后的对应项）。
 * ⚠️ **判定不再用它**（改走 `isTurnInterior` 族判定）；保留为：①兼容导出（旧引用）
 *    ②族判定的"金标准"对照（单测断言 族 ⊇ 本表，防止族前缀写漏）。
 */
export const MID_TURN_TYPES = new Set([
  EV.LEGACY_ASSISTANT_CHUNK, EV.ASSISTANT_ATTEMPT, EV.ASSISTANT_MESSAGE, 'user/message',
  'step/start', 'step/end',
  'tool/call', 'tool/result', EV.LEGACY_TOOL_CODE_DISPATCH, EV.LEGACY_TOOL_CODE_DISPATCH_START,
  EV.TOOL_PTC_DISPATCH, EV.TOOL_PTC_DISPATCH_START,
  'llm/retry', 'llm/retry-started',
  'approval/asked', 'approval/decided',
  'agent/inbox/spliced',
  'request/header', 'request/context',
  'todo/write',
  'hook/invoked', 'hook/result',
  'tool-workflow/agent-start', 'tool-workflow/agent-end',
  'tool-workflow/run-start', 'tool-workflow/run-end',
  'team/member', 'team/message/queued', 'team/message/delivered', 'team/task',
  'subagent/descriptor',
  'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune',
  'feedback/record',
  'web/deepseek-search-llm-request', 'session/title-llm-request',
]);

/** 会话级 / 回合外事件（出现在 turn/end 之后属正常，不表示回合进行中）。 */
export const OUT_OF_TURN_TYPES = new Set([
  EV.TURN_END, EV.SESSION_END_SEED,
  'session/title', 'goal/change', 'schedule/change',
  'plan/mode', 'permission/preset', 'sandbox/mode', 'approval/policy',
  'agent-preset/selected', 'command/run', 'command/done',
]);

/**
 * 未知族的归属策略（§3.3 档 A / 档 B 的唯一开关点）。
 * - `'unknown'` = **档 A（P0 现状）**：不认识的事件不当"回合进行中"，落 unknown 由 caller 决定。
 * - `'open'`    = **档 B（换尺子）**：未知族归 open（安全侧）。
 * ⚠️ P0 阶段**禁止改成 'open'** —— 属换尺子，必须等裸跑收尾 + 主人单独批准（卡红线）。
 *    订正注（2026-09-28 · 只标注不改原文）：该禁令**已解除** —— 前置条件（裸跑收尾 + 差异量化）已满足，
 *    主人 2026-09-28 11:38 单独批准切档 B 并上生产 ⇒ 本行现行值 = `'open'`。上句保留为历史注记。
 *    依据 = `docs\交付报告-adapter档B切与不切差异-20260928.md`（1554 真实会话差异 0 条 + 构造样本正向验证）。
 *    回滚 = 本行改回 `'unknown'` → 重跑 sync + 各包 deploy + P0 闸门重启；
 *    逐字节回滚器 = `_archive\adapter-policyB-20260928-1141\restore.mjs`（默认 dry-run，`--apply` 真回写，逐文件核 sha256）。
 */
export const UNKNOWN_FAMILY_POLICY = 'open';

// ══════════════════════════════════════════════════════════════════════════════
// events 组 —— 族判定与结构判定
// ══════════════════════════════════════════════════════════════════════════════

const isStr = (v) => typeof v === 'string' && v.length > 0;

/** `turn/start`。 */
export function isTurnStart(type) {
  return type === EV.TURN_START;
}
/** `turn/end`。 */
export function isTurnEnd(type) {
  return type === EV.TURN_END;
}
/** 回合边界（start 或 end）。 */
export function isTurnBoundary(type) {
  return type === EV.TURN_START || type === EV.TURN_END;
}
/** 会话终结标记（`session/end-seed`）。 */
export function isSessionEnd(type) {
  return type === EV.SESSION_END_SEED;
}

/** 回合中间事件（族判定；替代旧的事件名枚举）。 */
export function isTurnInterior(type) {
  if (!isStr(type)) return false;
  if (TURN_INTERIOR_EXACT.has(type)) return true;
  for (const p of TURN_INTERIOR_PREFIXES) if (type.startsWith(p)) return true;
  return false;
}

/** 会话级 / 回合外事件（出现在回合收尾之后不表示"在跑"）。 */
export function isSessionLevel(type) {
  return isStr(type) && OUT_OF_TURN_TYPES.has(type);
}

/**
 * 是否「正常收尾」的 `turn/end`。
 * 口径与旧实现逐字一致：缺 kind / 空 kind 视为正常（老日志没有 kind），
 * kind 非空且不在 NORMAL_TURN_END_KINDS 内 → 未正常收尾（interrupted）。
 */
export function isTerminalTurnEnd(ev) {
  if (!ev || !isTurnEnd(ev.type)) return false;
  const kind = ev?.data?.reason?.kind;
  if (typeof kind !== 'string' || kind === '') return true;
  return NORMAL_TURN_END_KINDS.has(kind);
}

/** `turn/end` 的非正常 kind（无/空/正常 → null）。 */
export function turnEndAbnormalKind(ev) {
  const kind = ev?.data?.reason?.kind;
  if (typeof kind !== 'string' || kind === '') return null;
  return NORMAL_TURN_END_KINDS.has(kind) ? null : kind;
}

/**
 * 折叠尾部事件的回合开闭状态（结构判定；**策略仍归 caller**）。
 *
 * 迁移自 `dsh-butler/lib/restart.mjs` 的 `classifyTail`（2026-09-11 v0.1.1 语义，逐字保留）：
 *   ① `turn/end` 的 `data.reason.kind` 不在 NORMAL_TURN_END_KINDS → `state='interrupted'`
 *      （回合结束了，但是被打断的）；`interrupted` 对"活跃判定"等价 closed，
 *      对"被打断清单 / P2 会盯人"是一条真信号。
 *   ② `session/end-seed` 透明化 —— 它是重启/停机补写的收尾标记，常落在被打断会话最后一条、
 *      把真尾挡住 ⇒ 记下 `seedSeen` 后**继续往前找**真边界；窗口内无任何边界 → closed（种子会话已终结）。
 *   ③ 窗口内无边界 → 按最后一条事件归类：seedSeen → closed；回合中间族 → open；否则按档 B。
 *      ⚠️ 订正注（2026-10-10 · 只标注不改原文）：原文末句写「否则 → unknown」——`UNKNOWN_FAMILY_POLICY`
 *         自 2026-09-28 起为 `'open'`（档 B）；且该「否则」分支现在**还受 ④ 收窄**。
 *   ④ **2026-10-10 治本**（卡「卡死自愈空会话误判」）：窗口内无边界时，若整段 `events`
 *      **一个"回合内事件"都没有**（`isTurnInterior` 对全部事件均为 false）⇒ 判 `closed` —— 该会话
 *      从未进入过回合（新建 / 空壳：尾巴只有会话级种子事件，如 `permission/preset`、`sandbox/mode`、
 *      `approval/policy`，甚至只有首帧 `session`）。真卡死会话的尾巴里**必然**含回合内事件
 *      （`turn/start` / `step/*` / `assistant/*` / `tool/*` / `agent/*` / `request/*` …），
 *      尾部只读窗口 256KB 不会把它们全切掉 ⇒「零回合内事件」判 open 没有依据。
 *      **有任一回合内事件时下面逐字不变**（mid-turn → open；否则按 `UNKNOWN_FAMILY_POLICY`）。
 *
 * @param {Array<{type:string,seq?:number,time?:number,data?:any}>} events 尾部事件（seq 升序）
 * @returns {{state:'empty'|'closed'|'open'|'interrupted'|'unknown', boundary:object|null, last:object|null, reason:string}}
 */
export function classifyTail(events) {
  const list = Array.isArray(events) ? events.filter((e) => e && isStr(e.type)) : [];
  if (!list.length) return { state: 'empty', boundary: null, last: null, reason: 'no-events' };
  const last = list[list.length - 1];
  let seedSeen = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (isTurnEnd(e.type)) {
      const abnormal = turnEndAbnormalKind(e);
      const suffix = seedSeen ? '（在 session/end-seed 之前）' : '';
      return {
        state: abnormal ? 'interrupted' : 'closed',
        boundary: e,
        last,
        reason: abnormal ? `boundary=turn/end(kind=${abnormal})${suffix}` : `boundary=turn/end${suffix}`,
      };
    }
    if (isTurnStart(e.type)) {
      return {
        state: 'open',
        boundary: e,
        last,
        reason: seedSeen ? 'boundary=turn/start（在 session/end-seed 之前，回合未闭合）' : 'boundary=turn/start',
      };
    }
    // end-seed 不当边界直接判 closed，而是记下"已终结"后继续往前找真尾
    if (isSessionEnd(e.type)) { seedSeen = true; continue; }
  }
  // 窗口内无回合边界：按最后一条事件归类（fail-safe 由调用方 + mtime 窗口兜底）
  if (seedSeen) return { state: 'closed', boundary: null, last, reason: 'session/end-seed（会话已终结）' };
  // ★ 2026-10-10 治本（卡「卡死自愈空会话误判」）：**前置判定** —— 整段里一个"回合内事件"都没有
  //   ⇒ 这个会话从未进入过回合（新建 / 空壳）。此时判 open 没有依据，改判 closed。
  //   为什么只在这一档收窄：真卡死会话的尾巴里必然含回合内事件（turn/start、step/*、assistant/*、
  //   tool/*、agent/*、request/* …），尾部只读窗口 256KB 不会把它们全切掉（turn/start 之后的事件都在窗口内）；
  //   而"整段零回合内事件"= 只有会话级种子事件（permission/preset、sandbox/mode、approval/policy）
  //   甚至只有首帧 session。原判 open 的后果（2026-10-10 生产实况）：空会话静止 10 分钟被卡死自愈链
  //   判「回合未闭合」→ 发提醒（提醒本身把空会话唤醒）、整夜模式下还会给 P0 闸门塞白重启事由。
  //   ⚠️ 只收窄"整段零回合内事件"这一种情形：只要**有一个**回合内事件，下面逐字不变（档 B 意图保持）。
  if (!list.some((e) => isTurnInterior(e.type))) {
    return { state: 'closed', boundary: null, last, reason: `no-boundary no-turn-interior tail=${last.type}（纯会话级尾巴 ⇒ closed）` };
  }
  if (isTurnInterior(last.type)) {
    return { state: 'open', boundary: null, last, reason: `no-boundary mid-turn tail=${last.type}` };
  }
  if (UNKNOWN_FAMILY_POLICY === 'open') {
    return { state: 'open', boundary: null, last, reason: `no-boundary unknown-family tail=${last.type}（档 B：未知族归 open）` };
  }
  return { state: 'unknown', boundary: null, last, reason: `no-boundary tail=${last.type}` };
}

/**
 * 人类可读的"尾巴停在 X"（打断清单 / 通知用）。
 * 文案逐字保留旧实现（含"正在流式输出 / 新回合即将开始"两处特判）——文案属"人类可读映射"，
 * 是本文件（唯一源）的职责，各包自带映射表视作 R4 违规。
 */
export function describeTail(event) {
  if (!event || !isStr(event.type)) return '尾巴停在未知事件';
  const d = event.data ?? {};
  const where = [];
  if (Number.isFinite(d.turn)) where.push(`turn ${d.turn}`);
  if (Number.isFinite(d.step)) where.push(`step ${d.step}`);
  let what = event.type;
  if (event.type === EV.TOOL_CALL && d.name) what = `tool/call ${d.name}`;
  if (event.type === EV.TOOL_RESULT && d.message) what = 'tool/result';
  if (event.type === EV.LEGACY_ASSISTANT_CHUNK) what = 'assistant/chunk（正在流式输出）';
  if (event.type === EV.ASSISTANT_ATTEMPT) what = 'assistant/attempt（本轮产出已结算）';
  if (event.type === EV.USER_MESSAGE) what = 'user/message（新回合即将开始）';
  const when = Number.isFinite(event.time) ? new Date(event.time).toISOString() : null;
  return `尾巴停在 ${what}${where.length ? `（${where.join(' · ')}）` : ''}${when ? ` @${when}` : ''}`;
}

/**
 * 事件类型 → 人话标签（**人类可读映射**，本文件职责；各包自带映射表视作 R4 违规，见方案 §9.2 I5）。
 *
 * 用途：向主人说明「这份日志里到底有什么」（归档会话的空壳预览等）。
 * 未登记的类型**回落到事件名本身**（与旧实现 `LABELS[key] ?? key` 逐字等价）。
 * ⚠️ 客户端 bundle 引用不到本文件 ⇒ 由 host 半调用本函数、把标签随 API 结果下发，
 *    client 只负责渲染（P1 收敛：archive-sessions 的 EVENT_LABELS 即按此迁移）。
 */
export function eventLabel(type) {
  switch (type) {
    case 'session': return '会话头';
    case EV.USER_MESSAGE: return '主人消息';
    case EV.ASSISTANT_MESSAGE: return '本鱼回复';
    case EV.TOOL_CALL: return '工具调用';
    case EV.TOOL_RESULT: return '工具结果';
    case EV.PERMISSION_PRESET: return '权限预设';
    case EV.SANDBOX_MODE: return '沙箱模式';
    case EV.APPROVAL_POLICY: return '审批策略';
    case EV.SESSION_END_SEED: return '会话结束标记';
    case EV.TURN_END: return '回合结束';
    case EV.LEGACY_ASSISTANT_CHUNK: return '流式片段';
    // —— 以下为 P1 新增（原调用方表里没有；命中即"新曾出现过的事件"，未命中仍回落事件名）
    case EV.TURN_START: return '回合开始';
    case EV.STEP_START: return '步骤开始';
    case EV.SESSION_TITLE: return '会话标题';
    default: return isStr(type) ? type : '未知事件';
  }
}

/**
 * 本地兼容表：旧名 ↔ 新名（**只用于人类可读文案 / 迁移对照，不承担判定职责**）。
 * @returns {{legacy:string, current:string, line:'0.1.1'|'0.1.5', note:string}|null}
 */
export function legacyName(type) {
  switch (type) {
    case EV.LEGACY_ASSISTANT_CHUNK:
      return { legacy: 'assistant/chunk', current: 'assistant/attempt', line: '0.1.1', note: '增量流 → 结算式整段流（粒度变了，不只是改名）' };
    case EV.ASSISTANT_ATTEMPT:
      return { legacy: 'assistant/chunk', current: 'assistant/attempt', line: '0.1.5', note: '增量流 → 结算式整段流（粒度变了，不只是改名）' };
    case EV.LEGACY_TOOL_CODE_DISPATCH:
      return { legacy: 'tool/code-dispatch', current: 'tool/ptc-dispatch', line: '0.1.1', note: '改名' };
    case EV.LEGACY_TOOL_CODE_DISPATCH_START:
      return { legacy: 'tool/code-dispatch-start', current: 'tool/ptc-dispatch-start', line: '0.1.1', note: '改名' };
    case EV.TOOL_PTC_DISPATCH:
      return { legacy: 'tool/code-dispatch', current: 'tool/ptc-dispatch', line: '0.1.5', note: '改名' };
    case EV.TOOL_PTC_DISPATCH_START:
      return { legacy: 'tool/code-dispatch-start', current: 'tool/ptc-dispatch-start', line: '0.1.5', note: '改名' };
    default:
      return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// activity 组 —— 语义取数（§2.1.1：粒度变了 ⇒ 光有族判定只能"不炸"，保证不了"不哑"）
// ══════════════════════════════════════════════════════════════════════════════

/** 流式静默窗口（单点定义；判据只用 `now - 事件时间` 的单调差值，禁墙钟）。 */
export const DEFAULT_STREAM_WINDOW_MS = 120_000;

const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** 是否"模型产出"事件（0.1.1 的 chunk/message；0.1.5 的 attempt）——族判定。 */
export function isAssistantProduction(type) {
  return isStr(type) && type.startsWith('assistant/');
}

/** 文本抽取（尽力而为，缺字段返回 ''；绝不抛错）。 */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (!part) continue;
    if (typeof part === 'string') { out += part; continue; }
    if (typeof part.text === 'string') out += part.text;
  }
  return out;
}

/** 0.1.5 `assistant/attempt.stream` 的文本抽取（结构未完全取证 ⇒ 递归收集 text 字段，缺则空串）。 */
function textOfStream(stream) {
  if (typeof stream === 'string') return stream;
  if (!Array.isArray(stream)) return '';
  let out = '';
  for (const rec of stream) {
    if (!rec || typeof rec !== 'object') continue;
    if (typeof rec.text === 'string') { out += rec.text; continue; }
    if (rec.chunk && typeof rec.chunk.text === 'string') { out += rec.chunk.text; continue; }
    if (rec.delta && typeof rec.delta.text === 'string') out += rec.delta.text;
  }
  return out;
}

/**
 * 单条事件的产出/用量（**逐事件**取数；token 统计等增量消费者用它）。
 *
 * **三线**形态判别（不靠版本号，靠事件形态 —— 版本读不到也不会跑偏）：
 *   - 0.1.1：`assistant/chunk` + `data.chunk.type === 'usage'` → `data.chunk.usage`（旧行为逐字节不变）
 *   - 0.1.5：`assistant/attempt` + `data.usage` → `data.usage`（⚠️ 本机全库实测 usage 命中 0 条 = 纸面兼容）
 *   - 0.2.x：`assistant/message` + `data.usage` / `data.message.usage` → 现行日志的 usage 落点
 *     （★ 2026-10-16 补：此前只认前两线 ⇒ 现行日志命中 0、生产账本按天数据自 2026-09-22 静默冻结）
 *
 * 🔴 **双计陷阱**：0.1.1 世代**同一笔 usage 在 `assistant/chunk` 与 `assistant/message` 各出现一次**
 *   （2026-10-16 全库实测：1037 个 legacy 文件全部 `chunkUsage == messageUsage`）⇒ 两者都算会翻倍。
 *   故 message 分支可经 `opts.message === false` 关闭 —— 「整文件世代判别」的消费者
 *   （`token-usage.mjs#extractUsage`）据此防双计；**逐事件消费者要么显式传参、要么确认单世代日志**。
 *
 * @param {object} ev 会话日志事件
 * @param {{message?:boolean}} [opts] `message:false` ⇒ 不取 `assistant/message`（防 0.1.1 双计）
 * @returns {{usage:object, turn:any, step:any, time:number, source:'chunk'|'attempt'|'message'}|null}
 */
export function eventUsage(ev, opts = {}) {
  if (!ev || !isStr(ev.type)) return null;
  const d = ev.data ?? {};
  if (ev.type === EV.LEGACY_ASSISTANT_CHUNK) {
    const chunk = d.chunk ?? null;
    if (!chunk || chunk.type !== 'usage' || !chunk.usage) return null;
    return { usage: chunk.usage, turn: d.turn ?? '?', step: d.step ?? '?', time: Number(ev.time ?? 0), source: 'chunk' };
  }
  if (ev.type === EV.ASSISTANT_ATTEMPT) {
    if (!d.usage) return null;
    return { usage: d.usage, turn: d.turn ?? '?', step: d.step ?? '?', time: Number(ev.time ?? 0), source: 'attempt' };
  }
  // ★ 2026-10-16：0.2.x 现行日志（usage 只在 assistant/message）—— 字段口径与 productionOf() 对齐
  if (ev.type === EV.ASSISTANT_MESSAGE && opts.message !== false) {
    const u = d.usage ?? d.message?.usage ?? null;
    if (!u || typeof u !== 'object') return null;
    return { usage: u, turn: d.turn ?? '?', step: d.step ?? '?', time: Number(ev.time ?? 0), source: 'message' };
  }
  return null;
}

/** 单条产出事件的归一记录（内部用）。 */
function productionOf(ev) {
  const d = ev?.data ?? {};
  if (ev.type === EV.ASSISTANT_ATTEMPT) {
    return {
      source: 'attempt',
      text: textOfStream(d.stream),
      usage: d.usage ?? null,
      interrupted: d.interrupted === true,
      turn: d.turn ?? null,
      step: d.step ?? null,
    };
  }
  if (ev.type === EV.ASSISTANT_MESSAGE) {
    return {
      source: 'message',
      text: textOfContent(d.message?.content ?? d.content),
      usage: d.usage ?? d.message?.usage ?? null,
      interrupted: false,
      turn: d.turn ?? null,
      step: d.step ?? null,
    };
  }
  if (ev.type === EV.LEGACY_ASSISTANT_CHUNK) {
    const chunk = d.chunk ?? null;
    const isUsage = chunk?.type === 'usage';
    return {
      source: 'chunk',
      text: isUsage ? '' : (typeof chunk?.text === 'string' ? chunk.text : ''),
      usage: isUsage ? (chunk.usage ?? null) : null,
      interrupted: false,
      turn: d.turn ?? null,
      step: d.step ?? null,
    };
  }
  return null;
}

/**
 * 最后一次模型产出（时间 / 文本 / 用量）。
 * 0.1.5 从 `assistant/attempt`（结算式）取；0.1.1 从 `assistant/message` / `assistant/chunk` 取。
 * @returns {{at:number|null, text:string, usage:object|null, source:string, turn:any, step:any, index:number}|null}
 */
export function lastProduction(events) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i];
    if (!ev || !isAssistantProduction(ev.type)) continue;
    const rec = productionOf(ev);
    if (!rec) continue;
    return { at: numOrNull(ev.time), ...rec, index: i };
  }
  return null;
}

/**
 * attempt 级状态（0.1.5 原生；0.1.1 由 chunk 序列推断）。
 * @returns {{open:boolean, interrupted:boolean, usage:object|null, hasAttempt:boolean, lastSource:string|null}}
 */
export function attemptState(events) {
  const list = Array.isArray(events) ? events : [];
  let usage = null;
  let interrupted = false;
  let hasAttempt = false;
  let lastSource = null;
  for (const ev of list) {
    if (!ev || !isAssistantProduction(ev.type)) continue;
    if (ev.type === EV.ASSISTANT_ATTEMPT) {
      hasAttempt = true;
      lastSource = 'attempt';
      if (ev.data?.usage) usage = ev.data.usage;
      if (ev.data?.interrupted === true) interrupted = true;
      continue;
    }
    const rec = eventUsage(ev);
    if (rec) { usage = rec.usage; lastSource = rec.source; }
    else if (ev.type === EV.ASSISTANT_MESSAGE) lastSource = 'message';
  }
  const cls = classifyTail(list);
  return { open: cls.state === 'open', interrupted, usage, hasAttempt, lastSource };
}

/**
 * 此刻是否在流式输出 / 在跑（语义判定）。
 * 口径：结构上回合未闭合（`classifyTail().state === 'open'`）**且**最后一条事件在静默窗口内。
 *   - 0.1.1：chunk 增量持续写 → 总是新鲜，等价于旧"回合未闭合"直觉；
 *   - 0.1.5：attempt 结算式（流式期间可能无事件）→ 本函数会转 false，**这正是升级后要换的判据**
 *     （§2.1.1 空窗期误报），P2 批按主包线给判定档。
 * @param {Array} events
 * @param {number} now 判定时刻（单调差值口径：只用 now - 事件时间）
 */
export function isStreamingNow(events, now, opts = {}) {
  const windowMs = Number(opts.windowMs ?? DEFAULT_STREAM_WINDOW_MS);
  const cls = classifyTail(events);
  if (cls.state !== 'open') return false;
  const at = numOrNull(cls.last?.time);
  if (at === null) return true; // 无时间戳 → 只以结构为准
  return (Number(now) - at) <= windowMs;
}

// ══════════════════════════════════════════════════════════════════════════════
// services 组 —— 存在性探测（**不存在返回 null/false，绝不抛错**）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 服务是否存在。
 * cordis 铁律：读**未 inject** 的服务属性会抛错（`cannot get property X without inject`），
 * 不是返回 undefined ⇒ 这里的任何取法都必须包 try/catch，失败即 false（优雅降级）。
 * @param {{get?:Function}} ctx cordis 上下文（或任何有 get 的对象）
 * @param {string} name 服务名
 */
export function has(ctx, name) {
  if (!ctx || !isStr(name)) return false;
  try {
    if (typeof ctx.get === 'function') return Boolean(ctx.get(name));
    return Boolean(ctx[name]);
  } catch {
    return false;
  }
}

/**
 * 按优先级挑第一个存在的服务名；都不存在 → null（**不抛错**）。
 * @param {{get?:Function}} ctx
 * @param {string[]} names 候选（按优先级）
 */
export function pick(ctx, names) {
  const list = Array.isArray(names) ? names : [];
  for (const n of list) if (has(ctx, n)) return n;
  return null;
}

/**
 * 动态获取服务（拿不到返回 null）。
 * ⚠️ 调用方**不得**把服务名留在静态 `inject` 声明里 —— 声明包含不存在的服务会让 entry
 *   永久 pending（= boot 失败）。正确姿势：用 `ctx.inject([...], cb)` 动态探测。
 */
export function service(ctx, name) {
  if (!ctx || !isStr(name)) return null;
  try {
    if (typeof ctx.get === 'function') return ctx.get(name) ?? null;
    const v = ctx[name];
    return v ?? null;
  } catch {
    return null;
  }
}

// ── P2：服务面收敛（settings 首装面双线分支 · 客户端 inject 声明解析） ──────────────

/**
 * settings 首装面（"给 settings 注册一个 namespace"）**两代 API**——本函数只**判事实**：
 * 运行中的宿主到底提供哪一代承载体。
 *
 * 取证（2026-09-15，两线主包实读）：
 *   - **0.1.1-rc.2**：`@deepseek-ai/dsh-settings` 包级导出 `installSettingsSection(ctx, ns, schema, entry, hooks)`
 *     与 `settingsNamespace(value)`；`SettingsProvider`（`settings` 服务）类上**只有 `register(ns, schema, options)`**，
 *     **没有 `installSection`**（实读方法清单确认：register/describe/get/write/section/resolve… 无 installSection）。
 *   - **0.1.5-rc.2**：两个包级导出**被移除**（实读导出面 = `SettingsConflictError` / `SettingsProvider` / `redactSecrets`），
 *     改为 `settings` 服务上的实例方法 `installSection(owner, ns, schema, entry, hooks)`。
 *   ⇒ 判据 = `installSection` 方法的有无（**新线专有**），不是包级导出的有无
 *     （调用方拿不到包级导入面，且静态 named import 会直接让 loader entry 加载失败——这是 P2 最贵的坑）。
 *
 * @param {object} ctx 任意 cordis 上下文（或任何有 get 的对象）
 * @returns {{api:'installSection'|'register'|'legacy-package'|'none', via:'ctx.settings.installSection'|'ctx.settings.register'|'@deepseek-ai/dsh-settings'|null, requires:string, degraded:boolean}}
 *   · `api='installSection'` → 用 `installSectionCompat()` 走服务方法（**0.1.2+ 首选**）
 *   · `api='register'`      → 服务在但无 installSection ⇒ 适配层用 `register()` 自行组装（fallback）
 *   · `api='legacy-package'`→ 服务探测不到 ⇒ 需包级 `installSettingsSection`（**由 caller 以动态 import 提供**，
 *     适配层不 import 主包符号，见硬约束 1）
 *   · `api='none'`          → 完全拿不到 ⇒ **降级路径**：调用方保持"只读组合 entry"，绝不抛错
 */
export function settingsApiOf(ctx) {
  const svc = service(ctx, SVC.settings);
  const hasInstallSection = Boolean(svc && typeof svc.installSection === 'function');
  const hasRegister = Boolean(svc && typeof svc.register === 'function');
  if (hasInstallSection) {
    return { api: 'installSection', via: 'ctx.settings.installSection', requires: SVC.settings, degraded: false };
  }
  if (hasRegister) {
    return { api: 'register', via: 'ctx.settings.register', requires: SVC.settings, degraded: true };
  }
  return { api: 'none', via: null, requires: SVC.settings, degraded: true };
}

/**
 * 在任意一条线上装载"settings 段落"（**承载体选择 + 降级**；本函数不 import 主包符号）。
 *
 * 行为：
 *   · 新线（`settings.installSection` 在位）→ 原样调用，等价于 0.1.1 的包级 helper
 *     （官方实现即"包级 helper 减去它自己的 `ctx.inject(['settings'])` 包装"，已实读两线源码对照）；
 *   · 中间线（只有 `register`）→ 适配层**自行组装**同一套 hooks 语义
 *     （`setSource` 绑到 scope.get()、卸载时回落到入口、`onChange` 初唤 + 变更时唤）；
 *   · 都不可得 → 返回 `{ok:false}`（**降级路径**），调用方保持"只读组合 entry"，**不抛错**。
 *
 * @param {object} ctx cordis 上下文（owner：注销时用它判 isUnloading）
 * @param {{ns:string, schema:any, entry:any, hooks:{setSource:Function,onChange:Function}, isUnloading?:Function}} opts
 * @returns {{ok:boolean, api:string, scope:object|null, reason:string}}
 */
export function installSectionCompat(ctx, opts = {}) {
  const probe = settingsApiOf(ctx);
  const svc = service(ctx, SVC.settings);
  const { ns, schema, entry, hooks } = opts;
  if (!ns || !hooks || typeof hooks.setSource !== 'function' || typeof hooks.onChange !== 'function') {
    return { ok: false, api: probe.api, scope: null, reason: 'invalid-arguments' };
  }
  if (probe.api === 'installSection') {
    try {
      svc.installSection(ctx, ns, schema, entry, hooks);
      return { ok: true, api: 'installSection', scope: null, reason: 'host-installSection' };
    } catch (e) {
      return { ok: false, api: 'installSection', scope: null, reason: `installSection-threw:${String(e?.message ?? e)}` };
    }
  }
  if (probe.api === 'register') {
    // 适配层自行组装（与两线 installSection 的 hooks 语义逐条一致）
    try {
      const scope = svc.register(ns, schema, { base: entry, ...(hooks.validate === undefined ? {} : { validate: hooks.validate }) });
      hooks.setSource(() => scope.get());
      try { ctx.effect(() => () => { if (typeof opts.isUnloading === 'function' && opts.isUnloading(ctx)) return; hooks.setSource(() => entry); hooks.onChange(); }); } catch { /* effect 不可用 → 不注册回落副作用 */ }
      hooks.onChange();
      if (typeof scope.watch === 'function') {
        scope.watch(() => { if (typeof opts.isUnloading === 'function' && opts.isUnloading(ctx)) return; hooks.onChange(); });
      }
      return { ok: true, api: 'register', scope, reason: 'adapter-assembled-register' };
    } catch (e) {
      return { ok: false, api: 'register', scope: null, reason: `register-threw:${String(e?.message ?? e)}` };
    }
  }
  // 降级：拿不到任何承载体 —— 调用方保持只读组合 entry
  return { ok: false, api: 'none', scope: null, reason: 'settings-service-absent' };
}

/**
 * 主包线**自带**的包级符号（供生态面板 / 升级体检对照；**只声明事实，不在本文件 import**）。
 * 取值来源：0.1.5-rc.2 实读——`@deepseek-ai/dsh-settings` 的导出面 = `SettingsConflictError` /
 * `SettingsProvider` / `redactSecrets`（`installSettingsSection`、`settingsNamespace` 已移除）。
 */
export const SETTINGS_PKG_EXPORTS = Object.freeze({
  '0.1.1': Object.freeze(['SettingsConflictError', 'SettingsProvider', 'deepEqualJson', 'installSettingsSection', 'redactSecrets', 'settingsNamespace']),
  '0.1.5': Object.freeze(['SettingsConflictError', 'SettingsProvider', 'redactSecrets']),
});
/** 0.1.2+ 移除的 settings 包级导出（静态 named import 会让 loader entry 直接加载失败）。 */
export const SETTINGS_PKG_REMOVED_SINCE_012 = Object.freeze(['installSettingsSection', 'settingsNamespace']);

/**
 * 客户端插件包名（`dsh.client.inject` 里声明、由宿主在浏览器侧组合；P1 取证 15 处客户端字面量的收敛面相）。
 * ⚠️ 客户端包**不存在 → 静默跳过**（界面在、功能没了，方案 §3.4 第二行）——本表只为 caller 提供
 *    "该声明是否落在已知客户端包面"这一事实，**是否告警、告警给谁，属 caller 策略**。
 */
export const CLIENT_PKG = Object.freeze({
  runtime: 'dsh-client-runtime',
  locale: 'dsh-client-locale',
  modules: 'dsh-client-modules',
});

/**
 * 解析一段客户端 `inject` 声明（字符串或数组）→ 结构事实。
 * @param {string[]|string} decl
 * @param {(name:string)=>boolean} [pkgPresent] 可选探针：包在当前闭包内是否存在（由 caller 注入）
 * @returns {{services:string[], unknownClientPackages:string[], skipped:boolean}}
 *   · `skipped=true` ⇔ 声明里存在**探针判定为不存在**的客户端包 ⇒ 该客户端模块会被宿主静默跳过，
 *     调用方**应当**把它变成一条显式告警（方案 §3.4：不静默）。
 */
export function clientInjectDecl(decl, pkgPresent) {
  const list = Array.isArray(decl) ? decl : (isStr(decl) ? [decl] : []);
  const services = [];
  const unknownClientPackages = [];
  for (const n of list) {
    if (!isStr(n)) continue;
    services.push(n);
    if (typeof pkgPresent !== 'function') continue;
    if (n.startsWith('dsh-client-') || Object.values(CLIENT_PKG).includes(n)) {
      let present = false;
      try { present = pkgPresent(n) === true; } catch { present = false; }
      if (!present) unknownClientPackages.push(n);
    }
  }
  return { services, unknownClientPackages, skipped: unknownClientPackages.length > 0 };
}

/**
 * 服务面事实快照（**只输出事实，不含策略**）。
 * 调用方（P2 / P5 / 面板）据此自行决定"这条线上该用什么判定"。
 *
 * @param {object} ctx cordis 上下文
 * @param {string[]} [candidates] 关心的服务名（缺省 = 关注清单 + SVC_GONE_ON_015）
 * @returns {{present:object, missing:string[], goneOn015:string[], settingsApi:string, settingsDegraded:boolean}}
 */
export function serviceFace(ctx, candidates) {
  const watch = Array.isArray(candidates) && candidates.length
    ? candidates
    : [SVC.webServer, SVC.settings, SVC.settingsScope, SVC.sessions, SVC.agents, SVC.llm, SVC.sessionTitle,
       SVC.apiProxy, SVC.sessionController, SVC.settingsController, SVC.workspaceController, SVC.locale, SVC.slots]
      .concat(SVC_GONE_ON_015);
  const present = {};
  const missing = [];
  for (const n of watch) {
    const ok = has(ctx, n);
    present[n] = ok;
    if (!ok) missing.push(n);
  }
  const api = settingsApiOf(ctx);
  return {
    present,
    missing,
    // 注意：**独立探测**（不依赖 candidates 是否含这些名字）
    goneOn015: SVC_GONE_ON_015.filter((n) => !has(ctx, n)),
    settingsApi: api.api,
    settingsDegraded: api.degraded,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// version 组 —— 能力档（读不到版本 → 'unknown'，**永不抛错**）
// ══════════════════════════════════════════════════════════════════════════════

/** 已知主包线（0.1.1 = 现网生产；0.1.2 = 拆包线；0.1.5 = 当前官方线）。 */
export const HOST_LINES = Object.freeze(['0.1.1', '0.1.2', '0.1.5']);

/** 能力 → 支持它的主包线。 */
const CAPABILITY_LINES = Object.freeze({
  'assistant-chunk-stream': new Set(['0.1.1', '0.1.2']), // 增量 chunk 流
  'assistant-attempt-settlement': new Set(['0.1.5']), // 结算式 attempt（含 usage/interrupted）
  'tool-code-dispatch': new Set(['0.1.1', '0.1.2']),
  'tool-ptc-dispatch': new Set(['0.1.5']),
  'session-end-seed': new Set(['0.1.1', '0.1.2', '0.1.5']),
});

/**
 * P2 能力档扩展面（**只登记"这条线上有什么"的事实**：承载体 / 失效症状 / 降级出口）。
 * ⚠️ 本表**不含策略** —— 不写"该怎么办"，只写"是什么、会怎样坏、哪个出口可用"；
 *     `fallback` 给的是**出口名**（调用方自行决定用不用），不是自动行为。
 * 取证来源：`docs\长期库大扫除-20260914\adapter-认知缺口取证-20260915.md` +
 *   本批 2026-09-15 两线主包闭包实读（服务名扫描 / settings 导出面 / known-event-types diff）。
 */
const CAPABILITY_DETAIL = Object.freeze({
  'assistant-chunk-stream': Object.freeze({
    carrier: 'assistant/chunk（增量 chunk，逐 chunk 落盘）', fallback: 'lastProduction()/eventUsage() 的 chunk 分支',
  }),
  'assistant-attempt-settlement': Object.freeze({
    carrier: 'assistant/attempt（结算式整段 stream[] + usage + interrupted）',
    symptom: '流式期间无事件落盘（长 attempt 静默）⇒ 以"回合未闭合 + 长时间无新事件"为判据的检测会误报',
    fallback: 'isStreamingNow() 的 attempt 分支（结构配对口径，禁 mtime/墙钟）',
  }),
  'tool-code-dispatch': Object.freeze({ carrier: 'tool/code-dispatch*（字段含 subCallId=deterministic）' }),
  'tool-ptc-dispatch': Object.freeze({ carrier: 'tool/ptc-dispatch*（0.1.5 改名，语义同构已取证）' }),
  'session-end-seed': Object.freeze({ carrier: 'session/end-seed（重启/停机补写的收尾标记）' }),
  'settings-install-section-method': Object.freeze({
    lines: new Set(['0.1.2', '0.1.5']),
    carrier: 'ctx.settings.installSection(owner, ns, schema, entry, hooks)（0.1.2+ 引入）',
    fallback: 'settingsApiOf() → register 组装 / caller 动态 import 包级 helper',
  }),
  'settings-pkg-installSettingsSection': Object.freeze({
    lines: new Set(['0.1.1']),
    carrier: '@deepseek-ai/dsh-settings 的包级 installSettingsSection（**0.1.2+ 已移除**）',
    symptom: '静态 named import 会让 loader entry 直接加载失败（整树不激活、不到 HTTP 200）',
    fallback: '改走 ctx.inject([SVC.settings]) + settings.installSection / register',
  }),
  'api-proxy-service': Object.freeze({
    lines: new Set(['0.1.1', '0.1.2']),
    carrier: 'ctx.apiProxy',
    symptom: '0.1.5 该服务整体移除 ⇒ 留在静态 inject 声明里会让 entry 永久 pending（boot 失败）',
    fallback: 'pick(ctx, [SVC.apiProxy]) 动态探测 + 降级路径',
  }),
});

/** 能力 → 主包线（含 P2 扩展面）。 */
function linesOf(cap) {
  const d = CAPABILITY_DETAIL[cap];
  if (d?.lines) return d.lines;
  return CAPABILITY_LINES[cap] ?? null;
}

/** 由事件形态推断主包线（版本字符串不可得时的兜底）。 */
export function detectLineFromEvents(events) {
  const list = Array.isArray(events) ? events : [];
  let sawNew = false;
  let sawOld = false;
  for (const ev of list) {
    const t = ev?.type;
    if (!isStr(t)) continue;
    if (t === EV.ASSISTANT_ATTEMPT || t === EV.TOOL_PTC_DISPATCH || t === EV.TOOL_PTC_DISPATCH_START) sawNew = true;
    else if (t === EV.LEGACY_ASSISTANT_CHUNK || t === EV.LEGACY_TOOL_CODE_DISPATCH || t === EV.LEGACY_TOOL_CODE_DISPATCH_START) sawOld = true;
  }
  if (sawNew && !sawOld) return '0.1.5';
  if (sawOld && !sawNew) return '0.1.1';
  return 'unknown';
}

/**
 * 主包线：'0.1.1' | '0.1.2' | '0.1.5' | 'unknown'（永不抛错）。
 * @param {string|{version?:string,events?:Array}|undefined} input 版本串 / 含版本的对象 / 事件数组
 */
export function hostLine(input) {
  try {
    if (typeof input === 'string') {
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(input.trim());
      if (!m) return 'unknown';
      // 主包行号用**三段**（0.1.1 / 0.1.2 / 0.1.5 —— 差别在 patch 位，不能只取 major.minor）
      const short = `${m[1]}.${m[2]}.${m[3]}`;
      return HOST_LINES.includes(short) ? short : 'unknown';
    }
    if (input && typeof input === 'object') {
      if (typeof input.version === 'string') return hostLine(input.version);
      if (Array.isArray(input.events)) return detectLineFromEvents(input.events);
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 该主包线是否支持某能力。
 * @param {string} capability 见 CAPABILITY_LINES
 * @param {string|object} [line] 缺省 = hostLine()（读不到即 'unknown' → false，**不会抛错**）
 */
export function supports(capability, line = 'unknown') {
  const lines = linesOf(capability);
  if (!lines) return false;
  const l = typeof line === 'string' ? line : hostLine(line);
  return lines.has(l);
}

/**
 * P2 · 按主包线派生**能力档**：`{capability: boolean}`（**只给事实**）。
 * 供调用方（P2 / P5 / 面板）自行判断"这条线上该用什么判定"——本函数**不返回任何策略**。
 * @param {string|{version?:string,events?:Array}|undefined} line 主包线（或版本串 / 含 events 的对象）
 */
export function hostCapabilities(line = 'unknown') {
  const l = typeof line === 'string' ? line : hostLine(line);
  const out = {};
  for (const cap of Object.keys(CAPABILITY_LINES)) out[cap] = linesOf(cap).has(l);
  for (const cap of Object.keys(CAPABILITY_DETAIL)) {
    if (cap in out) continue;
    out[cap] = linesOf(cap).has(l);
  }
  return out;
}

/** 能力档的**静态说明**（承载体 / 症状 / 出口名——仍是事实层，不含"该怎么办"）。 */
export function capabilityDetail(capability) {
  return CAPABILITY_DETAIL[capability] ?? null;
}

/**
 * P2 · **能力剖面**（版本 + 能力档 + 可选运行时服务面事实）。
 *
 * 与 `hostLine()` 的关系：`hostLine()` 保持原样（只回一个线名），本函数是**新增的第二入口**，
 * 不改变任何既有调用方的行为。
 *
 * ⚠️ **只提供事实**：本函数**不**回答"该不该报""算不算活跃"——
 *    面板"被打断会话"（宁少报不误报）与 P2"回合未闭合"（宁多报不放过）语义不同，
 *    策略仍归 caller（方案 §3.2 判定职责分层）。
 *
 * @param {{version?:string, events?:Array, ctx?:object, services?:string[]}|string|undefined} input
 * @returns {{line:string, capabilities:object, serviceFace:object|null}}
 */
export function capabilityProfile(input) {
  let line = 'unknown';
  let face = null;
  try {
    if (typeof input === 'string') line = hostLine(input);
    else if (input && typeof input === 'object') {
      if (typeof input.version === 'string') line = hostLine(input.version);
      else if (Array.isArray(input.events)) line = detectLineFromEvents(input.events);
      if (input.ctx) face = serviceFace(input.ctx, input.services);
    }
  } catch {
    line = 'unknown';
  }
  return { line, capabilities: hostCapabilities(line), serviceFace: face };
}

/**
 * 能力清单（文档 / 面板 / 登记表自动化生成用）。
 * ⚠️ **向后兼容**：无参调用仍返回原 5 能力 × 3 线 = 15 行（既有消费方 / 单测不变）；
 *    P2 扩展面（含"承载体 / 症状 / 出口"那 3 条）需显式 `{extended:true}` 才会并入 → 8 × 3 = 24 行。
 * @param {{extended?:boolean}} [opts]
 */
export function capabilityMatrix(opts = {}) {
  const out = [];
  const caps = opts.extended === true
    ? [...new Set([...Object.keys(CAPABILITY_LINES), ...Object.keys(CAPABILITY_DETAIL)])]
    : Object.keys(CAPABILITY_LINES);
  for (const cap of caps) {
    for (const l of HOST_LINES) out.push({ capability: cap, line: l, supported: linesOf(cap).has(l) });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// 自检（零依赖；`node tools/lib/host-adapter.mjs --self-test`）
// ══════════════════════════════════════════════════════════════════════════════

/** 极简自检：族判定 / 边界态 / 双线分支。返回 {pass, fail, failures}。 */
export function selfTest() {
  const failures = [];
  const eq = (name, got, want) => {
    const a = JSON.stringify(got);
    const b = JSON.stringify(want);
    if (a !== b) failures.push(`${name}: got ${a} want ${b}`);
  };
  eq('isTurnInterior(assistant/chunk)', isTurnInterior(EV.LEGACY_ASSISTANT_CHUNK), true);
  eq('isTurnInterior(assistant/attempt)', isTurnInterior(EV.ASSISTANT_ATTEMPT), true);
  eq('isTurnInterior(tool/ptc-dispatch)', isTurnInterior(EV.TOOL_PTC_DISPATCH), true);
  eq('isTurnInterior(session/title)', isTurnInterior(EV.SESSION_TITLE), false);
  eq('isTurnInterior(agent-preset/selected)', isTurnInterior('agent-preset/selected'), false);
  eq('isTurnInterior(tool-workflow/agent-start)', isTurnInterior('tool-workflow/agent-start'), true);
  eq('classifyTail(empty)', classifyTail([]).state, 'empty');
  eq('classifyTail(open)', classifyTail([{ type: EV.TURN_START }]).state, 'open');
  eq('classifyTail(closed)', classifyTail([{ type: EV.TURN_END, data: { reason: { kind: 'completed' } } }]).state, 'closed');
  eq('classifyTail(interrupted)', classifyTail([{ type: EV.TURN_END, data: { reason: { kind: 'aborted' } } }]).state, 'interrupted');
  // ★ 2026-10-10 空会话误判治本：整段零回合内事件（只有会话级种子事件）⇒ closed
  eq('classifyTail(纯会话级种子尾巴⇒closed)', classifyTail([{ type: EV.PERMISSION_PRESET }, { type: EV.SANDBOX_MODE }, { type: 'approval/policy' }]).state, 'closed');
  eq('classifyTail(有回合内事件+未知族尾⇒open)', classifyTail([{ type: EV.TOOL_RESULT }, { type: 'some/new-family' }]).state, 'open');
  eq('eventUsage(chunk)', eventUsage({ type: EV.LEGACY_ASSISTANT_CHUNK, time: 1, data: { chunk: { type: 'usage', usage: { inputTokens: 5 } } } })?.usage?.inputTokens, 5);
  eq('eventUsage(attempt)', eventUsage({ type: EV.ASSISTANT_ATTEMPT, time: 1, data: { usage: { inputTokens: 7 } } })?.usage?.inputTokens, 7);
  eq('eventUsage(none)', eventUsage({ type: EV.TOOL_CALL }), null);
  eq('eventUsage(message)', eventUsage({ type: EV.ASSISTANT_MESSAGE, time: 1, data: { usage: { inputTokens: 9 } } })?.usage?.inputTokens, 9);
  eq('eventUsage(message.message.usage)', eventUsage({ type: EV.ASSISTANT_MESSAGE, time: 1, data: { message: { usage: { inputTokens: 11 } } } })?.usage?.inputTokens, 11);
  eq('eventUsage(message, opts.message=false)', eventUsage({ type: EV.ASSISTANT_MESSAGE, time: 1, data: { usage: { inputTokens: 9 } } }, { message: false }), null);
  eq('eventUsage(message 无 usage)', eventUsage({ type: EV.ASSISTANT_MESSAGE, time: 1, data: {} }), null);
  eq('hostLine(0.1.5-rc.2)', hostLine('0.1.5-rc.2'), '0.1.5');
  eq('hostLine(garbage)', hostLine('nope'), 'unknown');
  eq('supports(attempt,0.1.5)', supports('assistant-attempt-settlement', '0.1.5'), true);
  eq('supports(attempt,0.1.1)', supports('assistant-attempt-settlement', '0.1.1'), false);
  eq('has(null ctx)', has(null, 'apiProxy'), false);
  // —— P1：服务名常量表 / 新增事件常量 / 人话标签
  eq('SVC.webServer', SVC.webServer, 'webServer');
  eq('SVC 键=值自洽', Object.entries(SVC).filter(([k, v]) => k !== v).map(([k]) => k), []);
  eq('SVC frozen', Object.isFrozen(SVC), true);
  eq('EV.SESSION_EVENT', EV.SESSION_EVENT, 'session/event');
  eq('EV.TOOLS_PRE_EXECUTE', EV.TOOLS_PRE_EXECUTE, 'tools/pre-execute');
  eq('eventLabel(user/message)', eventLabel(EV.USER_MESSAGE), '主人消息');
  eq('eventLabel 未知回落事件名', eventLabel('weird/thing'), 'weird/thing');
  eq('isTurnInterior(fs/write-intent)=false', isTurnInterior(EV.FS_WRITE_INTENT), false);
  // —— P2：服务面探测 / 降级 / 能力档（**只验事实与降级路径，不涉策略**）
  const fakeNew = { get: (n) => (n === SVC.settings ? { installSection() {} } : { stub: n }) };
  const fakeMid = { get: (n) => (n === SVC.settings ? { register() {} } : { stub: n }) };
  const fakeNone = { get: () => null };
  const fakeThrow = { get: () => { throw new Error('cannot get property "settings" without inject'); } };
  eq('settingsApiOf(new) 判 installSection', settingsApiOf(fakeNew).api, 'installSection');
  eq('settingsApiOf(mid) 判 register', settingsApiOf(fakeMid).api, 'register');
  eq('settingsApiOf(none) 判 none', settingsApiOf(fakeNone).api, 'none');
  eq('settingsApiOf(抛错 ctx) 不抛且判 none', settingsApiOf(fakeThrow).api, 'none');
  eq('settingsApiOf(null) 不抛且判 none', settingsApiOf(null).api, 'none');
  eq('settingsApiOf(new).degraded=false', settingsApiOf(fakeNew).degraded, false);
  eq('settingsApiOf(mid).degraded=true', settingsApiOf(fakeMid).degraded, true);
  eq('installSectionCompat(新线) ok', installSectionCompat(fakeNew, { ns: 'x', schema: null, entry: {}, hooks: { setSource() {}, onChange() {} } }).api, 'installSection');
  eq('installSectionCompat(无线) 降级不抛', installSectionCompat(fakeNone, { ns: 'x', schema: null, entry: {}, hooks: { setSource() {}, onChange() {} } }).ok, false);
  eq('installSectionCompat(无线) reason', installSectionCompat(fakeNone, { ns: 'x', schema: null, entry: {}, hooks: { setSource() {}, onChange() {} } }).reason, 'settings-service-absent');
  eq('installSectionCompat(参数非法) 降级', installSectionCompat(fakeNew, {}).reason, 'invalid-arguments');
  eq('serviceFace(goneOn015) 含 apiProxy', serviceFace(fakeNone).goneOn015.includes(SVC.apiProxy), true);
  eq('serviceFace(全在) apiProxy 不缺', serviceFace(fakeNew).goneOn015.includes(SVC.apiProxy), false);
  eq('serviceFace(missing) 列出 settings', serviceFace(fakeNone, [SVC.settings]).missing, [SVC.settings]);
  eq('SVC_GONE_ON_015 冻结', Object.isFrozen(SVC_GONE_ON_015), true);
  eq('SETTINGS_PKG_REMOVED_SINCE_012', SETTINGS_PKG_REMOVED_SINCE_012, ['installSettingsSection', 'settingsNamespace']);
  eq('SETTINGS_PKG_EXPORTS.0.1.5 无 installSettingsSection', SETTINGS_PKG_EXPORTS['0.1.5'].includes('installSettingsSection'), false);
  eq('clientInjectDecl(无探针) skipped=false', clientInjectDecl(['slots', 'locale']).skipped, false);
  eq('clientInjectDecl(包缺) skipped=true', clientInjectDecl(['slots', 'dsh-client-runtime'], () => false).skipped, true);
  eq('clientInjectDecl(包在) skipped=false', clientInjectDecl(['dsh-client-locale'], () => true).skipped, false);
  eq('clientInjectDecl(抛错探针) 不抛', clientInjectDecl(['dsh-client-locale'], () => { throw new Error('x'); }).unknownClientPackages, ['dsh-client-locale']);
  eq('hostCapabilities(0.1.5).attempt', hostCapabilities('0.1.5')['assistant-attempt-settlement'], true);
  eq('hostCapabilities(0.1.1).attempt', hostCapabilities('0.1.1')['assistant-attempt-settlement'], false);
  eq('hostCapabilities(0.1.5).api-proxy=false', hostCapabilities('0.1.5')['api-proxy-service'], false);
  eq('hostCapabilities(0.1.1).api-proxy=true', hostCapabilities('0.1.1')['api-proxy-service'], true);
  eq('hostCapabilities(0.1.5).settingsSeam=true', hostCapabilities('0.1.5')['settings-install-section-method'], true);
  eq('hostCapabilities(0.1.1).settingsSeam=false', hostCapabilities('0.1.1')['settings-install-section-method'], false);
  eq('hostCapabilities(0.1.2).settingsSeam=true', hostCapabilities('0.1.2')['settings-install-section-method'], true);
  eq('hostCapabilities(0.1.1).pkgHelper=true', hostCapabilities('0.1.1')['settings-pkg-installSettingsSection'], true);
  eq('hostCapabilities(0.1.2).pkgHelper=false', hostCapabilities('0.1.2')['settings-pkg-installSettingsSection'], false);
  eq('hostCapabilities(unknown) 全 false', Object.values(hostCapabilities('unknown')).some(Boolean), false);
  eq('capabilityDetail 含 symptom', Boolean(capabilityDetail('api-proxy-service').symptom), true);
  eq('capabilityDetail(未知)=null', capabilityDetail('nope'), null);
  eq('capabilityProfile(str)', capabilityProfile('0.1.5-rc.2').line, '0.1.5');
  eq('capabilityProfile(events)', capabilityProfile({ events: [{ type: EV.ASSISTANT_ATTEMPT }] }).line, '0.1.5');
  eq('capabilityProfile(ctx) 带服务面', capabilityProfile({ version: '0.1.1-rc.2', ctx: fakeNone }).serviceFace.missing.includes(SVC.settings), true);
  eq('capabilityProfile(null) 不抛', capabilityProfile(null).line, 'unknown');
  eq('capabilityMatrix 基线 15 行（向后兼容）', capabilityMatrix().length, 15);
  eq('capabilityMatrix(extended) 覆盖 P2 新能力', capabilityMatrix({ extended: true }).filter((r) => r.capability === 'api-proxy-service').length, 3);
  eq('EV.MODEL_SELECTION', EV.MODEL_SELECTION, 'model/selection');
  eq('EV.SUBAGENT_CATALOG', EV.SUBAGENT_CATALOG, 'subagent/catalog');
  return { pass: failures.length === 0, checks: 67, failures };
}

const invokedDirectly = (() => {
  try {
    const argv1 = process.argv?.[1] ?? '';
    return typeof argv1 === 'string' && argv1.replace(/\\/g, '/').endsWith('tools/lib/host-adapter.mjs');
  } catch {
    return false;
  }
})();

if (invokedDirectly && process.argv.includes('--self-test')) {
  const r = selfTest();
  for (const f of r.failures) process.stdout.write(`FAIL ${f}\n`);
  process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'} host-adapter self-test ${r.checks - r.failures.length}/${r.checks}\n`);
  process.exitCode = r.pass ? 0 : 1;
}
