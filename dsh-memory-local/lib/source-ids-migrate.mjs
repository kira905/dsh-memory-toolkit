/**
 * FORK-EDIT(2026-11-04): 观察级血缘列 `source_ids` —— 显式迁移键 + 读写归一（零 peer 依赖）。
 *
 * 一句话：**记忆可以说清"这条结论是从哪几条观察推出来的"**，但这句话必须落在一个
 * **独立列**里，绝不能塞进 tags。
 *
 * 三条设计铁律（照抄口径，别自己重新设计）：
 *   ① **独立列**：`source_ids TEXT NOT NULL DEFAULT ''`，值 = JSON 数组字符串
 *      （如 `["chunk-123","chunk-456"]`），空串 = 无来源声明（与存量逐字节同形）。
 *      ⚠️ **绝不写进 tags**：tags 在 FTS 索引里，把 id 塞进去会污染全文检索（搜一个 id
 *      能搜出整条记忆，且 tags 会被渲染进注入面）。
 *   ② **显式迁移版本键**：放库内 `schema_meta` 表（`memories.source_ids = 0/1`），
 *      **不用** `PRAGMA user_version` —— 上游打开链路里有一行 `PRAGMA user_version = N`，
 *      每个连接无条件覆写 ⇒ 放进那个数里的键会被静默改写成恒值（= 键等于不存在，fail-open 假象）；
 *      而且它只有一位整数，后面还要加键 ⇒ 必然打架。meta 表还能与"建表 + 加列 + 写键"
 *      放进同一个事务 ⇒ 原子。
 *   ③ **fail-closed**：列在 + 键=1 才算迁移完成；其它任意组合（半迁移 / 键被人改过）
 *      一律拒写并明确报错 —— 不许把"读不到列"当成"没有来源"继续跑。
 *
 * 写入口对来源 id 是**宽容**的（非数组 / 脏值 / 超限 ⇒ 归一或截断，绝不因此拒绝写入）：
 * 血缘是观察级附加信息，不能因为它把主人的写入挡掉。
 *
 * 本模块零 peer 依赖（只用 `node:sqlite` 的话由调用方传连接）⇒ 可在源码目录直接单测，无需部署。
 */
import { buildAddColumnSql, columnsOf, writeSchemaLog } from "./schema-migrate.mjs";

/** `source_ids` 列定义（加列时的唯一真源）。 */
export const SOURCE_IDS_COLUMN = Object.freeze({
	name: "source_ids",
	type: "TEXT",
	notNull: true,
	defaultLiteral: "",
	doc: "JSON 数组字符串（如 [\"chunk-123\",\"chunk-456\"]）；空串 = 无来源声明。⚠️ 必须是独立列：写进 tags 会进 FTS 索引 ⇒ 污染全文检索"
});

/** 迁移版本键所在的 meta 表（键名自带作用域，见铁律 ②）。 */
export const SCHEMA_META_TABLE = "schema_meta";
export const SCHEMA_META_DDL = `CREATE TABLE IF NOT EXISTS ${SCHEMA_META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
export const SOURCE_IDS_VERSION_KEY = "memories.source_ids";
/** 版本取值域：只有这两个值合法；其它一律「既不是迁移前也不是迁移后」⇒ fail-closed。 */
export const SOURCE_IDS_VERSION_BEFORE = "0";
export const SOURCE_IDS_VERSION_AFTER = "1";

/** 写入口防呆上限（超限只截断，绝不拒绝写入）。 */
export const SOURCE_IDS_MAX_ITEMS = 200;
export const SOURCE_IDS_MAX_ITEM_CHARS = 200;

/** fail-closed 的错误码（写入口把它挂到 `Error#code` 上，供判据断言）。 */
export const SOURCE_IDS_BLOCKED_CODE = "E_MEMORY_SCHEMA_VERSION_MISMATCH";

/** 读版本键：表/键不存在 ⇒ null、读失败 ⇒ null（都当"迁移前"，由 state 判定负责拒动）。 */
export function readSchemaMeta(db, key) {
	try {
		const row = db.prepare("SELECT value FROM " + SCHEMA_META_TABLE + " WHERE key = ?").get(key);
		return row === undefined ? null : String(row.value);
	} catch {
		return null;
	}
}

/** 写版本键（UPSERT；缺表则建）。⚠️ 由调用方包在事务里。 */
export function writeSchemaMeta(db, key, value) {
	db.exec(SCHEMA_META_DDL);
	db.prepare("INSERT INTO " + SCHEMA_META_TABLE + " (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

/**
 * 判 `source_ids` 迁移态（**只读**）。
 *
 * 四态：
 *   `before`   = 列缺 + 键缺/键=0 ⇒ 干净待迁；
 *   `after`    = 列在 + 键=1     ⇒ 迁移完成；
 *   `mismatch` = 其它任意组合     ⇒ **半迁移 / 键被人改过** ⇒ fail-closed（拒写 + 明确报错）；
 *   `no-table` = memories 表不存在 ⇒ 交给建表 DDL 与下次自检。
 * @returns {{state:string, columnExists:boolean, version:string|null, reason:string|null}}
 */
export function sourceIdsMigrationState(db, table = "memories") {
	const cols = columnsOf(db, table);
	if (cols.length === 0) return { state: "no-table", columnExists: false, version: null, reason: null };
	const columnExists = cols.includes(SOURCE_IDS_COLUMN.name);
	const version = readSchemaMeta(db, SOURCE_IDS_VERSION_KEY);
	const at = "列" + (columnExists ? "在" : "缺") + " + 版本键" + (version === null ? "缺" : "=" + version);
	if (!columnExists && (version === null || version === SOURCE_IDS_VERSION_BEFORE)) return { state: "before", columnExists, version, reason: null };
	if (columnExists && version === SOURCE_IDS_VERSION_AFTER) return { state: "after", columnExists, version, reason: null };
	return {
		state: "mismatch",
		columnExists,
		version,
		reason: "source_ids 迁移态自相矛盾（" + at + "）：既不是「迁移前」（列缺 + 键缺/0）也不是「迁移后」（列在 + 键 1）"
	};
}

/**
 * 执行 `source_ids` 迁移（**单事务原子**：建 meta 表 + 加列 + 写版本键）。
 * 幂等：已是 after 态 ⇒ 零语句。mismatch / no-table ⇒ **拒动**（不猜、不补键，判断交回调用方）。
 * @returns {{ok:boolean, ran:string[], state:string, error:string|null}}
 */
export function applySourceIdsMigration(db, table = "memories") {
	const state0 = sourceIdsMigrationState(db, table);
	if (state0.state === "after") return { ok: true, ran: [], state: "after", error: null };
	if (state0.state !== "before") return { ok: false, ran: [], state: state0.state, error: state0.reason ?? ("迁移态不可迁：" + state0.state) };
	const ran = [];
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec(SCHEMA_META_DDL);
		ran.push(SCHEMA_META_DDL);
		const alter = buildAddColumnSql(SOURCE_IDS_COLUMN, SOURCE_IDS_COLUMN.defaultLiteral, table);
		db.exec(alter);
		ran.push(alter);
		writeSchemaMeta(db, SOURCE_IDS_VERSION_KEY, SOURCE_IDS_VERSION_AFTER);
		ran.push("schema_meta: " + SOURCE_IDS_VERSION_KEY + " = " + SOURCE_IDS_VERSION_AFTER);
		db.exec("COMMIT");
	} catch (e) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* 忽略：回滚失败时向上抛原始错误（由调用方降级处理） */
		}
		return { ok: false, ran: [], state: "error", error: e && e.message ? String(e.message) : String(e) };
	}
	return { ok: true, ran, state: "after", error: null };
}

/**
 * 高层入口（插件**打开库的那一瞬间**调用一次）：迁移 + 判 fail-closed + 落日志。
 *
 * 位置必须紧跟表结构自检之后、且**在任何写入之前**（插件是这张表的唯一常驻打开者）。
 * 永不抛：任何失败都收敛成 `{ok:false, state, writeBlocked}`，绝不阻断宿主启动。
 *
 * @param {object} db - 已打开的 `node:sqlite` DatabaseSync 连接（写模式）
 * @param {{table?:string, dbPath?:string, logFile?:string, onLog?:(entry:object)=>void}} [opts]
 * @returns {{ok:boolean, ran:string[], state:string, error:string|null,
 *            writeBlocked:{code:string, reason:string, state:string}|null}}
 */
export function ensureSourceIdsColumn(db, opts = {}) {
	const table = opts.table ?? "memories";
	const logOpts = { dbPath: opts.dbPath ?? null, logFile: opts.logFile, onLog: opts.onLog };
	const cols = columnsOf(db, table);
	// 表还不存在（空库尚未建表）⇒ 本次跳过，交给建表 DDL 与下次自检（与表结构自检同口径）
	if (cols.length === 0) return { ok: true, ran: [], state: "no-table", error: null, writeBlocked: null };
	const sid = applySourceIdsMigration(db, table);
	const result = { ok: sid.ok, ran: sid.ran, state: sid.state, error: sid.error, writeBlocked: null };
	if (sid.state !== "after") {
		const stateNow = sourceIdsMigrationState(db, table);
		result.writeBlocked = {
			code: SOURCE_IDS_BLOCKED_CODE,
			reason: stateNow.reason ?? sid.error ?? ("source_ids 迁移未完成（state=" + sid.state + "）"),
			state: sid.state
		};
		writeSchemaLog(logOpts, {
			event: "source-ids-blocked",
			ok: false,
			state: sid.state,
			version: stateNow.version,
			columnExists: stateNow.columnExists,
			reason: result.writeBlocked.reason,
			dbPath: opts.dbPath ?? null
		});
	} else if (sid.ran.length > 0) {
		writeSchemaLog(logOpts, {
			event: "source-ids-migrate",
			ok: true,
			ran: sid.ran,
			version: SOURCE_IDS_VERSION_AFTER,
			dbPath: opts.dbPath ?? null
		});
	}
	return result;
}

/**
 * 归一化来源 id 列表（写入口）。
 * 规则：只收 string/number ⇒ trim 后非空、单条 ≤200 字、去重保序、最多 200 条。
 * 非数组 / 全空 ⇒ `[]`（**绝不抛**：来源是观察级附加信息，不能因为它把主人写入挡掉）。
 */
export function normalizeSourceIds(value) {
	const out = [];
	if (!Array.isArray(value)) return out;
	for (const raw of value) {
		if (typeof raw !== "string" && typeof raw !== "number") continue;
		const s = String(raw).trim();
		if (s.length === 0 || s.length > SOURCE_IDS_MAX_ITEM_CHARS) continue;
		if (!out.includes(s)) out.push(s);
		if (out.length >= SOURCE_IDS_MAX_ITEMS) break;
	}
	return out;
}

/** 归一化后序列化成落列值：空 ⇒ `''`（= 无来源声明，与存量逐字节同形）。 */
export function serializeSourceIds(value) {
	const list = normalizeSourceIds(value);
	return list.length === 0 ? "" : JSON.stringify(list);
}

/** 读回值 → 数组；**解析失败按空处理**（绝不抛：这条链路可能出现在渲染 / 注入里）。 */
export function parseSourceIds(raw) {
	if (typeof raw !== "string" || raw.length === 0) return [];
	try {
		const doc = JSON.parse(raw);
		if (!Array.isArray(doc)) return [];
		return doc.filter((x) => typeof x === "string" && x.length > 0);
	} catch {
		return [];
	}
}
