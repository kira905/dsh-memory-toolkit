# Changelog

本仓的版本按**语义化版本**：改结论/改契约升主版本，加能力升次版本，修错别字与文档订正不升。
英文摘要见每节末尾的 *English* 行。

## v0.1.2 — 2026-10-30

**内部标识残留清剿**（无 API / 行为契约变化）：

- 注释里残留的内部笔记路径、构建机设备标记一并清掉；`dsh-memory-local` 的 `lib/` 与 `src/` 两份适配层副本
  改成一致（`memory-engine` 184 项与适配层收敛用例复跑同绿）。

*English: residual internal note paths and build-machine device markers removed from comments; the lib/ and src/ adapter copies stay byte-identical; no behaviour change.*

## v0.1.1 — 2026-10-30

**部署面补齐 + 用语刷净**（无 API / 行为契约变化）：

- `dsh-memory-local/` 部署侧支持 `.modules.yaml` profiles（主包 0.2.0-rc.x 的文件布局），新增「全新安装」分支，备份目录改为按需创建。
- 内部用语刷净：构建机的设备标记改为中性写法（`【设备：ROG】`），文档标签示例由设备名改为通用词（`工作记录`）；对应单测断言同步更新，`memory-engine` 184 项全绿。
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
