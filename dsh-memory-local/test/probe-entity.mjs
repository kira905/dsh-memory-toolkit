/**
 * probe-entity.mjs <entityDir> —— 在**部署位置**加载 dsh-memory 实体，用 mock ctx 断言
 * 「插件注册出什么」：三工具（memory_write / memory_search / memory_forget）+ memory:recall 段。
 *
 * 为什么需要它：`node --check` 只查语法、静态扫只查 import 形态，而「插件被 DSH 加载后到底
 * 注册了什么」只有真 import 一次真 apply 才知道。它同时是 deploy.mjs 的门禁③ 与
 * verify-after-restart.mjs 的核心断言（同一支探针，两处口径一致）。
 *
 * 副作用：只在一个临时 SQLite 文件上跑 write/search/forget，跑完删掉；不碰任何 DSH home。
 * 输出：stdout 末行 `PROBE: {json}`；退出码 0 = 全部断言通过，1 = 有断言失败。
 *
 * 用法：node test/probe-entity.mjs <entityDir>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
// FORK-EDIT(2026-09-22): U3 adapter 接入 —— 断言里的服务名取自适配层唯一源；
// 由于两端同源，本断言变成**真可证伪**：适配层若把 SVC.tools 的值改错，这里立刻红。
import { SVC } from '../src/host-adapter.js'

const entityDir = process.argv[2]
// 默认断言「这是 fork 实体」；--upstream 用于拿上游原物做对照（回归脚本会用到）。
const mode = process.argv.includes('--upstream') ? 'upstream' : 'fork'
if (!entityDir) {
  console.error('usage: node test/probe-entity.mjs <entityDir>')
  process.exit(2)
}
const entityAbs = path.resolve(entityDir)
const entry = path.join(entityAbs, 'lib', 'index.js')
const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

const result = { entityDir: entityAbs, packageName: null, fork: null, tools: [], section: null, behavior: null }

try {
  const pkgFile = path.join(entityAbs, 'package.json')
  if (fs.existsSync(pkgFile)) {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
    result.packageName = pkg.name
    result.packageVersion = pkg.version
    result.fork = pkg.fork ?? null
  }
  check('lib/index.js exists', fs.existsSync(entry), entry)
  if (mode === 'fork') {
    check('package.json has a fork section', Boolean(result.fork), JSON.stringify(result.packageName))
    check('fork section records the upstream base',
      Boolean(result.fork?.base) && Boolean(result.fork?.baseSha256) && Boolean(result.fork?.libSha256),
      JSON.stringify(result.fork))
  } else {
    check('entity is the untouched upstream package',
      !result.fork && result.packageName === 'dsh-memory', JSON.stringify(result.packageName))
  }

  const mod = await import(pathToFileURL(entry).href)
  check('module exports apply', typeof mod.apply === 'function')
  check('module name === "memory"', mod.name === 'memory', String(mod.name))
  check('inject includes tools + systemPrompt',
    Array.isArray(mod.inject) && mod.inject.includes(SVC.tools) && mod.inject.includes(SVC.systemPrompt),
    JSON.stringify(mod.inject))

  // mock ctx：只实现插件真正用到的那几个面（tools.register / systemPrompt.section / effect / on）
  // FORK-EDIT(2026-09-21 · S2b): 新增 `on`（`agent/pre-step` 监听）与 `memory_get` 断言。
  const registered = []
  const sections = []
  const disposers = []
  const listeners = []
  const ctx = {
    tools: { register: (tool) => { registered.push(tool); return () => {} } },
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
    on: (event, handler, options) => { listeners.push({ event, handler, options }); return () => {} },
  }

  const dbFile = path.join(os.tmpdir(), `dsh-memory-probe-${process.pid}-${Date.now()}.db`)
  // S2b：配置走插件自己的 schema（拿全量默认值），再把注入面全部指向临时目录
  // ⇒ 探针不读也不写任何 DSH home（家规：测试不得落生产路径）。
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-probe-home-'))
  const baseConfig = {
    path: dbFile,
    promptRecentCount: 10,
    promptMaxChars: 2000,
    maxTextChars: 2000,
    searchLimitDefault: 10,
    searchLimitMax: 50,
    promptOrder: 50,
  }
  const config = typeof mod.Config === 'function'
    ? mod.Config({
        ...baseConfig,
        recallEnabled: false, // 探针不跑注入链，只验注册面
        recallHome: tmpHome,
        recallMemoryDb: path.join(tmpHome, 'memory', 'memory.db'),
        recallVectorsDb: path.join(tmpHome, 'memory-vectors', 'vectors.db'),
      })
    : baseConfig
  result.configKeys = Object.keys(config).length
  mod.apply(ctx, config)

  result.tools = registered.map((t) => ({ name: t?.name, hasExecute: typeof t?.execute === 'function' }))
  const names = result.tools.map((t) => t.name).sort()
  // S2b：fork 版在官方三工具之外自注册 `memory_get`（指针指向的那扇门，方案 §3.4 关 B1）；
  // `--upstream` 模式拿上游原物对照，仍是官方三工具、也没有 pre-step 监听。
  const expectedTools = mode === 'fork'
    ? ['memory_forget', 'memory_get', 'memory_search', 'memory_write']
    : ['memory_forget', 'memory_search', 'memory_write']
  check(`registers the expected tools (${mode})`,
    JSON.stringify(names) === JSON.stringify(expectedTools),
    JSON.stringify(names))
  check('every tool has execute()', result.tools.every((t) => t.hasExecute))
  if (mode === 'fork') {
    check('registers the agent/pre-step recall listener',
      listeners.some((l) => l.event === 'agent/pre-step' && typeof l.handler === 'function'),
      JSON.stringify(listeners.map((l) => l.event)))
    check('the pre-step listener is prepended',
      listeners.some((l) => l.event === 'agent/pre-step' && l.options && l.options.prepend === true),
      JSON.stringify(listeners.map((l) => l.options ?? null)))
  }

  check('registers the memory:recall prompt section', sections.length === 1 && sections[0]?.name === 'memory:recall',
    JSON.stringify(sections.map((s) => s?.name)))
  const section = sections[0]
  check('recall section exposes text()', typeof section?.text === 'function')

  // 行为冒烟：write → search → get → forget（在临时库上）
  const tool = (n) => registered.find((t) => t?.name === n)
  const written = await tool('memory_write').execute({ text: 'probe: dsh-memory-local entity smoke', tags: ['Probe', 'probe'], pinned: false })
  const found = await tool('memory_search').execute({ query: 'probe dsh-memory-local' })
  // S2b：只读展开（指针的落点）
  const got = tool('memory_get')
    ? await tool('memory_get').execute({ id: written.id }, { agent: { id: 'probe-session' } })
    : null
  const forgotten = await tool('memory_forget').execute({ id: written.id })
  const sectionTextOnEmpty = sections[0].text()
  result.behavior = {
    writeId: written.id, writeTags: written.tags, writePinned: written.pinned,
    searchHits: found.matches.length, searchFirstId: found.matches[0]?.id ?? null,
    gotText: got ? String(got.text).slice(0, 40) : null,
    gotFound: got ? String(got.text).length > 0 : null,
    forgotten: forgotten.forgotten,
    sectionAfterForget: sectionTextOnEmpty === '' ? 'empty' : 'non-empty',
  }
  check('memory_write returned an id + normalized tags', Number.isInteger(written.id) && written.tags === 'probe',
    JSON.stringify(written))
  check('memory_search finds the freshly written fact', found.matches.length === 1 && found.matches[0].id === written.id,
    JSON.stringify(found.matches.map((m) => m.id)))
  if (mode === 'fork') {
    check('memory_get expands the same record (read-only)',
      Boolean(got) && got.id === written.id && String(got.text).includes('entity smoke') && got.truncated === false,
      JSON.stringify(got))
    check('memory_get reports a missing id instead of throwing',
      JSON.stringify(await tool('memory_get').execute({ id: 999999 })) !== null)
  }
  check('memory_forget deletes it', forgotten.forgotten === true, JSON.stringify(forgotten))
  check('recall section renders empty after the delete', sectionTextOnEmpty === '', JSON.stringify(sectionTextOnEmpty.slice(0, 60)))

  for (const d of disposers) { try { d() } catch { /* dispose best-effort */ } }
  for (const f of [dbFile, `${dbFile}-journal`]) { try { fs.rmSync(f, { force: true }) } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
} catch (error) {
  failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`)
}

result.ok = failures.length === 0
result.failures = failures
console.log(`PROBE: ${JSON.stringify(result)}`)
process.exit(result.ok ? 0 : 1)
