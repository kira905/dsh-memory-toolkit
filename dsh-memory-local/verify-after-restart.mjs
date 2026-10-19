/**
 * verify-after-restart.mjs —— 部署后自检（**只读**，独立进程，不重启任何东西）。
 *
 * 断言五件事（每件都给 PASS/FAIL + 细节，退出码 0/1）：
 *   ① 实体面：目标 profile 的 `dsh-memory` 实体存在、带 `fork` 段、`lib/index.js` 的 sha
 *      与本包 `lib/index.js`（构建产物）逐字节一致；
 *   ② 源码↔产物：src/index.js 的 sha 与 lib/index.js 一致（即 lib 确实是当前源码的产物）、
 *      且与 FORK-BASE.json 的上游基点 sha 对得上（版本与 sha 对齐）；
 *   ③ 加载面：在**部署位置**跑 test/probe-entity.mjs —— 三工具 + memory:recall 段注册成功；
 *   ④ 实例面（--port 给出时）：目标实例 HTTP 可达；
 *   ⑤ 日志面（--log-file 给出时）：启动日志里没有崩溃特征与 patch 未命中告警。
 *
 * 用法：
 *   node verify-after-restart.mjs --target <DSH_HOME> [--profile web] [--port 3090]
 *                                 [--log-file <log>] [--expect fork|upstream] [--json]
 * 退出码：0 = 全 PASS / 1 = 有 FAIL / 2 = 用法错误。
 *
 * 【卡 S14 · 2026-10-08 · token 门判活遗留同批修】④ 实例面判活改走**单一真源**
 *   `lib/guard-http.mjs#judgeHttp`（2xx/3xx/401/403 = 活；其它 4xx/5xx/无应答 = 不活）。
 *   旧判据 `reachable = res.status === 200` 在 0.1.5 的 cookie token 门下，会把**活着的实例**
 *   误报成"不可达"（本机实测 2026-10-08：`GET http://localhost:3080/` → 401 · 68 字节纯文本）。
 *   接法 = 绝对 `file:///`（全仓只此一份码表；真源被移走/改名时本文件 import 阶段硬失败，不静默降级）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs, describeUnknown, EXIT } from '../lib/deploy-guard.mjs'
// 【卡 S14】HTTP 存活判据单一真源（H1 · 2026-09-22）：2xx/3xx/401/403 = 活。
import { judgeHttp } from '../lib/guard-http.mjs'

const KNOWN_ARGS = [
  '--json',
  { flag: '--target', takesValue: true },
  { flag: '--profile', takesValue: true, alias: '--p' },
  { flag: '--port', takesValue: true },
  { flag: '--log-file', takesValue: true },
  { flag: '--expect', takesValue: true },
]
const pa = parseArgs(process.argv.slice(2), KNOWN_ARGS)
if (!pa.ok) {
  console.error(`[verify] ${describeUnknown(pa.unknown, KNOWN_ARGS)}`)
  process.exit(EXIT.USAGE)
}
const rawTarget = pa.values['--target']
if (!rawTarget) {
  console.error('[verify] 缺少 --target <DSH_HOME>')
  process.exit(EXIT.USAGE)
}
const home = path.resolve(rawTarget)
const profileName = pa.values['--profile'] ?? 'web'
const expect = pa.values['--expect'] ?? 'fork'
const asJson = !!pa.flags['--json']
// 本脚本就住在包根（与 build.mjs / deploy.mjs 同级）——`here` 即包根。
const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = here

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const fileSha = (f) => (fs.existsSync(f) ? sha256(fs.readFileSync(f)) : null)
const checks = []
const check = (id, name, ok, detail = '') => {
  checks.push({ id, name, ok: Boolean(ok), detail: String(detail) })
  return Boolean(ok)
}

// ① 实体面 -------------------------------------------------------------------
const target = path.join(home, 'profiles', profileName, 'node_modules', 'dsh-memory')
const entityPkgFile = path.join(target, 'package.json')
const entityEntry = path.join(target, 'lib', 'index.js')
const localLib = path.join(pkgRoot, 'lib', 'index.js')
const entityExists = fs.existsSync(target)
check('entity.exists', '实体目录存在', entityExists, target)
const entityPkg = entityExists && fs.existsSync(entityPkgFile) ? JSON.parse(fs.readFileSync(entityPkgFile, 'utf8')) : null
const entitySha = fileSha(entityEntry)
const localSha = fileSha(localLib)
if (expect === 'fork') {
  check('entity.forkSection', '实体 package.json 带 `fork` 段（确认是 fork 版而非上游）',
    Boolean(entityPkg?.fork), JSON.stringify(entityPkg?.fork?.name ?? null))
  check('entity.sha', '实体 lib/index.js == 本包构建产物（逐字节）',
    Boolean(entitySha && localSha && entitySha === localSha), `entity=${entitySha?.slice(0, 16)} local=${localSha?.slice(0, 16)}`)
  check('entity.slot', '实体占用上游槽位名（bundle/patch/package-map 按 dsh-memory 解析）',
    entityPkg?.name === 'dsh-memory', String(entityPkg?.name))
} else {
  check('entity.upstream', '实体是未替换的上游包（无 fork 段）', !entityPkg?.fork, String(entityPkg?.name))
}

// ② 源码 ↔ 产物 ↔ 基点 --------------------------------------------------------
const srcSha = fileSha(path.join(pkgRoot, 'src', 'index.js'))
const buildInfoFile = path.join(pkgRoot, 'lib', '.build-info.json')
const buildInfo = fs.existsSync(buildInfoFile) ? JSON.parse(fs.readFileSync(buildInfoFile, 'utf8')) : null
const forkBase = fs.existsSync(path.join(pkgRoot, 'FORK-BASE.json'))
  ? JSON.parse(fs.readFileSync(path.join(pkgRoot, 'FORK-BASE.json'), 'utf8')) : null
check('src.lib', 'lib 产物 == src 源码（构建新鲜）', Boolean(srcSha && localSha && srcSha === localSha),
  `src=${srcSha?.slice(0, 16)} lib=${localSha?.slice(0, 16)}`)
check('src.buildInfo', 'lib/.build-info.json 记录的产物 sha 与实际一致',
  buildInfo?.artifacts?.find((a) => a.file === 'lib/index.js')?.sha256 === localSha,
  buildInfo?.artifacts?.find((a) => a.file === 'lib/index.js')?.sha256?.slice(0, 16) ?? 'missing')
check('base.sha', 'FORK-BASE.json 的上游基点 sha 与 FORK NOTICE 一致',
  Boolean(forkBase?.source?.sha256) && fs.readFileSync(path.join(pkgRoot, 'src', 'index.js'), 'utf8').includes(forkBase.source.sha256),
  forkBase?.source?.sha256?.slice(0, 16) ?? 'missing')
// 「部署态版本与基点对齐」只在期望 fork 时有意义（上游原物本来就没有 fork 段）
if (expect === 'fork') {
  check('version.align', '部署态版本与基点版本对齐（package.json fork.base）',
    entityPkg?.fork?.base === `${forkBase?.upstream?.name}@${forkBase?.upstream?.version}`,
    `${entityPkg?.fork?.base} vs ${forkBase?.upstream?.name}@${forkBase?.upstream?.version}`)
}

// ③ 加载面 -------------------------------------------------------------------
const probe = spawnSync(process.execPath, [path.join(here, 'test', 'probe-entity.mjs'), target, ...(expect === 'upstream' ? ['--upstream'] : [])],
  { encoding: 'utf8', timeout: 60000, windowsHide: true })
const probeLine = (probe.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('PROBE: ')) ?? ''
let probeJson = null
try { probeJson = JSON.parse(probeLine.slice('PROBE: '.length)) } catch { /* leave null */ }
check('load.tools', '部署位置加载后注册出三工具（write/search/forget）',
  probeJson?.tools?.map((t) => t.name).sort().join(',') === 'memory_forget,memory_search,memory_write',
  JSON.stringify(probeJson?.tools?.map((t) => t.name) ?? probe.stderr?.slice(0, 160)))
check('load.section', '注册 memory:recall 段（供 systemPrompt 注入）',
  probeJson?.section === undefined ? false : true, `probe ok=${probeJson?.ok}`)
check('load.behavior', '三工具在临时库上真跑通（write→search→forget）',
  probeJson?.behavior?.searchHits === 1 && probeJson?.behavior?.forgotten === true,
  JSON.stringify(probeJson?.behavior ?? probeJson?.failures ?? null))

// ④ 实例面 -------------------------------------------------------------------
const port = pa.values['--port'] ? Number(pa.values['--port']) : null
if (port) {
  let reachable = false
  let status = null
  let why = ''
  try {
    const res = await fetch(`http://localhost:${port}/`, { headers: { origin: `http://localhost:${port}` } })
    status = res.status
    // 【卡 S14】判活走单一真源（旧写法 `res.status === 200` 在 token 门下把 401 判死）
    const j = judgeHttp(res.status)
    reachable = j.alive
    why = j.reason
  } catch (error) {
    reachable = false
    status = error instanceof Error ? error.message : String(error)
    why = 'no-answer（连不上/超时）'
  }
  check('instance.http', `目标实例（端口 ${port}）HTTP 可达`, reachable, `status=${status}${why ? ` · ${why}` : ''}`)
}

// ⑤ 日志面 -------------------------------------------------------------------
const logFile = pa.values['--log-file']
if (logFile) {
  const exists = fs.existsSync(logFile)
  const text = exists ? fs.readFileSync(logFile, 'utf8') : ''
  const patterns = [
    [/Cannot find module/i, 'Cannot find module'],
    [/duplicate loader entry id/i, 'duplicate loader entry id'],
    [/declares no dsh\.bundle/i, 'declares no dsh.bundle'],
    [/did not activate/i, 'entry did not activate'],
    [/duplicate exact route/i, 'duplicate exact route'],
    [/patch[^\n]{0,80}(not found|unknown id|no match)/i, 'patch 未命中告警'],
    [/^\s*Error:/m, 'Error:'],
  ]
  const hits = []
  for (const [re, name] of patterns) {
    const m = re.exec(text)
    if (m) hits.push(`${name} → ${m[0].trim().slice(0, 120)}`)
  }
  check('log.clean', `启动日志无崩溃/未命中特征（${path.basename(logFile)}）`, exists && hits.length === 0,
    exists ? (hits.join(' | ') || 'no crash signatures') : 'log file missing')
}

// 汇总 -----------------------------------------------------------------------
const failed = checks.filter((c) => !c.ok)
if (asJson) {
  console.log(JSON.stringify({
    target: home, profile: profileName, expect, entitySha, localSha, srcSha,
    checks, ok: failed.length === 0,
  }, null, 2))
} else {
  console.log(`verify : ${target}  (expect=${expect})`)
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.id.padEnd(16)} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  console.log(failed.length === 0 ? '\nverify: ALL CHECKS PASS' : `\nverify: ${failed.length} CHECK(S) FAILED`)
}
process.exitCode = failed.length === 0 ? EXIT.OK : EXIT.GATE
