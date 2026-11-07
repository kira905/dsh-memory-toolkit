# Changelog

本仓的版本按**语义化版本**：改结论/改契约升主版本，加能力升次版本，修错别字与文档订正不升。
英文摘要见每节末尾的 *English* 行。

## v0.5.0 — 2026-11-08

**会话捕获管线**（`capture` 系列）+ 三个只读探针。这一版补的是「**从你自己的会话日志里挑出该记的句子**」
这条链路：读会话目录 → 按白名单取事件 → 剔掉注入 → 判「什么该记」→ 出候选 → 账本去重 → 分批撤回。
全链路**只出候选、不写库**（写不写、写哪条，仍由你决定）。

### ① 捕获管线（`memory-engine/`）

| 件 | 干什么 |
| --- | --- |
| `lib/session-capture.mjs` | 读 `<DSH 根>/sessions/` 下的会话日志（多帧 zstd 逐帧解）→ 白名单事件（只 `user/message` + `assistant/message`）→ 按 `data.source.kind` **剔掉 7 种注入** → 末 N 轮 + 三道上限截断 |
| `lib/capture-judge.mjs` | 「什么该记」判定器（`judgeVersion = U1-1`）：分档打分、剔敏感（密钥/私网 IP/凭据路径）、剔寒暄与工具回显，给出候选与理由 |
| `lib/capture-ledger.mjs` | 账本：已判过的内容哈希、每会话游标（只前进）、当日成本、每轮 run 记录。原子写 + `.bak` + 坏账本 fail-closed |
| `shadow-capture.mjs` | **影子**入口：跑一轮只落 `candidates.jsonl` / `candidates.md`，`--apply` 直接拒（rc=2）—— 设计上永不写库 |
| `rollback-capture.mjs` | 撤回器：把某一批落库的条**降层 + 标记作废**（不物理删）。三种粒度 `--tag` / `--run` / `--id`，命中行不带 `capture:*` 标签就整批拒动 |

判据夹具：`memory-engine/test/14-session-capture.test.mjs`（28 项，覆盖「注入不进候选、真 user 能出候选」、
账本幂等、游标不回退、坏账本 fail-closed）。跑法：`node memory-engine/test/run.mjs 14-session-capture`。
**零生产接触**：夹具根落系统临时区，不读 `~/.dsh`、不写库、不联网。

### ② 相似度算法收敛（`lib/text-similarity.mjs`）

`normalizeText` / `shingles` / `jaccard` + 阈值表抽成一件纯函数模块（零 IO），候选去重与近重复判定共用。
改阈值 = 改判定行为，请同批升 `judgeVersion`。

### ③ 三个只读探针

- `memory-engine/classify-memories.mjs` —— 给库里的记忆按「坑 / 口径 / 偏好 / 进度 / 过时」分类（缺省 dry-run，
  `--apply` 才写旁挂，`--rollback` 回滚）。规则表在代码里明写，词表可自行增补。
- `memory-engine/profile-recall.mjs` —— 召回耗时的分段读数（只读）。
- `memory-engine/tools/nl-recall-probe.mjs` —— 召回判据探针：给一批「问题 → 期望 id」，看命中位次与命中率（只读）。
- `memory-engine/event-loop-lag-probe.mjs` —— 事件循环阻塞的外部探测（对宿主反复打请求量延迟，判断是否有长同步卡住）。
- `memory-engine/add-memory.mjs` —— 小工具：按 `spec.json` 往库里插一条记忆（`ownerUser` 缺省取当前系统用户）。

### ④ 与 `session-source` / `session-distill` 的分工（别混）

本仓有两套「会话 → 记忆」的路径，**不是重复实现**，输入边界不同：

- `lib/session-source.mjs` + `lib/session-distill.mjs`：吃**一份纯文本 `.jsonl`**（或 `.jsonl.zstd`），抽结论句，
  **配了每日预算才调模型**合成，写库带 `distilled` 前缀 + 回指 refs。适合「把一段日志提炼成结论」。
- 本版 `capture` 系列：吃 **DSH 自己的会话目录**（`<DSH 根>/sessions/<桶>/session-*/`），认 DSH 的事件结构与
  注入 kind，**零模型调用**（纯规则判定），只出候选、供人或下游决定。适合「在我自己的历史会话语料上筛该记的」。

两者可以叠加：capture 出候选 → 你挑几条 → 用 distill 的预算链写入。

### ⑤ 没随本版发布的件（说明理由，不是漏）

- 号段哨兵的**多机版**（写死三台主机名 + ssh 别名）：本仓已有一套**配置驱动、单机自动退化**的实现
  （`lib/band-sentinel.mjs` + `cli/band-sentinel.mjs`），再放一份写死主机的会变成第二份实现 ⇒ 不纳入。
- 两件一次性事故诊断/回滚脚本（文件名带内部批次号，只对某次事故有效）⇒ 不进仓。

*English: adds a session-capture pipeline (read DSH session logs → whitelist events → drop injected blocks →
judge what is worth remembering → candidates → ledger → batch rollback), a shared text-similarity module, and
four read-only probes. Capture never writes to the database; `shadow-capture --apply` refuses by design.*

## v0.4.1 — 2026-11-06

**接线收口 + 判据面 + 追平。** `memory_write` / `memory_forget` 第一次**真的**接上 0.4.0 那三件
（此前是"装了不接线"）；新增「硬矛盾」判据（判词表**外置 JSON**）；指针行改成「近 7 天带时分、更老只留日期」；
`memory-db-tools` **30 件逐件判**（结论表见 §④）；`dsh-memory` 实体的两份可分发件追平（§⑤）。

### ① 接线（`dsh-memory-local/src/index.js` · 44,699 → 50,132 B）

0.4.0 交付了三件（删留痕 / 血缘预埋 / 血缘回填），但 `index.js` 一行没动 —— 装了不接线。
本次接上两处（第三件 `lineage-backfill` 是 CLI，本来就独立跑）：

- **写侧**：`memory_write` 落库、拿到 memoryId 之后，`void fireLineageAnchor(...)` 异步预埋「我在哪一轮」。
  三条硬约束：**不 await、不拦、不改返回值**；模块缺失 / 任何异常 ⇒ 吞掉只上 stderr 一行（fail-open）；
  `DSH_MEMORY_LINEAGE=off` ⇒ **零 import、零 IO、零日志**（与改动前逐字节等价）。
- **删侧**：`forget(id)` 的裸 `DELETE` **废止**，改走 `forget-ledger.mjs#forgetWithLedger`
  （归档正文 → 台账 → 事务内复核 hash → 才 DELETE）。归档根取不到 ⇒ **fail-closed 拒删**。

⚠️ **行为变化（升级前读）**：`memory_forget` 现在要求**归档根已配置**
（`config.removedRoot` / `DSH_MEMORY_REMOVED_ROOT` / `DSH_ROOT` 三者任一）。
一条都没配时，删会**报错并拒绝**（宁可不删，也不删了没记）。这是有意的 fail-closed，不是 bug。

夹具：`dsh-memory-local/test/test-wiring.mjs`（7 条，含阴性对照 —— 把接线抹掉必须翻红）。
`dsh-memory-local/test/regression-baseline.md` 的「第 7–9 条」同一 commit 更新为接线后的口径。

### ② 硬矛盾判据 `memory-db-tools/lib-mem-conflict.mjs` + `mem-conflict-rules.json`

同一槽（`factKey` 相等）上两侧取值集合**交集为空** ⇒ `hard-conflict`。三个取值域：日期/时刻（区间）、
数值（单位 + 谓词相同才比）、枚举（白名单槽）。其余一律 `unknown`（宁漏不假）。

- 🔴 **判词表外置**：哪种写法算日期 / 数值 / 枚举、哪些槽可判枚举、区间分隔符、单位与谓词表、tag 前缀
  —— 全在 `mem-conflict-rules.json`，**代码里 0 处硬编码判据**。
- 换一套词表（另一门语言 / 另一套单位）：`DSH_MEM_CONFLICT_RULES=<你的 json>`；或用 `loadRules(file)` 自行解析。
- 词表**缺字段即抛**（静默变成"什么都不能判"是更坏的结果）。
- 夹具 `memory-db-tools/_test/test-mem-conflict.mjs`：35 条，含阴性对照（把「相交」退化成「等值」必须让
  C1/C4/C7 翻红）+ 词表替换验证（删掉枚举槽 ⇒ 同一判定从 `hard` 变 `unknown`）。

### ③ 指针行「近 7 天带时分」`pointer.mjs`（9,810 → 14,444 B）

召回里一条记忆原本只有 `YYYY-MM-DD`，看不出「3 小时前」还是「20 小时前」（「昨晚」被说成「几天前」）。
现在：距今 **< 7 天** ⇒ `YYYY-MM-DD HH:MM`（**本地时区**，绝不用 `toISOString()`），**≥ 7 天** ⇒ 只留日期。

- 阈值可用 `DSH_MEMORY_POINTER_TIME_DAYS` 覆盖；`0` / 负数 / 非数字 ⇒ 回落默认（fail-open）。
- 🔴 **三档硬预算一个字不放宽**（≤8 条 / ≤800 字 / ≤600 token）：多出来的 6 字从**本行摘要**让位，
  摘要缩到 40 字仍放不下才丢这一条。夹具 `test/pointer-stamp.test.mjs`：14 条，含跨 7 天边界、
  时区（本地 vs UTC 对照）、两条阴性对照（老数据渲染逐字节不变）。

### ④ `memory-db-tools` 逐件判（30 件 · 结论表）

**判据**：对外部用户是不是空转（拿掉本机环境还能不能用）。

| 件 | 结论 | 理由 |
|---|---|---|
| `lib-mem-conflict.mjs` | **本批新增** | 通用判据，判词外置 |
| `memory-snapshot.mjs` | **本批新增** | 「改正文」留痕的唯一写口；`lineage-backfill` 的硬前置（没它就 rc=3 拒动） |
| `_test/test-memory-scope.mjs` | 保留仓内版 | 生产版增量是本机台账 / 设备分组 |
| `audit-analyze` / `audit-dump-ids` / `audit-export` / `audit-persona-overlap` / `audit-struct-probe` / `audit-verify-unchanged` | 保留仓内版 | 仓内版已是提炼版（生产版更大 = 加了本机环境分支） |
| `lib/known-devices.mjs` · `lib/memory-scope.mjs` · `memory-scope-fixture` · `memory-identity-check` · `memory-schema-migrate` · `refine-memories` | 保留仓内版 | 同上；**不追平生产增量**（增量全是本机事实） |
| `audit-hit-probe` / `audit-ledger-probe` / `read-memories` / `read-memory-db` / `show-mem-times` / `check-memory-db` / `dump-memory-db` | **判定不值得开源**（已在仓内 = 历史遗留，本次不再追平） | 只读本机库结构；对外是空转 |
| `list-memory-summary.mjs` | 保留仓内版 | 生产版 36 KB 的增量是设备分组 + 看板集成（本机事实） |
| `memory-ask.mjs`（三层只读查询） | **本批不进** | 有价值，但绑本机库布局 + 规矩库路径；需专门卡 |
| `memory-relate.mjs`（关系 tag 入口） | **本批不进** | 同上：引用插件 `forget-ledger` + 本机噪声词表 |
| `recall-usefulness.mjs`（召回有用率） | **本批不进** | 绑宿主会话日志格式（版本敏感）+ 16 处本机夹具 |
| `memory-change-audit.mjs`（留痕体检） | **本批不进** | 验的是本机台账的历史基线（前 26 行 sha）⇒ 对外空转 |
| `memory-fieldname-check.mjs` + `lib/fieldname-whitelist.json` | **本批不进** | 一次性迁移闸；白名单是**本机文件的精确行**清单 ⇒ 对外是垃圾数据 |

### ⑤ `dsh-memory` 生产实体追平（26 件 → 仓内 15 件 + 本批 1 件 + `dict/` 4 件）

| 生产件 | 结论 | 理由 |
|---|---|---|
| `lexicon-recall.mjs` | **本批新增** | 中文稀疏召回（jieba 词表 + IDF×稀有度 + RRF）。只清了一处注释路径 |
| `lib/dict/{词典,词频}.txt` + `lexicon-config.json` + `LICENSE-词典.md` | **本批新增（随仓发）** | 许可已核：来自 jieba（**MIT**），`LICENSE-词典.md` 原样随包保留即合规；本仓 AGPL-3.0 可与 MIT 共存 |
| `module-gate.mjs` | **本批追平** | 状态名解析补 `mtime` 双取（迁移期两份都在时取新者，平手按新名）；含本机事实的注释已改成通用说法 |
| `attrib-badge.mjs` | **不进** | 「认账标记」依赖本机的 `attrib-ledger` 全库结论；没有那份台账 ⇒ `badgeOf()` 恒返回空串 = 空转 |
| `memory-identity` / `memory-layers` / `shadow-hook` / `shadow-verdict` | **不进（红线）** | 家人侧身份与可见范围件，留在私有侧 |
| `index.js.bak-*`（2 份） | 不进 | 备份文件，不是源码 |
| `index.js`（109,683 B，+1,135 行） | **本批不追平** | 增量里含大量私有面（家人侧 4 件 import / 认账 / 影子态 / 分层 / 硬矛盾 tag 接线 / 设备词面）。本批只做了**接线**（§①），全量追平见报告「待拍板」 |
| `schema-migrate.mjs` | 不需追平 | 本仓 0.3.0 起已用 `fallbackOwnerUser()` 只读 `DSH_OWNER_USER`；生产版仍是真名字面量 —— **本仓是干净的那一侧** |
| `bridge` / `recall` / `recall-log` / `until-expiry` / `injector` / `pointer` 等 | 逐件核过 | 差异属本机私有（路径 / 注释 / 本机分支）；`pointer` 按 §③ 追平，`until-expiry` 仓内版已是提炼版 |

**核验读数**：仓内 12 条脱敏词表（私有标识，见脱敏口径档）逐条 **0 命中**；
盘符绝对路径（`<盘符>:\` 后跟工作根）**0 命中**（判据本身在夹具里用拼接构造，不写字面量）。

### 迁移与兼容

- 装 0.4.1 **必须配归档根**，否则 `memory_forget` 拒动（见 §① 的 ⚠️）。
- 指针行多了 ` HH:MM`：注入总量仍受 800 字 / 600 token 硬约束（靠缩摘要让位，不是放宽预算）。
- `dict/` 新增 1.25 MB 数据（jieba 词典 + 频表）；不需要中文稀疏召回可以删掉该目录（相关能力自动 fail-open）。

*English*: Wires the three 0.4.0 write-side pieces into `index.js` (lineage anchor on write, ledger-backed
forget), adds a hard-conflict detector with an **externalized rule table**, renders recent pointer lines with
`HH:MM` (7-day half-life, budget unchanged), ships `lexicon-recall` + the MIT-licensed jieba dictionary, and
completes a per-file verdict table for the internal memory toolchain. **Breaking-ish**: `memory_forget` now
requires a configured archive root and fails closed without one.

## v0.4.0 — 2026-11-06

**记忆的写侧补齐三件：删得可追溯、写时留出处、事后能回填。** 三件都是**新文件**，
`dsh-memory-local/src/index.js` 一行没动 ⇒ **装了不接线，行为与 0.3.0 逐字节一致**（接线点见各件头注释）。

三件是一条链：`lineage-auto` 写侧预埋 → `lineage-backfill` 补 `source_ids` → `forget-ledger` 删除留痕。
**必须一起用**（只装前两件 = 血缘填不满；只装第三件 = 删得清但说不清出处）。

### ① 删留痕 `forget-ledger.mjs`（生产件 sha16 `3839963928cae33a` · 23,016 B → 本仓 `ef903fd79700857b` · 25,098 B）

删一条记忆原本是 "DELETE 一行"，删完查不出「删了什么、谁删的、什么时候删的」。本件把删除改成
**八步顺序**：归档正文 → 写台账 → 事务内复核 hash → 才 DELETE → COMMIT。

- **归档根只走显式配置**（`config.removedRoot` → `DSH_MEMORY_REMOVED_ROOT` → `DSH_ROOT`，三级），
  取不到 ⇒ **fail-closed 拒删**（宁可不删，也不删了没记）。为什么不给缺省值：归档里是**正文全文**，
  落在任何"会被快照/备份整体收集"的目录里 ⇒ 一次备份就把正文搬出本机。
- **台账只 append**（老行一个字节不碰）：一行 = 6 个必有字段（`at`/`by`/`hash`/`owner`/`reasonCode`/`host`）
  + 7 个扩展字段（`op`/`memId`/`beforeRef`/`beforeBytes`/`textLength`/`seq`/`store`）。
  扩展字段靠本件**自写 raw 行**落盘，不走通用校验器 —— 那类函数会把不认识的字段静默砍掉，
  而老读器仍报 `invalid = 0`（判据假绿）。`host` 由调用方注入，不写死任何一台机器名。
- **台账不放正文**：只放指针 `beforeRef`（相对归档根的 posix 路径）。
- **事务内复核**：归档与 DELETE 之间重算内容 hash，不等 ⇒ `ROLLBACK`、记忆原样保留。
- 附带只读体检 `auditRelations(db)`：报关系 tag 的脏边（形态错 / 指向不存在的 id / 只写一边）。
- 硬约束：任一失败先 `ROLLBACK` 再抛 —— 共用连接停在开放事务里，会让后续写入"报成功却不落盘"。

### ② 血缘写侧预埋 `lineage-auto.mjs`（生产件 sha16 `d1cac0b193b86a54` · 30,239 B → 本仓 `b3af20a5a1948ff4` · 31,658 B）

`memory_write` 落库**之后**，把「这条记忆是在哪一轮对话里写下的」预埋进一行 pending 指针。

- 三条设计（别改成同步 / 整文件解压）：**异步**（插件与宿主同进程，同步读会卡事件循环）、
  **尾部优先**（从文件尾往前解 zstd 帧，拿到真人消息就停）、**过期即丢**（读前后各 stat 一次）。
- **竞争只降级**：`size` 变小（被截断/重写）⇒ 整笔丢；`size` 变大（尾部追加）⇒ 重读，最多 2 次；
  `mtime` 变化只作诊断、不作丢弃判据（写记忆那一刻几乎必然正在追加）。
- **只放指针**：日志行只有 `memId`/`sessionId`/`turnTs`/`userHeadSha16`/`textSha16`/`len`/`at`/`host`；
  落盘前自检「正文 ≥40 字前缀是否出现在行里」，命中即**拒写**。
- **帧预算可配**（本版把 512 从硬编码提出来）：`note.maxFrames` > env `DSH_MEMORY_LINEAGE_MAX_FRAMES`
  > `config.json#maxFrames` > 512。
- **零库**：不 import 任何 sqlite 包、不打开任何 `.db`；**fail-open**：任何异常都吞掉，只留一行
  `lineage.log`，绝不影响记忆写入。
- 取"最后一条**真人**"的判据与索引器**同解**（跳过 `source.kind !== 'user'` 的注入消息）——
  两边不同解的表现是整批 unmatched，而两侧各自的单测全绿。

### ③ 血缘回填 `lineage-backfill.mjs`（生产件 sha16 `ae97b0569c474f19` · 49,315 B → 本仓 `d33927bc994dab33` · 61,012 B）

读 pending 指针 → 按 `(session_id, ts)` 在索引库找块 → **先留痕** → 才 `UPDATE source_ids` → 写 `state.json`。
CLI：`--report`（覆盖率读数）· `--recheck`（存活率重算）· 缺省 dry-run，`--apply` 才写。

- **不写死表名**：块表按 `--chunk-table` > `chunks` > `life_chunks` > `memory_chunks` 探测，
  命中后逐一核 7 个必需列；探不到 / 缺列 ⇒ 整轮拒动（rc 3），**不猜列名**。
- **唯一写口可注入**：`--snapshot <file>` > env `DSH_MEMORY_SNAPSHOT_MODULE` > 候选路径；
  找不到 ⇒ apply 时拒动（rc 3）—— **不新造第二个写口**（"先归档旧行全文再改"那条铁律只允许一个实现）。
- **不碰 `updated_at`**：`UPDATE ... WHERE id=? AND source_ids=''`，`AND source_ids=''` 兼做并发守卫
  （别人先写了 ⇒ `changes=0` ⇒ 计 blocked，绝不复写别人的值）。
- **容量口径（跑一年不会卡）**：pending 分片按月（`pending-YYYY-MM.jsonl`），整月都已回填完的
  自动改名成 `*.jsonl.done`（不再被读）；超期分片**缺省只列进 `prunable`、不删**，
  要删得显式 `--prune-pending`（删是不可逆的，不替你决定）。
- 索引闸 / 告警都是**可选**：`--index-log`（末行不是 `done ...` ⇒ 本轮跳过）、`--alert-log`；
  不给就不判断、不写文件（不假设你用什么调度器）。

### ④ 最小闭环夹具 `dsh-memory-local/test/test-memory-lineage-loop.mjs`（18 项，已进 `npm test`）

三件**串起来**跑一次：预埋 1 条 → 回填 1 条 → forget 1 条留痕，全部产物走系统临时区。

- 判据不止"跑通"：`source_ids` 必须等于 `[用户首块, 用户尾块, assistant 前 3]`、`updated_at` 一个字不动、
  台账行 13 个字段齐、归档正文**全文**、`.done` 分片不再被读。
- **4 条阴性对照**（改坏就红）：① 只有注入消息 ⇒ 不写 pending ② 写口抛错 ⇒ blocked 且库一个字节没改
  ③ 写口若在 UPDATE 之后才被调 ⇒ 写口自己抛（顺序守卫）④ 写口找不到 ⇒ apply 拒动 rc=3。
- 另有两件"同源断言"：本件的 zstd 帧解析与 `lib/zstd-frames.mjs` **逐帧一致**、会话文件选取与
  `lib/session-file-name.mjs` 选中同一份 —— 内联副本一旦被改歪，夹具立刻红。

### 不在本版范围

- 插件接线（`memory_write` 之后调 `appendLineageAnchor`、`memory_forget` 改调 `forgetWithLedger`）
  属**部署侧**，本仓只在头注释里写明接线点，不改 `index.js`。
- 真实写口 `memory-snapshot.mjs`（归档旧行全文 + 台账）不在本仓，回填器的夹具用替身顶上；
  缺了它 `--apply` 会拒动而不是"照写不误"。
- 多用户 / 身份范围过滤、设备认账标记、家人侧四件：**不在本仓**（不含代码、夹具或口径）。

*English*: v0.4.0 adds the three memory **write-side** pieces: `forget-ledger.mjs` (archive → ledger →
in-transaction hash re-check → DELETE, fail-closed when no archive root is configured), `lineage-auto.mjs`
(records which conversation turn a memory was written in — async, tail-first zstd frame scan, pointer-only,
configurable frame budget), and `lineage-backfill.mjs` (fills `source_ids` from those pointers with a
detected chunk table, an injectable single write port, and monthly pending shards archived once backfilled).
No existing file changed; an 18-case loop fixture with 4 negative controls joins `npm test`.

## v0.3.0 — 2026-11-05

**给记忆加了两件事：它从哪来（来源血缘），它到什么时候为止（时效）。** 都是**加能力**，不破既有行为。

### ① 来源血缘 `source_ids`（独立列，绝不进 tags）

- `memories` 新增一列 `source_ids TEXT NOT NULL DEFAULT ''`，值 = JSON 数组字符串
  （如 `["chunk-123","chunk-456"]`），空串 = 无来源声明（与存量逐字节同形）。
  **绝不写进 `tags`** —— tags 在 FTS 索引里，塞进去会污染全文检索（搜一个 id 能搜出整条记忆，
  且 tags 会被渲染进注入面）。本仓有断言守着这一条（搜 id token ⇒ 0 命中）。
- 写法：`memory_write` 新增可选参数 `source_ids`（数组）；`MemoryStore#write()` 第四参数；
  读回：`MemoryStore#readSourceIds(id)`（解析失败按空处理，绝不抛）。
- **迁移**：显式版本键放库内新表 `schema_meta`（`memories.source_ids = 0/1`），
  **不用** `PRAGMA user_version` —— 打开链路里有一行 `PRAGMA user_version = N` 每连接无条件覆写，
  放进去等于键不存在。建 meta 表 + 加列 + 写键在**同一事务**里，原子。
- **fail-closed**：列在 + 键=1 才算迁移完成；其它组合（半迁移 / 键被改过）⇒ **拒写**并抛
  `code = E_MEMORY_SCHEMA_VERSION_MISMATCH`，不把"读不到列"当成"没有来源"继续跑。
- 写入口对来源 id 是**宽容**的：脏值丢弃、去重保序、单条 ≤200 字 / 最多 200 条（超限只截断，
  绝不因此拒绝写入）—— 血缘是观察级附加信息，不能反过来挡写记忆。

### ② 记忆时效 `until:YYYYMMDD`（过期不删，降权 + 标出）

- 落点 = **tags**（与既有 `src:<kind>#<token>;` 回指习惯一致）⇒ 只加标签、不加列、不改表。
  认标准 `until:20251130`、空格分隔 `until: 20251130`、以及 `2025-11-30` / `"20251130"` 几种写法；
  认不出来的一律当"无期限"（**fail-open**），只在统计里留一条"格式不认识"。
- **过期条目不删**：`memory_search` 走**稳定分区**（过期整体后移，两组内部名次一字不动，
  结果集不增不删）；注入侧的指针走**标注位降权**（名次不动，整行带「已过期（until …）」）。
  为什么两种：指针有 800 字 / 8 条硬预算，后移会把过期条目直接挤出渲染集 = 实质等于删掉。
- 渲染层：`pointerLine` / 搜索结果的过期标注**从本行摘要里让位**（逐字缩摘要，缩到 40 字仍放不下
  才放弃该条标注），800 字 / 600 token 硬预算一个字没放宽。
- 无一条带 `until:` 时：`rrfFuse` / `cosineTopK` / `bm25` 一字未碰，渲染输出与改动前**逐字节一致**
  （有阴性对照测试守着）。
- 急救关：`MEMORY_UNTIL=0` ⇒ 全部按"无期限"处理，与没有本能力时逐字一致。

### 不在本版范围（属部署侧私有实现）

**多用户 / 身份范围过滤**（可见性枚举的运行时判定、按身份 fail-closed 的召回闸）、设备认账标记、
层标与写入影子判定、`src` 回指参数 —— 这些是具体部署的私有实现，**本仓不含其代码、夹具或口径**。
本版只把上面两件与部署无关的通用能力提炼出来，实现与部署件语义等价（逐点对照见发版报告）。

### 发布包变化

- **测试不进 npm 包**：`files` 里排除 `dsh-memory-local/test/`、`memory-engine/test/`、
  `memory-db-tools/_test/` ⇒ 打包文件 164 → 137，解包体积 3.2 MB → 2.7 MB。
  测试仍在仓里（`npm test` 照跑），只是不再塞进用户安装面。
- `npm test` 增加两套新单测（时效 / 血缘），并新增 `npm run test:memory`、`npm run test:recall`。

*English*: two additive capabilities. (1) **Provenance** — `memories` gains an independent
`source_ids` column (JSON array string, empty = none) that is *never* written into `tags`, because
tags is full-text indexed. Migration uses an explicit version key in a new `schema_meta` table
(not `PRAGMA user_version`, which the open path overwrites) inside a single transaction, and is
fail-closed: a half-migrated database refuses writes with `E_MEMORY_SCHEMA_VERSION_MISMATCH` rather
than silently treating "column missing" as "no provenance". (2) **Expiry** — `until:YYYYMMDD` in tags;
expired rows are **never deleted**: `memory_search` moves them to the end with a stable partition,
the recall pointer keeps their rank and marks the line `已过期（until …）` instead (moving them out
would silently equal deletion under its hard 800-char budget). Rendering pays for the mark out of the
line's own summary, never out of the budget. With no `until:` anywhere the output is byte-identical
to before; `MEMORY_UNTIL=0` disables the whole feature. Multi-user / identity-scoped filtering, device
attribution marks, layer tags and the `src` back-reference are deployment-private and are **not**
included here. Tests are no longer shipped inside the npm tarball (164 → 137 files).


## v0.2.1 — 2026-11-04

**把真实账号从代码里移除**（安全修复）。⚠️ 如实说明：**v0.2.0 及更早的包仍带着它**（已发布在 npm，
可被下载），本版清除。

- `memory-db-tools/lib/memory-scope.mjs` 与 `dsh-memory-local/src/schema-migrate.mjs` 里的
  `FALLBACK_OWNER_USER` 不再写死任何 userid；改为读环境变量 **`$DSH_OWNER_USER`**（缺省空串）。
  新增函数 `fallbackOwnerUser(env)`；`FALLBACK_OWNER_USER` 保留为"进程启动瞬间的快照"导出
  （运行时判定请用函数，快照不跟随进程内 env 变化）。
- `memory-engine/lib/doc-index-store.mjs` 的建表默认值改为空串（SQLite 的 `DEFAULT` 只能是常量表达式），
  写入时由 `fallbackOwnerUser()` 补值；`memory-engine/lib/doc-index.mjs` 与
  `memory-engine/cli/domain-tags.mjs` 同样不再回落到内置 userid。
- **行为变化（唯一一条）**：身份表缺位**且**未配 `$DSH_OWNER_USER` 时，`owner_user` 落**空串**、
  `notes` 记一行"未配置 owner"，**不抛错**（抛错会让既有用户的迁移直接失败）。
  有身份表的主路径**完全不变**（仍取 `role === 'owner'` 那条，`source === 'identity-table'`）。
- 测试与夹具里的真实账号换成中性夹具名（`owner_x` / `Owner_X`），**断言语义不变**；另新增
  「未配 env ⇒ 留空 + 提示」与「配了 env ⇒ 取该值」两态断言（并做过证红演练：把实现临时改回
  "写死常量"，两处测试确实变红）。
- 测试夹具不再去读本机的真实身份表（`~/.dsh/secretary-users.json`）：需要身份表的用例一律显式传
  临时夹具表，否则会把本机 owner 写进夹具库。
- 顺带把 `dsh-memory-local/src/index.js` 注释里的设备别名与内部文档名改成中性说法（**仅注释**，行为不变）。

*English*: the real account name is gone from the code. `FALLBACK_OWNER_USER` is no longer a typed-in
userid — it is now `fallbackOwnerUser(env)`, read from `$DSH_OWNER_USER` (empty by default). With neither
an identity table nor that env var, `owner_user` stays empty and a note is emitted; nothing throws. The
identity-table path is unchanged (still `source === 'identity-table'`). Tests gained both states and a
red-drill proves they are not vacuous.

**测试**：`npm test` = scope 72 通过 / 0 失败（1 条跳过：`memory-fieldname-check.mjs` 从未随本仓发布，
已在测试里登记为缺口）+ schema-migrate 75 + engine 245。

## v0.2.0 — 2026-10-31

**41 个业务件独立重写**（能力与对外接口不变，实现换成自己的）：

`memory-engine/lib`(21) + `memory-engine/cli`(11) + `memory-engine/tools`(3) + 仓根 `lib`(6) = **41 件**
从"生产实现的逐字副本"改成**独立实现**。判据是**行级同源度**（同名可比件里，本仓文件的非空行有多少能在参照件中找到，多重集扣减）：

- 41 件均值：**99.2% → 24.6%**；
- **≥5KB 的 28 件全部 < 50%**（最高 47.5%，最低 12.5%）；
- 全仓「≥50% 行同占比」：**99% → 64%**（残余面 = `dsh-memory-local/`、`memory-db-tools/`、`memory-engine/test/`，这三块不在本版范围内）。

**对外接口零变化**：

- `memory-engine/test` 的 184 项回归全绿，测试文件一行未改（这就是"没改坏行为"的唯一证据）；
- 41 件导出面逐件比对：导出名零缺零多，常量值逐值不变；
- CLI 的 `--flag` 名、缺省值、stdout/stderr 分工、退出码语义不变（改前改后逐用例对拍）。

**顺带清掉内部标识**：卡号、棒号、设备别名、注释里的私有盘符路径与内部任务代号；
7 处保留的是**契约字符串**（`EXCLUDE_DIRS` 的四类目录名、`deploy-guard` 的忽略目录表），改了会破行为。

逐件台账见仓根 `k9-progress.jsonl`（41 行：before/after sha + 两次数值 + 实现形态说明）。

*English*: 41 business modules rewritten as independent implementations — same capability and public
interface, different code. Line-level shared-source ratio 99.2% → 24.6% on average; every file ≥5 KB is
below 50%. The 184-case regression suite passes unchanged, the export surface is identical, and CLI
flags / defaults / exit codes are unchanged. Internal identifiers were stripped; the seven remaining
hits are contractual strings (the excluded-directory list and the guard's ignore table).

### 召回链：降级 / 词表第二路 / 命中留痕（K4）

- **查询截断**：引擎侧新增 256 字符上限（原来引擎侧**完全不截**；生产侧那道 512 是插件注入器的配置，不在引擎里）。按码点截，`stats.queryChars / queryCharsUsed / queryTruncated` 如实记录。
- **编码降级**：编码带预算（默认 1500 ms）。超时 / 抛错 / 空向量 ⇒ 降级成**固定 Top-K**（默认 8 条，按最近改动取，仍排除 pinned），结果带 `degraded.mode = "fixed-topk"` 与 `encodeError = { name, ms }`。**绝不返回空、绝不把异常往上抛**。
- **词表第二路**（新文件 `lib/lexicon-recall.mjs`）：jieba 词典最长匹配 + **BM25**（tf 饱和 / 长度归一 / 语料 idf × 通用词具体度）+ 进程内缓存与后台预热，与向量、FTS 一起进 RRF(k=60)。开关 = `dict/lexicon-config.json#enabled`（出厂 **false**）/ `MEMORY_ENGINE_LEXICON` / `--lexicon on|off`。关掉时结果与改动前**逐字一致**（夹具对拍 4 条查询 + CLI 旧新对拍）。
- **命中留痕**（新文件 `lib/recall-log.mjs`）：旁路 JSONL，字段 = 时刻 / query / 命中 id / 分数 / 来源 / 是否降级 / 耗时；**不存记忆正文**。默认不写，给目录才写；`DSH_MEMORY_RECALL_LOG=off` 一键关回；字节（512 KB）→ 轮转（3 代）→ 天数（14 天）三重封口，`keepFiles: 0` 只留当前文件。
- **词典素材**：`memory-engine/dict/`（`词典.txt` 1.03 MB + `词频.txt` 219 KB + MIT 许可声明 + 开关文件），合计约 **1.25 MB**；`npm pack --dry-run` 实测 tarball **1.1 MB** / 解包 **2.8 MB** / **140** 个文件。素材目录可用 `MEMORY_ENGINE_DICT_DIR` 改位；缺素材时这一路优雅退化为纯向量。
- **验证**：`memory-engine/test` 184 项**一行未改、全绿**；新增 `tools/verify-recall-chain.mjs`（15 项自带判据，给 `--baseline <改动前 lib>` 则 17 项）；两个新文件行级同源度 **18.5% / 19.5%**。
- **接口**：只有新增 —— CLI 4 个开关（`--lexicon` / `--lexicon-top-k` / `--lexicon-floor` / `--fallback-top-k` / `--encode-timeout-ms` / `--query-max-chars` / `--recall-log` / `--no-recall-log`）、`recall()`/`recallMulti()` 的新可选入参、`stats` 新字段、`memory-source.recent()`；既有参数、缺省值、退出码语义不变。

*English*: recall chain hardening — 256-char query truncation; an encoding time budget with a **fixed top-K degradation** (never empty, never throws); a lexicon/BM25 second path fused through RRF (off by default, one-line switch, byte-identical results when off); and an opt-in side-channel JSONL recall log with byte/generation/age caps. Dictionary assets (~1.25 MB, jieba · MIT) ship in `memory-engine/dict/`; `npm pack` measures 1.1 MB tarball / 2.8 MB unpacked / 140 files. The 184 existing tests are unchanged and green, and `tools/verify-recall-chain.mjs` adds 15 acceptance checks. Interface changes are additive only.

### 分层软淘汰 + 号段哨兵（K5，净新增件）

记忆只能删、不能降级；多台机共用一个库时 id 号段越界没人喊 —— 各给一件，**出厂全是干跑 / 只读**。

- **`layer` 字段 + 迁移**（新文件 `lib/layers.mjs` / `lib/layer-migrate.mjs` / `cli/layer-migrate.mjs`）：加一列 `layer`，存量行回填缺省层。
  **零删行**：行数 / `sqlite_sequence` / `PRAGMA integrity_check` 三项改完复核，任一不符就报错并指向备份。
  **幂等**：列已在、空值已清零 ⇒ 第二次 `--apply` 库文件逐字节不变。`--apply` **必须**同时给 `--db` 与 `--backup`；`--restore <备份>` 默认干跑，真还原走「同目录临时文件 + sha 校验 + rename」，并先摘掉陈旧 `-wal`/`-shm`。
- **软淘汰执行器**（新文件 `lib/layer-move.mjs` / `cli/layer-move.mjs`）：整层搬进同库边表 `memories_evicted`，一条命令出去、一条命令回来，**一条不删**。
  硬判据 = 搬出行数 + 剩下行数 == 搬前总行数（事务内断言）；每行带 `content_sha`，搬回前先核指纹，边表被改过就整批拒动。配套 `--dump` / `--verify` 做逐行对拍；会搬空主表时默认拒跑（`--force` 才动）。
  代价写进 README：搬走的行仍占库体积、边表没有 FTS 索引。
- **号段哨兵**（新文件 `lib/band-sentinel.mjs` / `cli/band-sentinel.mjs`）：`sqlite_sequence` 主判 + 「更高位段有行」才判红；**更低位的别台段行只披露不判红**（生产件踩过的假红，没改回去）。
  **单机退化**：配置里只有一条 band 就只读本机、不 ssh；多机才走配置里的 `remote { ssh, node, db }`。**任一远端读不到 ⇒ 结论写「未探测 / 不可达」，退出码不是 4**（4 只留给本机库读不到）；`--require-all` 才把未探测算失败（rc=5）。
- **配置驱动**：`memory-engine/config/layers.json`（层名集合 / 列名 / 缺省层）与 `memory-engine/config/bands.json`（号段表）。代码里没有写死的层名，也没有任何机器名。
- **CLI 惯例**：新增三个命令全部 `--help` 可读、未知参数 fail-closed（rc=2）、默认 dry-run、`--json` **只落文件不上 stdout**、`isMainEntry` 守卫走 `realpathSync` 双方比。
- **验证**：`memory-engine/test` **既有 184 项一行未改、全绿**；新增 `test/12-layering.test.mjs` **21 项**（干跑零写 / 加列回填 / 幂等 / 备份还原 / 搬出守恒 / 搬回逐行指纹一致 / 边表被改整批拒动 / 号段红绿对照 / 远端读不到不许 rc=4）。新增 7 个代码件对生产同名件的行级同源度全部 < 50%（逐件读数见仓根 `k5-progress.jsonl`）。

*English*: layered soft eviction + id-band sentinel (net-new). `layer-migrate` adds a `layer` column and backfills the default layer — zero row deletion, idempotent (second `--apply` is byte-identical), requires an explicit `--db` and a `--backup`, and `--restore` is dry-run by default. `layer-move` moves a whole layer into the in-database side table `memories_evicted` and back, with the hard invariant `moved + remaining == before` asserted in-transaction and per-row `content_sha` verified before restoring. `band-sentinel` checks the `sqlite_sequence`-derived next id against a config-driven band table, judges rows in higher bands red, only *discloses* rows in lower foreign bands, degrades to a single-machine check with no ssh, and never returns 4 for an unreachable peer. All three CLIs are `--help`-readable, fail closed on unknown flags, default to dry-run, and write JSON reports to files only. The 184 existing tests are unchanged and green; `test/12-layering.test.mjs` adds 21 checks.

### 会话日志 → 记忆（K6，净新增件）

记忆的**输入面**补上第二条：一段会话日志进来，产出 ≤N 条可追溯、可整批撤回的结论条。**旧入口（`distill.mjs` / `distill-rollback.mjs` 及其 CLI）的默认值、参数名、退出码一个没改**。

- **会话适配层**（新文件 `lib/session-source.mjs`）：只挑能回指来源的结论句（决定 / 口径 / 偏好 / 修复方案），
  每条带 `sessionId` + 行号 + 行首字节偏移 + 原文前 48 字锚。寒暄 / 疑问 / 过程叙述 / 推测 / 工具输出 / 超长转述
  **一律不抽**，逐类计数后一次性报出来。抽的是原句，不做摘要式改写。
- **新入口**（新文件 `cli/distill-sessions.mjs`）：`--source <jsonl>` → 抽句 → 预算闸 → 一次模型调用 → `VACUUM INTO` 快照 → 写回。
  缺省 **dry-run**（不调模型、不写库、不写台账）；未知参数 fail-closed（rc=2）；`--json` 必须配 `--out`，**只落文件不上 stdout**。
- **预算闸（这条是核心）**：没给 `--max-tokens`、台账里也没配 ⇒ **一次模型都不调**，打印「未配置每日预算 ⇒ 本轮不跑（这是故意的）」，rc=0。
  **不继承**内核 `DAILY_TOKEN_CAP = 150000`，也不"没配 = 无限跑"；当日已超或本次估算会超，同样不跑并打印用量。
  实测（deepseek-flash，三轮夹具，每轮一次调用）**424 / 424 / 434 token**（合计 1311，prompt 1044 / completion 267），
  建议 `--max-tokens 20000`（约 19 轮/天按估算、~45 轮/天按实测）。
- **写回与撤回**：标签 = `distilled src=<批次键> srcids=<行号,...> date=<YYYYMMDD> sess=<场次> run=session:<批次 id>`；
  一轮一个来源键 ⇒ 撤回直接用既有 `distill-rollback.mjs --key <批次键> --apply`，一批一条命令整组删（不新写撤回器）。
  写库前快照拍不成 ⇒ **不写库**（fail-closed）。
- **压缩输入**：`.jsonl.zstd` 走 node 内置 zstd **逐帧**解（DSH 日志一次追加一帧，多帧文件），解不开给人话错误而不是静默失败；
  当前 node 没有 zstd API 时同样给"请先解压"的提示。
- **验证**：`memory-engine/test` **既有 205 项一行未改、全绿**；新增 `test/13-session-distill.test.mjs` **40 项**
  （抽句回指对得上原文 / zstd 单帧多帧坏帧 / 预算闸三态 / 快照 fail-closed / 模型失败也记账 / 幂等 / 整批撤回 /
  CLI 未知参数与 `--json` 分工）。两个新件对生产同名件的行级同源度见仓根 `k6-progress.jsonl`。

*English*: session logs → memories (net-new). `lib/session-source.mjs` extracts only conclusion sentences that can be
pointed back to their source (session id + line + byte offset + 48-char verbatim anchor), and drops greetings,
questions, process narration, speculation, tool output and over-long passages while counting each rejected class.
`cli/distill-sessions.mjs` is a new entry point that extracts, applies the budget gate, makes exactly one model call,
takes a `VACUUM INTO` snapshot and writes back — dry-run by default, unknown flags fail closed, and `--json` writes to
a file only, never to stdout. **No daily budget configured ⇒ the model is not called at all** (rc=0, and it prints
that this is deliberate); it never inherits the kernel's 150000 cap and never treats "unconfigured" as unlimited.
Measured over three fixture sessions: 424 / 424 / 434 tokens per round (1311 total), suggesting `--max-tokens 20000`.
Each run maps to one source key, so reverting is the existing `distill-rollback.mjs --key <batch key> --apply`.
Compressed `.jsonl.zstd` input is decoded frame by frame with node's built-in zstd; failures raise a plain-language
error instead of returning partial data. The 205 existing tests are unchanged and green; the new test file adds 40 checks.

## v0.1.3 — 2026-10-30

**主包补 bundle 声明 + 子路径导出面**（修「装完不生效」；无插件行为变化）：

根因是**声明层错位**：`dsh-memory-local/` 的 bundle 声明写在私有子包自己的 `package.json` 里，主包没有 `dsh.bundle`
⇒ `dsh plugin add` 只打一行 `declares no dsh.bundle` 警告、profile 的 `dsh.profile.bundles` 不变，**装了等于没装**
（rc 仍是 0，所以用户会当成装好了）。本版把声明提到主包根，并给出宿主 loader（ESM `import()`）能解析的子路径。

- 新增仓根 `cordis.patch.yml`：`id: kira905-memory`（**不是** `memory` —— 那个 id 归官方 `dsh-memory`，撞 id 会静默顶掉或启动抛错）、
  `name: '@kira905/dsh-memory-toolkit/dsh-memory-local'`；`config` 与子包那份逐键相同（含 `path`）。
- 主包 `package.json` 新增 `dsh.bundle.patch = ./cordis.patch.yml`。
- 主包 `package.json` 新增 `exports`：`./dsh-memory-local` → `./dsh-memory-local/lib/index.js`（**文件**，不是目录）、
  `./package.json` → `./package.json`；**没有** `"."` 条目（主包 `lib/` 没有 `index.js`，包根导入本来就不通）。
- `files` 补上 `cordis.patch.yml`（否则 tarball 里没有它，装了照样不生效）。

**迁移四条（"收窄包面"变更 —— 只升 patch 号，但请读一遍）**：

1. **从包根导入的写法会失败**（`import '@kira905/dsh-memory-toolkit'`）—— 旧版本来也不通（没有 `main` / `exports`），
   本版给它一个**明确的** `ERR_PACKAGE_PATH_NOT_EXPORTED`，而不是 "Cannot find package …/index.js" 这种像"文件丢了"的报错。
   没有可迁移的既有用法。
2. **子路径导入改走 `exports`**：`@kira905/dsh-memory-toolkit/dsh-memory-local` 从 0.1.2 的
   `ERR_UNSUPPORTED_DIR_IMPORT`（ESM 不认目录）变成**可用**；反过来，深路径
   `@kira905/dsh-memory-toolkit/dsh-memory-local/lib/index.js` 从 0.1.2 的"可达"变成 **`ERR_PACKAGE_PATH_NOT_EXPORTED`**。
   踩到的把 specifier 换成映射后的 `…/dsh-memory-local`（**不要**反过来删 `exports` 图省事 —— 那会把 ESM 这条路重新掐死）。
3. **与官方 `dsh-memory` 二选一**：本包定位是**替代实现**（`dsh-memory-local` 是 `dsh-memory@0.1.0` 的 fork），两者抢同一个
   "记忆"位置。装之前读 `<profile>/package.json` 的 `dsh.profile.bundles`，含 `dsh-memory` 就**别装**（反之亦然）；
   要换实现先把另一个摘掉，别让两份同时加载。
4. **旧版仍在 npm、可回退**：`0.1.2` 及以前都在，`npm i @kira905/dsh-memory-toolkit@0.1.2` 可回退；回退后深路径恢复可达，
   同时"不挂载"的老行为也回来（不坏，但等于白装）。

*English: 0.1.3 declares the bundle at the package root (new `cordis.patch.yml`, `id: kira905-memory`) and adds an
`exports` map that points the `./dsh-memory-local` subpath at a real file, so `dsh plugin add` mounts the fork instead
of printing "declares no dsh.bundle". No plugin behaviour changed. This narrows the package surface: the deep
`…/dsh-memory-local/lib/index.js` path is no longer importable (use the mapped subpath), the package root still has no
entry point (now with an explicit `ERR_PACKAGE_PATH_NOT_EXPORTED`), and this package replaces — never coexists with —
the official `dsh-memory`. 0.1.2 stays on npm for rollback.*

## v0.1.2 — 2026-10-30

**内部标识残留清剿**（无 API / 行为契约变化）：

- 注释里残留的内部笔记路径、构建机设备标记一并清掉；`dsh-memory-local` 的 `lib/` 与 `src/` 两份适配层副本
  改成一致（`memory-engine` 184 项与适配层收敛用例复跑同绿）。

*English: residual internal note paths and build-machine device markers removed from comments; the lib/ and src/ adapter copies stay byte-identical; no behaviour change.*

## v0.1.1 — 2026-10-30

**部署面补齐 + 用语刷净**（无 API / 行为契约变化）：

- `dsh-memory-local/` 部署侧支持 `.modules.yaml` profiles（主包 0.2.0-rc.x 的文件布局），新增「全新安装」分支，备份目录改为按需创建。
- 内部用语刷净：构建机的设备标记改为中性写法（原来的构建机设备标记），文档标签示例由设备名改为通用词（`工作记录`）；对应单测断言同步更新，`memory-engine` 184 项全绿。
- 本版起 `npm publish` 走 `next` 标签、稳定后再挂 `latest`。

*English: deploy side now supports `.modules.yaml` profiles (host 0.2.0-rc.x) with a fresh-install branch and lazy backup-dir creation; internal build-machine wording scrubbed (no API/behaviour change).*

## v0.1.0 — 2026-10-19（首发）

**首发范围**（从自用工作流中拆出的记忆面四件，源码级只读复制 + 脱敏 + 补齐仓骨架）：

- `memory-engine/` —— 记忆引擎离线层：独立矢量库、增量同步、兜底 hash 轮转、混合召回、文档索引、启动自检、本地编码桥
- `memory-db-tools/` —— 记忆库只读体检工具链（导出 / 分析 / 结构探针 / 特征词探针 / persona 重合度 / 看板账本探针 / 零改动自证 / 开工简报）
- `dsh-memory-local/` —— 上游 `dsh-memory`（MIT）的自持 fork：构建 / 幂等部署 / 一键回滚 / 部署后自检
- `persona-memory-audit.mjs` —— persona ↔ 记忆体检单文件 CLI
- `lib/` —— 四件共用的无依赖小件

**首发做了哪些适配**（相对私有原件）：

1. **路径全部去硬编码**：所有默认值改为「环境变量 → 当前工作目录 / `$DSH_HOME`」推导，仓内不含任何机器路径或用户名。
2. **依赖去私有化**：原先指向私有工具目录的绝对 `file:///` import 改为仓内相对路径；生产写闸换成本仓自带的等价实现（`dsh-memory-local/lib/prod-gate.mjs`，判定口径不变：realpath + 逻辑路径双比、dry-run 为第一道门）。
3. **新增 `--help`**：`persona-memory-audit.mjs` 与 `list-memory-summary.mjs` 补了不读任何库的纯文本帮助。
4. **跨平台默认 home**：`list-memory-summary.mjs` 的 home 缺省值改为 `$DSH_HOME` → `$USERPROFILE` → `$HOME` 三级回落。
5. **未随首发开源的件**：`memory-fieldname-check.mjs` 及其白名单（一次性内部字段改名审计，白名单逐条绑定内部文档原文，公开价值近零）、构建产物 `dsh-memory-local/lib/.build-info.json`（由 `node build.mjs` 重新生成）。

**许可**：代码仓 AGPL-3.0 + 商业授权；`dsh-memory-local/` 子树保持上游 MIT。

*English: First release — the memory-side quadruple (engine, audit toolkit, plugin fork, persona audit)
with machine paths removed, private absolute imports replaced by in-repo relatives, `--help` added to two CLIs,
and one internal one-off audit tool intentionally left out.*

## 后续版本（占位）

- 待办：把 `memory-engine` 的依赖声明与安装路径再收口（当前需要在 `memory-engine/` 内单独 `npm install`）
