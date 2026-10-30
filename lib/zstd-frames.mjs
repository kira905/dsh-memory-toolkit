// 多帧 zstd 日志的拆帧器（按帧结构解析，不靠搜魔数）。
//
// 会话日志是一个帧接一个帧追加出来的：一帧大约对应一次 flush 的那批事件。
// 想只取尾部若干帧、或者要逐帧解压，第一步就得把这一整块缓冲切成帧边界。
//
// 做法：读到 magic → 读帧头描述符（里面塞着字典 id、内容长度的宽度）→ 一帧一帧读 block
// （block type 3 是保留值，见着就停）→ 有校验位就再跳 4 字节。任何一步拿不够字节就
// 判定"撕裂"，把该帧起点交回去；**不猜长度，也不把半截字节凑成完整帧**。
//
// 为什么不用"搜魔数 + 游标推进"：压缩后的字节流里可能正好出现 magic 的字节序列，
// 那种做法会把一帧劈成两半；而且每份实现各写一套，改了一处另一处不跟，缺陷就会
// 隔一段时间冒一次。宁可多写几十行结构解析。
//
// 边界说明：这里只负责切，不负责解压（解压由调用方用平台自带的 zstd 解）。
// 另一份同样的算法存在于归档插件内部 —— 部署时插件只能带走自己目录里的文件，
// 所以两边各留一份实现，靠一致性单测对齐帧边界；要改算法就两边一起改、让单测过。

/** zstd 帧魔数（小端读出来的 32 位值） */
export const ZSTD_MAGIC = 4247762216;

const MAGIC_BYTES = 4;
const DESCRIPTOR_BYTES = 1;
const BLOCK_HEADER_BYTES = 3;
const CHECKSUM_BYTES = 4;
const BLOCK_TYPE_RESERVED = 3;
const BLOCK_TYPE_RLE = 1;

/**
 * 解析单帧，返回它的结束偏移。
 * @param {Buffer} buffer
 * @param {number} from 帧起点
 * @returns {{end:number}|null} null = 这帧不完整（或魔数对不上），由调用方记为撕裂点
 */
function parseFrameAt(buffer, from) {
  if (buffer.length - from < MAGIC_BYTES) return null;
  if (buffer.readUInt32LE(from) !== ZSTD_MAGIC) return null;

  let at = from + MAGIC_BYTES;
  if (at === buffer.length) return null;

  const descriptor = buffer.readUInt8(at);
  at += DESCRIPTOR_BYTES;
  // 描述符里第 3、4 位保留，非零说明不是我们认识的帧头
  if ((descriptor & 0b1_1000) !== 0) return null;

  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0b10_0000) !== 0;
  const hasChecksum = (descriptor & 0b100) !== 0;
  const dictionaryFlag = descriptor & 0b11;
  const dictionaryBytes = dictionaryFlag === 0b11 ? 4 : dictionaryFlag;
  // 单段帧不写 window descriptor；内容长度字段按 flag 给出的宽度（flag 0 时单段帧占 1 字节）
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  const windowBytes = singleSegment ? 0 : 1;

  at += windowBytes + dictionaryBytes + contentSizeBytes;
  if (at > buffer.length) return null;

  for (;;) {
    if (buffer.length - at < BLOCK_HEADER_BYTES) return null;
    const blockHeader = buffer.readUIntLE(at, BLOCK_HEADER_BYTES);
    at += BLOCK_HEADER_BYTES;

    const isLastBlock = (blockHeader & 0b1) !== 0;
    const blockType = (blockHeader >>> 1) & 0b11;
    const blockSize = blockHeader >>> 3;
    if (blockType === BLOCK_TYPE_RESERVED) return null;

    // RLE 块整块只有 1 个字节在流里，长度由 blockSize 说；其余类型的长度就是 blockSize
    at += blockType === BLOCK_TYPE_RLE ? 1 : blockSize;
    if (at > buffer.length) return null;
    if (isLastBlock) break;
  }

  if (hasChecksum) {
    at += CHECKSUM_BYTES;
    if (at > buffer.length) return null;
  }
  return { end: at };
}

/**
 * 扫出一整块缓冲里的完整帧。
 * @param {Buffer} buffer
 * @returns {{frames: {start:number,end:number}[], tornStart: number|undefined}}
 *   frames    —— 完整帧的 [start, end) 区间，顺序同文件内顺序；
 *   tornStart —— 第一处不完整帧的起点（没有则 undefined）。调用方遇到它就停：
 *                撕裂的那帧整体丢弃，绝不能把残字节当完整帧去解压。
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const parsed = parseFrameAt(buffer, cursor);
    if (!parsed) return { frames, tornStart: cursor };
    frames.push({ start: cursor, end: parsed.end });
    cursor = parsed.end;
  }
  return { frames, tornStart: undefined };
}
