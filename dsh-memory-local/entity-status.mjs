/**
 * entity-status.mjs —— 只读：报告某个 DSH home 的 web profile 里 `dsh-memory` 实体当前是
 * **上游官方原物**还是 **fork（dsh-memory-local）**，并给逐文件 sha / 体积 / 工具面摘要。
 *
 * 用途：一键回滚脚本（桌面 `记忆引擎回滚.cmd`）跑完后的判据、以及交付报告取证。
 * **只读**：不改任何文件、不重启、不写库。**输出全 ASCII**（要被 GBK 控制台读）。
 *
 * 退出码：0 = fork 版 / 3 = 上游原物 / 1 = 实体缺失或不可判。
 *
 * 用法：
 *   node entity-status.mjs                       # 默认本机 home（~/.dsh）
 *   node entity-status.mjs --target <DSH_HOME> [--profile web]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const val = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('usage: node entity-status.mjs [--target <DSH_HOME>] [--profile web]\n')
  process.exit(0)
}

const home = path.resolve(val('--target', path.join(os.homedir(), '.dsh')))
const profileName = val('--profile', 'web')
const entity = path.join(home, 'profiles', profileName, 'node_modules', 'dsh-memory')

const out = (s) => process.stdout.write(`${s}\n`)
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

out(`entity   : ${entity}`)
if (!fs.existsSync(entity)) {
  out('status   : MISSING (no dsh-memory entity under this home/profile)')
  process.exit(1)
}

const walk = (dir, base = '') => {
  const rows = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name)
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) rows.push(...walk(full, rel))
    else rows.push({ rel, bytes: fs.statSync(full).size, sha: sha256(full) })
  }
  return rows
}
const files = walk(entity)
for (const f of files) {
  out(`  ${f.rel.padEnd(24)} ${String(f.bytes).padStart(7)} B  ${f.sha}`)
}

const pkgFile = path.join(entity, 'package.json')
const entryFile = path.join(entity, 'lib', 'index.js')
let pkg = null
try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) } catch { /* ignore */ }

const mjsCount = files.filter((f) => f.rel.startsWith('lib/') && f.rel.endsWith('.mjs')).length
const entry = files.find((f) => f.rel === 'lib/index.js')
const fork = pkg && pkg.fork

out(`entrySha : ${entry ? entry.sha : '(none)'}  ${entry ? `${entry.bytes} B` : ''}`)
out(`lib/*.mjs: ${mjsCount}`)
if (fork) {
  out(`status   : FORK (${fork.name}@${fork.sourceVersion}, base ${fork.base})`)
  out(`forkLib  : ${fork.libSha256}`)
  out(`match    : ${entry && entry.sha === fork.libSha256 ? 'OK (entry sha == fork record)' : 'MISMATCH (entry sha != fork record!)'}`)
  process.exit(entry && entry.sha === fork.libSha256 ? 0 : 1)
}
out(`status   : UPSTREAM (official ${pkg ? `${pkg.name}@${pkg.version}` : 'unknown'}, no fork record)`)
process.exit(3)
