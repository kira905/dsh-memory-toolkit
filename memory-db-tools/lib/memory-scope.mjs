// tools/memory-db-tools/lib/memory-scope.mjs
//
// ⑤ 服务面隐私包 · §3.3 S-3「字段名定稿 + 身份绑定」的**唯一实现口径**（施工卡 ⑤-3 交付）。
//
// 口径出处（逐条对齐，改这里必须同步改方案档）：
//   · docs/服务面隐私包-方案-20260917.md §3.3（1 唯一权威 / 3 身份绑定 / 4 检索隔离 / 5 与 P2 接口）
//   · docs/P2-记忆引擎升级-方案-20260916.md §3.8（两列 DDL / PRAGMA table_info 幂等 / visibility 索引）
//   · docs/小秘书-家人档设计增补-2026-09-17.md §3.3（身份表 secretary-users.json 结构）
//
// 本模块是**纯逻辑 + 只读文件读取**：不开数据库连接（调用方把 DatabaseSync 实例传进来），
// 不写任何文件（除显式调用的 vacuumInto），不做时间/网络副作用。
// 这样它既能被 CLI 用，也能被将来的记忆引擎（P2 fork 版启动自检）用，还能被单测注入夹具。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 记忆表名（唯一）。 */
export const MEMORIES_TABLE = "memories";

/** 计量单位：加列前的既有列（实测 2026-09-20 · 生产库 6 列）。 */
export const LEGACY_COLUMNS = Object.freeze(["id", "text", "tags", "pinned", "created_at", "updated_at"]);

/** visibility 取值域（§3.3-1）。 */
export const VISIBILITY_VALUES = Object.freeze(["private_owner", "family", "public"]);

/** visibility 默认值（§3.3-1 / 家人档 §3.4「默认 private_owner」）。 */
export const DEFAULT_VISIBILITY = "private_owner";

/**
 * owner_user 缺省回落常量。
 * ⚠️ §3.3-3：它**不是**硬编码人名，而是"本机 owner 的 userid"的**回落值** —— 正常取值来自身份表
 * 里 role==='owner' 的那条；取不到身份表才回落这里，并在自检里**报一行**（见 resolveDefaultOwner）。
 */
export const FALLBACK_OWNER_USER = "LiJianXiao";

/** 身份表相对 ~ 的路径（家人档 §3.3：`.dsh/secretary-users.json`，不进任何仓）。 */
export const IDENTITY_TABLE_REL = Object.freeze([".dsh", "secretary-users.json"]);

/** 身份表 CLI（家人档 §3.3 规定；W1 线未落 ⇒ 本模块必须能优雅降级到直接读 JSON）。 */
export const IDENTITY_CLI_REL = Object.freeze(["tools", "dsh-butler", "secretary-user.mjs"]);

/** 两列定义（§3.3-1 唯一权威 / §3.8 表）。`defaultKind: 'owner'` = 默认值运行时从身份表解析。 */
export const NEW_COLUMNS = Object.freeze([
  Object.freeze({
    name: "owner_user",
    type: "TEXT",
    notNull: true,
    defaultKind: "owner",
    doc: "谁的（取值域 = 宿主账号体系的 user id）",
  }),
  Object.freeze({
    name: "visibility",
    type: "TEXT",
    notNull: true,
    defaultKind: "literal",
    defaultLiteral: DEFAULT_VISIBILITY,
    doc: "private_owner | family | public",
  }),
]);

/** visibility 索引（§3.8 幂等做法 · 家人侧过滤用）。 */
export const VISIBILITY_INDEX = Object.freeze({
  name: "memories_visibility",
  sql: "CREATE INDEX IF NOT EXISTS memories_visibility ON memories (visibility, updated_at DESC)",
});

/** 被裁决作废的旧字段名（§3.3-2：`source_user` 是 `owner_user` 的误写）。 */
export const DEPRECATED_FIELD = "source_user";

/** 生产记忆库绝对路径（唯一口径；`<USERPROFILE>/.dsh/memory/memory.db`）。 */
export function productionDbPath(env = process.env) {
  return path.join(env.USERPROFILE || env.HOME || "", ".dsh", "memory", "memory.db");
}

/** 主目录（`--home` 缺省 = 用户主目录）。 */
export function dshHome(env = process.env) {
  return path.join(env.USERPROFILE || env.HOME || "", ".dsh");
}

/** 判定两个路径是否同一个真实文件（realpath 双方再比 —— junction 场景的既有教训）。 */
export function sameRealPath(a, b) {
  const r = (p) => {
    try {
      return fs.realpathSync.native(p).toLowerCase();
    } catch {
      try {
        return path.resolve(p).toLowerCase();
      } catch {
        return String(p).toLowerCase();
      }
    }
  };
  return r(a) === r(b);
}

/** 是否是生产库路径（用于"打生产必须显式 --allow-production"这道闸）。 */
export function isProductionDb(p, env = process.env) {
  return sameRealPath(p, productionDbPath(env));
}

// ---------------------------------------------------------------- 身份表（§3.3-3）

/**
 * 从身份表文档里取 userid 列表 + owner —— **形态自适应**（2026-10-11 卡【翻译官·批4·家人档地基】新增）。
 *
 * 为什么必须做（**静默失真**，不是"兼容性优化"）：本档 §3.3 早期设计把表写成**平面 map**
 * （`{"<userid>": {...}}`，本文件 `parseIdentityTable` 的权威形态），而
 * 新形态（`{version, default, users}`）是：
 * `{version, default:"deny", users:{<userid>:{...}}}`。新表一落盘，只认平面 map 的读方会把**整表读成空**
 * ⇒ `resolveDefaultOwner` 回落常量、`ownerBindingDiff` 把全部 owner 判成"未登记" ⇒ **判据从绿变红却不报错**。
 * ⇒ 三种形态（平面 map / `{users:{…}}` / `[{userid,…}]`，外加 `{users:[…]}`）**统一在这里认**。
 *
 * 返回 `{ ok, why, shape, userids, owner }`；`ok:false` = 认不出（调用方按"不可用"处理，不判过）。
 */
export function useridsFromIdentityDoc(doc) {
  const out = { ok: false, why: null, shape: 'unknown', userids: [], owner: null };
  const META = new Set(['version', 'schemaVersion', 'default', 'product', 'updatedAt', 'note', '$schema']);
  const push = (uid, rec, seen) => {
    // 兼容"值就是 userid 字符串"的简写形态（`{"<userid>": "角色"}` / `["uid",…]`）—— 与 fork 实现同解
    if (typeof rec === 'string' && rec.trim() && !rec.startsWith('_')) {
      const v = rec.trim();
      if (!META.has(v) && !seen.has(v)) { seen.add(v); out.userids.push(v); }
      return;
    }
    const u = String(uid ?? '').trim();
    // `_` 前缀 = 注释键约定（三种形态一视同仁；`$schema` 同理）—— 2026-10-11 卡【家人档地基】补齐本处遗漏
    if (!u || u.startsWith('_') || u === '$schema' || seen.has(u)) return;
    seen.add(u);
    out.userids.push(u);
    if (out.owner === null && rec && typeof rec === 'object' && rec.role === 'owner') out.owner = u;
  };
  if (arrayOfRecords(doc)) {
    out.shape = 'array';
    const seen = new Set();
    for (const r of doc) push(r?.userid ?? r?.user ?? r?.id, r, seen);
    out.ok = true;
    return out;
  }
  // ⚠️ **数组但元素不是记录**（`[1,2]`）⇒ 判"认不出"，**绝不回落平面 map** ——
  //    回落会把 `[1,2]` 解析成 userid `"0"`/`"1"`（数组下标），把"不可用（不判过）"悄悄变成
  //    "认出了一个不存在的用户"。2026-10-11 本卡自查抓到（单测 `身份表：数组根 ⇒ ok=false` 抓住的）。
  if (Array.isArray(doc)) { out.why = '根节点是数组，但元素不是记录（不是 userid 列表）'; return out; }
  if (!doc || typeof doc !== 'object') { out.why = '根节点不是对象/数组'; return out; }
  const inner = doc.users ?? doc.members ?? null;
  if (inner && typeof inner === 'object' && !arrayOfRecords(inner)) {
    out.shape = 'object.users-map';
    const seen = new Set();
    for (const [uid, rec] of Object.entries(inner)) { if (uid.startsWith('_')) continue; push(uid, rec, seen); }
    out.ok = true;
    return out;
  }
  if (arrayOfRecords(inner)) {
    out.shape = 'object.users-array';
    const seen = new Set();
    for (const r of inner) push(r?.userid ?? r?.user ?? r?.id, r, seen);
    out.ok = true;
    return out;
  }
  // 平面 map：`{"<userid>": {...}}`（`_` 前缀 = 注释键，元数据键跳过）
  out.shape = 'flat-map';
  const seen = new Set();
  for (const [uid, rec] of Object.entries(doc)) {
    if (uid.startsWith('_') || META.has(uid)) continue;
    if (typeof rec === 'string') { push(rec, {}, seen); continue; }
    push(uid, rec, seen);
  }  out.ok = true;
  return out;
}

/**
 * 是不是"记录数组"（`[{userid,…}]` / `["uid",…]`）。
 * ⚠️ **不是"只要是数组就算"**：`[1,2]` 这类（元素既非对象也非字符串）必须**不认**——
 *    旧实现把"根节点是数组"一律拒（`ok:false`），若这里放宽成"元素随便"，
 *    就会把 `[1,2]` 从"认不出"悄悄变成"认出来但是空的"（判据由 `exit 2 不可用` 变 `差集=全部 owner`）⇒ 那是**误判**。
 */
function arrayOfRecords(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' || (x !== null && typeof x === 'object' && !Array.isArray(x)));
}

/**
 * 解析身份表 JSON（**三形态自适应**：平面 map / `{users:{…}}` / `[{userid,…}]`）。
 * 不抛异常；返回 `{ ok, userids, owner, error }`。
 */
export function parseIdentityTable(text) {
  let doc;
  try {
    doc = JSON.parse(String(text));
  } catch (e) {
    return { ok: false, userids: [], owner: null, error: `身份表 JSON 解析失败：${e.message}` };
  }
  const r = useridsFromIdentityDoc(doc);
  if (!r.ok) return { ok: false, userids: [], owner: null, error: `身份表形态认不出（${r.why ?? r.shape}）` };
  return { ok: true, userids: r.userids, owner: r.owner, shape: r.shape, error: null };
}

/** 只读身份表文件。返回 `{ ok, path, exists, userids, owner, error }`。 */
export function readIdentityTable(homeOrFile, env = process.env) {
  const file = homeOrFile || path.join(env.USERPROFILE || env.HOME || "", ...IDENTITY_TABLE_REL);
  const isFile = /\.json$/i.test(file);
  const p = isFile ? file : path.join(file, ...IDENTITY_TABLE_REL);
  if (!fs.existsSync(p)) {
    return { ok: false, path: p, exists: false, userids: [], owner: null, error: "身份表不存在（W1 线未落）" };
  }
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    return { ok: false, path: p, exists: true, userids: [], owner: null, error: `身份表读不到：${e.message}` };
  }
  return { ok: true, path: p, exists: true, ...parseIdentityTable(text) };
}

/**
 * 解析 `owner_user` 的默认值（§3.3-3 的取值优先级）：
 *   ① 身份表里 `role === 'owner'` 的那条  ② 缺省回落常量（并在启动自检里**报一行**）。
 * 返回 `{ ownerUser, source: 'identity-table' | 'fallback', notes:[…] }`。
 */
export function resolveDefaultOwner(identity) {
  const notes = [];
  if (identity && identity.ok && identity.owner) {
    return { ownerUser: identity.owner, source: "identity-table", notes };
  }
  if (identity && identity.exists && identity.ok && !identity.owner) {
    notes.push(`身份表 ${identity.path} 存在但**没有任何 role==='owner' 的条目** → 回落常量`);
  } else if (identity && identity.error) {
    notes.push(`身份表不可用（${identity.error}） → 回落常量`);
  }
  notes.push(`owner_user 默认值回落常量 '${FALLBACK_OWNER_USER}'（身份表缺位时的人工兜底，非硬编码设计）`);
  return { ownerUser: FALLBACK_OWNER_USER, source: "fallback", notes };
}

// ---------------------------------------------------------------- 列与迁移（§3.8 幂等做法）

/** 读某表的列名（PRAGMA table_info；表不存在返回 []）。 */
export function columnsOf(db, table = MEMORIES_TABLE) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  } catch {
    return [];
  }
}

/** 索引是否已存在。 */
export function hasIndex(db, name) {
  try {
    return db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name=?").get(name) !== undefined;
  } catch {
    return false;
  }
}

/**
 * 单列的 `ALTER TABLE ADD COLUMN` 语句。`defaultLiteral` 由调用方按 §3.3-3 解析后传入。
 * ⚠️ SQLite 的 ADD COLUMN 默认值**必须是常量表达式** ⇒ 动态默认值只能在 DDL 里写死为常量，
 * "从身份表取默认值"落在这里（解析出常量再拼进 DDL），而不是数据库端函数。
 */
export function buildAddColumnSql(col, defaultLiteral, table = MEMORIES_TABLE) {
  const parts = [`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.type}`];
  if (col.notNull) parts.push("NOT NULL");
  parts.push(`DEFAULT ${quoteLiteral(defaultLiteral)}`);
  return parts.join(" ");
}

/** SQL 字符串字面量转义（单引号翻倍）。 */
export function quoteLiteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * 迁移计划（**只读**，不改库）：算缺哪些列、要跑哪些语句、默认值取什么。
 * 返回 `{ columns, missing, present, indexExists, statements, defaultOwner, notes }`。
 */
export function migrationPlan(db, { identity = null, table = MEMORIES_TABLE } = {}) {
  const resolved = resolveDefaultOwner(identity);
  const columns = columnsOf(db, table);
  const missing = NEW_COLUMNS.filter((c) => !columns.includes(c.name));
  const present = NEW_COLUMNS.filter((c) => columns.includes(c.name)).map((c) => c.name);
  const statements = missing.map((c) =>
    buildAddColumnSql(c, c.defaultKind === "owner" ? resolved.ownerUser : c.defaultLiteral, table),
  );
  const indexExists = hasIndex(db, VISIBILITY_INDEX.name);
  if (!indexExists) statements.push(VISIBILITY_INDEX.sql);
  return {
    columns,
    missing: missing.map((c) => c.name),
    present,
    indexExists,
    statements,
    defaultOwner: resolved,
    notes: resolved.notes,
  };
}

/** 执行迁移（**幂等**；语句来自 migrationPlan，列已存在则天然无语句可跑）。返回实际执行的语句数组。 */
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
      /* rollback 失败时保留原始错误 */
    }
    throw e;
  }
  return ran;
}

// ---------------------------------------------------------------- 检索隔离（§3.3-4 · 不靠提示词靠 SQL）

/**
 * **家人侧**过滤（§3.3-4 原文）：`WHERE visibility IN ('family','public') OR owner_user = :self`。
 *
 * `options.registeredOwners`（可选）：给出**身份表已登记 userid 集合**时启用**严格模式** —— 追加
 * `AND owner_user IN (…)` 护栏，把"未登记 owner 的条"（超域条）挡在家人侧之外。理由：`visibility`
 * 是"主人显式共享"的标记，但一条 `visibility='family'` 而 `owner_user` 未登记的条，其归属人未知，
 * 不该因为共享标记而泄给家人；且判据 4 同时会判红。给不出身份表（不可用）⇒ **不返回任何他人条**
 * （fail-closed：只留 `owner_user = :self`）—— 宁可家人看不到共享条，不可多看到。
 */
export function familyScopeSql(selfUser, options = {}) {
  if (!selfUser) throw new Error("familyScopeSql 需要 selfUser（宿主 user id）");
  const { registeredOwners = null, strict = false } = options;
  if (Array.isArray(registeredOwners)) {
    const uniq = [...new Set(registeredOwners.filter((x) => typeof x === "string" && x))];
    if (uniq.length === 0) {
      return { mode: "strict-empty", where: "owner_user = ?", params: [selfUser], note: "身份表为空/不可用 ⇒ 只返回本人条（fail-closed）" };
    }
    const ph = uniq.map(() => "?").join(", ");
    return {
      mode: "strict",
      where: `(visibility IN ('family','public') OR owner_user = ?) AND owner_user IN (${ph})`,
      params: [selfUser, ...uniq],
      note: "严格模式：追加已登记 owner 护栏，挡超域条",
    };
  }
  void strict;
  return {
    mode: "base",
    where: "(visibility IN ('family','public') OR owner_user = ?)",
    params: [selfUser],
    note: "基础模式（§3.3-4 原文）：未登记 owner 的 family/public 条**会**被命中 ⇒ 需配判据 4 兜底",
  };
}

/** **主人侧注入层**过滤（§3.3-4：默认只注入 `owner_user = 主人` 的条）。 */
export function ownerScopeSql(ownerUser, options = {}) {
  if (!ownerUser) throw new Error("ownerScopeSql 需要 ownerUser");
  const { includeShared = false } = options;
  if (includeShared) {
    return { mode: "owner+shared", where: "(owner_user = ? OR visibility IN ('family','public'))", params: [ownerUser] };
  }
  return { mode: "owner-only", where: "owner_user = ?", params: [ownerUser] };
}

/**
 * 真跑一次过滤查询（夹具与实现层都用它，避免各写一份 SQL）。
 * `options.tagLike`（可选）：追加 `tags LIKE ?` —— 夹具用它把结果限定在夹具条内，
 * 否则真实数据量一大就会被 `limit` 截断，断言会**假绿**（2026-09-20 本卡实测踩过：库内 599 条真实条
 * 把夹具条挤出 LIMIT 500，导致"主人注入层命中主人自己的条"假红、"不注入家人条"假绿）。
 */
export function selectMemories(db, scope, { columns = "id, owner_user, visibility, tags", limit = 500, tagLike = null } = {}) {
  const where = tagLike ? `(${scope.where}) AND tags LIKE ?` : scope.where;
  const params = tagLike ? [...scope.params, tagLike] : scope.params;
  const sql = `SELECT ${columns} FROM ${MEMORIES_TABLE} WHERE ${where} ORDER BY id LIMIT ${Number(limit)}`;
  return db.prepare(sql).all(...params);
}

// ---------------------------------------------------------------- 判据 4：身份绑定一致

/**
 * 判据 4（§5-3 / §3.3-3）：`secretary-user list` 的 userid 集合 ⊇ `SELECT DISTINCT owner_user`，
 * 差集 = 0（新 owner 一旦写库就必须在身份表里，未登记即判红）。
 * 返回 `{ owners, registered, unregistered, ok }`。
 */
export function ownerBindingDiff(db, identity) {
  const owners = db
    .prepare(`SELECT DISTINCT owner_user AS u FROM ${MEMORIES_TABLE} WHERE owner_user IS NOT NULL ORDER BY owner_user`)
    .all()
    .map((r) => r.u);
  const registered = identity && identity.ok ? [...identity.userids] : [];
  const regSet = new Set(registered);
  const unregistered = identity && identity.ok ? owners.filter((u) => !regSet.has(u)) : [...owners];
  return {
    owners,
    registered,
    unregistered,
    ok: Boolean(identity && identity.ok) && unregistered.length === 0,
    identityUsable: Boolean(identity && identity.ok),
  };
}

// ---------------------------------------------------------------- 杂项

/** 文件 sha256（读不动时返回 null）。 */
export function sha256File(p) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

/** 表行数。 */
export function tableCount(db, table = MEMORIES_TABLE) {
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  } catch {
    return null;
  }
}

/**
 * `VACUUM INTO` 在线快照（**只读源库**，绝不写源库本体）。
 * 目标已存在先删（VACUUM INTO 要求目标不存在）。
 */
export function vacuumInto(srcDbPath, destPath) {
  const dest = path.resolve(destPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest);
  // 动态 import：本模块被纯逻辑单测引用时不强制加载 sqlite 绑定
  return import("node:sqlite").then(({ DatabaseSync }) => {
    const db = new DatabaseSync(srcDbPath, { readOnly: true });
    try {
      db.exec(`VACUUM INTO ${quoteLiteral(dest.replace(/\\/g, "/"))}`);
    } finally {
      db.close();
    }
    return dest;
  });
}

/** 数据源信息（给人看的摘要）。 */
export function describeDb(db, table = MEMORIES_TABLE) {
  return {
    columns: columnsOf(db, table),
    count: tableCount(db, table),
    visibilityIndex: hasIndex(db, VISIBILITY_INDEX.name),
  };
}
