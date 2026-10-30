# dsh-memory-toolkit

> **本仓装完即用**（0.1.3 起）：`dsh plugin --profile <profile> add @kira905/dsh-memory-toolkit` 一条命令，`dsh.bundle` 会让它自动挂进 profile 的组合列表，**不需要再手工写 `cordis.patch.yml`**。包内 3 个 CLI（`dsh-memory-audit` / `dsh-memory-summary` / `dsh-memory-export`）与挂载无关，`npm i -g` 或 `npx` 直接用。

## 装完自检（三条只读验法）

`<profile>` 换成你实际用的 profile（默认 `web`），`<数据根>` 换成你的 DSH 数据根（默认 `~/.dsh`）。

```powershell
# ① 组合树里有没有它（只读、约 0.6 秒、不启服务）
dsh --profile <profile> --dump-config | Select-String "dsh-memory-toolkit"
# 期望：bundle 层出现一行 "# == <登记名>"、insert 层出现 "- id: <entry>"（问的都是「它挂上没」）；
#       本仓包名 @kira905/dsh-memory-toolkit —— 带 scope 装的写带 scope 名、老工装 / 手写的可能是裸名，两种都搜一遍
#       ⚠️ 若该包会 insert 一行，还要数一遍"同一个 id 出现了几次"，必须 == 1

# ② 组合列表里有没有它（只读）
Get-Content <数据根>/profiles/<profile>/package.json | Select-String "@kira905/dsh-memory-toolkit"
# 期望：dependencies 与 dsh.profile.bundles 两处都有（CLI 类只需要 dependencies；bundles 里也可能写裸名 dsh-memory-toolkit）

# ③ 命令在不在 —— 【只查存在，不执行】
Test-Path <数据根>/profiles/<profile>/node_modules/.bin/dsh-memory-summary.CMD   # 装进 profile 的
Test-Path "$env:APPDATA\npm\dsh-memory-summary.CMD"                           # npm i -g 装的
# 期望：True。两条路径按你实际用的装法挑一条
```

> 探针只做存在性检查（只看命令文件在不在，不执行任何命令）。
> 要不要用 `--help` 验，见本仓当前说明与该命令的参数表。

---

**DSH（DeepSeek Harness）生态的记忆面工具集** —— 一个独立向量记忆引擎、一套记忆库只读体检工具链、
一个自持 fork 的本地记忆插件，以及一个 persona ↔ 记忆体检小工具。

四件东西原本是同一套自用工作流的不同切面，抽出来独立成仓，可以单独用，也可以拼起来用：
**引擎负责"记什么、怎么找回来"，工具链负责"看得见、改得动"，插件负责"接进会话"。**

---

## 一、里面有什么

| 目录 | 是什么 | 形态 |
|---|---|---|
| [`memory-engine/`](./memory-engine/README.md) | 记忆引擎（离线层）：独立矢量库 · 增量同步 · 兜底 hash 轮转 · 混合召回（向量 + FTS5 + 词表 BM25 + RRF + 编码降级兜底 + 旁路留痕） · 文档索引 · 启动自检 · 本地编码桥 | 纯 Node ESM + `node:sqlite` |
| [`memory-db-tools/`](./memory-db-tools/README.md) | 记忆库工具集：只读导出 / 六项体检分析 / 结构探针 / 特征词探针 / 与 persona 的重合度 / 看板账本只读探针 / 零改动自证 / 新会话开工简报 | 一组独立 CLI |
| [`dsh-memory-local/`](./dsh-memory-local/README.md) | 本地记忆插件：上游 `dsh-memory` 的自持 fork（跨会话持久记忆 + 召回提示段 + 指针注入链），带构建 / 幂等部署 / 一键回滚 / 部署后自检 | DSH 插件 |
| [`persona-memory-audit.mjs`](./persona-memory-audit.mjs) | persona ↔ 记忆体检：把「persona 正文体积」与「记忆可见率」两项指标固定下来，超阈值即报红 | 单文件 CLI |
| [`lib/`](./lib) | 四件共用的无依赖小件（参数白名单 / HTTP 存活判据 / zstd 帧解析 / 会话文件名 / 坑库打分） | 纯函数模块 |

## 同源说明

本仓**部分文件与一套内部生产实现同源**（同一份工程长期演进下来的两处落点）。

- **同源程度**：按**行级同源度**口径统计（同名可比件里，仓内文件的非空行有多少能在参照件中找到，多重集扣减），本仓「≥50% 行同占比」= **64%**。
- **这意味着**：本仓是那套实现的**提炼导出** —— **既不是逐字副本，也不是完全重写的独立实现**。拿单个文件当"独立参考实现"读之前，请先跑下面的判据。
- **怎么复跑**：同源度扫描器见 `dsh-quality-toolkit` 的 `dsh-sim-scan.mjs`（`--repo <本仓> --prod-root <参照根>`）；分档阈值与口径写在它的 `config/sim-scan.json` 里，不藏在代码里。
- **许可**：本仓许可见仓根 `LICENSE`（有子树例外时以子树 `LICENSE` 为准）。

## 召回链：降级 / 词表第二路 / 命中留痕（0.2.0 新增）

召回有三类老毛病，这一版各给一条**可一键关回**的解法；出厂默认一条都没改。

| 毛病 | 现在的做法 | 开关 | 出厂 |
|---|---|---|---|
| 编码超时/失败 ⇒ 那一轮**一条记忆都不注入** | 查询先截断到 256 字符；编码带预算（默认 1500 ms），超时 / 抛错 / 空向量一律**降级成固定 Top-K**（按最近改动取，条数默认 8），结果里带 `degraded.mode = "fixed-topk"` 与 `encodeError.name` | `fallbackTopK` / `encodeTimeoutMs` / `--fallback-top-k` / `--encode-timeout-ms` | 降级**常开**（只作用于失败路径，成功路径一字不改） |
| 纯向量对**精确词**不敏感；中文又走不了 FTS5（`unicode61` 不切中文） | **词表第二路**：jieba 词典最长匹配切词 + **BM25**（tf 饱和 + 文档长度归一 + 语料内 idf × 通用词具体度），与向量、FTS 一起进 RRF(k=60) | `memory-engine/dict/lexicon-config.json` 的 `enabled`、`MEMORY_ENGINE_LEXICON=on/off`、`--lexicon on` | **关**（关掉时结果与改动前**逐字节一致**，见下） |
| 召回了什么、命中了哪条、准不准，事后无从判断 | **旁路 JSONL**：query / 命中 id / 分数 / 是否降级 / 时刻；按字节轮转 + 天数清理，不无限增长 | 给目录：`--recall-log <目录>` 或 `DSH_MEMORY_RECALL_LOG_DIR`；`DSH_MEMORY_RECALL_LOG=off` 一键关回 | **不写**（库不该在纯查询里偷偷落盘） |

**为什么这么设计**（完整版见 [`memory-engine/README.md`](./memory-engine/README.md) 的「设计依据」）：

- **降级用「最近改动」而不是随便凑数**：拿不到向量时，语义相关已无从计算；此时最可能的"有用"是刚写进来的东西。兜底三档依次是数据源直给的 `recent()` → 元数据按 `updated_at` 降序 → 向量表里 id 最大的几条，**保证非空、顺序确定、仍排除 pinned**。
- **词表默认关**：它的收益是"精确词多捞回来一截"，代价是"两路融合会重排名次"。本仓对外的承诺是默认行为不改 ⇒ 出厂关、由使用方一行配置打开。打开后 `stats.lexiconStatus` 从 `off` 变 `ok`，命中里出现 `sources: ["vector","lexicon"]`。
- **留痕默认不写**：query 可能是隐私内容，库不该在纯查询里落盘；要判"召回准不准"就显式给目录，且字节/份数/天数三重封口。实际记录里**不存记忆正文**，只存 id 与分数。
- **为什么不复用生产那份补丁**：生产侧是"按行号锚点重放"的补丁（`patch-*-lexicon.mjs`），搬进独立仓必碎；本仓是按行为重写的模块，靠夹具与旧版对拍证明等价，而不是靠 sha 相同。

**词典体积与许可**：`词典.txt`（1,029,582 B）+ `词频.txt`（219,541 B）来自
[jieba](https://github.com/fxsjy/jieba) 的 `extra_dict/dict.txt.small`（MIT），随包内嵌在
`memory-engine/dict/`，合计约 **1.25 MB**（`npm pack --dry-run` 实测：整包 tarball **1.1 MB** / 解包 **2.8 MB** / **140** 个文件）。
**为什么要内嵌**：不内嵌的话 `npm i` 完这一路直接不可用（要么首次运行去联网拉，要么用户自己找词典）。素材目录可用 `MEMORY_ENGINE_DICT_DIR` 指到别处（打包方嫌大可以把它们挪出包，代价是这一路默认不可用）。

许可按**子树优先**：`memory-engine/dict/` 保持上游 **MIT**（全文与版权声明见 [`dict/LICENSE-词典.md`](./memory-engine/dict/LICENSE-词典.md)），
与仓级 AGPL-3.0 **不冲突** —— MIT 与 AGPL 兼容，分发时把那份版权声明原样带上即可（与本仓 `dsh-memory-local/` fork 的上游 MIT 同一口径）。
词典/词频按字节原样保留（`.gitattributes` 里 `-text`），可与上游 sha256 直接对拍。

**怎么复现这些结论**：

```bash
cd memory-engine
node tools/verify-recall-chain.mjs                                  # 15 项：截断 / 降级 / 词表 / 留痕 / 多来源 / CLI
node tools/verify-recall-chain.mjs --baseline <改动前的 lib 目录>    # 追加 2 项：开关关掉时与旧版逐字对拍
```

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
> `memory-engine/dict/`（词典与词频）来自 jieba（MIT），同样**保持上游 MIT**（见 `dict/LICENSE-词典.md`）；
> 其余目录（引擎代码、工具链、共用件）为本项目原创，按 AGPL-3.0 + 商业授权双许可发布。
> 子树许可优先：分发整包时，上述两个 MIT 子树按 MIT 原样附版权声明即可，不适用 AGPL 的传染条款。

## 八、相关仓

- [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) —— DSH 大管家（自主运维机制）归档仓
- [`dsh-session-toolkit`](https://github.com/kira905/dsh-session-toolkit) —— 会话标题 / 会话治理
- [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) —— 生态面板
- [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) —— 急救台 / 回滚演练
- 同属 DSH 生态的伴生组件各自独立仓、独立版本、许可各自独立。
