# Changelog

本仓的版本按**语义化版本**：改结论/改契约升主版本，加能力升次版本，修错别字与文档订正不升。
英文摘要见每节末尾的 *English* 行。

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
