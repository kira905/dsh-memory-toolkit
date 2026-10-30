# Changelog

本仓的版本按**语义化版本**：改结论/改契约升主版本，加能力升次版本，修错别字与文档订正不升。
英文摘要见每节末尾的 *English* 行。

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
