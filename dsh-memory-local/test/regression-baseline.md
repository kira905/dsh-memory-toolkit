# regression 基线（双实体对照 · 已登记差异）

> 这份档是 `test/regression.mjs` 的**人工对照物**，不是脚本输入 —— 脚本本身不读它。
> 判绿口径 = 「差异增量 ⊆ 本表，且本批新增 = 0」；**不是** rc=0。
> 与本档配套的口径来源：`docs/审核-插件与router开源批-独立复审round3-*.md` §四 N-1（内部档，不随仓分发）。

## 1. 为什么要这份档（先读，否则会假绿）

`regression.mjs` 是**双实体对照**测试：一边是上游官方实体（`dsh-memory`），一边是本仓 fork 实体，逐步骤比对
（工具描述 / 参数 schema / 错误消息 / 段落文本 / render 文本）。

三条必须记住的坑：

1. 🔴 **仓根裸跑 rc=0 是假绿**：上游对照物按 `process.env.DSH_ARCHIVE || path.join(process.cwd(), '_archive')` 解析
   （源码 L61）。仓根通常没有 `_archive` ⇒ 回落到本机已装的生产实体，而 fork 侧也解析到**同一个实体** ⇒
   两侧同源自比 ⇒ 必然 `IDENTICAL` / rc=0。源码 L56 自己就写了「它不是一致性证据」。
2. ✅ **真对照要钉归档根**：把上游官方部署快照放进归档目录，并显式钉住环境变量（见下 §2）。
3. 🔴 **本批起：差异新增即红**。差异可以有（fork 必然比上游多能力），但**必须逐条登记在本表里**，
   并写清「为什么这是预期的」。想加差异 ⇒ 先改本表 + 在 PR/CHANGELOG 说明，**不许直接改脚本来消红**。

## 2. 怎么跑（判据命令）

```
# 判绿的前提：把环境变量 DSH_ARCHIVE 指到含官方部署快照的归档根
#   （<你的归档根> 里应有 g24-s2a-memory-deploy-*/official-entity/dsh-memory 这类上游快照）
node dsh-memory-local/test/regression.mjs
```

- **未钉 `DSH_ARCHIVE` 时的输出一律不作为一致性证据**，报告里要如实写。
- 实体解析也可显式注入：`--dsh-home <DSH_HOME>`（隔离实例 / 换机）或 `--subject <实体目录>`（直指被测侧）。
  找不到实体时应以 **rc=2 + 人话**退出（首跑先 `node dsh-memory-local/deploy.mjs --target <DSH_HOME>`）。
- `npm test` **不包含** `regression.mjs`（`scripts.test` 只跑其余五段；等价 npm 脚本名 = `test:plugin`）。

## 3. 已登记差异（基线 = 9 处 · 上游快照 2026-09-21 vs fork 当前）

上游对照物身份：官方部署快照（`official-entity/dsh-memory`，2026-09-21 版）。
读数（本次登记时的现跑）：`regression: 9 DIFFERENCE(S)` / rc=1 · 上游 fingerprint `ecff5e08…` / fork `34eae9dc…`
（fingerprint 会随 fork 继续演进，**它变了不代表基线失效** —— 基线看的是「哪些步骤差、差在哪」）。

| # | 步骤 / 面 | 上游 | fork | 成因（为什么是预期的） |
|---|---|---|---|---|
| 1 | `tool shapes` → `memory_write` | 无 `source_ids` / `src` 参数 | 参数 schema 多 `source_ids`、`src` | FORK-EDIT 2a「记忆条目带 `src:` 回指」+ 2b `source_ids` 来源回指（写侧预埋） |
| 2 | `step[0] write.fixture` | `tags: "reg 中文-标签"` | `tags: "reg 中文-标签 recall:auto"` | fork 写侧自动补 `recall:auto` 层标签（未指定层时的缺省层） |
| 3 | `step[1] write.pinned` | `tags: ""` | `tags: "core:pinned"` | 同上：pinned 写入自动补 `core:pinned` 层标签 |
| 4 | `step[2] section.afterWrites` | 只有条目行 | 条目行前多两行「层标签说明」+ 条目带 `[core:pinned]` / `[tags recall:auto]` | fork 的注入段带层标签渲染（核心层 / 召回层 / 归档层的口径说明） |
| 5 | `step[3] search.hit` | 渲染 `[reg 中文-标签]` | 渲染 `[reg 中文-标签 recall:auto]` | 同 2：标签在渲染里如实显示 |
| 6 | `step[7] search.limitOverMax` | 同上（无层标签） | 同上（带 `core:pinned` / `recall:auto`） | 同 5 |
| 7 | `step[10] forget.missing` | `ok:true · forgotten:false · "No memory #999999 to forget."` | `ok:false` · 错误「归档根未配置（`config.removedRoot` / `env DSH_MEMORY_REMOVED_ROOT` / `env DSH_ROOT` 三者都取不到）⇒ 已拒绝删除」 | FORK-EDIT「删留痕」：**宁可不删，也不删了没记**。测试环境没配归档根 ⇒ 走 fail-closed 分支（**0.4.1 起 `memory_forget` 已接线 `forgetWithLedger`，裸 DELETE 废止**，见下注） |
| 8 | `step[11] forget.hit` | `ok:true · forgotten:true · "Forgot memory #1."` | 同上错误（拒绝删除） | 同 7 |
| 9 | `step[12] section.afterForget` | 只列 `#2` | 两行层标签说明 + `#2`、`#1`（`#1` 未被删掉，因为第 8 步拒绝删除） | 同 7/8 的下游后果 |

**⚠️ 关于第 7–9 条（2026-11-06 · 0.4.1 接线后订正口径）**：

- **接线前后的差别**：0.4.0 及以前，仓内 `src/index.js` 的 `forget(id)` 是**裸 DELETE**（删了没留痕）；
  0.4.1 起改调 `forget-ledger.mjs#forgetWithLedger`（归档正文 → 写台账 → 事务内复核 → 才 DELETE），
  并且 `memory_write` 落库后异步调 `lineage-auto.mjs#appendLineageAnchor`（写侧预埋）。
  ⇒ 仓内接线由 `test/test-wiring.mjs` 把关（含阴性对照），不靠这份基线。
- **这三条差异的成因**（接线后仍然成立）：本夹具的 fork 侧取的是**部署实体**
  （`<DSH_HOME>/profiles/web/node_modules/dsh-memory`），它**早已接线**；而测试环境没有配
  `removedRoot` ⇒ `forgetWithLedger` 按设计 **fail-closed 拒删**。所以三条差异是「预期能力差」，
  不是回归。
- **要让它们变绿的正确做法**：在测试配置里给一个临时归档目录（`removedRoot` / `DSH_MEMORY_REMOVED_ROOT`），
  让 forget 走成功分支；**不许**改成「不配也照删」（那正好毁掉这个闸要保的东西）。

## 4. 判绿与登记纪律

- **判绿**：钉住 `DSH_ARCHIVE` 跑一次 ⇒ 差异集合 **⊆ 本表 9 条**，且**本批新增差异 = 0**。
- **新增差异怎么办**：先判断是「预期能力差」还是「真回归」——
  - 真回归（上游有、fork 该有却没有 / 行为被无意改坏）⇒ **修代码**，不许登记进基线。
  - 预期能力差 ⇒ 加一行到 §3 表里，写清成因，并在 CHANGELOG 记一句。
- **删条目**：fork 追上上游后对应差异消失 ⇒ 把该行移到底部「已闭合」小节并注明日期，别直接删（留痕）。
- **本表更新必须同 commit**：改了「预期差异」却不更新本表 = 下一次判红，谁看都以为回归。

## 5. 已闭合

（暂无）
