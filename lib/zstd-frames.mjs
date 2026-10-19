// zstd-frames.mjs —— zstd 多帧日志「拆帧」的 **CLI 侧唯一源**（严格结构解析）。
//
// 用途：会话日志（`session.jsonl.zstd` / `session.v3.jsonl.zstd`）是**多帧**追加写的
//   —— 一帧 ≈ 一次 flush 的一批事件。要取「尾部 N 帧」或「全部帧」，就得先把多帧缓冲切成逐帧。
//
// 算法（严格结构解析，**不吃"魔数搜索"那套启发式**）：
//   ZSTD magic（0xFD2FB528 LE）→ frame header descriptor（含 dictionary / content-size 字段宽度）
//   → block 循环（block type 3 = reserved ⇒ 断）→ optional 4 字节 checksum；
//   遇**不完整帧**返回 `tornStart`（该帧起点），**不猜长度、也不把残字节当完整帧**。
//   对比"魔数搜索 + 游标推进"启发式的两个弱点：
//     ① 压缩数据里**恰好出现 zstd magic 字节序列**时会把一帧切成两半（本件靠帧结构解析不会）；
//     ② 多份实现各自演化 ⇒ 一处修另一处不跟（2026-09-29 的「隔帧取样」缺陷族就是这么来的）。
//
// 三条必读：
//   ① **本件是 CLI 侧唯一源**（2026-09-29 卡「归档帧扫描同源化」建立）：`tools\archive-card-sessions.mjs`
//      与 `tools\archive-inactive-sessions.mjs` 的 **6 处**拆帧点（tailTypes / readSessionMeta / framesOf、
//      tailState / allTypes / framesOf）全部消费本件。原魔数搜索实现已删除。
//   ② 与插件侧 `tools\dsh-archive-sessions\lib\zstd-frame-rewrite.mjs#scanZstdFrames` **同源但不是同一
//      文件**：插件部署时只同步插件目录 ⇒ 插件**不能 import 插件目录外的文件**（CLI 侧也不该反向依赖
//      插件目录 = 跨包部署边界）。两份实现靠 `tools\_test\test-archive-framescan.mjs` 的**一致性单测**
//      守住：两文件并排跑同一批样本（含魔数字节样本 / 撕裂帧样本 / 生产形态样本），帧边界必须逐帧相同。
//      ⇒ **禁再抄第三份**：要改算法，先改这两份并让一致性单测过。
//   ③ 与本件同算法的另两份**历史副本**（`tools\archive-meta-backfill.mjs` 约 L169 /
//      `tools\projcache-restore-archived.mjs` 约 L64 各自的内联版：无 tornStart、撕裂即 break）
//      **登记为待收口** —— 它们属其它卡的产物，本件建立时**未动**，留给后续卡（避免与在途改动互相踩）。

export const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 LE

/**
 * 扫描 zstd 多帧边界（严格帧结构解析；与插件侧 scanZstdFrames 逐行同源）。
 * @param {Buffer} buffer 整个多帧缓冲（调用方负责截断/切片）
 * @returns {{frames: {start:number,end:number}[], tornStart: number|undefined}}
 *   frames    —— **完整帧**的 [start, end) 区间，顺序即文件内顺序；
 *   tornStart —— 第一个**不完整**帧的起点（没有 = undefined）。调用方须"遇撕裂不猜"：
 *                撕裂帧一律丢弃，绝不把残字节当完整帧去解。
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, tornStart: start }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, tornStart: start }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tornStart: undefined }
}
