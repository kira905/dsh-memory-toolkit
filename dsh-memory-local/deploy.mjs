/**
 * deploy.mjs —— 把自持 fork（dsh-memory-local）幂等部署进某个 DSH home 的 web profile，
 * 替换上游 `dsh-memory` 实体（同一槽位：bundle 名 / patch insert name / .package-map.json
 * 全部按 `dsh-memory` 解析，所以只换实体内容、不动 profile wiring）。
 *
 * ⚠️ 安全口径（本卡红线）：
 *   · `--target <DSH_HOME>` **必填** —— 没有默认值，写错路径不会静默落到生产；
 *   · 目标是本机默认 home（`~/.dsh`，即生产）时必须显式再加 `--allow-production`，
 *     否则 fail-closed 拒绝（本卡 S2a 明令禁止部署生产）；
 *   · 本脚本**绝不重启任何 DSH**、绝不动 `memory.db`、绝不写 profile package.json / package-map。
 *
 * 步骤：
 *   0) gate0：参数白名单（fail-closed）+ 目标 home 形态校验（必须 <home>/profiles/<profile> 存在）
 *   1) gate1：静态扫 lib/ 里「解析后逃出插件目录的相对 import」（tools\lib\deploy-guard.mjs）
 *   2) 备份当前实体（**仅当它不是 fork 版**）：整份拷进 _archive\g24-s2a-memory-deploy-<stamp>\official-entity\
 *   3) 幂等写实体：lib/ + cordis.patch.yml + 部署态 package.json（name→dsh-memory、version→上游版本，
 *      真身与基点记在 package.json 的 `fork` 段）
 *   4) gate2：以**部署位置**为解析上下文冒烟 import 每个 lib 模块
 *   5) gate3：mock ctx 加载探针 —— 断言三工具注册 + memory:recall 段注册
 *
 * 退出码：0 = 成功（含幂等无变化） / 1 = 门禁或部署失败 / 2 = 用法/参数错误。
 *
 * 用法：
 *   node deploy.mjs --target <DSH_HOME> [--profile web] [--dry-run] [--allow-production]
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs, describeUnknown, findEscapingImports, smokeImportAll, EXIT } from '../lib/deploy-guard.mjs'

const KNOWN_ARGS = [
  '--dry-run',
  '--allow-production',
  { flag: '--target', takesValue: true },
  { flag: '--profile', takesValue: true, alias: '--p' },
]
const pa = parseArgs(process.argv.slice(2), KNOWN_ARGS)
if (!pa.ok) {
  console.error(`[deploy] ${describeUnknown(pa.unknown, KNOWN_ARGS)}`)
  console.error('[deploy] 用法：node deploy.mjs --target <DSH_HOME> [--profile web] [--dry-run] [--allow-production]')
  process.exit(EXIT.USAGE)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const dry = !!pa.flags['--dry-run']
const allowProduction = !!pa.flags['--allow-production']
const profileName = pa.values['--profile'] ?? 'web'

// ── gate0：--target 必填 + fail-closed ────────────────────────────────────────
const rawTarget = pa.values['--target']
if (!rawTarget) {
  console.error('[deploy] 缺少 --target <DSH_HOME>：本脚本没有默认目标（写死生产路径是明令禁止的）')
  console.error('[deploy] 示例：node deploy.mjs --target <隔离实例的 DSH_HOME> --dry-run')
  process.exit(EXIT.USAGE)
}
const home = path.resolve(rawTarget)
if (!fs.existsSync(home)) {
  console.error(`[deploy] --target 不存在：${home}`)
  process.exit(EXIT.USAGE)
}
const defaultHome = path.join(os.homedir(), '.dsh')
const isProduction = home.toLowerCase() === path.resolve(defaultHome).toLowerCase()
if (isProduction && !allowProduction) {
  console.error(`[deploy] 目标 ${home} 是本机默认 home（= 生产）。`)
  console.error('[deploy] 本卡（G24-S2a）明令禁止部署生产；确认要动生产请显式追加 --allow-production。')
  process.exit(EXIT.GATE)
}
const profile = path.join(home, 'profiles', profileName)
if (!fs.existsSync(profile)) {
  console.error(`[deploy] profile 不存在：${profile}`)
  process.exit(EXIT.USAGE)
}
const target = path.join(profile, 'node_modules', 'dsh-memory')
const packageMapFile = path.join(profile, 'node_modules', '.package-map.json')

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
function listTree(root) {
  const out = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) out.push(path.relative(root, full).replaceAll('\\', '/'))
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out.sort()
}

// ── 产物齐备性 ────────────────────────────────────────────────────────────────
const libEntry = path.join(here, 'lib', 'index.js')
const buildInfoFile = path.join(here, 'lib', '.build-info.json')
if (!fs.existsSync(libEntry) || !fs.existsSync(buildInfoFile)) {
  console.error('[deploy] 构建产物缺失：先跑 `node build.mjs`')
  process.exit(EXIT.GATE)
}
const buildInfo = readJson(buildInfoFile)
const srcSha = sha256(fs.readFileSync(libEntry))
const pkg = readJson(path.join(here, 'package.json'))
const forkBase = readJson(path.join(here, 'FORK-BASE.json'))

// ── gate1：逃逸相对 import 静态扫（一切写操作之前） ─────────────────────────────
{
  const esc = findEscapingImports(path.join(here, 'lib'), { root: here })
  console.log(`[gate1] 静态扫 lib/：${esc.scanned} 文件 / ${esc.specs} 处相对 import`)
  if (esc.bad.length) {
    for (const b of esc.bad) console.error(`  ✗ ${b.file}:${b.line}  '${b.spec}' → ${b.resolved}`)
    console.error('[gate1] 未通过 —— 已中止，未写任何文件')
    process.exit(EXIT.GATE)
  }
  console.log('[gate1] OK：无逃逸相对 import')
}

// ── 现状判定（幂等 / 备份需求） ───────────────────────────────────────────────
const archiveRoot = process.env.DSH_ARCHIVE || path.join(process.cwd(), '_archive')
const entityPkgFile = path.join(target, 'package.json')
const entityEntryFile = path.join(target, 'lib', 'index.js')
const entityExists = fs.existsSync(target)
const entityPkg = entityExists && fs.existsSync(entityPkgFile) ? readJson(entityPkgFile) : null
const entitySha = fs.existsSync(entityEntryFile) ? sha256(fs.readFileSync(entityEntryFile)) : null
const alreadyFork = Boolean(entityPkg && entityPkg.fork && entitySha === srcSha)
const isUpstream = entityExists && !entityPkg?.fork

console.log(`source   : ${here}`)
console.log(`target   : ${target}${isProduction ? '  ⚠ PRODUCTION HOME' : '  [non-default home]'}`)
console.log(`entity   : ${entityExists ? (alreadyFork ? `already fork (sha ${entitySha.slice(0, 16)}…)` : entityPkg?.fork ? 'fork, but different sha' : `upstream ${entityPkg?.name}@${entityPkg?.version}`) : 'absent'}`)
console.log(`lib sha  : ${srcSha}`)
if (!fs.existsSync(packageMapFile)) {
  console.error(`[deploy] 找不到 ${packageMapFile} —— 这不是一个可加载的 DSH profile`)
  process.exit(EXIT.USAGE)
}

/** 已有备份里是否有与该实体逐文件一致的「上游原物」快照（回滚→重部署时不重复归档）。 */
function findMatchingSnapshot(entityDir) {
  if (!fs.existsSync(archiveRoot)) return null
  const dirs = fs.readdirSync(archiveRoot)
    .filter((n) => n.startsWith('g24-s2a-memory-deploy-'))
    .map((n) => path.join(archiveRoot, n))
    .sort()
    .reverse()
  for (const dir of dirs) {
    const manifestFile = path.join(dir, 'OFFICIAL-ENTITY.json')
    if (!fs.existsSync(manifestFile)) continue
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
      if (manifest.files.every((f) => {
        const full = path.join(entityDir, f.file)
        return fs.existsSync(full) && sha256(fs.readFileSync(full)) === f.sha256
      })) return dir
    } catch { /* malformed manifest -> skip */ }
  }
  return null
}

let backupDir = null
let reusedSnapshot = false
if (isUpstream) {
  const existing = findMatchingSnapshot(target)
  if (existing) { backupDir = existing; reusedSnapshot = true }
  else backupDir = path.join(archiveRoot, `g24-s2a-memory-deploy-${stamp()}`)
} else {
  // 已在 fork 态：沿用最近一个「含上游原物」的备份目录（restore 的唯一还原源）
  const candidates = fs.existsSync(archiveRoot)
    ? fs.readdirSync(archiveRoot)
      .filter((n) => n.startsWith('g24-s2a-memory-deploy-'))
      .map((n) => path.join(archiveRoot, n))
      .filter((d) => fs.existsSync(path.join(d, 'official-entity', 'package.json')))
      .sort()
    : []
  backupDir = candidates.at(-1) ?? null
  if (backupDir === null) {
    console.error('[deploy] 实体已是 fork 态，但 _archive 里找不到含上游原物的备份目录 ——')
    console.error('         继续部署会让 restore.mjs 失去还原源，已中止（先把上游 dsh-memory 原物归档再跑）。')
    process.exit(EXIT.GATE)
  }
}
console.log(`backup   : ${backupDir}${isUpstream ? '  (will capture the upstream entity)' : '  (existing upstream snapshot)'}`)

if (dry) {
  console.log('[dry-run] 未写任何文件')
  process.exit(EXIT.OK)
}

// ── 2) 备份上游实体（仅首次替换时；回滚→重部署复用同一份快照） ──────────────────
if (isUpstream && reusedSnapshot) {
  console.log(`[backup] 复用已有上游快照：${backupDir}（与当前实体逐文件一致，不重复归档）`)
} else if (isUpstream) {
  fs.mkdirSync(backupDir, { recursive: true })
  fs.cpSync(target, path.join(backupDir, 'official-entity'), { recursive: true })
  const files = listTree(path.join(backupDir, 'official-entity')).map((f) => {
    const full = path.join(backupDir, 'official-entity', f)
    return { file: f, bytes: fs.statSync(full).size, sha256: sha256(fs.readFileSync(full)) }
  })
  fs.writeFileSync(path.join(backupDir, 'OFFICIAL-ENTITY.json'), `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    from: target,
    package: { name: entityPkg.name, version: entityPkg.version },
    files,
  }, null, 2)}\n`, 'utf8')
  console.log(`[backup] 上游实体已归档：${files.length} 个文件 → ${path.join(backupDir, 'official-entity')}`)
}

// ── 3) 写实体（幂等） ─────────────────────────────────────────────────────────
fs.rmSync(target, { recursive: true, force: true })
fs.mkdirSync(target, { recursive: true })
for (const entry of ['lib', 'cordis.patch.yml']) {
  const from = path.join(here, entry)
  if (!fs.existsSync(from)) continue
  fs.cpSync(from, path.join(target, entry), { recursive: true })
}
// 部署态 package.json：占上游槽位名（name/version），真身与基点记在 `fork` 段
const deployed = {
  ...pkg,
  name: forkBase.upstream.name,
  version: forkBase.upstream.version,
  fork: {
    name: pkg.name,
    sourceVersion: pkg.version,
    base: `${forkBase.upstream.name}@${forkBase.upstream.version}`,
    baseSha256: forkBase.source.sha256,
    libSha256: srcSha,
    deployedAt: new Date().toISOString(),
    deployedFrom: here,
    note: 'Deployed entity occupies the upstream slot: bundle name, patch insert name and .package-map entry all resolve `dsh-memory`.',
  },
}
// lib/.build-info.json 不进实体（部署态只放运行时需要的三件）
fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify(deployed, null, 2)}\n`, 'utf8')
fs.rmSync(path.join(target, 'lib', '.build-info.json'), { force: true })
console.log(`[deploy] 实体已写入：lib/ cordis.patch.yml package.json（deploy 态名=${deployed.name}@${deployed.version}，fork 真身=${pkg.name}@${pkg.version}）`)

// ── 4) gate2：部署位置冒烟 import ─────────────────────────────────────────────
{
  const sm = smokeImportAll(target, 'lib')
  if (sm.error) {
    console.error(`[deploy] 门禁②无法执行：${sm.error}（回滚：node ${path.join(here, 'restore.mjs')} --target ${home}）`)
    process.exit(EXIT.GATE)
  }
  console.log(`[gate2] 部署位置冒烟 import：${sm.total} 个模块（模式 ${sm.mode}）`)
  for (const b of sm.bad) console.error(`  ✗ ${b.file} → ${b.err}`)
  if (sm.bad.length) {
    console.error('[gate2] 未通过 —— 立即回滚：node restore.mjs --target ' + home)
    process.exit(EXIT.GATE)
  }
  console.log('[gate2] OK：模块在部署位置可解析')
}

// ── 5) gate3：mock ctx 加载探针（三工具 + recall 段） ─────────────────────────
{
  const probe = spawnSync(process.execPath, [path.join(here, 'test', 'probe-entity.mjs'), target], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  })
  const out = (probe.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
  console.log(`[gate3] 加载探针：${out || (probe.stderr ?? '').trim().slice(0, 300) || 'no output'}`)
  if (probe.status !== 0) {
    console.error('[gate3] 未通过（插件在 DSH 加载期注册不出预期工具/段）—— 立即回滚：node restore.mjs --target ' + home)
    process.exit(EXIT.GATE)
  }
}

// ── 记录 ─────────────────────────────────────────────────────────────────────
const info = {
  deployedAt: new Date().toISOString(),
  target,
  home,
  profile: profileName,
  productionHome: isProduction,
  source: here,
  fork: { name: pkg.name, version: pkg.version },
  occupation: { name: deployed.name, version: deployed.version },
  base: `${forkBase.upstream.name}@${forkBase.upstream.version}`,
  baseSha256: forkBase.source.sha256,
  libSha256: srcSha,
  upstreamEntityCaptured: isUpstream,
  upstreamSnapshotDir: backupDir,
  rollback: `node ${path.join(here, 'restore.mjs')} --target ${home}${isProduction ? ' --allow-production' : ''}`,
}
const infoFile = path.join(backupDir, `DEPLOY-INFO-${stamp()}.json`)
fs.writeFileSync(infoFile, `${JSON.stringify(info, null, 2)}\n`, 'utf8')
console.log(`\n[deploy] complete — 记录：${infoFile}`)
console.log('[deploy] 未重启任何 DSH（本脚本不做重启）。隔离实例请用测试环境冒烟脚本启动：')
console.log('  （隔离实例请用你自己的测试环境冒烟脚本启动，本仓不提供）')
