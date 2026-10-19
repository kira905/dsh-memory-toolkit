/**
 * FORK-EDIT(2026-09-21): 记忆引擎 v2 · S3b —— `memories` 表结构自检（方案 §3.8 / §3.9）
 *
 * 为什么必须有这个文件（三条硬理由）：
 *   ① **表已存在的库上 `CREATE TABLE IF NOT EXISTS` 整条 DDL 不生效** ⇒ 新列永远加不上（§3.8 明文），
 *      所以只能 `PRAGMA table_info` 查列 → 缺哪列补哪列 `ALTER TABLE memories ADD COLUMN …`；
 *   ② 加列必须发生在**库被打开的那一瞬间**（插件是这张表唯一的常驻打开者），
 *      且**失败绝不阻断 DSH 启动** ⇒ 全链路包 try，失败只落日志 + 结构化降级标记；
 *   ③ 两列口径（列定义 / 默认值来源 / 索引名）的**权威源**是
 *      本仓 `memory-db-tools/lib/memory-scope.mjs`（逐字同源）——
 *      本文件是它在 fork 内的**最小自持镜像**：插件部署到 profile 后只带 `lib/`，
 *      **无法 import 那条绝对路径**（也不该依赖 DSH 工作目录的绝对路径），故必须镜像一份。
 *      两者的一致性由 `test/schema-migrate.test.mjs` 的**逐字对照断言**守住（漂移即测试红）。
 *
 * 本模块零 peer 依赖（只用 `node:sqlite` 与 node 内置模块）⇒ 可在源码目录直接单测，无需部署。
 */
import fs from "node:fs";
import path from "node:path";

const { existsSync, readFileSync, mkdirSync, appendFileSync } = fs;
const { dirname, join } = path;

/** 计量单位：加列前的既有列（§3.8 起点，与权威源 LEGACY_COLUMNS 一致）。 */
export const LEGACY_COLUMNS = Object.freeze(["id", "text", "tags", "pinned", "created_at", "updated_at"]);

/** visibility 取值域（§3.3-1）。 */
export const VISIBILITY_VALUES = Object.freeze(["private_owner", "family", "public"]);

/** visibility 默认值（§3.3-1 / 家人档 §3.4）。 */
export const DEFAULT_VISIBILITY = "private_owner";

/**
 * `owner_user` 缺省**回落**常量。
 * ⚠️ 它不是硬编码人名，而是"本机 owner 的 userid"的兜底值：正常取值来自身份表里
 * `role === 'owner'` 的那条；取不到才回落这里，并在自检日志里**报一行**（§3.3-3）。
 */
export const FALLBACK_OWNER_USER = "LiJianXiao";

/** 身份表文件名（家人档 §3.3：`.dsh/secretary-users.json`，不进任何仓）。 */
export const IDENTITY_TABLE_NAME = "secretary-users.json";

/** 两列定义（与权威源 NEW_COLUMNS 逐字一致）。`defaultKind: 'owner'` = 默认值运行时解析。 */
export const NEW_COLUMNS = Object.freeze([
	Object.freeze({
		name: "owner_user",
		type: "TEXT",
		notNull: true,
		defaultKind: "owner",
		doc: "谁的（取值域 = 宿主账号体系的 user id）"
	}),
	Object.freeze({
		name: "visibility",
		type: "TEXT",
		notNull: true,
		defaultKind: "literal",
		defaultLiteral: DEFAULT_VISIBILITY,
		doc: "private_owner | family | public"
	})
]);

/** visibility 索引（§3.8；家人侧过滤用）。 */
export const VISIBILITY_INDEX_NAME = "memories_visibility";
export const VISIBILITY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${VISIBILITY_INDEX_NAME} ON memories (visibility, updated_at DESC)`;

/** SQL 字符串字面量转义（单引号翻倍）。 */
export function quoteLiteral(s) {
	return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 解析身份表文本 → `{ ok, userids, owner, error }`。
 *
 * **三种形态都认**（2026-10-11 卡【翻译官·批4·家人档地基】扩了一档；与权威源 `memory-scope.mjs` 同解）：
 *   ① 平面 map（历史权威形态）`{ "<userid>": { role, name, caps } }`，`_` 前缀键与元数据键跳过；
 *   ② **`{version, default:"deny", users:{…}}`** —— 该形态是**新形态**
 *      §5.6 定稿的**新形态**（`users` 是 **map** 不是数组）。⚠️ 旧实现只认 `users` 是**数组**的包装
 *      ⇒ 新表一落盘会被**读成空表**（owner 回落常量 / 全部 owner 判"未登记"）= **静默失真**；
 *   ③ 数组 `[{userid,…}]` 与 `{ users: [ … ] }`（家人档定稿前的历史形态）。
 * @param {string} text - 身份表 JSON 文本。
 * @returns {{ok:boolean,userids:string[],owner:string|null,error:string|null}}
 */
export function parseIdentityTable(text) {
	let doc;
	try {
		doc = JSON.parse(String(text));
	} catch (e) {
		return { ok: false, userids: [], owner: null, error: `身份表 JSON 解析失败：${e.message}` };
	}
	const userids = [];
	let owner = null;
	const take = (userid, rec) => {
		// ① 键侧的 `_` 注释约定 / 元数据键：**一律跳过**（值侧也一样 —— 见下）
		if (typeof userid === "string") {
			const k = userid.trim();
			if (k.startsWith("_") || k === "$schema" || METADATA_KEYS.has(k)) return;
		}
		// ② 简写形态：值就是 userid 字符串（`{"<userid>": "角色"}` / `["uid",…]`）
		if (typeof rec === "string") {
			const v = rec.trim();
			if (v && !v.startsWith("_") && !METADATA_KEYS.has(v) && !userids.includes(v)) userids.push(v);
			return;
		}
		if (typeof userid !== "string") return;
		const id = userid.trim();
		if (id.length === 0) return;
		if (!userids.includes(id)) userids.push(id);
		if (owner === null && rec && typeof rec === "object" && rec.role === "owner") owner = id;
	};
	// ③ 数组根：**只认"记录数组/字符串数组"**（`[1,2]` 这类必须判不认 —— 否则"认不出"会悄悄变成"认出来是空的"）
	if (Array.isArray(doc)) {
		if (!isRecordArray(doc)) return { ok: false, userids: [], owner: null, error: "身份表根节点是数组，但元素不是记录" };
		for (const e of doc) (typeof e === "string") ? take(e, {}) : take(e.userid ?? e.user ?? e.id, e);
		return { ok: true, userids, owner, error: null };
	}
	if (!doc || typeof doc !== "object") return { ok: false, userids: [], owner: null, error: "身份表根节点既不是对象也不是数组" };
	const inner = doc.users ?? doc.members ?? null;
	if (Array.isArray(inner)) {                        // 历史包装 `{ users: [ … ] }`
		if (!isRecordArray(inner)) return { ok: false, userids: [], owner: null, error: "`users` 是数组但元素不是记录" };
		for (const e of inner) (typeof e === "string") ? take(e, {}) : take(e.userid ?? e.user ?? e.id, e);
		return { ok: true, userids, owner, error: null };
	}
	if (inner && typeof inner === "object") {          // ② 新形态 `{ users: { <userid>: {…} } }`
		for (const [uid, rec] of Object.entries(inner)) take(uid, rec);
		return { ok: true, userids, owner, error: null };
	}
	for (const [userid, rec] of Object.entries(doc)) take(userid, rec); // ① 平面 map（`_` 前缀 / 元数据键由 take 内跳过）
	return { ok: true, userids, owner, error: null };
}

/** 表级元数据键（不是 userid）。 */
const METADATA_KEYS = new Set(["version", "schemaVersion", "default", "product", "updatedAt", "note", "$schema"]);

/** `[{userid,…}]` / `["uid",…]` ⇒ true；`[1,2]` ⇒ false。 */
function isRecordArray(v) {
	return Array.isArray(v) && v.every((x) => typeof x === "string" || (x !== null && typeof x === "object" && !Array.isArray(x)));
}

/**
 * 定位身份表：`base` 可能是 `.dsh` 目录、`.dsh` 的父目录（USERPROFILE），或身份表文件本身。
 * @returns {string} 候选路径中第一个存在的；都不存在则返回首选候选（供错误信息展示）。
 */
export function identityTablePath(base) {
	if (typeof base === "string" && /\.json$/i.test(base)) return base;
	const root = base && base.length > 0 ? base : ".";
	const candidates = [join(root, IDENTITY_TABLE_NAME), join(root, ".dsh", IDENTITY_TABLE_NAME)];
	for (const c of candidates) {
		try {
			if (existsSync(c)) return c;
		} catch {
			/* 忽略：继续试下一个候选 */
		}
	}
	return candidates[0];
}

/**
 * 只读身份表文件；**永不抛错**（读不到就返回不 ok，由调用方回落常量）。
 * @param {string} [home] - DSH home（`.dsh` 目录）或身份表文件路径。
 * @returns {{ok:boolean,path:string,exists:boolean,userids:string[],owner:string|null,error:string|null}}
 */
export function readIdentityTable(home) {
	const p = identityTablePath(home);
	let text;
	try {
		if (!existsSync(p)) return { ok: false, path: p, exists: false, userids: [], owner: null, error: "身份表不存在（家人档身份表未落地）" };
		text = readFileSync(p, "utf8");
	} catch (e) {
		return { ok: false, path: p, exists: true, userids: [], owner: null, error: `身份表读不到：${e && e.message ? e.message : e}` };
	}
	return { ok: true, path: p, exists: true, ...parseIdentityTable(text) };
}

/**
 * 解析 `owner_user` 的默认值（§3.3-3 的取值优先级）：
 *   ① 身份表里 `role === 'owner'` 的那条 ② 缺省回落常量 + 一行说明。
 * @param {{ok:boolean,exists?:boolean,owner?:string|null,error?:string|null,path?:string}} identity
 * @returns {{ownerUser:string,source:'identity-table'|'fallback',notes:string[]}}
 */
export function resolveDefaultOwner(identity) {
	const notes = [];
	if (identity && identity.ok && identity.owner) return { ownerUser: identity.owner, source: "identity-table", notes };
	if (identity && identity.exists && identity.ok && !identity.owner) {
		notes.push(`身份表 ${identity.path} 存在但没有任何 role==='owner' 的条目 → 回落常量`);
	} else if (identity && identity.error) {
		notes.push(`身份表不可用（${identity.error}） → 回落常量`);
	}
	notes.push(`owner_user 默认值回落常量 '${FALLBACK_OWNER_USER}'（身份表缺位时的人工兜底，非硬编码设计）`);
	return { ownerUser: FALLBACK_OWNER_USER, source: "fallback", notes };
}

/** 读某表列名（PRAGMA table_info；表不存在/失败返回 []）。 */
export function columnsOf(db, table = "memories") {
	try {
		return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
	} catch {
		return [];
	}
}

/** 索引是否已存在（查 sqlite_master；失败按"不存在"处理，交由 DDL 的 IF NOT EXISTS 兜底）。 */
export function hasIndex(db, name) {
	try {
		return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name=?").get(name) !== undefined;
	} catch {
		return false;
	}
}

/**
 * 单列的 `ALTER TABLE ADD COLUMN` 语句（与权威源 buildAddColumnSql 逐字同构）。
 * ⚠️ SQLite 的 ADD COLUMN 默认值**必须是常量表达式** ⇒ "从身份表取默认值"只能在这里
 * 先把常量解析出来再拼进 DDL，而不是库端函数。
 */
export function buildAddColumnSql(col, defaultLiteral, table = "memories") {
	const parts = [`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`];
	if (col.notNull) parts.push("NOT NULL");
	parts.push(`DEFAULT ${quoteLiteral(defaultLiteral)}`);
	return parts.join(" ");
}

/**
 * 迁移计划（**只读**，不改库）：算缺哪些列、要跑哪些语句、默认值取什么。
 * @returns {{columns:string[],missing:string[],present:string[],indexExists:boolean,statements:string[],defaultOwner:object,notes:string[]}}
 */
export function migrationPlan(db, { identity = null, table = "memories" } = {}) {
	const resolved = resolveDefaultOwner(identity);
	const columns = columnsOf(db, table);
	const missing = NEW_COLUMNS.filter((c) => !columns.includes(c.name));
	const present = NEW_COLUMNS.filter((c) => columns.includes(c.name)).map((c) => c.name);
	const statements = missing.map((c) => buildAddColumnSql(c, c.defaultKind === "owner" ? resolved.ownerUser : c.defaultLiteral, table));
	const indexExists = hasIndex(db, VISIBILITY_INDEX_NAME);
	if (!indexExists) statements.push(VISIBILITY_INDEX_SQL);
	return { columns, missing: missing.map((c) => c.name), present, indexExists, statements, defaultOwner: resolved, notes: resolved.notes };
}

/** 执行迁移（单事务；语句来自 migrationPlan，列已存在则天然无语句可跑）。返回实际执行的语句数组。 */
export function applyMigration(db, plan) {
	const ran = [];
	db.exec("BEGIN IMMEDIATE");
	try {
		for (const sql of plan.statements) {
			db.exec(sql);
			ran.push(sql);
		}
		db.exec("COMMIT");
	} catch (e) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* 忽略：回滚失败时向上抛原始错误（由调用方降级处理） */
		}
		throw e;
	}
	return ran;
}

/**
 * 高层入口（**插件启动自检**用）：幂等加列 + 建索引，**全链路包 try，永不抛**。
 *
 * 设计约束（方案 §3.8 风险与对策③）：
 *   · 自检失败 ⇒ **不加列 + 功能降级，绝不阻断 DSH 启动** ⇒ 本函数返回结构化结果，不 throw；
 *   · 只有"发生了变更 / 失败 / 降级"才写日志（幂等无变化时不写，避免每次启动刷日志）。
 *
 * @param {object} db - 已打开的 `node:sqlite` DatabaseSync 连接（写模式）。
 * @param {object} [opts]
 * @param {string} [opts.home] - DSH home（`.dsh` 目录）；缺省由 dbPath 推导（`<home>/memory/memory.db`）。
 * @param {string} [opts.dbPath] - 库路径，用于推导 home 与写日志。
 * @param {string} [opts.logFile] - 日志文件路径；缺省 `<home>/logs/memory-schema.log`。
 * @param {(entry:object)=>void} [opts.onLog] - 额外日志回调（测试用）。
 * @returns {{ok:boolean,degraded:boolean,added:string[],present:string[],indexCreated:boolean,statements:string[],ownerUser:string,ownerSource:string,notes:string[],error:string|null,skipped:string|null}}
 */
export function ensureMemoryColumns(db, opts = {}) {
	const result = {
		ok: false,
		degraded: false,
		added: [],
		present: [],
		indexCreated: false,
		statements: [],
		ownerUser: FALLBACK_OWNER_USER,
		ownerSource: "fallback",
		notes: [],
		error: null,
		skipped: null
	};
	try {
		// ① 表不存在（空库尚未建表）⇒ 本次跳过，交给建表 DDL
		const columns = columnsOf(db);
		if (columns.length === 0) {
			result.ok = true;
			result.skipped = "memories 表不存在 ⇒ 本次自检跳过（由建表 DDL 负责）";
			return result;
		}
		// ② 身份表 → owner_user 默认值
		const home = opts.home ?? deriveHome(opts.dbPath);
		const identity = readIdentityTable(home);
		const resolved = resolveDefaultOwner(identity);
		result.ownerUser = resolved.ownerUser;
		result.ownerSource = resolved.source;
		result.notes = resolved.notes;
		// ③ 只读规划
		const plan = migrationPlan(db, { identity });
		result.present = plan.present;
		result.statements = plan.statements;
		// ④ 无变更 ⇒ 幂等返回（不写日志）
		if (plan.statements.length === 0) {
			result.ok = true;
			return result;
		}
		// ⑤ 执行（单事务）
		const ran = applyMigration(db, plan);
		result.statements = ran;
		result.added = ran
			.filter((s) => /ADD COLUMN/.test(s))
			.map((s) => (s.match(/ADD COLUMN (\w+)/) || [])[1])
			.filter(Boolean);
		result.indexCreated = ran.some((s) => s.includes(VISIBILITY_INDEX_NAME));
		result.ok = true;
		writeSchemaLog(opts, {
			event: "migrate",
			ok: true,
			added: result.added,
			indexCreated: result.indexCreated,
			ownerUser: result.ownerUser,
			ownerSource: result.ownerSource,
			dbPath: opts.dbPath ?? null
		});
		return result;
	} catch (e) {
		// ⑥ 失败 ⇒ 降级 + 落日志，**绝不抛**（绝不阻断 DSH 启动）
		result.ok = false;
		result.degraded = true;
		result.error = e && e.message ? String(e.message) : String(e);
		writeSchemaLog(opts, { event: "migrate", ok: false, degraded: true, error: result.error, dbPath: opts.dbPath ?? null });
		return result;
	}
}

/**
 * 写自检日志（JSON 行、追加写）。**日志失败绝不影响调用方**（自检本身也不许因日志炸）。
 * @returns {string|null} 实际写入的文件路径，失败返回 null。
 */
export function writeSchemaLog(opts = {}, entry = {}) {
	try {
		const file = opts.logFile ?? join(opts.home ?? deriveHome(opts.dbPath), "logs", "memory-schema.log");
		if (typeof opts.onLog === "function") {
			try {
				opts.onLog({ at: new Date().toISOString(), pid: process.pid, ...entry });
			} catch {
				/* 回调失败不影响日志落盘 */
			}
		}
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`, "utf8");
		return file;
	} catch {
		return null;
	}
}

/** 由库路径推导 DSH home：`<home>/memory/memory.db` → `<home>`。 */
export function deriveHome(dbPath) {
	if (typeof dbPath !== "string" || dbPath.length === 0) return ".";
	return dirname(dirname(dbPath));
}
