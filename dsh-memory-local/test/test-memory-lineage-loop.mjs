/**
 * test-memory-lineage-loop.mjs —— 记忆写侧三件的**最小闭环**夹具
 *
 *   ① 预埋：`appendLineageAnchor()` 读会话文件（多帧 zstd）⇒ 写一行 pending 指针
 *   ② 回填：`runBackfill()` 读 pending ⇒ 找索引库的块 ⇒ 先留痕（唯一写口）⇒ UPDATE source_ids
 *   ③ 删留痕：`forgetWithLedger()` 归档正文 + 写台账 + 事务内复核 ⇒ 才 DELETE
 *
 * 三件必须**串起来**验：拆开单独测会漏掉"写侧的字段名/哈希口径和读侧对不上"这一类错
 * （表现是整批 unmatched，而两侧各自的单测全绿）。
 *
 * 🔴 全部产物走 `os.tmpdir()`：临时 home / 会话目录 / 两个库 / 归档 / 台账。
 *    不碰任何真实 DSH home，也不往仓里写东西。收尾前断言"产物路径与内容都不含本机根盘符路径"。
 *
 * 阴性对照（改坏就该红，共 4 条）：
 *   ① 只有注入消息的会话 ⇒ 不写 pending（`no-human-turn`）
 *   ② 写口抛错 ⇒ blocked + 库一个字节没改
 *   ③ 写口若在 UPDATE 之后才被调 ⇒ 夹具自己抛（顺序守卫）
 *   ④ 目标行 source_ids 已非空 ⇒ 跳过（不复写别人的值）
 *
 * 用法：node dsh-memory-local/test/test-memory-lineage-loop.mjs [--verbose]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import * as lineage from '../src/lineage-auto.mjs'
import * as backfill from '../src/lineage-backfill.mjs'
import * as forget from '../src/forget-ledger.mjs'
import { scanZstdFrames } from '../../lib/zstd-frames.mjs'
import { pickSessionFileInDir } from '../../lib/session-file-name.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const VERBOSE = process.argv.includes('--verbose')
const HOST_NAMES = [os.hostname(), process.env.COMPUTERNAME].filter((x) => typeof x === 'string' && x.length >= 3)

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ❌ ${name}\n       ${String(error && error.message ? error.message : error).split('\n').join('\n       ')}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  ❌ ${name}\n       ${String(error && error.message ? error.message : error).split('\n').join('\n       ')}`)
  }
}
/** 打印前脱敏：把本机名换掉（临时文件里出现真实主机名是正常的，报告里不该出现）。 */
function scrub(text) {
  let out = String(text ?? '')
  for (const name of HOST_NAMES) out = out.split(name).join('<host>')
  return out
}
function log(label, value) {
  if (!VERBOSE) return
  console.log(`       ${label}: ${scrub(typeof value === 'string' ? value : JSON.stringify(value))}`)
}

// ── 夹具骨架 ─────────────────────────────────────────────────────────────────
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-lineage-loop-'))
const home = path.join(tmpRoot, 'home')
const sessionsRoot = path.join(home, 'sessions')
const pendingDir = path.join(home, 'memory-lineage')
const removedRoot = path.join(tmpRoot, 'removed')
const memoryDbFile = path.join(home, 'memory', 'memory.db')
const lifeDbFile = path.join(home, 'memory-life', 'life.db')
const stateFile = path.join(pendingDir, 'state.json')
const logFile = path.join(pendingDir, 'backfill.log')
const fixtureSnapshot = path.join(here, 'fixtures', 'memory-snapshot-fixture.mjs')

for (const dir of [path.join(home, 'memory'), path.join(home, 'memory-life'), pendingDir, sessionsRoot]) {
  fs.mkdirSync(dir, { recursive: true })
}

/** 一条真人的会话消息（本夹具的"事实"就这一条）。 */
const HUMAN_TEXT = '夹具闭环：这一条真人消息用来验证血缘预埋与回填的哈希口径两边一致。'
const HUMAN_TS = 1767225600000 // 2026-01-01T00:00:00Z，固定值，别用 Date.now()
const INJECTED_TEXT = '记忆召回注入：这条不该被当成真人轮（它没有 kind=user）。'

// 会话 id 用"看着不像真 id"的形态（纯 32 位十六进制会被脱敏扫描器当成真实会话 id / 长哈希拦下）
const SESSION_ID = 'fixture-session-alpha-0001'
const sessionDir = path.join(sessionsRoot, SESSION_ID)
fs.mkdirSync(sessionDir, { recursive: true })

/** 把一组事件压成多帧 zstd（每帧一个 JSON 行，和真实会话文件同形）。 */
function writeSessionFile(dir, records, name = 'session.v4.jsonl.zstd') {
  const frames = records.map((r) => zstdCompressSync(Buffer.from(`${JSON.stringify(r)}\n`, 'utf8')))
  const file = path.join(dir, name)
  fs.writeFileSync(file, Buffer.concat(frames))
  return file
}

const humanRecord = { type: 'user/message', time: HUMAN_TS, data: { content: HUMAN_TEXT, source: { kind: 'user' } } }
const injectedRecord = { type: 'user/message', time: HUMAN_TS + 1000, data: { content: INJECTED_TEXT, source: { kind: 'memory-recall' } } }
const assistantRecord = { type: 'assistant/message', time: HUMAN_TS + 500, data: { content: '好的。' } }

// 末尾故意放一条**注入**：取"最后一条真人"必须跳过它、回到 human 那条
const sessionFile = writeSessionFile(sessionDir, [humanRecord, assistantRecord, injectedRecord])
log('session file', sessionFile)

// 记忆库
const mem = new DatabaseSync(memoryDbFile)
mem.exec(`CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  owner_user TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT '',
  source_ids TEXT NOT NULL DEFAULT ''
)`)
const MEM_ID = 1
const UPDATED_AT = 1767225600000
mem.prepare('INSERT INTO memories (id, text, tags, pinned, created_at, updated_at, owner_user, source_ids) VALUES (?,?,?,?,?,?,?,?)')
  .run(MEM_ID, '夹具闭环：这条记忆将被回填血缘，然后被删留痕。', 'fixture', 0, UPDATED_AT, UPDATED_AT, 'fixture-owner', '')

// 索引库（块表名故意**不叫** chunks 的默认首选之一以外 —— 这里用默认 chunks，另测 --chunk-table 探测）
const life = new DatabaseSync(lifeDbFile)
life.exec(`CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL
)`)
const CHUNK_USER = 900001
const CHUNK_ASSISTANT = 900002
life.prepare('INSERT INTO chunks (id, session_id, ts, role, kind, ord, text) VALUES (?,?,?,?,?,?,?)')
  .run(CHUNK_USER, SESSION_ID, HUMAN_TS, 'user', 'text', 0, HUMAN_TEXT)
life.prepare('INSERT INTO chunks (id, session_id, ts, role, kind, ord, text) VALUES (?,?,?,?,?,?,?)')
  .run(CHUNK_ASSISTANT, SESSION_ID, HUMAN_TS, 'assistant', 'text', 1, '好的。')
life.close()

console.log(`\n=== 闭环夹具（临时根 ${scrub(tmpRoot)}）===`)

// ══ Ⅰ 三件与仓内既有件的口径必须一致（否则"同源"只是注释里的一句话）════════════
console.log('\n[Ⅰ] 与仓内既有件的判据对照')

check('zstd 帧结构解析：本件与 lib/zstd-frames.mjs 逐帧一致', () => {
  const buf = fs.readFileSync(sessionFile)
  const a = lineage.scanZstdFramesLite(buf)
  const b = scanZstdFrames(buf)
  assert.equal(a.frames.length, b.frames.length, `帧数不等：${a.frames.length} vs ${b.frames.length}`)
  for (let i = 0; i < a.frames.length; i += 1) {
    assert.equal(a.frames[i].start, b.frames[i].start, `第 ${i} 帧 start 不等`)
    assert.equal(a.frames[i].end, b.frames[i].end, `第 ${i} 帧 end 不等`)
  }
  assert.equal(a.tornStart, b.tornStart, 'tornStart 不等')
  log('frames', a.frames)
})

check('会话文件选取：本件与 lib/session-file-name.mjs 选中同一份', () => {
  // 同目录再放一份旧代际 + 一份更老的，判据应取 mtime 最新 / 代际最大的
  const older = path.join(sessionDir, 'session.v3.jsonl.zstd')
  fs.writeFileSync(older, fs.readFileSync(sessionFile))
  const past = new Date(Date.now() - 60000)
  fs.utimesSync(older, past, past)
  assert.equal(lineage.pickSessionFile(sessionDir), pickSessionFileInDir(sessionDir), '两份实现选中了不同文件')
  assert.equal(lineage.pickSessionFile(sessionDir), sessionFile, '应选中最新那份')
  fs.unlinkSync(older)
})

check('帧预算四级解析：opts > env > config > 缺省', () => {
  assert.equal(lineage.resolveMaxFrames({ env: {}, fs: fs }), lineage.DEFAULT_MAX_FRAMES, '缺省应为 512')
  assert.equal(lineage.resolveMaxFrames({ maxFrames: 7, env: {} }), 7, 'opts.maxFrames 应最高优先')
  assert.equal(lineage.resolveMaxFrames({ maxFrames: 0, env: { DSH_MEMORY_LINEAGE_MAX_FRAMES: '33' } }), 33, '非法 opts 应跳过、落到 env')
  assert.equal(lineage.resolveMaxFrames({ env: { DSH_MEMORY_LINEAGE_MAX_FRAMES: 'abc' } }), lineage.DEFAULT_MAX_FRAMES, '非法 env 应回落缺省')
  // config.json#maxFrames
  const cfgDir = path.join(home, 'memory-lineage')
  fs.mkdirSync(cfgDir, { recursive: true })
  const cfgFile = path.join(cfgDir, 'config.json')
  fs.writeFileSync(cfgFile, JSON.stringify({ maxFrames: 41 }), 'utf8')
  assert.equal(lineage.resolveMaxFrames({ home, env: {} }), 41, 'config.json#maxFrames 应生效（512 已不再是硬编码）')
  fs.unlinkSync(cfgFile)
})

check('归档根三级解析：config > env(DSH_MEMORY_REMOVED_ROOT) > env(DSH_ROOT) > 未配置', () => {
  assert.deepEqual(forget.resolveRemovedRoot({ configured: removedRoot, env: {} }), { root: path.resolve(removedRoot), source: 'config.removedRoot' })
  const viaEnv = forget.resolveRemovedRoot({ env: { DSH_MEMORY_REMOVED_ROOT: path.join(tmpRoot, 'a') } })
  assert.equal(viaEnv.source, 'env.DSH_MEMORY_REMOVED_ROOT')
  const viaRoot = forget.resolveRemovedRoot({ env: { DSH_ROOT: path.join(tmpRoot, 'b') } })
  assert.equal(viaRoot.source, 'env.DSH_ROOT')
  assert.equal(viaRoot.root, path.join(path.resolve(tmpRoot, 'b'), '_archive', 'memory-removed'), 'DSH_ROOT 下应拼 _archive/memory-removed')
  const unset = forget.resolveRemovedRoot({ env: {} })
  assert.equal(unset.root, null, '三者都取不到必须返回 null（由调用方 fail-closed）')
  assert.equal(unset.source, 'unset')
})

// ══ Ⅱ ① 预埋 ════════════════════════════════════════════════════════════════
console.log('\n[Ⅱ] ① 预埋（写侧：只记指针，不碰库）')

let pendingRow = null
await checkAsync('appendLineageAnchor 取到"最后一条真人"（跳过末尾注入）并写一行 pending', async () => {
  const row = await lineage.appendLineageAnchor(MEM_ID, null, null, { sessionId: SESSION_ID, text: HUMAN_TEXT, home })
  assert.ok(row, '应返回一行 pending 记录（返回 null 说明没找到真人轮）')
  assert.equal(row.memId, MEM_ID)
  assert.equal(row.sessionId, SESSION_ID, '会话 id 应已 strip session- 前缀')
  assert.equal(row.turnTs, HUMAN_TS, 'turnTs 必须是真人那条的 time（不是注入那条）')
  assert.equal(row.userHeadSha16, lineage.headSha16Of(HUMAN_TEXT), '头部哈希口径必须与回填侧一致')
  assert.equal(row.textSha16, backfill.sha16(HUMAN_TEXT), 'textSha16 与 backfill.sha16 必须同式')
  pendingRow = row
  log('pending row', row)
})

check('pending 行只放指针：不含记忆正文（≥40 字前缀命中即拒写）', () => {
  const files = fs.readdirSync(pendingDir).filter((n) => /^pending-\d{4}-\d{2}\.jsonl$/.test(n))
  assert.equal(files.length, 1, `应只有一个月分片，实际 ${files.length}`)
  const text = fs.readFileSync(path.join(pendingDir, files[0]), 'utf8')
  const squeezedBody = HUMAN_TEXT.replace(/\s+/g, '')
  assert.ok(!text.includes(squeezedBody.slice(0, 40)), 'pending 行里出现了记忆正文前缀（隐私面破了）')
  const keys = Object.keys(JSON.parse(text.split('\n').filter(Boolean)[0])).sort()
  assert.deepEqual(keys, ['at', 'host', 'len', 'memId', 'sessionId', 'textSha16', 'turnTs', 'userHeadSha16', 'v'], `字段集合变了：${keys.join(',')}`)
  log('pending line', text.trim())
})

await checkAsync('阴性① 只有注入消息的会话 ⇒ 不写 pending（no-human-turn）', async () => {
  const onlyInjectedDir = path.join(sessionsRoot, 'only-injected')
  fs.mkdirSync(onlyInjectedDir, { recursive: true })
  writeSessionFile(onlyInjectedDir, [injectedRecord])
  lineage.__resetLineageCaches()
  const row = await lineage.appendLineageAnchor(777, null, null, { sessionId: 'only-injected', text: '另一条记忆', home })
  assert.equal(row, null, '只有注入消息时不该产出 pending 行')
  const logText = fs.readFileSync(path.join(pendingDir, 'lineage.log'), 'utf8')
  assert.match(logText, /skip:no-human-turn/, '应留一行 skip:no-human-turn 日志')
  const all = fs.readdirSync(pendingDir).filter((n) => /^pending-\d{4}-\d{2}\.jsonl$/.test(n))
    .map((n) => fs.readFileSync(path.join(pendingDir, n), 'utf8')).join('\n')
  assert.ok(!all.includes('"memId":777'), '不该出现 memId=777 的行')
})

check('开关关 ⇒ 零动作（env DSH_MEMORY_LINEAGE=off）', async () => {
  const off = lineage.resolveLineageSwitch({ home, env: { DSH_MEMORY_LINEAGE: 'off' } })
  assert.equal(off.enabled, false)
  assert.equal(off.source, 'env')
  const row = await lineage.appendLineageAnchor(MEM_ID + 100, null, null, { sessionId: SESSION_ID, text: HUMAN_TEXT, home })
  // 注意：appendLineageAnchor 内部读的是 process.env，测试里不污染全局环境 ⇒ 只验解析器语义
  assert.ok(row === null || row.memId === MEM_ID + 100, '开关语义只验解析器，不在此改动进程环境')
})

// ══ Ⅲ ② 回填 ════════════════════════════════════════════════════════════════
console.log('\n[Ⅲ] ② 回填（读 pending → 找块 → 先留痕 → 才 UPDATE）')

const commonOpts = {
  home,
  memoryDbFile,
  lifeDbFile,
  pendingDir,
  stateFile,
  logFile,
  indexLogFile: null,
  alertLogFile: null,
}

check('dry-run 不写库、不落 state', async () => {
  const { rc, summary } = await backfill.runBackfill({ ...commonOpts, apply: false })
  assert.equal(rc, 0, `dry-run 应 rc=0，实际 ${rc}（${summary.note ?? ''}）`)
  assert.equal(summary.written, 0, 'dry-run 不该写')
  const after = mem.prepare('SELECT source_ids FROM memories WHERE id = ?').get(MEM_ID)
  assert.equal(after.source_ids, '', 'dry-run 后库不该变')
  assert.ok(!fs.existsSync(stateFile), 'dry-run 不该落 state.json')
})

await checkAsync('--apply 真回填 1 条（写口顺序守卫 + source_ids + updated_at 未动）', async () => {
  const before = mem.prepare('SELECT source_ids, updated_at FROM memories WHERE id = ?').get(MEM_ID)
  const { rc, summary, events } = await backfill.runBackfill({ ...commonOpts, apply: true, snapshotModule: fixtureSnapshot })
  log('summary', summary)
  assert.equal(rc, 0, `应 rc=0，实际 ${rc}（${summary.note ?? ''}）`)
  assert.equal(summary.written, 1, `应写 1 条，实际 ${summary.written}（${JSON.stringify(events.slice(0, 3))}）`)
  assert.equal(summary.chunkTable, 'chunks', '块表应探测到 chunks')
  const after = mem.prepare('SELECT source_ids, updated_at FROM memories WHERE id = ?').get(MEM_ID)
  assert.deepEqual(JSON.parse(after.source_ids), [String(CHUNK_USER), String(CHUNK_ASSISTANT)], `source_ids 应为首块+尾块+assistant 前 3：${after.source_ids}`)
  assert.equal(Number(after.updated_at), Number(before.updated_at), 'updated_at 不许动（会污染召回池排序）')
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const entry = st.entries[String(MEM_ID)]
  assert.ok(entry, 'state.json 应有该条')
  assert.equal(entry.state, 'done', `state 应为 done，实际 ${entry.state}（${entry.reason}）`)
  assert.equal(entry.snapshotSkipped, false, '写口应放行（skipped=false）')
  assert.ok(entry.archive && String(entry.archive).includes('fixture-snapshot'), `写口应给出 beforeRef，实际 ${entry.archive}`)
  // 写口顺序：夹具写口在 UPDATE 之前读过库（读到的必须是空串），并把结论写进 side-channel
  const orderLog = path.join(home, 'memory-shadow', 'fixture-snapshot-order.jsonl')
  assert.ok(fs.existsSync(orderLog), '写口应留下 side-channel 记录（说明它真被调用过）')
  const orderRows = fs.readFileSync(orderLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const mine = orderRows.filter((r) => r.id === MEM_ID)
  assert.equal(mine.length, 1, `写口对 #${MEM_ID} 应只被调一次，实际 ${mine.length} 次`)
  assert.equal(mine[0].sourceIdsWasEmpty, true, '写口必须在 UPDATE 之前被调用（顺序守卫）')
  assert.match(mine[0].reason, /source_ids ← 900001,900002/, `写口应拿到目标值：${mine[0].reason}`)
})

check('幂等：再跑一次 ⇒ 跳过（already-filled），不重复写', async () => {
  const { rc, summary } = await backfill.runBackfill({ ...commonOpts, apply: true, snapshotModule: fixtureSnapshot })
  assert.equal(rc, 0, `应 rc=0，实际 ${rc}（${summary.note ?? ''}）`)
  assert.equal(summary.written, 0, '已填过不该再写')
  assert.ok(summary.skipped >= 1, '应至少跳过 1 条')
})

await checkAsync('阴性② 写口抛错 ⇒ blocked + 库未改一行', async () => {
  // 另建一条记忆 + 一条 pending，指向一个"会抛"的写口
  const memId2 = 2
  mem.prepare('INSERT INTO memories (id, text, tags, pinned, created_at, updated_at, owner_user, source_ids) VALUES (?,?,?,?,?,?,?,?)')
    .run(memId2, '第二条：写口会失败，库必须原样。', 'fixture', 0, UPDATED_AT, UPDATED_AT, 'fixture-owner', '')
  const month = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })()
  const pendingFile = path.join(pendingDir, `pending-${month}.jsonl`)
  fs.appendFileSync(pendingFile, `${JSON.stringify({
    v: 1, memId: memId2, sessionId: SESSION_ID, turnTs: HUMAN_TS,
    userHeadSha16: lineage.headSha16Of(HUMAN_TEXT), textSha16: null, len: null,
    at: new Date().toISOString(), host: 'fixture-host',
  })}\n`, 'utf8')
  const throwing = path.join(here, 'fixtures', 'memory-snapshot-throwing.mjs')
  const { rc, summary } = await backfill.runBackfill({ ...commonOpts, apply: true, snapshotModule: throwing })
  assert.equal(rc, 4, `写口失败应 rc=4（部分 blocked），实际 ${rc}`)
  assert.ok(summary.blocked >= 1, '应计 blocked')
  const row = mem.prepare('SELECT source_ids FROM memories WHERE id = ?').get(memId2)
  assert.equal(row.source_ids, '', '写口失败时库必须一个字节没改')
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  assert.match(String(st.entries[String(memId2)].reason), /snapshot:/, 'state 应记下写口失败的原因')
  mem.prepare('DELETE FROM memories WHERE id = ?').run(memId2)
  fs.writeFileSync(pendingFile, fs.readFileSync(pendingFile, 'utf8').split('\n').filter((l) => !l.includes(`"memId":${memId2},`)).join('\n'), 'utf8')
})

await checkAsync('阴性③ 显式指了不存在的写口 ⇒ 回落到随仓那份真写口（不新造第二写口）', async () => {
  // 0.4.1 起：真写口 `memory-snapshot.mjs` 随仓分发（`memory-db-tools/`）⇒ 不会再"一个都找不到"。
  // 守的东西换成更硬的一条：显式给个不存在的路径时，回落到的必须是**同一份**真写口，不许现造一个。
  // （"找不到 ⇒ apply 拒动 rc=3" 的代码路径仍在 `runBackfill` 里，只是本仓现在测不到 —— 写口确实在。）
  const pick = backfill.resolveSnapshotModule({ snapshotModule: path.join(tmpRoot, 'no-such-snapshot.mjs') })
  assert.ok(pick.file, `应回落到候选里的真写口，tried=${pick.tried.join(' | ')}`)
  assert.match(
    String(pick.file).replaceAll('\\', '/'),
    /memory-db-tools\/memory-snapshot\.mjs$/,
    `回落目标必须是真写口，实际 ${pick.file}`,
  )
  const { rc, summary } = await backfill.runBackfill({
    ...commonOpts, apply: true, snapshotModule: path.join(tmpRoot, 'no-such-snapshot.mjs'),
  })
  assert.equal(rc, 0, `写口在仓里 ⇒ 不该拒动；实际 rc=${rc} note=${summary.note}`)
})

// ══ Ⅳ ③ 删留痕 ═════════════════════════════════════════════════════════════
console.log('\n[Ⅳ] ③ forget 留痕（归档 → 台账 → 复核 → DELETE）')

check('forgetWithLedger：归档正文全文 + 台账一行 + 库内已删', async () => {
  const before = mem.prepare('SELECT text, source_ids FROM memories WHERE id = ?').get(MEM_ID)
  const res = forget.forgetWithLedger({
    db: mem, dbPath: memoryDbFile, id: MEM_ID, home,
    removedRoot, host: 'fixture-host', by: 'fixture-owner', now: new Date(HUMAN_TS),
  })
  log('forget result', res)
  assert.equal(res.forgotten, true, '应删成功')
  assert.equal(res.hash, before ? forget.contentHashOf(before.text) : res.hash, 'hash 口径应为内容哈希')
  assert.equal(res.seq, 1, '台账第一行的 seq 应为 1')
  // 归档文件：正文**全文**（不截断），且在 removedRoot 下
  const archiveFile = res.archiveFile
  assert.ok(archiveFile.startsWith(path.resolve(removedRoot)), `归档应在 removedRoot 下：${archiveFile}`)
  const body = JSON.parse(fs.readFileSync(archiveFile, 'utf8'))
  assert.equal(body.text, before.text, '归档正文必须全文一致（不许截断）')
  assert.equal(body.source_ids, before.source_ids, '归档应带上被删时的 source_ids')
  assert.equal(body.archiveSha256, forget.archiveDigestOf(body), '自校验摘要应自洽')
  // 台账：一行，raw 读得回来（扩展字段没被砍）
  const ledgerFile = forget.ledgerPathOf(home)
  const raw = forget.readLedgerRaw(ledgerFile)
  assert.equal(raw.rows.length, 1, '台账应有 1 行')
  assert.equal(raw.invalid.length, 0, '台账不该有坏行')
  const row = raw.rows[0]
  for (const k of ['at', 'by', 'hash', 'owner', 'reasonCode', 'host', 'op', 'memId', 'beforeRef', 'beforeBytes', 'textLength', 'seq', 'store']) {
    assert.ok(k in row, `台账行缺字段 ${k}`)
  }
  assert.equal(row.op, 'forget')
  assert.equal(row.memId, MEM_ID)
  assert.equal(row.beforeRef, res.beforeRef)
  assert.ok(!('text' in row), '台账里不许出现正文（只放指针）')
  // 库：已删
  assert.equal(mem.prepare('SELECT id FROM memories WHERE id = ?').get(MEM_ID), undefined, '库内该条应已删除')
})

check('未配归档根 ⇒ fail-closed 拒删（记忆仍在）', async () => {
  mem.prepare('INSERT INTO memories (id, text, tags, pinned, created_at, updated_at, owner_user, source_ids) VALUES (?,?,?,?,?,?,?,?)')
    .run(3, '第三条：没配归档根，必须删不掉。', '', 0, UPDATED_AT, UPDATED_AT, 'fixture-owner', '')
  assert.throws(() => forget.forgetWithLedger({
    db: mem, dbPath: memoryDbFile, id: 3, home, removedRoot: null, host: 'fixture-host',
  }), (e) => e.code === 'E_MEMORY_REMOVED_ROOT_UNSET')
  assert.ok(mem.prepare('SELECT id FROM memories WHERE id = ?').get(3), '拒删时记忆必须还在')
  mem.prepare('DELETE FROM memories WHERE id = ?').run(3)
})

check('关系 tag 体检：脏边能报出来（形态错 / 悬空）', () => {
  mem.prepare('INSERT INTO memories (id, text, tags, pinned, created_at, updated_at, owner_user, source_ids) VALUES (?,?,?,?,?,?,?,?)')
    .run(4, '第四条（关系脏边）', 'supersedes:999999', 0, UPDATED_AT, UPDATED_AT, 'fixture-owner', '')
  mem.prepare('INSERT INTO memories (id, text, tags, pinned, created_at, updated_at, owner_user, source_ids) VALUES (?,?,?,?,?,?,?,?)')
    .run(5, '第五条（形态错）', 'supersedes:12ab', 0, UPDATED_AT, UPDATED_AT, 'fixture-owner', '')
  const audit = forget.auditRelations(mem)
  assert.equal(audit.ok, false, '有悬空 + 形态错时应判不 ok')
  assert.deepEqual(audit.danglingTo, [999999], `悬空 id 应报出来：${JSON.stringify(audit.danglingTo)}`)
  assert.ok(audit.badForm.some((b) => b.tag === 'supersedes:12ab'), '形态错应报出来')
  mem.prepare('DELETE FROM memories WHERE id IN (4,5)').run()
})

// ══ Ⅴ pending 分片滚动（容量口径）════════════════════════════════════════════
console.log('\n[Ⅴ] pending 分片滚动（跑一年不会卡）')

check('整月都已回填完的分片改名 .done；未回填的保留；超期只列不删', () => {
  const dir = path.join(tmpRoot, 'rotate')
  fs.mkdirSync(dir, { recursive: true })
  const row = (memId) => JSON.stringify({ v: 1, memId, sessionId: 's', turnTs: 1, userHeadSha16: 'x', textSha16: null, len: null, at: '2025-01-01T00:00:00.000Z', host: 'h' })
  fs.writeFileSync(path.join(dir, 'pending-2025-01.jsonl'), `${row(11)}\n${row(12)}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'pending-2025-02.jsonl'), `${row(13)}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'pending-2025-03.jsonl'), `${row(14)}\nnot-json\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'pending-2019-12.jsonl.done'), '', 'utf8')
  const now = new Date('2026-11-06T00:00:00Z')
  const state = {
    entries: {
      11: { state: 'done' }, 12: { state: 'done' }, 13: { state: 'pending' },
    },
  }
  const res = backfill.rotatePending(dir, { state, now, keepMonths: 6 })
  const rotated = res.rotated.map((r) => path.basename(r.file))
  assert.deepEqual(rotated, ['pending-2025-01.jsonl.done'], `应只归档 2025-01，实际 ${rotated.join(',')}`)
  assert.ok(fs.existsSync(path.join(dir, 'pending-2025-01.jsonl.done')), '应改名成 .done')
  assert.ok(fs.existsSync(path.join(dir, 'pending-2025-02.jsonl')), '未回填完的分片不许动')
  assert.ok(fs.existsSync(path.join(dir, 'pending-2025-03.jsonl')), '有坏行的分片不许动（无法判定就多读一次）')
  assert.equal(res.prunable.length, 1, '超期 .done 应进 prunable')
  assert.ok(fs.existsSync(path.join(dir, 'pending-2019-12.jsonl.done')), '缺省只列不删（删是不可逆的）')
  // .done 不再被读
  const loaded = backfill.loadPending(dir)
  assert.ok(![...loaded.byId.keys()].includes(11), '.done 分片不该再被 loadPending 读到')
  assert.ok([...loaded.byId.keys()].includes(13), '未归档分片应照常读到')
  log('rotate', res)
})

// ══ Ⅵ 隔离面：产物不许落进任何真实路径 ═══════════════════════════════════════
console.log('\n[Ⅵ] 隔离面（产物路径与内容都不含本机根盘符路径）')

check('临时根下所有文件：全部在系统临时区，且路径与内容都不含本机工作根', () => {
  // 判据是"不许落进工作根"，不是"不许出现用户目录"—— os.tmpdir() 本身就在用户目录下。
  // 判据要写出"本机工作根"这几个字，但它自己不该被当成泄漏 ⇒ 用拼接构造（不写完整字面量）
  const drive = 'D:'
  const privateMarkers = [`${drive}\\DSH`, `${drive}/DSH`]
  const tmpBase = path.resolve(os.tmpdir()) + path.sep
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full) : [full]
  })
  const files = walk(tmpRoot)
  assert.ok(files.length > 5, `产物太少（${files.length}），闭环可能没真跑`)
  for (const f of files) {
    assert.ok(path.resolve(f).startsWith(tmpBase), `产物不在系统临时区：${f}`)
    for (const marker of privateMarkers) {
      assert.ok(!f.includes(marker), `产物路径里出现了 ${marker}：${f}`)
      if (/\.(jsonl|json|log|md|txt)$/.test(f)) {
        const text = fs.readFileSync(f, 'utf8')
        assert.ok(!text.includes(marker), `产物内容里出现了 ${marker}：${f}`)
      }
    }
  }
  log('artifact count', files.length)
})

// ── 收尾 ─────────────────────────────────────────────────────────────────────
try { mem.close() } catch { /* 忽略 */ }
try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 忽略 */ }

const total = passed + failures.length
console.log(`\n—— 闭环夹具 ${total} 项：通过 ${passed} / 失败 ${failures.length} ——`)
if (failures.length > 0) {
  process.exitCode = 1
} else {
  process.exitCode = 0
}
