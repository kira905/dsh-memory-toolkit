# dsh-memory-local

自持 fork：官方 `dsh-memory` 插件（跨会话持久记忆 + `memory:recall` 提示段），加一层自研的指针注入链。
本包是记忆引擎的**插件侧载体**：把独立向量库的记忆接进会话提示面。


> **首发范围**：源码自持 → 构建 → 幂等部署 → 一键回滚 → 部署后自检，以及 L2 模块登记。
> 指针注入逻辑见 `src/injector.mjs`（与骨架同批交付）。

---

## 1. fork 基点（FORK-BASE.json 为机器可读版本）

| 项 | 值 |
|---|---|
| 上游包 | `dsh-memory@0.1.0`（npm dist · MIT） |
| 基点文件 | `lib/index.js` —— sha256 `494ca272f674918f5acfcf32327c164c6eba26fa08fc28bef50e085754c6f28c`，421 行 |
| 上游来源（只读） | `<DSH_HOME>/profiles/<profile>/node_modules/dsh-memory/` |
| fork 时间 | 2026-09-21 |


上游 npm 包**只发布编译产物**（`lib/`，无 TypeScript 源，也不含 `src/`），所以本 fork 的
「源码」= 官方 `lib/index.js` 逐字节 + 一段 `FORK NOTICE` 头注；构建不是编译，而是
**语法校验 + 拷贝 + 指纹**（见 §3）。

## 2. 与官方的差异（当前 = 只有头注）

| 文件 | 差异 |
|---|---|
| `src/index.js` | 上游文件逐字节 + 顶部 19 行 `FORK NOTICE`。**函数体、工具定义、配置项一字未改**（`Compare-Object` 差异行 = 19，全部落在头注内） |
| `src/index.d.ts` | 逐字节同上游 |
| `cordis.patch.yml` | **逐字节同上游** —— 其中 `insert.name` 必须保持 `dsh-memory`（见 §4） |
| `package.json` | `name` → `dsh-memory-local`、`private: true`、**`dependencies` 置空**（零第三方依赖；`@deepseek-ai/schemastery` / `@deepseek-ai/dsh-tools` 由宿主主包的闭包在部署位置提供）、`scripts` 换成 build/test/deploy/verify |
| `src/injector.mjs` | fork 自研（指针注入链；上游没有这个文件）。**2026-10-09**：`visibleInjections()` 取事件面改「**新面优先 + 老线回落**」—— 主包 0.1.5-rc.2 起 `Session.events` 已移除，只能用 `eventAt(seq)`；老线（≤0.1.4 的 `session.events`）回落保留，两面都没则安全返回 `{count:0}`。⚠️ 主包 0.1.6 会再弃用 `seq`/`eventAt`/`snapshotEvents` ⇒ 升级时此处须再复测。回滚：`node rollback-injector-fix.mjs --target <home> --allow-production`（默认 dry-run） |

**零第三方依赖判据**：`package.json` 的 `dependencies` 为空对象；运行期只 import
`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`（宿主主包自带）与 node 内置模块
（`node:fs` / `node:path` / `node:sqlite`）。

## 3. 目录与命令

```
dsh-memory-local/
├─ src/index.js            自持源码（官方基点 + FORK NOTICE）
├─ src/index.d.ts
├─ lib/                    构建产物（deploy 只搬这一层 + cordis.patch.yml + package.json）
├─ cordis.patch.yml        bundle patch（逐字节同上游）
├─ FORK-BASE.json          fork 基点元数据（上游 sha / 行数 / 来源 / 口径说明）
├─ build.mjs               构建：断言基点 → node --check → 拷进 lib/ → 写 lib/.build-info.json
├─ deploy.mjs              幂等部署进 <DSH_HOME>/profiles/<profile>/node_modules/dsh-memory
├─ restore.mjs             原子还原上游原物（含 --self-test 沙箱演练 / --dry-run / --list）
├─ verify-after-restart.mjs 部署后自检（只读）
└─ test/
   ├─ probe-entity.mjs     部署位置加载探针：三工具 + memory:recall 段 + 真跑 write/search/forget
   └─ regression.mjs       上游 vs fork「同输入同输出」逐步骤对照（行为一致判据）
```

```powershell
node build.mjs                                  # 构建（--check 只校验不写 lib/）
node build.mjs --check

# 部署（--target 必填；目标是本机默认 home = 生产，须显式 --allow-production）
node deploy.mjs --target <隔离实例的 DSH_HOME>

# 自检（可带实例端口与日志文件）
node verify-after-restart.mjs --target <隔离实例的 DSH_HOME> --port <实例端口> --log-file <实例日志>

# 回滚（原子还原上游原物；先演练再动真）
node restore.mjs --self-test
node restore.mjs --target <隔离实例的 DSH_HOME> --dry-run
node restore.mjs --target <隔离实例的 DSH_HOME>

# 行为回归（fork 侧默认取隔离实例实体）
node test/regression.mjs
```

## 4. 部署形态：为什么占「上游槽位」

profile 的 `package.json`（`dsh.profile.bundles` 含 `dsh-memory`）、`node_modules/.package-map.json`
（`dsh-memory → ./dsh-memory`）与 bundle patch 的 `insert.name` **三处都按 `dsh-memory` 解析**。
因此部署**不新增包名、不改 profile wiring**，而是**原地替换 `node_modules/dsh-memory` 实体**：

* 实体里的 `package.json` 写成**部署态**：`name` = `dsh-memory`、`version` = 上游版本（与 profile
  的 `dependencies` 声明一致），另加 `fork` 段记录真身（`dsh-memory-local@…`）、基点 sha、产物 sha、
  部署来源与时间 —— 自检与人工都据此判别「这是 fork 版」；
* `cordis.patch.yml` 的 `insert.name` 保持 `dsh-memory`（若改成 `dsh-memory-local`，
  解析会去找不存在的 `node_modules/dsh-memory-local`）。

副作用：`deploy.mjs` **不写** profile `package.json`、**不写** `.package-map.json`、**不重启**任何 DSH。

## 5. 备份与回滚

* 首次替换时，`deploy.mjs` 把上游原物**整份**归档到 `$DSH_ARCHIVE`（缺省 `<cwd>/_archive`）下：
  `_archive\g24-s2a-memory-deploy-<stamp>\official-entity\` + `OFFICIAL-ENTITY.json`（逐文件 sha 清单）；
* 之后重复 deploy 只追加 `DEPLOY-INFO-<stamp>.json`，**不覆盖**那份上游原物；
* `restore.mjs` 的还原源 = 上述目录（导出路径见 `--list`），
  还原前先把当前 fork 实体快照到 `_archive\g24-s2a-memory-prerestore-<stamp>\entity-before-restore\`
  （还原动作自己也可被回看/再回滚），然后 `stage → 核 sha → 交换 → 复核`。

## 6. 上游合并流程（将来升 `dsh-memory` 时）

1. 取新版上游实体（另一份 npm 安装目录，或 `npm pack dsh-memory@<ver>` 解包）；
2. 重跑骨架步骤，让 `src/index.js` 重新等于「新版 + FORK NOTICE」（`FORK-BASE.json` 更新基点 sha）；
3. 用 `git diff --no-index <上游新 lib/index.js> <旧 src/index.js 去掉头注>` 的形式看**自己的本地改动**
   （本地改动一律以 `FORK-EDIT(<date>):` 行注留在 `src/`，便于三方合并）；
4. `node build.mjs` → `node test/regression.mjs`（对照物换成新版上游实体）→ 隔离实例 `deploy.mjs` → `verify-after-restart.mjs`；
5. 全绿才谈上生产；任一环红了就 `restore.mjs` 回滚到官方原物。

## 7. 边界（本卡红线）

* 只做**隔离面**（独立 `DSH_HOME` + 非生产端口）；生产实例的端口与生产 `profiles` 实体**一律不碰**；
* 不写 `memory.db`、不挂 tickd job、不改 `butler-autonomy.json`；
* `deploy.mjs` / `restore.mjs` 都**不重启 DSH**（要重启一律走 P0 闸门）。
