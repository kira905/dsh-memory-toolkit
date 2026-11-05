/**
 * memory-snapshot-fixture.mjs —— 回填器的**夹具写口**（只在 test/ 里被用，不进任何生产路径）
 *
 * 它替代真实的"唯一写口"（`memory-db-tools/memory-snapshot.mjs` —— 那一件属另一个批次，
 * 本仓尚未收录）。所以它**不做归档与台账**，只做两件事：
 *   ① **顺序守卫**：被调用时目标行的 `source_ids` 必须还是空串。若已被写过 ⇒ 说明调用方
 *      "先 UPDATE 再留痕"，直接抛 `E_SNAPSHOT_ORDER`（这正是"先留痕才准改"那条铁律的判据）。
 *   ② 写一行 side-channel 记录（`<home>/memory-shadow/fixture-snapshot-order.jsonl`），
 *      让夹具能断言"写口确实在 UPDATE 之前被调过一次"。
 *
 * 返回值形状与真写口一致：`{ skipped, beforeRef, archiveFile, seq }`。
 * `skipped:true` 在真写口里表示"这条不需要再归档"，调用方**仍须 UPDATE**（本夹具永远返回 false）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const FIXTURE_SNAPSHOT_VERSION = 'fixture-1'

export function snapshotBeforeUpdate(opts = {}) {
  const { db, id, home, reason, dbPath } = opts
  if (!db) {
    const e = new Error('夹具写口：没有 db 连接')
    e.code = 'E_SNAPSHOT_NO_DB'
    throw e
  }
  const row = db.prepare('SELECT source_ids FROM memories WHERE id = ?').get(id)
  const wasEmpty = row ? String(row.source_ids ?? '') === '' : false
  if (!wasEmpty) {
    const e = new Error('夹具写口：被调用时 source_ids 已非空 ⇒ 调用方把顺序做反了（必须先留痕再 UPDATE）')
    e.code = 'E_SNAPSHOT_ORDER'
    throw e
  }
  const base = home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    const dir = path.join(base, 'memory-shadow')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, 'fixture-snapshot-order.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), v: FIXTURE_SNAPSHOT_VERSION, id: Number(id), dbPath: String(dbPath ?? ''), sourceIdsWasEmpty: wasEmpty, reason: String(reason ?? '') })}\n`,
      { encoding: 'utf8', flag: 'a' },
    )
  } catch {
    /* side-channel 写不进不影响主流程（真写口在这个位置也不会因为日志失败而阻断） */
  }
  return { skipped: false, beforeRef: `fixture-snapshot/${Number(id)}.json`, archiveFile: null, seq: 1 }
}

export default { snapshotBeforeUpdate, FIXTURE_SNAPSHOT_VERSION }
