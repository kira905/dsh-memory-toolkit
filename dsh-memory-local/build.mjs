/**
 * build.mjs —— dsh-memory-local 的构建步骤（零依赖，node 原生）。
 *
 * 上游 npm 包只发布编译后的 JS（无 TypeScript 源），所以本 fork 的「源码」就是
 * `src/index.js`（= 官方 lib/index.js + FORK NOTICE 头注）。构建因此是：
 *
 *   1) 断言 src/ 齐全、FORK NOTICE 在位、与 FORK-BASE.json 的基点一致；
 *   2) `node --check` 对每个 JS 源码做语法校验（解析失败即拒绝产出）；
 *   3) 把 src/* 拷进 lib/（运行时实体目录，deploy.mjs 只搬 lib/ + cordis.patch.yml + package.json）；
 *   4) 写 lib/.build-info.json —— 源码 sha / 产物 sha / 基点 sha / 构建时间 / node 版本，
 *      供 verify-after-restart.mjs 做「版本与 sha 对齐」断言。
 *
 * 幂等：产物字节一致时不重写文件（只刷新指纹文件）。
 * 退出码：0 = 成功 / 1 = 构建失败（源缺失、语法错、基点不符）。
 *
 * 用法：node build.mjs [--check]      （--check = 只校验不写 lib/，可当 CI 用）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(here, 'src')
const libDir = path.join(here, 'lib')
const checkOnly = process.argv.includes('--check')

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const rel = (p) => path.relative(here, p).replaceAll('\\', '/')

function fail(message) {
  console.error(`[build] FAIL ${message}`)
  process.exit(1)
}

// 1) 源与基点 -----------------------------------------------------------------
const forkBaseFile = path.join(here, 'FORK-BASE.json')
if (!fs.existsSync(forkBaseFile)) fail('FORK-BASE.json missing (run the fork skeleton step first)')
const forkBase = JSON.parse(fs.readFileSync(forkBaseFile, 'utf8'))
const entry = path.join(srcDir, 'index.js')
if (!fs.existsSync(entry)) fail('src/index.js missing')
const srcText = fs.readFileSync(entry, 'utf8')
if (!srcText.startsWith('/**\n * FORK NOTICE')) fail('src/index.js is missing the FORK NOTICE header')
if (!srcText.includes(forkBase.source.sha256)) fail('FORK NOTICE carries a base sha256 that does not match FORK-BASE.json')

// 2) 语法校验 -----------------------------------------------------------------
const sources = fs.readdirSync(srcDir).filter((n) => /\.(mjs|cjs|js)$/.test(n)).sort()
for (const name of sources) {
  const full = path.join(srcDir, name)
  const r = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' })
  if (r.status !== 0) fail(`node --check failed for ${rel(full)}\n${(r.stderr ?? '').trim()}`)
}
console.log(`[build] syntax ok: ${sources.length} source file(s) -> ${sources.join(', ')}`)

// 3) 产出 ---------------------------------------------------------------------
// ⚠️ U3(2026-09-22)：宿主适配层副本**不进 build 产出** —— 它由 tools\sync-host-adapter.mjs 生成，
//    `src/` 与 `lib/` 各持一份、头部带各自的 target 标识（字节必然不同）。若 build 把 src 那份拷进
//    `lib/`，lib 副本的头会变成 src 的 target ⇒ R5 立刻报 header-only-diff（lib 目标是同步器独占的）。
//    语法校验仍照跑（上面的 sources 未变），只有"拷贝"这一步跳过。
const GENERATED_BY_SYNC = new Set(['host-adapter.js'])
if (!fs.existsSync(path.join(libDir, 'host-adapter.js'))) {
  fail('lib/host-adapter.js missing — 先跑宿主侧的 sync-host-adapter.mjs 生成（否则部署会 Cannot find module）')
}
const artifacts = sources.filter((name) => !GENERATED_BY_SYNC.has(name)).map((name) => ({
  name,
  from: path.join(srcDir, name),
  to: path.join(libDir, name),
}))
// 类型声明随源码走（官方包 exports 的 types 指向它）
const dts = path.join(srcDir, 'index.d.ts')
if (fs.existsSync(dts)) artifacts.push({ name: 'index.d.ts', from: dts, to: path.join(libDir, 'index.d.ts') })

if (checkOnly) {
  console.log('[build] --check: lib/ not written')
  process.exit(0)
}
fs.mkdirSync(libDir, { recursive: true })

const info = {
  package: 'dsh-memory-local',
  builtAt: new Date().toISOString(),
  node: process.version,
  forkBase: {
    upstream: `${forkBase.upstream.name}@${forkBase.upstream.version}`,
    sha256: forkBase.source.sha256,
    lines: forkBase.source.lines,
  },
  artifacts: [],
}
for (const a of artifacts) {
  const buf = fs.readFileSync(a.from)
  const srcSha = sha256(buf)
  let wrote = 'written'
  if (fs.existsSync(a.to) && sha256(fs.readFileSync(a.to)) === srcSha) wrote = 'unchanged'
  else fs.writeFileSync(a.to, buf)
  info.artifacts.push({ file: rel(a.to), src: rel(a.from), bytes: buf.length, sha256: srcSha, state: wrote })
  console.log(`[build] ${wrote.padEnd(9)} ${rel(a.to)}  ${buf.length} bytes  ${srcSha.slice(0, 16)}`)
}
fs.writeFileSync(path.join(libDir, '.build-info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8')
console.log(`[build] ok — base ${info.forkBase.upstream} sha256=${info.forkBase.sha256.slice(0, 16)}…`)
