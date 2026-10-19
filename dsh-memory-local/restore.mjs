/**
 * restore.mjs —— 把 web profile 的 `dsh-memory` 实体原子还原成**上游官方原物**（一键回滚）。
 *
 * 还原源 = deploy.mjs 首次替换时归档的 `_archive\g24-s2a-memory-deploy-*\official-entity\`
 * （该目录不存在就不动手：没有还原源时回滚等于破坏）。
 *
 * 流程（可回滚的原子交换）：
 *   1) 找含上游原物的备份目录（最新一个）
 *   2) 把当前实体快照到 `_archive\g24-s2a-memory-prerestore-<stamp>\entity-before-restore\`
 *      —— 还原本身也可被审视/再回滚
 *   3) 上游原物拷进 `<target>.restore-tmp-<stamp>`，逐文件核 sha（与 OFFICIAL-ENTITY.json 对齐）
 *   4) 交换：target → `<target>.restore-old-<stamp>`、tmp → target，然后删掉 old
 *   5) 复核还原后 sha，打印「重新部署」命令
 *
 * 退出码：0 = 成功（含 --dry-run / --self-test 通过） / 1 = 还原失败 / 2 = 用法错误（含未知参数 / 缺 --allow-production） / 3 = 无还原源。
 *
 * 🔒 生产闸：`--target` 落在生产树（`$DSH_HOME` 与可选 `DSH_PROD_ROOTS`，realpath + 逻辑双比）内时，
 *    **真还原**必须显式 `--allow-production`（否则 rc=2）；`--dry-run` 是只读档，不受闸门限制。
 *
 * 用法：
 *   node restore.mjs --target <DSH_HOME> [--profile web] [--dry-run] [--list] [--allow-production]
 *   node restore.mjs --self-test              # 沙箱夹具演练（不碰任何真实 home）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseArgs, describeUnknown, EXIT } from '../lib/deploy-guard.mjs'
// R-060 隔离闸（2026-10-16 接入）：把本文件原来"只比是否等于默认 home"的精确字符串比较，换成共享件
// 「realpath + 逻辑路径双比」的生产树判定（`tools\lib\production-guard.mjs`）。
import { gateProductionWrite, refuseLine } from './lib/prod-gate.mjs'

const KNOWN_ARGS = [
  '--dry-run', '--list', '--self-test', '--allow-production',
  { flag: '--target', takesValue: true },
  { flag: '--profile', takesValue: true, alias: '--p' },
  { flag: '--archive', takesValue: true },
]

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const listTree = (root) => {
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

/** 找含上游原物的备份目录（最新优先）。 */
function findSnapshot(archiveRoot) {
  if (!fs.existsSync(archiveRoot)) return []
  return fs.readdirSync(archiveRoot)
    .filter((n) => n.startsWith('g24-s2a-memory-deploy-'))
    .map((n) => path.join(archiveRoot, n))
    .filter((d) => fs.existsSync(path.join(d, 'official-entity', 'package.json')))
    .sort()
}

/** 校验一份实体目录与 OFFICIAL-ENTITY.json 的逐文件 sha 是否一致。 */
function verifyAgainstManifest(entityDir, manifestFile) {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const bad = []
  for (const f of manifest.files) {
    const full = path.join(entityDir, f.file)
    if (!fs.existsSync(full)) { bad.push(`${f.file}: missing`); continue }
    const got = sha256(fs.readFileSync(full))
    if (got !== f.sha256) bad.push(`${f.file}: sha ${got.slice(0, 12)} != ${f.sha256.slice(0, 12)}`)
  }
  return { manifest, bad }
}

/** 核心还原（供正常路径与 self-test 共用）。 */
function restoreEntity({ target, backupDir, archiveRoot, dry }) {
  const officialDir = path.join(backupDir, 'official-entity')
  const manifestFile = path.join(backupDir, 'OFFICIAL-ENTITY.json')
  const out = { target, backupDir, actions: [], ok: false }

  const verified = verifyAgainstManifest(officialDir, manifestFile)
  if (verified.bad.length) throw new Error(`备份原物自身校验失败：${verified.bad.join('; ')}`)
  out.manifestFiles = verified.manifest.files.length

  const tag = stamp()
  const preDir = path.join(archiveRoot, `g24-s2a-memory-prerestore-${tag}`)
  const tmpDir = `${target}.restore-tmp-${tag}`
  const oldDir = `${target}.restore-old-${tag}`
  out.actions.push(`snapshot current entity -> ${path.join(preDir, 'entity-before-restore')}`)
  out.actions.push(`stage upstream entity -> ${tmpDir}`)
  out.actions.push(`swap: ${target} -> ${oldDir}, then ${tmpDir} -> ${target}`)
  out.preRestoreDir = preDir
  if (dry) return out

  // 2) 快照当前实体（还原也可被再回滚）
  fs.mkdirSync(preDir, { recursive: true })
  if (fs.existsSync(target)) fs.cpSync(target, path.join(preDir, 'entity-before-restore'), { recursive: true })
  fs.writeFileSync(path.join(preDir, 'RESTORE-INFO.json'), `${JSON.stringify({
    restoredAt: new Date().toISOString(), restoredFrom: backupDir, target,
  }, null, 2)}\n`, 'utf8')

  // 3) stage + 核 sha
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.cpSync(officialDir, tmpDir, { recursive: true })
  const staged = verifyAgainstManifest(tmpDir, manifestFile)
  if (staged.bad.length) { fs.rmSync(tmpDir, { recursive: true, force: true }); throw new Error(`stage 校验失败：${staged.bad.join('; ')}`) }

  // 4) 交换
  if (fs.existsSync(target)) fs.renameSync(target, oldDir)
  fs.renameSync(tmpDir, target)
  fs.rmSync(oldDir, { recursive: true, force: true })

  // 5) 复核
  const after = verifyAgainstManifest(target, manifestFile)
  if (after.bad.length) throw new Error(`还原后复核失败：${after.bad.join('; ')}`)
  out.ok = true
  out.restoredFiles = after.manifest.files.length
  return out
}

// ── --self-test：沙箱夹具演练（不碰真实 home / 真实 _archive） ─────────────────
if (process.argv.includes('--self-test')) {
  const pa = parseArgs(process.argv.slice(2), KNOWN_ARGS)
  if (!pa.ok) { console.error(`[restore] ${describeUnknown(pa.unknown, KNOWN_ARGS)}`); process.exit(EXIT.USAGE) }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'g24-s2a-restore-selftest-'))
  const archiveRoot = path.join(sandbox, 'archive')
  const target = path.join(sandbox, 'home', 'profiles', 'web', 'node_modules', 'dsh-memory')
  const failures = []
  const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures.push(name) }
  try {
    // 夹具：一份「官方原物」备份目录 + 一份「fork 实体」当前态
    const backupDir = path.join(archiveRoot, 'g24-s2a-memory-deploy-20260921-000000')
    const officialDir = path.join(backupDir, 'official-entity')
    fs.mkdirSync(path.join(officialDir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(officialDir, 'lib', 'index.js'), 'export const marker = "UPSTREAM";\n', 'utf8')
    fs.writeFileSync(path.join(officialDir, 'package.json'), `${JSON.stringify({ name: 'dsh-memory', version: '0.1.0' }, null, 2)}\n`, 'utf8')
    const files = listTree(officialDir).map((f) => ({
      file: f, bytes: fs.statSync(path.join(officialDir, f)).size, sha256: sha256(fs.readFileSync(path.join(officialDir, f))),
    }))
    fs.writeFileSync(path.join(backupDir, 'OFFICIAL-ENTITY.json'), `${JSON.stringify({ files }, null, 2)}\n`, 'utf8')

    fs.mkdirSync(path.join(target, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(target, 'lib', 'index.js'), 'export const marker = "FORK";\n', 'utf8')
    fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({ name: 'dsh-memory', version: '0.1.0', fork: { name: 'dsh-memory-local' } }, null, 2)}\n`, 'utf8')

    // ① 无还原源时拒绝
    const emptyArchive = path.join(sandbox, 'empty-archive')
    fs.mkdirSync(emptyArchive, { recursive: true })
    check('no snapshot -> findSnapshot returns []', findSnapshot(emptyArchive).length === 0)
    check('snapshot discovered', findSnapshot(archiveRoot).length === 1, JSON.stringify(findSnapshot(archiveRoot)))

    // ② dry-run 不动盘
    const dryRun = restoreEntity({ target, backupDir, archiveRoot, dry: true })
    check('dry-run reports actions', dryRun.actions.length === 3 && dryRun.ok === false)
    check('dry-run leaves the fork entity untouched',
      fs.readFileSync(path.join(target, 'lib', 'index.js'), 'utf8').includes('FORK'))

    // ③ 真还原
    const real = restoreEntity({ target, backupDir, archiveRoot, dry: false })
    check('restore ok', real.ok === true && real.restoredFiles === 2, JSON.stringify(real.restoredFiles))
    check('entity is upstream again',
      fs.readFileSync(path.join(target, 'lib', 'index.js'), 'utf8').includes('UPSTREAM'))
    check('fork package.json (with fork section) is gone',
      JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).fork === undefined)
    check('pre-restore snapshot captured the fork entity',
      fs.readFileSync(path.join(real.preRestoreDir, 'entity-before-restore', 'lib', 'index.js'), 'utf8').includes('FORK'))
    check('no leftover swap dirs',
      !fs.existsSync(`${target}.restore-old-`) && fs.readdirSync(path.dirname(target)).every((n) => !n.includes('.restore-tmp-') && !n.includes('.restore-old-')),
      JSON.stringify(fs.readdirSync(path.dirname(target))))

    // ④ 幂等：再还原一次仍然成功（还原上游原物到上游原物）
    const again = restoreEntity({ target, backupDir, archiveRoot, dry: false })
    check('second restore is idempotent', again.ok === true)
    check('entity still upstream', fs.readFileSync(path.join(target, 'lib', 'index.js'), 'utf8').includes('UPSTREAM'))
  } catch (error) {
    check('self-test ran without throwing', false, error instanceof Error ? error.message : String(error))
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }
  console.log(failures.length === 0 ? '\nrestore self-test: ALL CHECKS PASS' : `\nrestore self-test: ${failures.length} CHECK(S) FAILED`)
  process.exit(failures.length === 0 ? EXIT.OK : EXIT.GATE)
}

// ── 正常路径 ─────────────────────────────────────────────────────────────────
const pa = parseArgs(process.argv.slice(2), KNOWN_ARGS)
if (!pa.ok) {
  console.error(`[restore] ${describeUnknown(pa.unknown, KNOWN_ARGS)}`)
  process.exit(EXIT.USAGE)
}
const dry = !!pa.flags['--dry-run']
const archiveRoot = pa.values['--archive'] ?? process.env.DSH_ARCHIVE ?? path.join(process.cwd(), '_archive')
const profileName = pa.values['--profile'] ?? 'web'
const snapshots = findSnapshot(archiveRoot)

if (pa.flags['--list']) {
  console.log(snapshots.length === 0 ? `no upstream snapshots under ${archiveRoot}` : snapshots.join('\n'))
  process.exit(snapshots.length === 0 ? 3 : EXIT.OK)
}

const rawTarget = pa.values['--target']
if (!rawTarget) {
  console.error('[restore] 缺少 --target <DSH_HOME>：本脚本没有默认目标（写死生产路径是明令禁止的）')
  process.exit(EXIT.USAGE)
}
const home = path.resolve(rawTarget)
const target = path.join(home, 'profiles', profileName, 'node_modules', 'dsh-memory')

// ── 生产闸（R-060 · 2026-10-16 接入）──────────────────────────────────────────
// 旧判据 = `home.toLowerCase() === path.resolve(defaultHome).toLowerCase()`：两个洞
//   ① 只比"**等于**"默认 home ⇒ `--target <生产树内的子目录>` 一律放行（2026-10-16 实测：真把上游原物写进了
//      `~\.dsh\<子目录>\profiles\...`，无人拦）；
//   ② 只比**逻辑**字符串、不走 realpath ⇒ junction 跨面可绕（R-060 取证⑦ V7 卡形态）。
// 新判据 = 「realpath + 逻辑路径双比」前缀判定：目标落在生产树（`$DSH_HOME`）内 ⇒
//   真还原必须显式 `--allow-production`（否则 rc=2）；**dry-run 是第一道门** ⇒ 只读档不设闸（旧实现连
//   `--dry-run` 打生产也拒 —— 那是误拦，本次一并修掉：只读档零写入，闸门不该拦计划）。
const gate = gateProductionWrite({
  targets: [{ path: home, label: '--target' }],
  allowProduction: pa.flags['--allow-production'] === true,
  dryRun: dry,
  op: '还原',
  reason: `dsh-memory-local restore --target ${home}${dry ? '（只读 dry-run）' : '（真还原）'}`,
})
if (!gate.ok) {
  console.error(refuseLine(gate))
  process.exit(gate.exitCode)   // 2（缺放行 = 用法错；与生态既有 --allow-production 口径一致）
}

if (snapshots.length === 0) {
  console.error(`[restore] 在 ${archiveRoot} 下找不到含上游原物的 g24-s2a-memory-deploy-* 备份 —— 无还原源，拒绝动手。`)
  process.exit(3)
}
const backupDir = snapshots.at(-1)

console.log(`target   : ${target}`)
console.log(`restore  : ${backupDir}\\official-entity`)
console.log(`archive  : ${archiveRoot}`)
if (!fs.existsSync(target)) console.log('[restore] 注意：目标实体当前不存在（将直接铺上游原物）')

try {
  const res = restoreEntity({ target, backupDir, archiveRoot, dry })
  for (const a of res.actions) console.log(`  ${dry ? 'would ' : ''}${a}`)
  if (dry) { console.log('\n[restore] dry-run：未改任何文件'); process.exit(EXIT.OK) }
  console.log(`\n[restore] 已还原上游原物：${res.restoredFiles} 个文件（逐文件 sha 复核通过）`)
  console.log(`[restore] 还原前实体快照：${res.preRestoreDir}\\entity-before-restore`)
  console.log('[restore] 未重启任何 DSH。重新装上 fork：')
  console.log(`  node ${path.join(path.dirname(fileURLToPath(import.meta.url)), 'deploy.mjs')} --target ${home}`)
  process.exit(EXIT.OK)
} catch (error) {
  console.error(`[restore] FAIL ${error instanceof Error ? error.message : String(error)}`)
  process.exit(EXIT.GATE)
}
