// lineage-auto.mjs —— 记忆「观察血缘」的**写侧预埋**（只读会话文件 + 只写旁挂日志）
//
// 一句话：`memory_write` 落库之后，把「这条记忆是在**哪一轮对话**里写下的」预埋进一行 pending 日志；
// 之后由回填器（`lineage-backfill.mjs`）拿着这一行的 `(sessionId, turnTs, userHeadSha16)` 去索引库里
// 认回原文块，写进 `memories.source_ids`。**写侧只记指针、不碰库**，所以它不会拖慢也不影响写入。
//
// ── 本件干什么（三件，不多干）─────────────────────────────────────────────────
//   ① resolveSessionDir()  会话 id ⇒ 会话目录（裸 uuid / `session-` 前缀 / 扫 workspace 三种形态都认）
//   ② resolveTurnAnchor()  只读会话文件（多帧 zstd）⇒ 最后一条**真人** `user/message` 的
//                          `(time, 前 200 字 sha16)` —— 判据与索引器的「取轮」实现必须同解，
//                          否则 `(session_id, ts)` 这一对永远配不上（配不上的表现是整批 unmatched）
//   ③ appendPending()      往 `<home>/memory-lineage/pending-<YYYY-MM>.jsonl` 追加**一行只放指针**的记录
//   对外唯一入口：appendLineageAnchor(memId, exec, config, note) —— **异步、永不 reject、fail-open**
//
// ── 六条硬约束（改这段不许破）────────────────────────────────────────────────
//   ① **零库**：绝不 import 任何 sqlite 包 / 不打开任何 `.db` —— 本件只读会话文件、只写自己的旁挂日志；
//   ② **不阻塞回合**：readFile / zstd 解压全走异步，调用方**不 await**；
//   ③ **过期即丢**：解析前后各 stat 一次，文件又长了 ⇒ 丢弃这次结果（不写 pending、不写句柄），
//      等下一次 `memory_write` 再取 —— 这比任何"超时"都简单可靠；
//   ④ **只放指针**：日志行只许有 memId / sessionId / ts / hash / len；落盘前自检「记忆正文 ≥40 字前缀
//      是否出现在行里」，命中即**拒写**；
//   ⑤ **fail-open**：任何异常 / 找不到会话文件 / 取不到真人消息 ⇒ 吞掉，只留一行 `lineage.log`；
//      **绝不影响记忆写入、绝不改 `source_ids` 的现有语义**（不传仍是空串）；
//   ⑥ **零 schema 变更**：不碰 `memories` 表、不碰任何版本键、不改任何 SQL 字面量。
//
// ── zstd 读法 ────────────────────────────────────────────────────────────────
//   本件自带**尾部帧结构解析最小实现**（`scanZstdFramesLite`）：只做结构切帧、**不整文件解压**，
//   从文件尾部往前逐帧解，拿到"最后一条真人消息"就停。
//   为什么不 import 仓内 `lib/zstd-frames.mjs`：本件会被部署进宿主的 `node_modules`（插件实体目录），
//   从那里往上找仓内 `lib/` 会断链（换机 / 单独装子包就 Cannot find module）。
//   ⚠️ 算法与仓内 `lib/zstd-frames.mjs#scanZstdFrames` 同源：**改算法两处同步**，
//      仓内夹具 `test/test-memory-lineage-loop.mjs` 会拿同一段 buffer 对两份实现做逐字段对照。
//
// ── 开关（缺省 on）──────────────────────────────────────────────────────────
//   `DSH_MEMORY_LINEAGE=off`（或 0/false/no）⇒ 整段零动作；
//   `<home>/memory-lineage/config.json` 的 `{"enabled": false}` ⇒ 同样关（env 优先）。
//   帧预算：`note.maxFrames` > env `DSH_MEMORY_LINEAGE_MAX_FRAMES` > `config.json#maxFrames` > 512。
//
// ── 谁调用它 ────────────────────────────────────────────────────────────────
//   宿主插件的 `memory_write.execute`：落库拿到 `record.id` **之后** fire-and-forget 调一次。
//   本件不注册工具、不改召回渲染、不进 `memory_search` / `memory_get` 输出。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { zstdDecompress } from "node:zlib";

/** 件版本（报告 / 夹具 / 运维用；不进任何判据）。 */
export const LINEAGE_AUTO_VERSION = "2b-P1-1";

/** pending 日志目录名（在 `<home>` 下）。 */
export const LINEAGE_DIR_NAME = "memory-lineage";
/** 开关文件 / 日志 / 状态文件名。 */
export const LINEAGE_CONFIG_FILE = "config.json";
export const LINEAGE_LOG_FILE = "lineage.log";
/** 帧预算的 env 名（把 512 从硬编码提成可配）。 */
export const MAX_FRAMES_ENV = "DSH_MEMORY_LINEAGE_MAX_FRAMES";

/** 尾部帧回溯上限（缺省）：实测最大的几个会话「最后一条真人消息回退帧数」中位 33 / 最大 161 ⇒ 512 有 3 倍余量。 */
export const DEFAULT_MAX_FRAMES = 512;
/** 尾部追加（`size` 变大）时的重读上限 —— 竞争只降级、最多重试 2 次。 */
const MAX_STALE_RETRY = 2;
/** 隐私自检的前缀长度（日志行里出现记忆正文 ≥40 字前缀即拒写）。 */
export const PRIVACY_PREFIX_CHARS = 40;
/** 会话文件的世代判据（认任意 vN）。 */
const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;
/** zstd 帧魔数（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = 4247762216;

// ── 进程内缓存（会话坐标 / 开关文件）──────────────────────────────────────────
/** `${home}|${sessionId}` → `{ size, mtimeMs, anchor }`。命中 = 0 ms。 */
const anchorCache = new Map();
/** 开关文件按 `(mtimeMs,size)` 缓存；改一下 `config.json` 下一次写就生效。 */
const configCache = new Map();

/** 夹具 / 排障用：清空进程内缓存（生产路径没人调它）。 */
export function __resetLineageCaches() {
	anchorCache.clear();
	configCache.clear();
}

// ── 小工具 ───────────────────────────────────────────────────────────────────
/** home 解析（`opts.home` > `DSH_HOME` > `~/.dsh`）。 */
export function resolveLineageHome(opts = {}) {
	const override = opts.home;
	if (override) return path.resolve(String(override));
	const env = process.env.DSH_HOME;
	if (env && String(env).trim()) return path.resolve(String(env).trim());
	return path.join(os.homedir(), ".dsh");
}

/** 统一口径的会话 id（落日志时 **strip `session-` 前缀**，与索引库的会话主键对齐）。 */
export function normalizeSessionId(raw) {
	const s = String(raw ?? "").trim();
	if (!s) return "";
	return s.replace(/^session-/, "");
}

/** sha256 十六进制前 16 位。 */
function sha16(text) {
	return createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 16);
}

/** 空白压缩（隐私自检与「前 200 字」都按去空白口径）。 */
function squeeze(text) {
	return String(text ?? "").replace(/\s+/g, "");
}

/**
 * 真人消息的「前 200 字（去空白）sha16」—— 回填时的机器判据。
 * 取前 200 字而不是全文：消息超 1,200 字被切块时，第一块开头仍是这 200 字。
 */
export function headSha16Of(text) {
	return sha16(squeeze(text).slice(0, 200));
}

/** 一条 `user/message` 的正文（`data.content` 既可能是字符串也可能是 `[{type:'text',text}]`）。 */
function userTextOf(record) {
	const content = record?.data?.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

// ── ① 开关解析 ───────────────────────────────────────────────────────────────
/**
 * 开关解析（**纯读**，永不抛）。
 * 顺序：env `DSH_MEMORY_LINEAGE` 优先（off/0/false/no ⇒ 关；其它非空值 ⇒ 开）→ `config.json#enabled`（缺省开）。
 * @param {{home?:string, env?:object, fs?:object, useCache?:boolean}} [opts]
 * @returns {{enabled:boolean, source:"env"|"config"|"default"|"config-error"}}
 */
export function resolveLineageSwitch(opts = {}) {
	const envBag = opts.env ?? process.env;
	const envRaw = String(envBag?.DSH_MEMORY_LINEAGE ?? "").trim();
	if (envRaw) return { enabled: !/^(0|false|off|no)$/i.test(envRaw), source: "env" };
	const fsImpl = opts.fs ?? fs;
	const cfgPath = path.join(resolveLineageHome(opts), LINEAGE_DIR_NAME, LINEAGE_CONFIG_FILE);
	try {
		const st = fsImpl.statSync(cfgPath);
		const key = `${st.mtimeMs}|${st.size}`;
		const hit = opts.useCache === false ? null : configCache.get(cfgPath);
		if (hit && hit.key === key) return { enabled: hit.enabled, source: hit.source };
		const parsed = JSON.parse(fsImpl.readFileSync(cfgPath, "utf8"));
		// 只有**显式 false** 才算关；文件缺 enabled / 写别的值 ⇒ 维持缺省开（fail-open，缺省关等于没做）。
		const enabled = parsed?.enabled !== false;
		configCache.set(cfgPath, { key, enabled, source: "config" });
		return { enabled, source: "config" };
	} catch (error) {
		// 文件不存在 / 读坏了 ⇒ 缺省开；但它不是"config 关"，source 如实标注。
		return { enabled: true, source: error?.code === "ENOENT" ? "default" : "config-error" };
	}
}

/** 便捷布尔版。 */
export function lineageEnabled(opts = {}) {
	return resolveLineageSwitch(opts).enabled;
}

// ── ①b 帧预算解析（把 512 从硬编码提成可配）─────────────────────────────────────
/**
 * 尾部帧回溯预算（`maxFrames`）。四级：`opts.maxFrames` > env `DSH_MEMORY_LINEAGE_MAX_FRAMES`
 * > `config.json#maxFrames` > {@link DEFAULT_MAX_FRAMES}。非法值（≤0 / 非数）一律跳过错，不抛。
 * @param {{maxFrames?:number|string, home?:string, env?:object, fs?:object}} [opts]
 * @returns {number} 正整数
 */
export function resolveMaxFrames(opts = {}) {
	const asBudget = (value) => {
		const n = Number(value);
		return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
	};
	const explicit = asBudget(opts.maxFrames);
	if (explicit !== null) return explicit;
	const envBag = opts.env ?? process.env;
	const fromEnv = asBudget(String(envBag?.[MAX_FRAMES_ENV] ?? "").trim());
	if (fromEnv !== null) return fromEnv;
	try {
		const cfgPath = path.join(resolveLineageHome(opts), LINEAGE_DIR_NAME, LINEAGE_CONFIG_FILE);
		const parsed = JSON.parse((opts.fs ?? fs).readFileSync(cfgPath, "utf8"));
		const fromCfg = asBudget(parsed?.maxFrames);
		if (fromCfg !== null) return fromCfg;
	} catch {
		/* 没配置文件 ⇒ 用缺省 */
	}
	return DEFAULT_MAX_FRAMES;
}

// ── ② 会话目录定位（三种形态都认）────────────────────────────────────────────
function isDirectory(fsImpl, p) {
	try {
		return fsImpl.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 会话 id ⇒ 会话目录。
 * 三种形态（历史会话里裸 uuid 与带 `session-` 前缀的两种都存在 ⇒ 两种都得认）：
 *   ① `<root>/<raw>`（扁平形态 / 裸 uuid / 夹具直接用绝对路径）
 *   ② `<root>/<session-raw>`
 *   ③ 扫 `<root>/*`（workspace 桶）里的同名子目录
 * 🔴 **找目录时不拼不剥**：`raw` 与 `session-<raw>` 两路都试；落日志时才 strip（见 `normalizeSessionId`）。
 * @returns {{dir:string, name:string, via:"abs"|"flat"|"scan", matched:"raw"|"prefixed"}|null}
 */
export function resolveSessionDir(sessionId, opts = {}) {
	const raw = String(sessionId ?? "").trim();
	if (!raw) return null;
	const fsImpl = opts.fs ?? fs;
	// ⓪ 调用方直接给了目录（夹具 / 命令行复用）
	if (path.isAbsolute(raw) && isDirectory(fsImpl, raw)) return { dir: raw, name: path.basename(raw), via: "abs", matched: "raw" };
	const root = opts.sessionsRoot ? path.resolve(String(opts.sessionsRoot)) : path.join(resolveLineageHome(opts), "sessions");
	const names = [{ name: raw, matched: "raw" }];
	if (!raw.startsWith("session-")) names.push({ name: `session-${raw}`, matched: "prefixed" });
	for (const candidate of names) {
		const dir = path.join(root, candidate.name);
		if (isDirectory(fsImpl, dir)) return { dir, name: candidate.name, via: "flat", matched: candidate.matched };
	}
	let buckets = [];
	try {
		buckets = fsImpl
			.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return null;
	}
	for (const bucket of buckets) {
		for (const candidate of names) {
			const dir = path.join(root, bucket, candidate.name);
			if (isDirectory(fsImpl, dir)) return { dir, name: candidate.name, via: "scan", matched: candidate.matched };
		}
	}
	return null;
}

/**
 * 会话目录里"当前那份"会话文件（多世代并存取法：mtime 新 > 代际大 > 名字典序小）。
 * 同序判据与仓内 `lib/session-file-name.mjs#rankSessionFilesInDir` 一致；本件不 import 它（理由同上文"包外断链"），
 * 故内联这一小段 —— 两处判据由夹具对照守着。
 * @returns {string|null} 绝对路径
 */
export function pickSessionFile(dir, opts = {}) {
	const fsImpl = opts.fs ?? fs;
	let entries = [];
	try {
		entries = fsImpl.readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	const hits = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const m = SESSION_FILE_RE.exec(entry.name);
		if (!m) continue;
		const full = path.join(dir, entry.name);
		let st;
		try {
			st = fsImpl.statSync(full);
		} catch {
			continue;
		}
		hits.push({ file: full, name: entry.name, generation: m[1] ? Number(m[1]) : 0, mtimeMs: st.mtimeMs, size: st.size });
	}
	hits.sort((a, b) => b.mtimeMs - a.mtimeMs || b.generation - a.generation || (a.name < b.name ? -1 : 1));
	return hits.length ? hits[0].file : null;
}

// ── ③ zstd 多帧「结构切帧」（最小实现 · 与仓内 lib 同源）──────────────────────
/**
 * 扫描 zstd 多帧边界（严格结构解析，**不吃魔数搜索那套启发式**）。
 * 算法与仓内 `lib/zstd-frames.mjs#scanZstdFrames` 同源（只改了命名与格式）。
 * @param {Buffer} buffer 整个多帧缓冲
 * @returns {{frames:{start:number,end:number}[], tornStart:number|undefined}}
 *   frames    —— **完整帧**的 [start, end) 区间；`tornStart` = 第一个不完整帧的起点。
 *   调用方须"遇撕裂不猜"：撕裂帧整帧丢弃（⇒ 不存在"半条记录"）。
 */
export function scanZstdFramesLite(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start };
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) return { frames, tornStart: start };
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) return { frames, tornStart: start };
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames, tornStart: undefined };
}

// ── ④ 判"最后一条真人 user/message"（纯函数）──────────────────────────────────
/**
 * 从一组会话记录里取**最后一条真人** `user/message`。
 *
 * 判据必须与索引器「取轮」的实现**同解**（`chunks` 就是它写出来的，`(session_id, ts)` 配对的命门
 * 在这条判据上）：
 *   · `kind = data.source.kind`；`kind && kind !== 'user'` ⇒ **一律跳过**（注入：时间上下文 / 记忆召回 /
 *     素材索引 / 提醒 / 技能目录 / 运行时上下文…）；
 *   · 缺 `kind` ⇒ **算真人**（与索引器同口径；⚠️ 与"提炼记忆"那一侧的白名单分类**不同**，
 *     本件要对齐的是**索引器**）；
 *   · 正文取 `data.content`（数组取 `type==='text'` 拼接），空正文跳过。
 * 实测为什么必须按这条取：按"最后一条 user/message"（不筛注入）⇒ 时间戳几乎全配不上；
 *   按本条 ⇒ 绝大多数配上。**这就是注入态夹具要钉的那条判据。**
 *
 * @param {object[]} records 一条会话的事件流（按文件顺序）
 * @returns {{turnTs:number, userHeadSha16:string, chars:number}|null}
 *   找到真人那条但没有可用 `time` ⇒ **返回 null**（宁缺毋滥：不往前退一条，退一条就是挂错轮）。
 */
export function pickLastHumanTurn(records) {
	const list = Array.isArray(records) ? records : [];
	for (let i = list.length - 1; i >= 0; i -= 1) {
		const record = list[i];
		if (!record || record.type !== "user/message") continue;
		const kind = record?.data?.source?.kind;
		if (kind && kind !== "user") continue;
		const text = userTextOf(record);
		if (!text) continue;
		const turnTs = Number(record.time);
		if (!Number.isFinite(turnTs)) return null;
		return { turnTs, userHeadSha16: headSha16Of(text), chars: text.length };
	}
	return null;
}

// ── ⑤ 读会话文件 → 轮级锚点（异步、尾部优先、过期即丢）──────────────────────
function parseJsonLines(text, stats) {
	const out = [];
	for (const raw of String(text).split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			stats.badLines += 1;
		}
	}
	return out;
}

function zstdDecompressAsync(buffer) {
	return new Promise((resolve, reject) => {
		zstdDecompress(buffer, (error, out) => (error ? reject(error) : resolve(out)));
	});
}

/**
 * 读会话文件，取「最后一条真人 `user/message`」的轮级锚点。
 *
 * 三条设计（别改回同步 / 整解压）：
 *   ① **异步**：`fs.promises.readFile` + 异步 zstd（同步读会卡宿主主进程事件循环 —— 插件与主进程同进程）；
 *   ② **尾部优先**：只从文件尾部往前解帧，拿到真人消息就停（`maxFrames` 兜底，缺省见 `resolveMaxFrames`）；
 *   ③ **过期即丢**：读前 / 读后各 stat 一次，size 或 mtime 变了 ⇒ `reason:"stale"`，调用方当没拿到。
 *
 * @param {string} dir 会话目录（或传 `{file}` 直接指定文件）
 * @param {{file?:string, maxFrames?:number, home?:string, env?:object, fs?:object}} [opts]
 * @returns {Promise<{ok:true, file:string, turnTs:number, userHeadSha16:string, chars:number,
 *                    framesTotal:number, framesRead:number, tornFrames:number, badLines:number, torn:boolean, bytes:number}
 *                  |{ok:false, reason:string, file?:string|null, framesTotal?:number, framesRead?:number,
 *                    tornFrames?:number, badLines?:number, torn?:boolean, bytes?:number}>}
 */
export async function resolveTurnAnchor(dir, opts = {}) {
	const fsImpl = opts.fs ?? fs;
	const file = opts.file || pickSessionFile(dir, { fs: fsImpl });
	if (!file) return { ok: false, reason: "no-session-file", file: null };
	// 竞争判据：**只降级、不整笔丢弃**
	//   · `size` **变小**（文件比我们见过的任一长度都短）⇒ 被截断 / 重写 ⇒ 整笔丢弃（`reason:"stale"`）
	//   · `size` **变大**（尾部追加）⇒ 已解析帧的内容没变 ⇒ 重读（最多 `MAX_STALE_RETRY` 次），
	//     以当次 buffer 里的**完整帧**为准（不完整帧整帧丢弃 —— `scanZstdFramesLite` 已有该语义）
	//   · `mtime` 只进返回值的 `mtimeChanged` 做诊断，**不作丢弃判据**（写记忆那一刻几乎必然正在追加）
	// `sizeBefore` 取**首次** stat（`before` 不随重读更新），`sizeAfter` 取最后一次 stat。
	let before = await fsImpl.promises.stat(file);
	let buffer = await fsImpl.promises.readFile(file);
	let after = await fsImpl.promises.stat(file);
	let retries = 0;
	while (after.size > buffer.length && retries < MAX_STALE_RETRY) {
		retries += 1;
		buffer = await fsImpl.promises.readFile(file);
		after = await fsImpl.promises.stat(file);
	}
	if (after.size < Math.max(before.size, buffer.length)) {
		// 文件比我们见过的长度更短 ⇒ 内容可能已被重写，这一份 buffer 不可信（真 stale）
		return {
			ok: false,
			reason: "stale",
			file,
			bytes: buffer.length,
			sizeBefore: before.size,
			sizeAfter: after.size,
			retries,
			mtimeChanged: after.mtimeMs !== before.mtimeMs
		};
	}
	const probe = { sizeBefore: before.size, sizeAfter: after.size, retries, mtimeChanged: after.mtimeMs !== before.mtimeMs };
	const { frames, tornStart } = scanZstdFramesLite(buffer);
	const maxFrames = resolveMaxFrames({ maxFrames: opts.maxFrames, home: opts.home, env: opts.env, fs: fsImpl });
	const stats = { badLines: 0 };
	let framesRead = 0;
	let tornFrames = 0;
	for (let i = frames.length - 1; i >= 0 && framesRead < maxFrames; i -= 1) {
		framesRead += 1;
		let decoded;
		try {
			decoded = (await zstdDecompressAsync(buffer.subarray(frames[i].start, frames[i].end))).toString("utf8");
		} catch {
			tornFrames += 1;
			continue;
		}
		const hit = pickLastHumanTurn(parseJsonLines(decoded, stats));
		if (hit) {
			return {
				ok: true,
				file,
				turnTs: hit.turnTs,
				userHeadSha16: hit.userHeadSha16,
				chars: hit.chars,
				framesTotal: frames.length,
				framesRead,
				tornFrames,
				badLines: stats.badLines,
				torn: tornStart !== undefined,
				bytes: buffer.length,
				maxFrames,
				...probe
			};
		}
	}
	return {
		ok: false,
		// 帧预算用尽 ⇒ 单独一个 reason（"这一轮在很靠前的位置"，不是"这个会话没有真人消息"）
		reason: frames.length > maxFrames ? "frame-budget" : "no-human-turn",
		file,
		framesTotal: frames.length,
		framesRead,
		tornFrames,
		badLines: stats.badLines,
		torn: tornStart !== undefined,
		bytes: buffer.length,
		maxFrames,
		...probe
	};
}

// ── ⑥ 落盘：pending 一行 / lineage.log 一行 ──────────────────────────────────
function lineageDirOf(opts = {}) {
	return path.join(resolveLineageHome(opts), LINEAGE_DIR_NAME);
}

function monthOf(date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 追加一行 pending（**只放指针**；字段表一字不多）。
 * 按月分片（`pending-<YYYY-MM>.jsonl`）—— 分片是为了让回填器能整月归档已回填的行，
 * 否则这个日志只增不减，跑一年就得整文件扫（见回填器的 `rotatePending`）。
 * @param {{memId:number, sessionId:string, turnTs:number, userHeadSha16:string,
 *          textSha16:string|null, len:number|null, at:string, host:string}} record
 * @param {{home?:string, text?:string, fs?:object, flags?:string}} [opts] `text` 仅供隐私自检，**不会被写进文件**
 * @returns {{ok:boolean, path?:string, reason?:string, error?:string}}
 */
export function appendPending(record, opts = {}) {
	const fsImpl = opts.fs ?? fs;
	try {
		const line = JSON.stringify(record);
		// 隐私自检：正文 ≥40 字前缀若出现在行里 ⇒ 拒写。指针字段构不出正文，命中即说明写错了。
		const squeezed = squeeze(opts.text);
		if (squeezed.length >= PRIVACY_PREFIX_CHARS && line.includes(squeezed.slice(0, PRIVACY_PREFIX_CHARS))) {
			return { ok: false, reason: "privacy" };
		}
		const dir = lineageDirOf(opts);
		fsImpl.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `pending-${monthOf(new Date())}.jsonl`);
		fsImpl.appendFileSync(file, `${line}\n`, { encoding: "utf8", flag: "a" });
		return { ok: true, path: file };
	} catch (error) {
		return { ok: false, reason: "append-failed", error: String(error?.message ?? error) };
	}
}

/**
 * 写一行 `lineage.log`（**永不抛**）。
 * @returns {boolean} 写成功与否（调用方从不消费，只给夹具看）
 */
export function appendLineageLog(event, fields = {}, opts = {}) {
	const fsImpl = opts.fs ?? fs;
	try {
		const dir = lineageDirOf(opts);
		fsImpl.mkdirSync(dir, { recursive: true });
		const row = { ts: new Date().toISOString(), v: 1, event: String(event), ...fields };
		fsImpl.appendFileSync(path.join(dir, LINEAGE_LOG_FILE), `${JSON.stringify(row)}\n`, { encoding: "utf8", flag: "a" });
		return true;
	} catch {
		return false;
	}
}

// ── ⑦ 对外唯一入口（异步 · 永不 reject · fail-open）──────────────────────────
/** 兜底：调用方没传 `note.sessionId` 时从 exec 取。 */
function sessionIdOfExec(exec) {
	try {
		const agent = exec && exec.agent;
		if (!agent || typeof agent !== "object") return null;
		const session = agent.session;
		if (session && typeof session.id === "string" && session.id.length > 0) return session.id;
		if (session && session.header && typeof session.header.id === "string" && session.header.id.length > 0) return session.header.id;
		if (agent.id !== void 0 && agent.id !== null) return String(agent.id);
		return null;
	} catch {
		return null;
	}
}

/**
 * `memory_write` 落库后调一次：把「我在哪一轮」预埋进 pending 日志。**不写库、不改 `source_ids`。**
 *
 * @param {number|string} memId 刚落库的记忆 id
 * @param {unknown} exec 工具执行上下文（`memory_write.execute(args, exec)` 的第二个参数）
 * @param {unknown} config 插件配置（保留这个位是为了与宿主工具签名一致，且给未来扩参留位）
 * @param {{sessionId?:string, text?:string, tags?:string, home?:string, maxFrames?:number, fs?:object}} [note]
 *        `sessionId` 由调用方用**身份唯一口径**解析后传入（本件不另抄一份）；
 *        `text` 只用于算 `textSha16` / `len` 与隐私自检，**绝不落盘**。
 * @returns {Promise<object|null>} 只给夹具看（生产路径**不 await、不消费**）；**永不 reject**
 */
export async function appendLineageAnchor(memId, exec, config, note = null) {
	const startedAt = Date.now();
	const mem = Number(memId) || null;
	const opts = { home: note?.home };
	try {
		const sw = resolveLineageSwitch(opts);
		if (!sw.enabled) return null; // 关掉 ⇒ 零动作、零日志（契约：与改动前逐字节等价）
		const rawSessionId = note && note.sessionId !== void 0 ? note.sessionId : sessionIdOfExec(exec);
		const sessionId = normalizeSessionId(rawSessionId);
		if (!sessionId) {
			appendLineageLog("skip:no-session-id", { memId: mem }, opts);
			return null;
		}
		const located = resolveSessionDir(rawSessionId, opts);
		if (!located) {
			appendLineageLog("skip:no-session", { memId: mem, sessionId }, opts);
			return null;
		}
		// 缓存：文件没长（size 相同）⇒ 直接命中，0 ms
		const file = pickSessionFile(located.dir, { fs: opts.fs ?? fs });
		const cacheKey = `${resolveLineageHome(opts)}|${sessionId}`;
		let anchor = null;
		let cacheState = "miss";
		if (file) {
			try {
				const st = (opts.fs ?? fs).statSync(file);
				const hit = anchorCache.get(cacheKey);
				if (hit && hit.size === st.size && hit.file === file) {
					anchor = hit.anchor;
					cacheState = "hit";
				}
			} catch {
				/* stat 失败 ⇒ 走正常解析路 */
			}
		}
		if (cacheState === "miss") {
			anchor = await resolveTurnAnchor(located.dir, { file: file ?? void 0, maxFrames: note?.maxFrames, home: opts.home, fs: opts.fs });
			if (anchor && anchor.ok) {
				try {
					const st = (opts.fs ?? fs).statSync(anchor.file);
					anchorCache.set(cacheKey, { size: st.size, file: anchor.file, anchor });
				} catch {
					/* 缓存写不进不算失败 */
				}
			}
		}
		if (!anchor || !anchor.ok) {
			const reason = anchor?.reason ?? "no-human-turn";
			appendLineageLog(`skip:${reason}`, {
				memId: mem,
				sessionId,
				dir: located.dir,
				via: located.via,
				framesTotal: anchor?.framesTotal ?? null,
				framesRead: anchor?.framesRead ?? null,
				ms: Date.now() - startedAt
			}, opts);
			return null;
		}
		const text = typeof note?.text === "string" ? note.text : null;
		const row = {
			v: 1,
			memId: mem,
			sessionId, // 已 strip `session-` 前缀（与索引库的会话主键对齐）
			turnTs: anchor.turnTs,
			userHeadSha16: anchor.userHeadSha16,
			textSha16: text === null ? null : sha16(text),
			len: text === null ? null : text.length,
			at: new Date().toISOString(),
			host: String(os.hostname() || "").toLowerCase()
		};
		const written = appendPending(row, { home: opts.home, text, fs: opts.fs });
		if (!written.ok) {
			appendLineageLog("append-failed", { memId: mem, sessionId, reason: written.reason ?? null, error: written.error ?? null }, opts);
			return null;
		}
		appendLineageLog(cacheState === "hit" ? "ok:cache-hit" : "ok", {
			memId: mem,
			sessionId,
			turnTs: anchor.turnTs,
			via: located.via,
			framesRead: cacheState === "hit" ? 0 : anchor.framesRead ?? null,
			ms: Date.now() - startedAt
		}, opts);
		return row;
	} catch (error) {
		// fail-open 的最后一层：连日志都可能失败 ⇒ 全吞，绝不 reject（调用方没 await，reject 会变 unhandledRejection）
		try {
			appendLineageLog("error", { memId: mem, error: String(error?.message ?? error) }, opts);
		} catch {
			/* 吞 */
		}
		return null;
	}
}

export default {
	LINEAGE_AUTO_VERSION,
	LINEAGE_DIR_NAME,
	LINEAGE_CONFIG_FILE,
	LINEAGE_LOG_FILE,
	DEFAULT_MAX_FRAMES,
	MAX_FRAMES_ENV,
	PRIVACY_PREFIX_CHARS,
	__resetLineageCaches,
	resolveLineageHome,
	normalizeSessionId,
	headSha16Of,
	resolveLineageSwitch,
	lineageEnabled,
	resolveMaxFrames,
	resolveSessionDir,
	pickSessionFile,
	scanZstdFramesLite,
	pickLastHumanTurn,
	resolveTurnAnchor,
	appendPending,
	appendLineageLog,
	appendLineageAnchor
};
