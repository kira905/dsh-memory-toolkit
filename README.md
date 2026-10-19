# dsh-memory-toolkit

**DSH（DeepSeek Harness）生态的记忆面工具集** —— 一个独立向量记忆引擎、一套记忆库只读体检工具链、
一个自持 fork 的本地记忆插件，以及一个 persona ↔ 记忆体检小工具。

四件东西原本是同一套自用工作流的不同切面，抽出来独立成仓，可以单独用，也可以拼起来用：
**引擎负责"记什么、怎么找回来"，工具链负责"看得见、改得动"，插件负责"接进会话"。**

---

## 一、里面有什么

| 目录 | 是什么 | 形态 |
|---|---|---|
| [`memory-engine/`](./memory-engine/README.md) | 记忆引擎（离线层）：独立矢量库 · 增量同步 · 兜底 hash 轮转 · 混合召回（向量 + FTS5 + RRF） · 文档索引 · 启动自检 · 本地编码桥 | 纯 Node ESM + `node:sqlite` |
| [`memory-db-tools/`](./memory-db-tools/README.md) | 记忆库工具集：只读导出 / 六项体检分析 / 结构探针 / 特征词探针 / 与 persona 的重合度 / 看板账本只读探针 / 零改动自证 / 新会话开工简报 | 一组独立 CLI |
| [`dsh-memory-local/`](./dsh-memory-local/README.md) | 本地记忆插件：上游 `dsh-memory` 的自持 fork（跨会话持久记忆 + 召回提示段 + 指针注入链），带构建 / 幂等部署 / 一键回滚 / 部署后自检 | DSH 插件 |
| [`persona-memory-audit.mjs`](./persona-memory-audit.mjs) | persona ↔ 记忆体检：把「persona 正文体积」与「记忆可见率」两项指标固定下来，超阈值即报红 | 单文件 CLI |
| [`lib/`](./lib) | 四件共用的无依赖小件（参数白名单 / HTTP 存活判据 / zstd 帧解析 / 会话文件名 / 坑库打分） | 纯函数模块 |

## 二、环境要求

- **Node.js ≥ 22**（用到内置 `node:sqlite`，以及 ESM 顶层能力）
- 平台：Windows / Linux / macOS 均可；路径默认值一律从**环境变量或当前工作目录**推导，不含任何写死的机器路径
- `memory-engine/` 的**本地向量编码**额外需要 `@huggingface/transformers`（可选，见下）

## 三、安装

```bash
git clone https://github.com/kira905/dsh-memory-toolkit.git
cd dsh-memory-toolkit
npm install          # 本仓根包零运行时依赖，此步只装元数据
```

要跑**本地向量编码**（`memory-engine` 的 ONNX 路径），再装它自己的依赖：

```bash
cd memory-engine
npm install          # 会拉 @huggingface/transformers（较大，约 300+ MB）
```

不想装这个依赖也可以：引擎的召回支持**HTTP 编码桥**（见下），以及纯 FTS5 的降级路径。

## 四、快速开始（命令可直接照抄）

```bash
# ① 体检工具链的用法与参数（零副作用，先看再跑）
node memory-db-tools/audit-export.mjs --help

# ② persona ↔ 记忆体检（只读；读 $DSH_HOME 下的 persona 与记忆库）
node persona-memory-audit.mjs --help

# ③ 新会话开工简报（只读：设备行 + 记忆清单 + pinned 全文）
node memory-db-tools/list-memory-summary.mjs --help

# ④ 记忆引擎的启动自检（需要先在 memory-engine/ 内 npm install）
cd memory-engine && node cli/selfcheck.mjs --json
```

一次典型的**季度记忆库体检**（全部只读，产物落你指定的目录）：

```bash
node memory-db-tools/audit-export.mjs --out ./_audit/memories.json
node memory-db-tools/audit-analyze.mjs --in ./_audit/memories.json --out ./_audit
node memory-db-tools/audit-struct-probe.mjs --in ./_audit/memories.json
node memory-db-tools/audit-verify-unchanged.mjs --baseline ./_audit/memories.json --expect-unchanged
```

## 五、与 DSH 的集成点

本仓**不依赖 DSH 才能运行**，但下面三处是刻意的接缝：

| 接缝 | 说明 |
|---|---|
| `DSH_HOME`（缺省 `~/.dsh`） | 记忆库（`memory/memory.db`）、向量库（`memory-vectors/`）、preset（`.agent-presets/`）、profile 覆盖（`profiles/<profile>/cordis.patch.yml`）一律从它推导 |
| `dsh-memory-local/` 的部署形态 | 插件**占用上游包槽位** `profiles/<profile>/node_modules/dsh-memory`（不新增包名、不改 profile wiring），`cordis.patch.yml` 的 `insert.name` 必须保持 `dsh-memory` |
| 环境变量注入 | `MEMORY_ENGINE_*`（库/向量/模型/批大小/召回参数）、`DOC_INDEX_*`（文档索引扫描面）、`DSH_ARCHIVE`（备份落点）、`DSH_PROD_ROOTS`（生产树放行闸） |

## 六、数据与安全

- **对记忆库只读**：引擎与全套 `audit-*` 工具打开 `memory.db` 一律 `readOnly: true`；唯一的写口是独立向量库与你自己指定的输出目录。
- **不收集、不外发**：没有任何遥测；唯一的外部网络调用是你主动启用的 LLM/编码端点。
- **凭据只从环境变量或本地配置文件读**，代码里没有、也不会写任何密钥。
- **生产写闸**：还原 / 回滚类脚本动到生产树前必须显式 `--allow-production`，否则拒跑（`--dry-run` 是只读档，不受限）。

## 七、许可

**AGPL-3.0**（GNU Affero General Public License v3.0），全文见 [LICENSE](./LICENSE)。

个人、学习、开源项目可自由使用与修改。若要在**闭源**或**商业场景**中使用（AGPL 的传染条款不适用），
请在 [Issues](https://github.com/kira905/dsh-memory-toolkit/issues) 开一条说明用途，获取**商业授权**。

> **子树例外**：`dsh-memory-local/` 是上游 `dsh-memory`（MIT）的 fork，
> 该子树**保持上游 MIT 许可**（见其 `package.json` 的 `license` 字段与 `FORK-BASE.json`）；
> 其余目录（引擎、工具链、共用件）为本项目原创，按 AGPL-3.0 + 商业授权双许可发布。

## 八、相关仓

- [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) —— DSH 大管家（自主运维机制）归档仓
- [`dsh-session-toolkit`](https://github.com/kira905/dsh-session-toolkit) —— 会话标题 / 会话治理
- [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) —— 生态面板
- [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) —— 急救台 / 回滚演练
- 同属 DSH 生态的伴生组件各自独立仓、独立版本、许可各自独立。
