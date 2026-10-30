# 记忆引擎 v2 · 离线层（S1）

> 定位：DSH 生态的**离线记忆层**（向量库 / 增量同步 / 召回 / 自检 / 编码桥），可独立运行。
> 落点：向量库默认 `~/.dsh/memory-vectors/`；依赖自带于本目录，**绝不装进宿主的 `profiles/node_modules`**。

## 这是什么

记忆引擎 v2 的**离线层**（不含 S2 注入插件）：

| 能力 | 实现 | 方案条款 |
|---|---|---|
| 独立向量库 | `vectors` 表 + `meta` 表（schemaVersion / hostId / modelId / dim / lastIncrementalSyncAt / lastFullHashSweepAt） | §3.1 |
| 增量同步 | 按 `updated_at ≥ 水位` 只读扫 `memory.db`，批 50，失败保留进度可续跑；换模型/维度自动全量重建 | §3.1 |
| 兜底校验 | 每周按 id 段轮转做全表 `text_hash` 校验（治「改 text 不动 updated_at」的外部写口，A7） | §3.1 / §6.2 |
| 召回 | 向量余弦 top-20 为主 + FTS5 仅补标签/英文/数字 + **词表第二路（BM25，默认关）** + RRF(k=60) 融合 + **排除 pinned**；非空即触发，纯符号/单字跳过；**查询截断 256 字符**；**编码超时/失败降级成固定 Top-K** | §3.3 |
| 召回留痕 | 旁路 JSONL（query / 命中 id / 分数 / 是否降级 / 时刻），按字节轮转 + 天数清理；默认不写 | 本仓 0.2.0 |
| 启动自检 | 模型可用性 / 维度一致 / 表存在性（缺则重建）/ hostId 校验 | §8.3 #9 |
| 编码桥 | `serve.mjs`，**仅绑 127.0.0.1:8201**，`GET /health` + `POST /encode` | §3.1 编码通道契约 |

## 目录

```
memory-engine/
├─ serve.mjs            编码桥（回环 HTTP，模型常驻）
├─ cli/                 sync.mjs · sweep.mjs · recall.mjs · selfcheck.mjs ·
│                       layer-migrate.mjs（加层字段）· layer-move.mjs（整层搬走/搬回）· band-sentinel.mjs（号段哨兵）
├─ lib/                 config / vectors-store / memory-source / embedder / sync / sweep / recall /
│                       lexicon-recall（词表第二路） / recall-log（旁路留痕） / selfcheck / cli-util / cli-strict / hashes /
│                       layers（层配置 + 行指纹） / layer-migrate / layer-move / band-sentinel
├─ config/              layers.json（层名集合 / 列名 / 缺省层） · bands.json（号段表）
├─ dict/                词表素材：词典.txt · 词频.txt（jieba · MIT） · LICENSE-词典.md · lexicon-config.json（开关）
├─ tools/               fetch-model.mjs（模型权重）· bridge-smoke.mjs · smoke-recall.mjs
│                       verify-recall-chain.mjs（召回链验收夹具，自带判据）
├─ test/                单测（夹具全部落系统临时目录）+ run.mjs
└─ bench/bench.mjs      V1 / V2 基准（方案 §9）
```

## 常用命令

```powershell
# 一次性：取权重（fp32 90MB / int8 约 25MB）
node tools\fetch-model.mjs --out <模型目录> --variant fp32

# 启动自检
node cli\selfcheck.mjs [--json]

# 编码桥幂等启动（S2c）：探活优先（在跑就跳过），不在跑才 detached 拉起；
# 端口 8201 被占 +1 顺延，真实端口按子进程 pid 定位后落 bridge-port.json
node cli\serve-start.mjs [--port 8201] [--port-file <台账路径>] [--no-start] [--json]
#   退出码：0 已在跑 / 拉起就绪 · 1 拉起失败 · 3 --no-start 且桥不在（让路）· 2 用法错

# 增量同步 / 全量重建（--memory-db 必须指向记忆库副本，勿指生产库）
node cli\sync.mjs --memory-db <副本> [--full] [--dry-run]

# 兜底 hash 轮转：每次 1 段，--all 一轮完整覆盖
node cli\sweep.mjs --memory-db <副本> [--rounds N | --all]

# 召回（人工查验用）
node cli\recall.mjs --query "退下吧" --json

# 召回：词表第二路 / 降级条数 / 编码预算 / 旁路留痕（都是新增开关；不写就等于原来的行为）
node cli\recall.mjs --query "挡推裁决口径" --lexicon on --json
node cli\recall.mjs --query "..." --fallback-top-k 8 --encode-timeout-ms 1500
node cli\recall.mjs --query "..." --recall-log .\logs\memory-recall

# 召回链验收夹具（自带 15 项判据；给 --baseline <改动前 lib 目录> 就追加与旧版逐字对拍）
node tools\verify-recall-chain.mjs

# 基准（写报告）
node bench\bench.mjs --memory-db <副本> --out bench-report.json

# 分层软淘汰 + 号段哨兵（三件都默认干跑 / 只读，详见仓根 README 同名小节）
node cli\layer-migrate.mjs [--db <库>]                                  # 干跑：说会加什么列、回填几行
node cli\layer-migrate.mjs --db <库> --apply --backup <备份文件>          # 真加列 + 回填
node cli\layer-migrate.mjs --db <库> --restore <备份文件> [--apply]       # 还原（默认干跑）
node cli\layer-move.mjs --db <库> --layer <层> [--apply] [--force]        # 搬出（主表 → memories_evicted）
node cli\layer-move.mjs --db <库> --layer <层> --back [--apply]           # 搬回（先核逐行指纹）
node cli\layer-move.mjs --db <库> --dump before.json / --verify before.json  # 搬前留凭据 / 搬回后对拍
node cli\band-sentinel.mjs [--db <库>] [--line] [--apply --out r.json]    # 号段哨兵（缺省单机、纯只读）
```

## 召回链：三个开关与设计依据

### 三个开关（都只增不改）

| 开关 | 取值 | 出厂 | 说明 |
|---|---|---|---|
| `dict/lexicon-config.json#enabled` | `true/false` | `false` | 词表第二路总开关；`MEMORY_ENGINE_LEXICON=on/off` 可临时覆盖；`--lexicon on/off` 是命令行覆盖 |
| `fallbackTopK` / `--fallback-top-k` | 正整数 | `8` | 编码失败时兜底几条 |
| `encodeTimeoutMs` / `--encode-timeout-ms` | 毫秒 | `1500` | 编码等待预算；`0` = 不设预算（只接抛错） |
| `--recall-log <目录>` / `DSH_MEMORY_RECALL_LOG_DIR` | 目录 | 无（不写） | 旁路留痕；`DSH_MEMORY_RECALL_LOG=off` 一键关回 |
| `MEMORY_ENGINE_DICT_DIR` | 目录 | `dict/` | 词表素材位置 |

### 为什么是这三件事

**① 查询截断 256 字符。** 本仓引擎侧原来**完全不截断**（本地 ONNX 只在**分词后**按 512 token 截，HTTP 桥不截）；生产侧那道 `512` 是插件配置 `recallQueryMaxChars`，作用在**注入器**里、不在引擎里。所以这里是引擎侧新增的一道下限：超长 query 拿去编码既是浪费，也会把 FTS 的 `MATCH` 表达式撑大。按**码点**截（不是 UTF-16 码元），免得把 emoji 劈成半个代理对；截没截、原长多少都写进 `stats.queryChars/queryCharsUsed/queryTruncated`。

**② 编码失败降级成固定 Top-K。** 原来的行为是异常一路冒到调用方：命令行整条命令 rc 2；插件侧记 `skip/exception` ⇒ **那一轮一条记忆都不注入**。现在编码有预算，超时 / 抛错 / 空向量都记成 `encodeError = { name, ms }`（只存错误名与耗时，**不存 query 原文、不存 message**），然后走兜底：
`source.recent()` → 元数据按 `updated_at` 降序 → 向量表里 id 最大的几条，取 `fallbackTopK` 条，仍排除 pinned，来源标 `fallback`、名次记 `fallbackRank`。
为什么按"最近改动"：拿不到向量时**语义相关已经无从计算**，此时最可能有用的是刚写进来的东西；而且它顺序确定、可复现、非空。

**③ 词表第二路的做法与默认值。** 切词 = 英文/数字串（≥2）+ 汉字按词典最长匹配（窗口 16，词典最长词条 15 字）；单字与虚词直接丢（单字几乎不是线索）。打分 = **BM25**：`idf = ln(1 + (N-df+0.5)/(df+0.5))`，`tf 饱和 + 长度归一`（`k1=1.2, b=0.75`），再乘"通用词具体度"（来自 jieba 词频表，0 = 最常见 ⇒ 不当线索；低于 `floor`(0.3) 的词直接不参与）。它输出的候选与向量路同构（`[{id, score, rank}]`），直接进现成的 RRF。
**默认关**的理由：收益是"精确词多捞回来"，代价是"两路融合会重排名次"；本仓承诺"默认行为不改"，所以出厂关、一行配置打开。索引走**进程内缓存 + 后台预热**（条数/`max(updated_at)`/TTL 三重失效），首次调用拿不到就先只走向量路，绝不把建索引的几百毫秒砸在某一轮对话上。
**词典缺失**（删了 `dict/` 或 `MEMORY_ENGINE_DICT_DIR` 指到空目录）⇒ `buildLexiconIndex` 返回 `null`、这一路零命中，结果与纯向量**逐字一致**。

**④ 留痕为什么默认不写、又怎么封口。** query 可能是隐私内容，库不该在纯查询里偷偷落盘；要判"召回准不准"就显式给目录。写入口全程 try/catch（**写失败不影响召回**），记录里**不存记忆正文**，只存 id/分数/来源/是否降级/耗时。封口三闸：单文件 `maxBytes`（512 KB）→ 按字节轮转留 `keepFiles`（3）代 → 超 `keepDays`（14 天）的旧代清掉；`keepFiles: 0` = 只留当前文件、超限清空重开。文件名不许带路径（构造时拒绝），轮转只在日志目录内派生文件名。

### 与生产实现的关系

生产侧的词表能力是「按行号锚点重放」的补丁（`patch-*-lexicon.mjs`）+ 直改文件；那套东西搬进独立仓必碎。本仓不搬补丁、不做 `sed` 式移植，而是**按行为重写**成 `lib/lexicon-recall.mjs` 与 `lib/recall-log.mjs`（行级同源度分别 18.5% / 19.5%），并用两件判据证明没跑偏：① 开关关掉时与改动前的 `recall.mjs` **逐字对拍**（`tools/verify-recall-chain.mjs --baseline`）；② `test/` 184 项一行未改、全绿。

## 边界（硬约束）

1. **对 `memory.db` 只读**——所有打开方式都是 `new DatabaseSync(path, { readOnly: true })`，同步只写独立向量库。
2. **向量库不进任何同步仓**：默认落 `~/.dsh/memory-vectors/`，在仓1 采集白名单之外（方案 D3 的机制收益）。
3. **模型权重不进同步仓**：放中枢机本地目录（`MEMORY_ENGINE_MODEL_DIR` 可覆盖），两机各下一份。
4. **依赖不污染闭包**：`node_modules` 只在本目录，绝不装进 `profiles\node_modules`（生态铁律）。
5. 一切路径可注入：`--memory-db / --vectors-db / --model-dir`，或环境变量 `MEMORY_ENGINE_*`；**测试一律落临时目录**。

## 已知坑（实测）

- **Windows curl 取不到 HF 大文件**：HF 的 LFS 文件 302 到 Xet CAS 桥（`cas-bridge.xethub.hf.co`），部分 Windows 主机上 schannel 握手失败（`curl: (35) SEC_E_ILLEGAL_MESSAGE`）。用 `tools/fetch-model.mjs`（node 自带 TLS 栈）下载，别用 curl。
- **`memory-source.close()` 幂等**：调用方常在 `finally` 里再关一次，重复 `db.close()` 会抛 `database is not open`——已做幂等保护。
- **入口守卫必须 realpath**：工作区里常有目录 junction，`import.meta.url` 解析为物理路径而 `process.argv[1]` 是逻辑路径，直接字符串比较会让脚本静默退出 0（`lib/cli-util.mjs` 的 `isMainEntry`）。
