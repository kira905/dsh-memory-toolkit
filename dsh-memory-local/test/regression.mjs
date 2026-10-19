/**
 * regression.mjs —— fork 回归：**同输入、同输出**地对照上游实体与 fork 实体。
 *
 * 对照对象（各跑一遍完全相同的操作序列，全部在各自的临时 SQLite 上）：
 *   · 模块面   ：name / inject / 三工具的名字、描述、参数 schema、输出 render 文本
 *   · 行为面   ：write（含 tags 归一化 / pinned）/ search（命中、空结果、非法 limit）/
 *                forget（命中、不存在）/ memory:recall 段文本 / 各错误消息
 *   · 汇总指纹 ：把两次运行的观测序列各算一个 sha256，不相等即 FAIL 并打印首个差异
 *
 * 这是「三个官方工具行为一致」的机器判据（不花 token、不碰任何 DSH home、只用临时库）。
 *
 * 用法：
 *   node test/regression.mjs [--upstream <上游实体目录>] [--fork <fork实体或源码目录>]
 * 默认：上游 = _archive 里 deploy 备份的 official-entity（其次本机生产 profile 实体，只读）；
 *       fork = 本包（未部署时直接用源码 lib/）。
 * 退出码：0 = 完全一致 / 1 = 存在差异 / 2 = 用法错误 / 3 = 找不到上游对照物。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.join(here, '..')
const args = process.argv.slice(2)
const argValue = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : null
}

function findUpstream() {
  const explicit = argValue('--upstream')
  if (explicit) return explicit
  const archive = process.env.DSH_ARCHIVE || path.join(process.cwd(), '_archive')
  if (fs.existsSync(archive)) {
    const snaps = fs.readdirSync(archive)
      .filter((n) => n.startsWith('g24-s2a-memory-deploy-'))
      .map((n) => path.join(archive, n, 'official-entity'))
      .filter((d) => fs.existsSync(path.join(d, 'lib', 'index.js')))
      .sort()
    if (snaps.length) return snaps.at(-1)
  }
  const production = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-memory')
  if (fs.existsSync(path.join(production, 'lib', 'index.js'))) return production
  return null
}

/**
 * fork 侧默认取**隔离实例里的部署实体** —— 插件只能在「部署位置」被加载：
 * 它的 peer 依赖（@deepseek-ai/schemastery、@deepseek-ai/dsh-tools）由 profile 的闭包提供，
 * 源码目录（tools/dsh-memory-local）没有 node_modules，直接 import 会 ERR_MODULE_NOT_FOUND。
 */
function findForkEntity() {
  const explicit = argValue('--fork') ?? process.env.DSH_MEMORY_FORK_ENTITY ?? null
  if (explicit) return explicit
  const candidates = [
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'web', 'node_modules', 'dsh-memory'),
  ]
  for (const c of candidates) {
    const pkgFile = path.join(c, 'package.json')
    if (!fs.existsSync(pkgFile)) continue
    try {
      if (JSON.parse(fs.readFileSync(pkgFile, 'utf8')).fork) return c
    } catch { /* not a dsh entity */ }
  }
  return null
}

/**
 * 从 dir 向上找第一个「能解析到宿主闭包」的目录（判据 = node_modules/@deepseek-ai/schemastery 存在）。
 * 插件只能在这样的位置被 import —— 源码目录与 _archive 都不满足，profile 实体满足。
 */
function resolvableContext(dir) {
  let cur = path.resolve(dir)
  for (;;) {
    if (fs.existsSync(path.join(cur, 'node_modules', '@deepseek-ai', 'schemastery'))) return cur
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

const forkDir = findForkEntity()
const upstreamDir = findUpstream()
if (!forkDir) {
  console.error('[regression] 找不到 fork 部署实体：先把 fork 部署到隔离实例（deploy.mjs --target <DSH_HOME>），')
  console.error('            或用 --fork <实体目录> / $DSH_MEMORY_FORK_ENTITY 显式指定部署位置。')
  process.exit(2)
}
if (!upstreamDir) { console.error('[regression] 找不到上游对照实体：用 --upstream <dir> 显式指定'); process.exit(3) }

const fixtureText = 'regression fixture: DSH 记忆引擎 fork 基线（tags 归一化 + 中文）'
const pinnedText = 'pinned fixture: 每轮都要出现的事实'

/** 用 mock ctx 加载一个实体，跑固定序列，返回可比较的观测对象。 */
async function observe(label, dir) {
  const obs = { label, dir, steps: [] }
  const entry = path.join(dir, 'lib', 'index.js')
  const mod = await import(pathToFileURL(entry).href)
  obs.module = { name: mod.name, inject: mod.inject, hasApply: typeof mod.apply === 'function' }

  const registered = []
  const sections = []
  const ctx = {
    tools: { register: (t) => { registered.push(t); return () => {} } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    // FORK-EDIT(2026-09-21): S2b 起 fork 会注册 `agent/pre-step` 监听（指针注入）。
    // 夹具给一个空监听口 —— 注入链本身由 s2b.test.mjs 覆盖，本对照只看三工具与段。
    on: () => () => {},
  }
  const dbFile = path.join(os.tmpdir(), `dsh-memory-regression-${label}-${process.pid}-${Date.now()}.db`)
  // FORK-EDIT(2026-09-21): S2b 起 fork 的 Config 多了 recall* 字段（指针注入，默认关）。
  // 它们全部给默认值 ⇒ 两侧行为面不变；上游实体不认识这些键（schemastery 忽略），故可同一份夹具。
  // `recallEnabled:false` = 注入链路不激活，对照的仍是「三工具 + memory:recall 段」本身。
  const recallDefaults = {
    recallEnabled: false, recallHome: '', recallMemoryDb: '', recallVectorsDb: '',
    recallBridgeHost: '127.0.0.1', recallBridgePort: 8201, recallBridgePortScanMax: 10,
    recallTimeoutMs: 300, recallEncodeTimeoutMs: 250, recallMaxItems: 8, recallMaxChars: 800,
    recallMaxTokens: 600, recallMaxPerSession: 3, recallSummaryChars: 80, recallQueryMaxChars: 512,
    recallVectorTopK: 20, recallFtsTopK: 20, recallRrfK: 60, recallResultTopK: 8, recallIndexTtlMs: 60000,
  }
  mod.apply(ctx, {
    path: dbFile, promptRecentCount: 10, promptMaxChars: 2000, maxTextChars: 2000,
    searchLimitDefault: 10, searchLimitMax: 50, promptOrder: 50,
    ...recallDefaults,
  })

  const capture = async (step, fn) => {
    try {
      const value = await fn()
      obs.steps.push({ step, ok: true, value })
    } catch (error) {
      obs.steps.push({ step, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const tool = (n) => registered.find((t) => t?.name === n)
  const describe = (t) => ({
    name: t?.name,
    description: t?.description,
    parameters: t?.parameters,
    outputSchema: t?.output?.schema,
    hasRender: typeof t?.output?.render === 'function',
    hasPresentCall: typeof t?.presentCall === 'function',
  })
  obs.toolShapes = registered.map(describe)
  obs.sectionShapes = sections.map((s) => ({ name: s?.name, order: s?.order, hasText: typeof s?.text === 'function' }))

  const render = (name, args, value) => tool(name).output.render(args, value)

  await capture('write.fixture', () => tool('memory_write').execute({ text: fixtureText, tags: ['Reg', 'reg', '中文 标签'], pinned: false }))
  await capture('write.pinned', () => tool('memory_write').execute({ text: pinnedText, tags: [], pinned: true }))
  await capture('section.afterWrites', () => sections[0].text())
  await capture('search.hit', async () => {
    const value = await tool('memory_search').execute({ query: 'regression fixture' })
    return { value, rendered: render('memory_search', { query: 'regression fixture' }, value) }
  })
  await capture('search.miss', async () => {
    const value = await tool('memory_search').execute({ query: 'zzz-不存在的词-zzz' })
    return { value, rendered: render('memory_search', { query: 'zzz-不存在的词-zzz' }, value) }
  })
  await capture('search.badLimit', () => tool('memory_search').execute({ query: 'fixture', limit: 0 }))
  await capture('search.emptyQuery', () => tool('memory_search').execute({ query: '   ' }))
  await capture('search.limitOverMax', () => tool('memory_search').execute({ query: 'fixture', limit: 999 }))
  await capture('write.blank', () => tool('memory_write').execute({ text: '   ' }))
  await capture('write.tooLong', () => tool('memory_write').execute({ text: 'x'.repeat(2001) }))
  await capture('forget.missing', async () => {
    const value = await tool('memory_forget').execute({ id: 999999 })
    return { value, rendered: render('memory_forget', { id: 999999 }, value) }
  })
  await capture('forget.hit', async () => {
    const value = await tool('memory_forget').execute({ id: 1 })
    return { value, rendered: render('memory_forget', { id: 1 }, value) }
  })
  await capture('section.afterForget', () => sections[0].text())
  await capture('write.render', () => render('memory_write', { text: fixtureText }, { id: 7, tags: 'reg', pinned: false }))

  for (const f of [dbFile, `${dbFile}-journal`]) { try { fs.rmSync(f, { force: true }) } catch { /* ignore */ } }
  obs.fingerprint = crypto.createHash('sha256').update(JSON.stringify(obs)).digest('hex')
  return obs
}

// 上游对照物也必须落在「能解析到宿主闭包」的位置：_archive 里的备份原物不在任何 profile 的
// node_modules 树内，直接 import 会 ERR_MODULE_NOT_FOUND（schemastery 由 profile 闭包提供）。
// → 必要时把它铺进隔离 profile 的隐藏参考目录（跑完清理，--keep-ref 可保留）。
const keepRef = args.includes('--keep-ref')
const refRoot = path.join(path.dirname(path.resolve(forkDir)), '.g24-s2a-upstream-ref')
let upstreamPath = path.resolve(upstreamDir)
let cleanupRef = null
if (resolvableContext(upstreamPath) === null) {
  try { fs.rmSync(refRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  fs.mkdirSync(refRoot, { recursive: true })
  upstreamPath = path.join(refRoot, 'dsh-memory')
  fs.cpSync(upstreamDir, upstreamPath, { recursive: true })
  cleanupRef = keepRef ? null : refRoot
  console.log(`[regression] 上游对照物已铺到可解析位置：${upstreamPath}${keepRef ? '（--keep-ref 保留）' : '（跑完清理）'}`)
}

let upstream
let fork
try {
  upstream = await observe('upstream', upstreamPath)
  fork = await observe('fork', path.resolve(forkDir))
} finally {
  if (cleanupRef) { try { fs.rmSync(cleanupRef, { recursive: true, force: true }) } catch { /* ignore */ } }
}

const failures = []
function compare(label, a, b) {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa !== sb) failures.push({ label, upstream: sa?.slice(0, 400), fork: sb?.slice(0, 400) })
}
/**
 * FORK-EDIT(2026-09-21): 「工具集」对照的**显式白名单**（否则这道门永远红 = 等于失效）。
 * 依据：方案 `docs\P2-记忆引擎升级-方案-20260916.md` §3.4 —— `memory_get` 是 fork 自注册的
 * 「指针展开」工具（官方包不提供，属**有意新增**）；其余任何工具差异照旧判红。
 * 只放宽"多出"这一个名字，且要求上游工具集是 fork 的**真子集**（少一个/改名/多一个都算差异）。
 */
const FORK_ONLY_TOOLS = ['memory_get']
function compareToolShapes(a, b) {
  const names = (list) => (Array.isArray(list) ? list.map((t) => t?.name) : [])
  const up = names(a)
  const fk = names(b)
  const extra = fk.filter((n) => !up.includes(n))
  const missing = up.filter((n) => !fk.includes(n))
  const unexpectedExtra = extra.filter((n) => !FORK_ONLY_TOOLS.includes(n))
  const byName = (list) => Object.fromEntries((list ?? []).map((t) => [t?.name, t]))
  const upMap = byName(a)
  const fkMap = byName(b)
  const shapeDiffs = up.filter((n) => JSON.stringify(upMap[n]) !== JSON.stringify(fkMap[n])).map((n) => n)
  if (missing.length === 0 && unexpectedExtra.length === 0 && shapeDiffs.length === 0) {
    if (extra.length > 0) console.log(`[regression] 白名单放行 fork 独有工具：${extra.join(', ')}（依据：方案 §3.4 / S2b 交付报告）`)
    return
  }
  failures.push({
    label: `tool shapes（缺=${JSON.stringify(missing)} 越界多出=${JSON.stringify(unexpectedExtra)} 形状变化=${JSON.stringify(shapeDiffs)}）`,
    upstream: JSON.stringify(a)?.slice(0, 400),
    fork: JSON.stringify(b)?.slice(0, 400),
  })
}
compare('module shape', upstream.module, fork.module)
compareToolShapes(upstream.toolShapes, fork.toolShapes)
compare('section shapes', upstream.sectionShapes, fork.sectionShapes)
compare('step count', upstream.steps.length, fork.steps.length)
for (let i = 0; i < Math.max(upstream.steps.length, fork.steps.length); i++) {
  compare(`step[${i}] ${upstream.steps[i]?.step ?? fork.steps[i]?.step ?? '?'}`, upstream.steps[i], fork.steps[i])
}

console.log(`upstream : ${upstream.dir}`)
console.log(`fork     : ${fork.dir}`)
console.log(`upstream fingerprint : ${upstream.fingerprint}`)
console.log(`fork     fingerprint : ${fork.fingerprint}`)
console.log(`steps compared       : ${upstream.steps.length}`)
for (const s of upstream.steps) {
  console.log(`  ${s.ok ? 'ok  ' : 'err '} ${s.step.padEnd(20)} ${JSON.stringify(s.ok ? s.value : s.error).slice(0, 120)}`)
}
if (failures.length === 0) {
  console.log('\nregression: IDENTICAL — 上下游实体在同一序列上逐步骤一致（含工具描述、参数 schema、错误消息、段落文本、render 文本）')
  process.exit(0)
}
console.log(`\nregression: ${failures.length} DIFFERENCE(S)`)
for (const f of failures) {
  console.log(`  ✗ ${f.label}`)
  console.log(`      upstream: ${f.upstream}`)
  console.log(`      fork    : ${f.fork}`)
}
process.exit(1)
