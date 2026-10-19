/**
 * test-adapter-converge.mjs —— U3「adapter 接入」收敛点的**可证伪**用例（2026-09-22）。
 *
 * 为什么要有它：收敛（裸字面量 → 适配层常量）本身是"值恒等"的机械替换，最容易出的不是
 * 逻辑错，而是**无声失准**——适配层某条常量被改错值、或 `lib/` 副本过期（build 覆盖 / 同步器没跑），
 * 两者都不会让任何功能测试变红，只会在生产上表现为"判据悄悄变了"。
 * 所以这里断言的是**值本身**，而不是"函数返回了 truthy"：
 *   ① 适配层副本里 SVC.* / EV.* 的值必须等于主包真名（改错值 → 红）
 *   ② fork 真正消费出来的值（`inject` 数组 / injector 的判据常量）必须与主包真名一致（改错取值 → 红）
 *   ③ `src/` 与 `lib/` 两份副本的**正文逐字节一致**、且头部记录的 sourceSha256 等于唯一源实际 sha
 *      （副本过期 / build 把 src 那份拷进 lib 覆盖掉 lib 头 → 红；2026-09-22 实测踩过这一形态）
 *
 * 跑法：node --test test/test-adapter-converge.mjs
 *
 * ⚠️ 命名形态：`test-*.mjs`（而不是 `*.test.mjs`）—— 本文件断言的就是"主包真名"本身，
 *    字面量是**判据**，无法也不需要收敛（用常量断言常量 = 自证、不可证伪）；
 *    而 R4 判定器（方案 §3.5）的白名单只豁免 `_test/` 与 `test-*.mjs` 两种测试夹具形态
 *    （`test/` 目录本身不在白名单里）。取名 `test-*` 是**走既有合法形态**，不是改判定口径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC_COPY = path.join(ROOT, 'src', 'host-adapter.js')
const LIB_COPY = path.join(ROOT, 'lib', 'host-adapter.js')
/** 唯一源：<workspace>\tools\lib\host-adapter.mjs（从包位置反推，跨机不写死盘符）。 */
const SOURCE = path.resolve(ROOT, '..', 'lib', 'host-adapter.mjs')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
/** 去掉生成头（`══ END HEADER ══` 之后才是正文）。 */
const bodyOf = (text) => {
  const marker = '══ END HEADER ══'
  const i = text.indexOf(marker)
  return i < 0 ? text : text.slice(i + marker.length)
}
/**
 * 剥掉行内注释之后的部分 —— **与 R4 判定器同口径**（`check-decoupling.mjs:129` 也是这么做的）。
 * 不加这一步会把"注释里引述原字面量"误判成违规（本文件首跑就踩到）。
 */
const stripComments = (text) =>
  text.split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l }).join('\n')
/** 头部里的 `// sourceSha256: <hex>` 行。 */
const sourceShaOf = (text) => (text.match(/^\/\/ sourceSha256: ([0-9a-f]{64})$/m) ?? [])[1] ?? null

const srcText = fs.readFileSync(SRC_COPY, 'utf8')
const libText = fs.readFileSync(LIB_COPY, 'utf8')
const srcMod = await import(pathToFileURL(SRC_COPY).href)
const libMod = await import(pathToFileURL(LIB_COPY).href)

// ── ① 适配层常量的值（改错值 → 红） ────────────────────────────────────────────
test('① SVC.* 的值 == 主包 ctx 服务真名', () => {
  assert.equal(srcMod.SVC.tools, 'tools')
  assert.equal(srcMod.SVC.systemPrompt, 'systemPrompt')
  // fork 只用这两个服务；表里多出来的键不在此断言（唯一源自检 test-host-adapter.mjs 负责全表）
})

test('① EV.* 的值 == 主包事件真名', () => {
  assert.equal(srcMod.EV.USER_MESSAGE, 'user/message')
})

test('① 常量表是冻结的（防运行期被就地改）', () => {
  assert.equal(Object.isFrozen(srcMod.SVC), true)
  assert.equal(Object.isFrozen(srcMod.EV), true)
})

// ── ② fork 真消费出来的值（取值方式写错 → 红） ─────────────────────────────────
test('② inject 声明的取值来自适配层常量，且两值合起来就是 ["tools","systemPrompt"]', () => {
  // 为什么不 import lib/index.js：本包在 tools\ 下没有 node_modules，宿主依赖
  // （@deepseek-ai/schemastery 等）只有部署位置才解析得到 —— "真加载后 inject 是什么"
  // 由部署侧探针 test/probe-entity.mjs 断言（那是它的本职），这里守源码形状 + 常量真值。
  const text = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8'))
  assert.match(text, /const inject = \[SVC\.tools, SVC\.systemPrompt\]/)
  assert.deepEqual([srcMod.SVC.tools, srcMod.SVC.systemPrompt], ['tools', 'systemPrompt'])
})

test('② injector 判据消费的事件名 == "user/message"', async () => {
  // 从源码消费点读：injector.mjs 里的判据常量就是 EV.USER_MESSAGE（此处断言其真值）
  const injectorText = fs.readFileSync(path.join(ROOT, 'src', 'injector.mjs'), 'utf8')
  assert.match(injectorText, /ev\.type !== EV\.USER_MESSAGE/, 'injector 判据应走适配层常量')
  assert.equal(srcMod.EV.USER_MESSAGE, 'user/message')
})

test('② 源码里不再有收纳点位的裸字面量（剥注释后）', () => {
  const files = [
    path.join(ROOT, 'src', 'index.js'),
    path.join(ROOT, 'src', 'injector.mjs'),
    path.join(ROOT, 'lib', 'index.js'),
    path.join(ROOT, 'lib', 'injector.mjs'),
    path.join(ROOT, 'test', 'fixtures-s2b.mjs'),
    path.join(ROOT, 'test', 'probe-entity.mjs'),
  ]
  for (const f of files) {
    const t = stripComments(fs.readFileSync(f, 'utf8'))
    assert.doesNotMatch(t, /['"]user\/message['"]/, `${path.basename(f)} 仍有裸事件名字面量`)
    assert.doesNotMatch(t, /\[\s*["']tools["']\s*,\s*["']systemPrompt["']\s*\]/, `${path.basename(f)} 仍有裸 inject 字面量`)
  }
})

// ── ③ 副本新鲜度 / 分叉（副本过期或 build 覆盖 → 红） ───────────────────────────
test('③ src/ 与 lib/ 两份副本正文逐字节一致（仅生成头不同）', () => {
  assert.equal(bodyOf(srcText), bodyOf(libText))
})

test('③ 两份副本头部记录的 sourceSha256 相互一致', () => {
  const a = sourceShaOf(srcText)
  const b = sourceShaOf(libText)
  assert.ok(a && b, '副本头缺 sourceSha256 行 —— 是否被手工改过/被 build 覆盖？')
  assert.equal(a, b)
})

test('③ 副本与唯一源一致（唯一源缺失时跳过——它随仓 3 同步，本包可被单独拷走）', (t) => {
  if (!fs.existsSync(SOURCE)) return t.skip(`唯一源不可达：${SOURCE}`)
  const srcSha = sha256(fs.readFileSync(SOURCE))
  assert.equal(sourceShaOf(srcText), srcSha, 'src 副本过期 —— 跑宿主侧 sync-host-adapter.mjs')
  assert.equal(sourceShaOf(libText), srcSha, 'lib 副本过期 —— 跑宿主侧 sync-host-adapter.mjs')
})

test('③ 两份副本导出的接口面相同（防只同步其中一份导致行为分叉）', () => {
  const keysOf = (m) => Object.keys(m).sort()
  assert.deepEqual(keysOf(srcMod), keysOf(libMod))
})
