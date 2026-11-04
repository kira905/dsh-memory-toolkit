/**
 * test/source-ids.test.mjs —— 观察级血缘列 `source_ids` 单测
 *
 * 覆盖（正例 + 反例 + 阴性对照）：
 *   01 迁移：老库（无列）⇒ before → after（建 meta 表 + 加列 + 写版本键，单事务）
 *   02 幂等：第二次 0 语句、版本键不变
 *   03 列定义：NOT NULL + 默认 ''；存量行读回空串（= 无来源声明）
 *   04 fail-closed：列在键缺 / 键在列缺 ⇒ mismatch ⇒ 拒写并给明确错误码
 *   05 归一：去重保序 / trim / 长度上限 / 条数上限 / 非数组 ⇒ []（绝不抛）
 *   06 序列化 / 解析：空 ⇒ `''`；坏 JSON ⇒ `[]`
 *   07 **隔离**：写进独立列、没写进 tags ⇒ FTS 全文检索搜不到那个 id
 *   08 端到端（真 apply + mock ctx）：memory_write 带 source_ids ⇒ 落库正确；
 *      不带 ⇒ 列值为 `''`（与存量同形）；memory_search 搜 id token ⇒ 0 命中
 *
 * 家规：一切路径来自临时目录，不碰任何宿主 home。
 * 跑法：node --test test/source-ids.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import * as mod from '../src/index.js';
import {
  SOURCE_IDS_COLUMN,
  SCHEMA_META_TABLE,
  SOURCE_IDS_VERSION_KEY,
  SOURCE_IDS_VERSION_AFTER,
  SOURCE_IDS_MAX_ITEMS,
  SOURCE_IDS_MAX_ITEM_CHARS,
  SOURCE_IDS_BLOCKED_CODE,
  readSchemaMeta,
  writeSchemaMeta,
  sourceIdsMigrationState,
  applySourceIdsMigration,
  ensureSourceIdsColumn,
  normalizeSourceIds,
  serializeSourceIds,
  parseSourceIds,
} from '../src/source-ids-migrate.mjs';

/** 老库形态（= 加列之前的 `memories` 表 + FTS 触发器，与插件建表 DDL 同构）。 */
const LEGACY_DDL = `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(text, tags, content='memories', content_rowid='id');
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, text, tags) VALUES (new.id, new.text, new.tags);
  END;
`;

function tmpDb(withLegacy = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-source-ids-'));
  const file = path.join(dir, 'memory.db');
  const db = new DatabaseSync(file);
  if (withLegacy) db.exec(LEGACY_DDL);
  return {
    db,
    file,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

// ── 01 迁移 ────────────────────────────────────────────────────────────────
test('迁移：老库无列 ⇒ before，迁完 ⇒ after，列定义 NOT NULL 且默认空串', () => {
  const t = tmpDb();
  try {
    assert.equal(sourceIdsMigrationState(t.db).state, 'before');
    const sid = applySourceIdsMigration(t.db);
    assert.equal(sid.ok, true);
    assert.equal(sid.state, 'after');
    assert.equal(sid.ran.length, 3, JSON.stringify(sid.ran));
    assert.equal(sourceIdsMigrationState(t.db).state, 'after');
    assert.equal(readSchemaMeta(t.db, SOURCE_IDS_VERSION_KEY), SOURCE_IDS_VERSION_AFTER);

    const col = t.db.prepare('PRAGMA table_info(memories)').all().find((c) => c.name === SOURCE_IDS_COLUMN.name);
    assert.ok(col, '列必须加上');
    assert.equal(col.type, 'TEXT');
    assert.equal(col.notnull, 1);
    assert.equal(col.dflt_value, "''");
    // schema_meta 表真的建出来了
    const meta = t.db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(SCHEMA_META_TABLE);
    assert.ok(meta, 'schema_meta 表必须存在');
  } finally {
    t.cleanup();
  }
});

test('迁移：存量行在加列后读回空串（= 无来源声明，与存量逐字节同形）', () => {
  const t = tmpDb();
  try {
    t.db.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('旧记忆', 'recall:manual', 0, 1, 1);
    applySourceIdsMigration(t.db);
    assert.equal(t.db.prepare('SELECT source_ids FROM memories WHERE id = 1').get().source_ids, '');
  } finally {
    t.cleanup();
  }
});

// ── 02 幂等 ────────────────────────────────────────────────────────────────
test('幂等：已是 after ⇒ 零语句、版本键不被改写', () => {
  const t = tmpDb();
  try {
    applySourceIdsMigration(t.db);
    writeSchemaMeta(t.db, SOURCE_IDS_VERSION_KEY, SOURCE_IDS_VERSION_AFTER);
    const again = applySourceIdsMigration(t.db);
    assert.equal(again.ok, true);
    assert.deepEqual(again.ran, []);
    assert.equal(readSchemaMeta(t.db, SOURCE_IDS_VERSION_KEY), SOURCE_IDS_VERSION_AFTER);
  } finally {
    t.cleanup();
  }
});

// ── 04 fail-closed ────────────────────────────────────────────────────────
test('fail-closed：列在但版本键缺 ⇒ mismatch，拒动并给出理由（不猜、不补键）', () => {
  const t = tmpDb();
  try {
    // 手工造半迁移态：只加列、不写键
    t.db.exec('ALTER TABLE memories ADD COLUMN source_ids TEXT NOT NULL DEFAULT \'\'');
    const st = sourceIdsMigrationState(t.db);
    assert.equal(st.state, 'mismatch');
    assert.match(st.reason, /自相矛盾/);
    const sid = applySourceIdsMigration(t.db);
    assert.equal(sid.ok, false);
    assert.equal(sid.state, 'mismatch');
    assert.deepEqual(sid.ran, []);
    // 键不会被偷偷补上
    assert.equal(readSchemaMeta(t.db, SOURCE_IDS_VERSION_KEY), null);
  } finally {
    t.cleanup();
  }
});

test('fail-closed：版本键=1 但列缺 ⇒ mismatch', () => {
  const t = tmpDb();
  try {
    writeSchemaMeta(t.db, SOURCE_IDS_VERSION_KEY, SOURCE_IDS_VERSION_AFTER);
    const st = sourceIdsMigrationState(t.db);
    assert.equal(st.state, 'mismatch');
    assert.equal(st.columnExists, false);
  } finally {
    t.cleanup();
  }
});

test('fail-closed：版本键是野值（比如被改成 2）⇒ mismatch', () => {
  const t = tmpDb();
  try {
    applySourceIdsMigration(t.db);
    writeSchemaMeta(t.db, SOURCE_IDS_VERSION_KEY, '2');
    assert.equal(sourceIdsMigrationState(t.db).state, 'mismatch');
  } finally {
    t.cleanup();
  }
});

test('高层入口：mismatch 态返回 writeBlocked（带固定错误码），不抛', () => {
  const t = tmpDb();
  try {
    t.db.exec('ALTER TABLE memories ADD COLUMN source_ids TEXT NOT NULL DEFAULT \'\'');
    const out = ensureSourceIdsColumn(t.db, { dbPath: t.file });
    assert.equal(out.ok, false);
    assert.ok(out.writeBlocked, '必须给出写闸');
    assert.equal(out.writeBlocked.code, SOURCE_IDS_BLOCKED_CODE);
    assert.equal(out.writeBlocked.state, 'mismatch');
    assert.ok(out.writeBlocked.reason.length > 0);
  } finally {
    t.cleanup();
  }
});

test('高层入口：表还不存在时跳过（交给建表 DDL），不误报 fail-closed', () => {
  const t = tmpDb(false);
  try {
    const out = ensureSourceIdsColumn(t.db, { dbPath: t.file });
    assert.equal(out.state, 'no-table');
    assert.equal(out.writeBlocked, null);
  } finally {
    t.cleanup();
  }
});

// ── 05 归一 ────────────────────────────────────────────────────────────────
test('归一：去重保序 / trim / 丢脏值 / 非数组 ⇒ []', () => {
  assert.deepEqual(normalizeSourceIds([' b ', 'a', 'b', 3, null, {}, '', '  ']), ['b', 'a', '3']);
  assert.deepEqual(normalizeSourceIds('not-an-array'), []);
  assert.deepEqual(normalizeSourceIds(undefined), []);
  assert.deepEqual(normalizeSourceIds([]), []);
});

test('归一：单条长度上限与条数上限（超限截断，**绝不拒绝写入**）', () => {
  const tooLong = 'x'.repeat(SOURCE_IDS_MAX_ITEM_CHARS + 1);
  assert.deepEqual(normalizeSourceIds([tooLong, 'ok']), ['ok']);
  const many = Array.from({ length: SOURCE_IDS_MAX_ITEMS + 5 }, (_, i) => `c${i}`);
  assert.equal(normalizeSourceIds(many).length, SOURCE_IDS_MAX_ITEMS);
  assert.deepEqual(normalizeSourceIds([SOURCE_IDS_MAX_ITEM_CHARS === 200 ? 'y'.repeat(200) : 'y']).length, 1);
});

// ── 06 序列化 / 解析 ──────────────────────────────────────────────────────
test('序列化：空 ⇒ 空串（与存量同形）；有值 ⇒ JSON 数组字符串，往返无损', () => {
  assert.equal(serializeSourceIds([]), '');
  assert.equal(serializeSourceIds(null), '');
  assert.equal(serializeSourceIds(['a', 'b']), '["a","b"]');
  assert.deepEqual(parseSourceIds('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseSourceIds(''), []);
  assert.deepEqual(parseSourceIds('{bad json'), []);
  assert.deepEqual(parseSourceIds('{"a":1}'), []);
  assert.deepEqual(parseSourceIds('["a",2,null,""]'), ['a']);
});

// ── 07 隔离：不进 tags ⇒ 不进 FTS ─────────────────────────────────────────
test('隔离：source_ids 落在独立列，FTS 全文检索搜不到那个 id', () => {
  const t = tmpDb();
  try {
    applySourceIdsMigration(t.db);
    const lineage = serializeSourceIds(['chunk-abc123']);
    t.db.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at, source_ids) VALUES (?, ?, ?, ?, ?, ?)')
      .run('一条有血缘的记忆', 'recall:manual', 0, 1, 1, lineage);
    const hits = t.db.prepare("SELECT m.id FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid WHERE memories_fts MATCH ?").all('"chunk-abc123"');
    assert.equal(hits.length, 0, '来源 id 不得出现在全文检索里');
    // 但按 id 读回是够的
    assert.deepEqual(parseSourceIds(t.db.prepare('SELECT source_ids FROM memories WHERE id = 1').get().source_ids), ['chunk-abc123']);
  } finally {
    t.cleanup();
  }
});

// ── 08 端到端 ─────────────────────────────────────────────────────────────
function applyWithMockCtx(dbFile) {
  const registered = [];
  const sections = [];
  const listeners = [];
  const ctx = {
    tools: { register: (tool) => { registered.push(tool); return () => {}; } },
    systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    on: (event, handler, options) => { listeners.push({ event, handler, options }); return () => {}; },
  };
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-source-ids-home-'));
  const base = {
    path: dbFile,
    promptRecentCount: 10,
    promptMaxChars: 2000,
    maxTextChars: 2000,
    searchLimitDefault: 10,
    searchLimitMax: 50,
    promptOrder: 50,
  };
  const config = typeof mod.Config === 'function'
    ? mod.Config({
        ...base,
        recallEnabled: false,
        recallHome: tmpHome,
        recallMemoryDb: path.join(tmpHome, 'memory', 'memory.db'),
        recallVectorsDb: path.join(tmpHome, 'memory-vectors', 'vectors.db'),
      })
    : base;
  mod.apply(ctx, config);
  const tool = (n) => registered.find((t) => t && t.name === n);
  return { tool, tmpHome, cleanup: () => { try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

test('端到端：memory_write 带 source_ids ⇒ 落独立列；不带 ⇒ 列值空串；检索不被污染', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-source-ids-e2e-'));
  const dbFile = path.join(dir, 'memory.db');
  const h = applyWithMockCtx(dbFile);
  try {
    const write = h.tool('memory_write');
    // 本仓不带 peer 依赖（`@deepseek-ai/dsh-tools` 缺席时插件按设计**跳过工具注册**、不崩 boot）
    // ⇒ 端到端这一层在无宿主符号的环境里明确跳过，而不是假装通过。
    if (typeof write?.execute !== 'function') {
      t.skip('宿主符号 @deepseek-ai/dsh-tools 不可用 ⇒ 工具未注册（端到端需在带 peer 依赖的环境跑）');
      return;
    }
    const withLineage = await write.execute({
      text: '结论：这条是从两条观察推出来的',
      tags: ['Probe', 'probe'],
      pinned: false,
      source_ids: ['chunk-abc123', 'chunk-def456'],
    });
    const withoutLineage = await h.tool('memory_write').execute({ text: '结论：这条没有来源声明', tags: ['probe'], pinned: false });
    assert.ok(Number.isInteger(withLineage.id) && Number.isInteger(withoutLineage.id));

    const db = new DatabaseSync(dbFile);
    try {
      const a = db.prepare('SELECT source_ids, tags FROM memories WHERE id = ?').get(withLineage.id);
      const b = db.prepare('SELECT source_ids FROM memories WHERE id = ?').get(withoutLineage.id);
      assert.equal(a.source_ids, '["chunk-abc123","chunk-def456"]');
      assert.equal(b.source_ids, '');
      // 铁律：绝不写进 tags
      assert.equal(a.tags.includes('chunk-'), false, `tags 被污染: ${a.tags}`);
    } finally {
      db.close();
    }

    // 搜那个 id token ⇒ 0 命中（FTS 只索引 text/tags）
    const found = await h.tool('memory_search').execute({ query: 'chunk-abc123' });
    assert.equal(found.matches.length, 0, JSON.stringify(found.matches));
    // 正文照常能搜到
    const byText = await h.tool('memory_search').execute({ query: '观察推出来的' });
    assert.equal(byText.matches.length, 1);
    assert.equal(byText.matches[0].id, withLineage.id);
  } finally {
    h.cleanup();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

test('端到端：半迁移库（列在键缺）⇒ memory_write 拒绝写入并给固定错误码', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-source-ids-e2e2-'));
  const dbFile = path.join(dir, 'memory.db');
  // 先造一个"列在键缺"的库，再让插件打开它
  const seed = new DatabaseSync(dbFile);
  try {
    seed.exec(LEGACY_DDL);
    seed.exec('ALTER TABLE memories ADD COLUMN source_ids TEXT NOT NULL DEFAULT \'\'');
  } finally {
    seed.close();
  }
  const h = applyWithMockCtx(dbFile);
  try {
    const write = h.tool('memory_write');
    if (typeof write?.execute !== 'function') {
      t.skip('宿主符号 @deepseek-ai/dsh-tools 不可用 ⇒ 工具未注册（端到端需在带 peer 依赖的环境跑）');
      return;
    }
    await assert.rejects(
      () => write.execute({ text: '这条不该落库', tags: [], pinned: false }),
      (err) => {
        assert.equal(err.code, SOURCE_IDS_BLOCKED_CODE);
        assert.match(err.message, /拒绝写入/);
        return true;
      },
    );
    const db = new DatabaseSync(dbFile);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0, '拒绝写入必须是真拒绝');
    } finally {
      db.close();
    }
  } finally {
    h.cleanup();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
