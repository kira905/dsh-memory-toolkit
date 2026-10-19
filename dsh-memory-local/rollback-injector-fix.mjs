/**
 * rollback-injector-fix.mjs —— 冲刺600-M1《注入去重修复》的**一键回滚入口**。
 *
 * 回滚语义（本卡专属）：把生产实体 `dsh-memory` 的 `lib/injector.mjs`
 * 从「修复后」退回「改动前」——**只动这一个文件**，不碰实体其余 13 个文件、不碰库、不碰 wiring。
 *
 * 锚（改动前后逐字节固定）：
 *   BEFORE（改动前）: fadbec42e2311b7cc2f09109a5ca3ef34e761760a409a28a84704d179c538f9c  14,939 B
 *   AFTER （改动后）: fceb32b48aa6a057ee8d1652e91522d6aab3daa60d7f1a10e784cd49d75b71ea  16,368 B
 *
 * 安全口径：
 *   · **默认 dry-run**（只打印将要做的事 + 逐条校验，不写任何文件）；`--apply` 才真写。
 *   · 写前把关：目标当前 sha 必须 == AFTER（否则说明实体已不是本卡交付的那一份 ⇒ fail-closed 拒绝，
 *     避免把别人的改动误盖）。
 *   · 写前把「当前实体」备份到 `<回滚点>\rollback-runs\<stamp>\`（本动作自身也可被回看）。
 *   · 写后复核 sha == BEFORE，不等即报错（不回滚一半）。
 *   · 目标 home = 本机默认 `~/.dsh`（生产）时必须显式 `--allow-production`。
 *   · 默认写完后走 **P0 闸门** 请求重启（`request-restart.mjs`）；`--no-restart` 跳过。
 *     ⚠️ 只请求、不裸杀进程；无守护鱼时本脚本**不碰** dsh。
 *
 * 用法：
 *   node rollback-injector-fix.mjs --target <DSH_HOME> [--point <回滚点目录>] [--apply] [--no-restart] [--allow-production]
 *   node rollback-injector-fix.mjs --status --target <DSH_HOME>      # 只读：当前实体是改动前/后/其它
 *
 * 退出码：0 = 成功（含 dry-run 通过 / 无需回滚） · 1 = 门禁失败 · 2 = 用法错误 · 3 = 重启请求失败
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const BEFORE = { sha: 'fadbec42e2311b7cc2f09109a5ca3ef34e761760a409a28a84704d179c538f9c', bytes: 14939, label: '改动前（0.1.5 之前的老取事件面写法）' }
const AFTER = { sha: 'fceb32b48aa6a057ee8d1652e91522d6aab3daa60d7f1a10e784cd49d75b71ea', bytes: 16368, label: '改动后（M1 修复：新面优先 + 老线回落）' }
const ARCHIVE = process.env.DSH_ARCHIVE || path.join(process.cwd(), '_archive')
const RESTART_CLI = process.env.DSH_RESTART_CLI || path.join(process.cwd(), 'tools', 'request-restart.mjs')

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const say = (s) => process.stdout.write(`${s}\n`)

// ── 参数 ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const valu = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : null }
const USAGE = 'node rollback-injector-fix.mjs --target <DSH_HOME> [--point <dir>] [--apply] [--no-restart] [--allow-production] | --status'
const known = new Set(['--apply', '--dry-run', '--no-restart', '--allow-production', '--status', '--help', '--target', '--point', '--reason'])
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  if (!known.has(a)) { say(`[rollback-m1] 未知参数 ${a}\n用法：${USAGE}`); process.exit(2) }
  if ((a === '--target' || a === '--point' || a === '--reason') && !argv[i + 1]) { say(`[rollback-m1] ${a} 缺值\n用法：${USAGE}`); process.exit(2) }
  if (a === '--target' || a === '--point' || a === '--reason') i += 1
}
if (flag('help') || argv.length === 0) { say(`用法：${USAGE}`); process.exit(argv.length === 0 ? 2 : 0) }

const rawTarget = valu('target')
if (!rawTarget) { say(`[rollback-m1] --target <DSH_HOME> 必填（没有默认目标）\n用法：${USAGE}`); process.exit(2) }
const home = path.resolve(rawTarget)
if (!fs.existsSync(home)) { say(`[rollback-m1] --target 不存在：${home}`); process.exit(2) }
const defaultHome = path.join(os.homedir(), '.dsh')
const isProduction = home.toLowerCase() === path.resolve(defaultHome).toLowerCase()
if (isProduction && !flag('allow-production')) {
  say(`[rollback-m1] 目标 ${home} 是本机默认 home（= 生产）；确认要动生产请显式追加 --allow-production。`)
  process.exit(2)
}
const apply = flag('apply')
const doRestart = !flag('no-restart')
const statusOnly = flag('status')

const targetFile = path.join(home, 'profiles', 'web', 'node_modules', 'dsh-memory', 'lib', 'injector.mjs')

// ── 回滚点定位（before 快照） ──────────────────────────────────────────────────
function findPoint() {
  const explicit = valu('point')
  if (explicit) {
    const p = path.resolve(explicit)
    const f = path.join(p, 'before', 'prod-entity', 'lib', 'injector.mjs')
    return fs.existsSync(f) ? { dir: p, file: f } : null
  }
  if (!fs.existsSync(ARCHIVE)) return null
  const dirs = fs.readdirSync(ARCHIVE)
    .filter((n) => n.startsWith('m1-injector-fix-'))
    .map((n) => path.join(ARCHIVE, n))
    .sort()
    .reverse()
  for (const dir of dirs) {
    const f = path.join(dir, 'before', 'prod-entity', 'lib', 'injector.mjs')
    if (!fs.existsSync(f)) continue
    if (sha256(fs.readFileSync(f)) === BEFORE.sha) return { dir, file: f }
  }
  return null
}

const point = findPoint()
const currentBytes = fs.existsSync(targetFile) ? fs.readFileSync(targetFile) : null
const currentSha = currentBytes ? sha256(currentBytes) : null
const state = currentSha === AFTER.sha ? 'AFTER' : currentSha === BEFORE.sha ? 'BEFORE' : currentSha ? 'OTHER' : 'ABSENT'

say('[rollback-m1] 冲刺600-M1 注入去重修复 · 一键回滚')
say(`  target      : ${targetFile}`)
say(`  home        : ${home}${isProduction ? '  ⚠ PRODUCTION HOME' : '  [non-default home]'}`)
say(`  mode        : ${statusOnly ? 'status(只读)' : apply ? 'APPLY(真写)' : 'DRY-RUN(默认，不写)'}`)
say(`  当前实体     : ${currentSha ? `${currentSha}  ${currentBytes.length} B` : '(文件不存在)'}`)
say(`  状态         : ${state}  ${state === 'AFTER' ? '（= 本卡改动后，可回滚）' : state === 'BEFORE' ? '（= 改动前，已回滚/无需回滚）' : state === 'OTHER' ? '（⚠ 既不是改动前也不是改动后 ⇒ 拒绝覆盖，请人工确认）' : ''}`)
say(`  回滚点       : ${point ? point.dir : '(未找到含 before/prod-entity/lib/injector.mjs 且 sha 命中改动前锚的回滚点)'}`)
say(`  改动前锚     : ${BEFORE.sha}  ${BEFORE.bytes} B  ${BEFORE.label}`)
say(`  改动后锚     : ${AFTER.sha}  ${AFTER.bytes} B  ${AFTER.label}`)
if (point) {
  const src = fs.readFileSync(point.file)
  say(`  回滚源复核   : ${sha256(src)} ${src.length} B  ${sha256(src) === BEFORE.sha && src.length === BEFORE.bytes ? '✅ 与改动前锚逐字节相同' : '❌ 不一致（回滚源被污染 ⇒ 拒绝）'}`)
}

if (statusOnly) {
  say(`[rollback-m1] status 结束（只读，零写入）。`)
  process.exit(0)
}

// ── 门禁 ─────────────────────────────────────────────────────────────────────
if (state === 'ABSENT') { say('[rollback-m1] 目标文件不存在 ⇒ 无法回滚（实体可能未部署）。'); process.exit(1) }
if (state === 'BEFORE') { say('[rollback-m1] 当前已是改动前版本 ⇒ 无需回滚（零写入）。'); process.exit(0) }
if (state === 'OTHER') { say('[rollback-m1] 目标 sha 既不是改动前也不是改动后 ⇒ fail-closed 拒绝覆盖（请人工确认后再动）。'); process.exit(1) }
if (!point) { say('[rollback-m1] 找不到可信回滚点 ⇒ fail-closed 中止（零写入）。'); process.exit(1) }
const srcBuf = fs.readFileSync(point.file)
if (sha256(srcBuf) !== BEFORE.sha || srcBuf.length !== BEFORE.bytes) {
  say('[rollback-m1] 回滚源与改动前锚不一致 ⇒ fail-closed 中止（零写入）。')
  process.exit(1)
}

if (!apply) {
  say('[rollback-m1] DRY-RUN 结论：门禁全过，可安全回滚。实际执行请追加 --apply。')
  say(`  [dry-run] 将把 ${point.file} 覆盖到 ${targetFile}（${BEFORE.bytes} B）`)
  say(`  [dry-run] 覆盖前会先把当前实体备份到 ${path.join(point.dir, 'rollback-runs', '<stamp>')}`)
  say(`  [dry-run] 覆盖后会复核 sha == ${BEFORE.sha}`)
  say(`  [dry-run] ${doRestart ? '随后走 P0 闸门请求重启' : '--no-restart：不请求重启'}`)
  process.exit(0)
}

// ── 真回滚 ───────────────────────────────────────────────────────────────────
const stamp = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}` })()
const runDir = path.join(point.dir, 'rollback-runs', stamp)
fs.mkdirSync(runDir, { recursive: true })
fs.writeFileSync(path.join(runDir, 'injector.before-rollback.mjs'), currentBytes)
fs.writeFileSync(path.join(runDir, 'MANIFEST.json'), `${JSON.stringify({
  at: new Date().toISOString(), target: targetFile, home, productionHome: isProduction,
  before: { sha256: currentSha, bytes: currentBytes.length },
  after: { sha256: BEFORE.sha, bytes: BEFORE.bytes },
  source: point.file, note: '此次回滚动作自身的留痕：before = 回滚前实体，after = 回滚后应等于改动前锚。',
}, null, 2)}\n`, 'utf8')
say(`[rollback-m1] 回滚前实体已备份：${path.join(runDir, 'injector.before-rollback.mjs')}（sha ${currentSha}）`)

fs.writeFileSync(targetFile, srcBuf)
const afterSha = sha256(fs.readFileSync(targetFile))
say(`[rollback-m1] 已覆盖：${targetFile}`)
say(`[rollback-m1] 复核 sha = ${afterSha}  ${afterSha === BEFORE.sha ? '✅ 与改动前锚相同' : '❌ 不一致'}`)
if (afterSha !== BEFORE.sha) { say('[rollback-m1] 回滚后复核失败 —— 请人工检查（备份与回滚源都在回滚点里）。'); process.exit(1) }

if (!doRestart) { say('[rollback-m1] --no-restart：回滚完成，未请求重启（改动要生效需自行走 P0 闸门重启）。'); process.exit(0) }

// ── P0 闸门重启 ──────────────────────────────────────────────────────────────
if (!fs.existsSync(RESTART_CLI)) { say(`[rollback-m1] 找不到重启闸门：${RESTART_CLI} ⇒ 未请求重启（回滚已生效于文件，等下次重启）。`); process.exit(3) }
const reason = valu('reason') ?? `冲刺600-M1 回滚：dsh-memory 的 lib/injector.mjs 已退回改动前（${AFTER.sha.slice(0, 8)}→${BEFORE.sha.slice(0, 8)}）`
const r = spawnSync(process.execPath, [RESTART_CLI, '--reason', reason], { encoding: 'utf8', windowsHide: true })
say(`[rollback-m1] 重启闸门输出：\n${(r.stdout ?? '').trim()}`)
if (r.status !== 0) { say(`[rollback-m1] 重启请求失败（rc=${r.status}）：${(r.stderr ?? '').trim().slice(0, 300)}`); process.exit(3) }
say('[rollback-m1] 回滚完成 + 已走 P0 闸门请求重启。')
process.exit(0)
