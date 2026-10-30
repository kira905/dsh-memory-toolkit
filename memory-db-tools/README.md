# memory-db-tools — 记忆库工具集

本目录内与 `~/.dsh/memory/memory.db`（记忆库）相关的工具集。
本 README 维护**用法表**；口径类真源（体检判据、字段白名单）在 `lib\` 与各脚本文件头的常量里。

> 下文的 `node <工具>` 均指**在本目录内**执行；工具一律支持 `--help` / `--self-test`。
> 所有 `audit-*` 工具的 `--out` / `--in` 默认落**系统临时目录**（不落生产路径），
> 季度体检建议显式传 `--out` 到自己建的体检目录（临时目录会被系统清理）。

---

## 体检工具链（`audit-*`）

**来源**：2026-09-25 体检工具链固化，从早期临时脚本沉淀而来，
做了三件事：去硬编码（用户名/盘符/写死目录 → `DSH_HOME` 动态解析 + 参数化）、补 `--help` / `--self-test`、
收尾改 `process.exitCode`（禁 `process.exit()`，Windows + undici 会概率崩 libuv）。

| 工具 | 用途 | 命令 | 主要参数 | 只读/可写 | 输出 |
|---|---|---|---|---|---|
| `audit-export.mjs` | 第 1 站：把记忆库全量导成 `memories.json`，给下面所有探针当数据源 | `node audit-export.mjs` | `--db` `<库路径>`、`--out` `<文件>`、`--force`（覆盖已存在）、`--json`、`--quiet` | **只读库**（可写 `--out`） | `memories.json` + 统计（TOTAL/PINNED/CHARS/设备分布） |
| `audit-analyze.mjs` | 第 2 站：六项分析——首行清单 / 漏标设备候选 / 重复对 / 过期关键词 / pinned 全文 / 统计 | `node audit-analyze.mjs` | `--in` `<memories.json>`、`--out` `<目录>`、`--json`、`--quiet` | 只读输入（可写 6 个产物） | `list-lines.txt`、`list-nodev.txt`、`dup-pairs.txt`、`keyword-hits.txt`、`pinned-full.txt`、`stats.json` |
| `audit-struct-probe.mjs` | 结构异常：设备标不在「已知设备名」清单（OTHER）+ 一条里两个设备标（DOUBLE）+ 长度分布 | `node audit-struct-probe.mjs` | `--in` `<memories.json>`、`--top` `<n>`、`--json` | **只读，不写文件** | 标准输出（OTHER / DOUBLE / PINNED_CHARS / TOP_LONG_NONPINNED） |
| `audit-hit-probe.mjs` | 给 id 列表，报每条命中了哪些机器特征词（自证「漏标设备」判据站得住） | `node audit-hit-probe.mjs --ids 40,46,67` | `--ids`（必填）、`--in`、`--json` | **只读，不写文件** | 标准输出（每行 `#id [命中词] 首行`） |
| `audit-dump-ids.mjs` | 按 id 取记忆全文（分批精读，规避 stdout 编码/截断坑） | `node audit-dump-ids.mjs --ids 40,46,67` | `--ids`（必填）、`--out`、`--stdout`、`--db`、`--json` | **只读库**（可写 `--out`） | `dump-ids-<本地时间>.txt`（默认临时目录）或 stdout |
| `audit-persona-overlap.mjs` | 量化每条记忆有多少比例已出现在 persona 里（找「焊接残留」条目） | `node audit-persona-overlap.mjs` | `--db`、`--persona`、`--out`、`--top` `<n>`、`--json` | **只读库与 persona**（可写 `--out`） | `persona-overlap.json` + 覆盖比 Top N / pinned 覆盖比 |
| `audit-ledger-probe.mjs` | 看板账本只读探针：按关键词筛卡 + 状态分布 | `node audit-ledger-probe.mjs --keyword "体检\|记忆"` | `--ledger`、`--keyword` `<正则>`、`--limit`、`--json` | **只读账本** | 标准输出（命中卡列表 + 状态统计） |
| `audit-verify-unchanged.mjs` | 收尾站：对照基线快照，证明体检期间记忆库零写入（物理 sha + 逻辑指纹 + 逐条 diff） | `node audit-verify-unchanged.mjs --expect-unchanged` | `--db`、`--baseline`、`--expect-unchanged`、`--json` | **只读，不写文件** | 标准输出（sha / 条数 / 新增·缺失·内容变更） |

### 典型季度体检流程

```powershell
$T = (Get-Location).Path                     # 本目录
$W = Join-Path $HOME 'Documents/mem-audit'   # 自建体检目录（示例）

node $T\audit-export.mjs --out "$W\memories.json"      # ① 冻结基线
node $T\audit-analyze.mjs --in "$W\memories.json" --out $W   # ② 六项分析
node $T\audit-struct-probe.mjs --in "$W\memories.json"       # ③ 结构异常
node $T\audit-hit-probe.mjs --ids <漏标候选 id>              # ③b 判据自证
node $T\audit-persona-overlap.mjs --out "$W\persona-overlap.json"  # ④ 与 persona 的重合度
node $T\audit-ledger-probe.mjs --keyword "体检|记忆"         # 顺带看看板
node $T\audit-verify-unchanged.mjs --baseline "$W\memories.json" --expect-unchanged  # ⑤ 零改动自证
```

退出码约定：`0` 成功 · `1` `--self-test` 断言失败 · `2` 用法错误 · `3` 输入/输出条件不满足（文件不存在、`--expect-unchanged` 检出差异等）· `4` 运行错误。

### 口径真源（要改判据改这里，别改产物）

- **漏标设备判据（机器特征词）**：`audit-analyze.mjs` 的 `MACHINE_RE` 与 `audit-hit-probe.mjs` 的 `MACHINE_PATTERNS`（两处需同批维护）。
- **过期关键词表**：`audit-analyze.mjs` 的 `STALE_KEYWORDS`（19 组；过期项增减改这一处）。
- **重复对阈值**：`audit-analyze.mjs` 的 `analyze(mems, { shingle, minShared, jacThreshold })`（默认 6-gram / 共享 shingle ≥ 6 / Jaccard ≥ 0.15）。

### 已知设备名（改这里，不是改代码）

`audit-export.mjs` 的设备分布统计与 `audit-struct-probe.mjs` 的 OTHER 判据，都要知道「哪些设备名算已知」。
**代码里不写死任何机器名**（不带任何真实机器名，换机器不用改代码）。优先级从高到低：

1. **环境变量** `MEMORY_DB_AUDIT_DEVICES` —— 逗号或空格分隔，例如
   `$env:MEMORY_DB_AUDIT_DEVICES = 'laptop,desktop'`（临时起效，适合偶尔跑一次）；
2. **配置文件** `memory-engine/config/audit-devices.json` 里的 `devices` 数组 —— 随包发布，改它长期生效：

   ```json
   { "devices": ["alpha", "beta"] }
   ```

3. 两者都没给时退回**内置中性示例名** `alpha` / `beta`（只是让工具装完能跑，不代表任何真实机器）。

匹配规则：只看 `【设备：X】` 里的 X 那段，拿名单里每个名字做**大小写敏感**的子串匹配；
名单不认识的一律归 **OTHER**（结构探针会列出来让人复核）；名单里出现 `NONE` / `OTHER` / `DOUBLE`
（统计结果里的固定键）或形态不合法的名字会被剔掉，并在 stderr 打一行警告。
名单为空或全不合法 ⇒ 退回内置缺省（不是「全都算 OTHER」）。

> ⚠️ **别把本机真实设备名写进仓里那份 `audit-devices.json`** —— 它会随包发布到公开仓。
> 本机跑体检要认真名，用环境变量（或写进自己的 PowerShell profile / 启动脚本），
> 让仓里的那份始终是**中性洁本**。反过来说：缺省配置不认识你的机器名时，
> 全部设备标都会落进 OTHER —— 这是**故意**的（宁可让你看见一堆"不认识"，也不把机器名刻进代码）。
>
> 统计输出（`DEV={...}`）的形状固定 = 名单里每个名字一个计数 + `NONE` / `OTHER` / `DOUBLE` 三个固定键；
> 名单换了，键名跟着换，**键的数量与顺序规则不变**。改名单不会改动任何 CLI 参数 / 缺省值 / 退出码。

### 自检

每个工具都有 `--help`（用法/参数/退出码）与 `--self-test`（合成夹具跑一遍 + 自证只读：合成库 sha 前后一致、主体逻辑段每次开库都带 `readOnly: true`）：

```powershell
node audit-export.mjs --self-test
```

---

## 本目录其余工具（非本次固化范围）

`list-memory-summary.mjs`（新会话开工简报：**设备行 + 插电保护口径行** + 全量 id/pinned 列表 + pinned 全文 + **坑库段**）。⚠️ **2026-10-16 起头部多一行「🛡 插电保护」口径行** —— 治「会话看不见保护态」（保护其实一直开着，但 persona 的自主授权全是「整夜模式期间…」条件句、条件不在开工面上 ⇒ 会话无从判断 ⇒ 保守走常规口径，主人只能挨个会话人肉通知）。实现 = 只读 `~\.dsh\overnight-mode-<host 小写>.json` **轻判据**（<10ms）+ **fail-open**（任何异常只打一行提示）；⚠️ **刻意不调 `overnight-mode.mjs status`**（本机实测 **15.7s / 17.0s**，塞进简报 = 每个会话开场白等 17 秒）；⚠️ 该行给的是**口径不是体检**（不核电源设置是否真还在），健康核对归 `plug-guard`（10 分钟一轮 · 2026-10-16 起）与 `overnight-guard`（每日 15:10）两个 job。真源 = persona【铁律·插电保护禁停与自动交棒】（2026-10-16 由「整夜模式禁停与自动交棒」改名）。⚠️ **2026-10-10 起坑库段 = 向量召回优先 + 固定 Top3 兜底**（记忆引擎 A3 第 8 步）：按当前会话上下文（会话日志尾部最近的**真实**用户消息 + projcache 标题/上轮请求，去重截 500 字）召回 `vectors.db` 的 `source='pitfall'` 向量；**fail-open**（无上下文/无向量库/坑源无向量/编码桥不可达/超时/零命中/任何异常 ⇒ 回落原 `topN(pitfalls,3)`」，简报绝不报错、超时硬预算 900ms）。参数（默认不影响生产）：`--query` / `--no-recall` / `--top-k` / `--recall-timeout-ms` / `--bridge-port` / `--home` / `--memory-db` / `--vectors-db` / `--pitfalls-file` / `--session` / `--debug`。· `read-memories.mjs` / `read-memory-db.mjs`（读条）·
`dump-memory-db.mjs`（全量导 stdout）· `check-memory-db.mjs` · `show-mem-times.mjs`（时间戳）·
`refine-memories.mjs`（记忆整理，**可写**）· `memory-schema-migrate.mjs` /
`memory-identity-check.mjs` / `memory-scope-fixture.mjs`（schema 与字段口径，`lib/` 为共享口径库）。
用法见各自文件头注释；改动前先读文件头。
