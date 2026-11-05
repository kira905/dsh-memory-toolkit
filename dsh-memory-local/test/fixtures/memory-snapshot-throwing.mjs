/**
 * memory-snapshot-throwing.mjs —— **阴性对照**用的写口（只在 test/ 里被用）
 *
 * 它永远抛 `E_SNAPSHOT_FIXTURE_DENY`，用来验：
 *   写口拒绝 ⇒ 回填器必须计 `blocked`、**库一个字节没改**（fail-closed），而不是"当作没留痕也照写"。
 */
export function snapshotBeforeUpdate() {
  const e = new Error('阴性对照：写口拒绝（这条不许写库）')
  e.code = 'E_SNAPSHOT_FIXTURE_DENY'
  throw e
}

export default { snapshotBeforeUpdate }
