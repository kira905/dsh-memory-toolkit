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
| 召回 | 向量余弦 top-20 为主 + FTS5 仅补标签/英文/数字 + RRF(k=60) 融合 + **排除 pinned**；非空即触发，纯符号/单字跳过 | §3.3 |
| 启动自检 | 模型可用性 / 维度一致 / 表存在性（缺则重建）/ hostId 校验 | §8.3 #9 |
| 编码桥 | `serve.mjs`，**仅绑 127.0.0.1:8201**，`GET /health` + `POST /encode` | §3.1 编码通道契约 |

## 目录

```
memory-engine/
├─ serve.mjs            编码桥（回环 HTTP，模型常驻）
├─ cli/                 sync.mjs · sweep.mjs · recall.mjs · selfcheck.mjs
├─ lib/                 config / vectors-store / memory-source / embedder / sync / sweep / recall / selfcheck / cli-util / hashes
├─ tools/fetch-model.mjs  模型权重获取器（node fetch，绕开 Windows curl 的 schannel 坑）
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

# 基准（写报告）
node bench\bench.mjs --memory-db <副本> --out bench-report.json
```

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
