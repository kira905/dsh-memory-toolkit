// 06 · 文档索引层（独立库 / 扫描面 / 粒度 / 幂等 / 变更感知 / 锁与重试 / 成本闸 / 重建一致）
//
// 铁律：夹具一律落 os.tmpdir()，库/state/日报全在临时根下 —— 绝不碰 ~/.dsh 与生产 docs。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, assert, assertEq } from './harness.mjs';
import {
  COLUMNS,
  META_KEYS,
  getMeta,
  getMetaAll,
  getRow,
  listRows,
  openDocIndexStore,
  countRows,
  isBusyError,
  withBusyRetry,
  upsertDocs,
  deleteDoc,
  escapeLike,
} from '../lib/doc-index-store.mjs';
import {
  EXCLUDE_DIRS,
  FIRST_BATCH,
  LONG_DOC_CHARS,
  SUMMARY_MAX_CHARS,
  isExcludedRel,
  parseStructure,
  pickParagraph,
  planRowCount,
  planRows,
  scanDocs,
  splitSections,
  toRelPath,
} from '../lib/doc-scan.mjs';
import {
  LLM_LIMITS,
  buildLlmView,
  buildRuleSummary,
  checkCostGate,
  emptyCost,
  parseLlmRows,
  rolloverCost,
  summarizeAll,
} from '../lib/doc-summarize.mjs';
import {
  DAILY_SECTION_TITLE,
  dailyReportPath,
  needsRebuild,
  renderDailyLine,
  resolveScope,
  runDocIndexOnce,
  updateDailySection,
} from '../lib/doc-index.mjs';

export const __section = '06 · 文档索引层（独立库 / 扫描面 / 粒度 / 幂等 / 变更感知 / 锁重试 / 成本闸）';

// ---------------------------------------------------------------- 夹具

/** 临时沙箱：docs 根 + 库 + state + 日报，全部在 tmp 下 */
function makeSandbox(prefix = 'dsh-doc-index-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const docsRoot = path.join(root, 'DSH', 'docs');
  fs.mkdirSync(docsRoot, { recursive: true });
  const paths = {
    root,
    dshRoot: path.join(root, 'DSH'),
    docsRoot,
    dbPath: path.join(root, 'memory-vectors', 'doc-index.db'),
    stateFile: path.join(root, 'butler-doc-index-state.json'),
  };
  return {
    ...paths,
    write(rel, text) {
      const abs = path.join(paths.dshRoot, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text, 'utf8');
      return abs;
    },
    /** 改文档内容并把 mtime 推到未来（模拟"文档真的变了"） */
    touch(rel, text, plusMs = 5000) {
      const abs = path.join(paths.dshRoot, rel);
      fs.writeFileSync(abs, text, 'utf8');
      const st = fs.statSync(abs);
      const t = new Date(st.mtimeMs + plusMs);
      fs.utimesSync(abs, t, t);
      return abs;
    },
    flags(extra = {}) {
      return {
        'docs-root': paths.docsRoot,
        'dsh-root': paths.dshRoot,
        'doc-index-db': paths.dbPath,
        'state-file': paths.stateFile,
        'no-daily': true,
        ...extra,
      };
    },
    cleanup() {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** 快跑的注入（跳过退避等待、busy_timeout 压到 ~30ms） */
const FAST = {
  sleep: async () => {},
  retryDelaysMs: [1, 1, 1],
  openStore: (p, o) => openDocIndexStore(p, { ...o, busyTimeoutMs: 30 }),
};

function mkDoc(rel, text) {
  return { rel, chars: text.length, structure: parseStructure(text) };
}

const SHORT_DOC = `# 短文档 A

引言：这是一份短文档，用来说明主人与机器人的关系设定。

## 一、第一节标题

本节讲关系设定：主人 = 用户，机器人负责干活。
还有第二句不该出现。

## 二、第二节标题

本节讲工作环境：本机装在 D: 盘。
`;

/** 长文档：> 2 万字、多个 H2（用于验证 2~5 条切分） */
function longDoc(sections = 8, sectionChars = 3000) {
  const parts = ['# 长文档 L\n\n引言：这是一份超长文档用于验证切条。\n'];
  for (let i = 1; i <= sections; i += 1) {
    parts.push(`\n## 第 ${i} 节标题\n\n${`第 ${i} 节正文。`.repeat(Math.ceil(sectionChars / 8))}\n`);
  }
  return parts.join('');
}

// ---------------------------------------------------------------- 1. 独立库与表结构

test('建库：doc_index + meta 表按需创建，schemaVersion/hostId 自动落 meta', () => {
  const s = makeSandbox();
  try {
    const store = openDocIndexStore(s.dbPath, { hostId: 'test-host' });
    assertEq(store.schema.tables.doc_index, true, 'doc_index 表');
    assertEq(store.schema.tables.meta, true, 'meta 表');
    assert(store.schema.created.includes('doc_index'), '首次应报告新建 doc_index');
    assertEq(getMeta(store.db, META_KEYS.schemaVersion), '1', 'schemaVersion');
    assertEq(getMeta(store.db, META_KEYS.hostId), 'test-host', 'hostId');
    const again = openDocIndexStore(s.dbPath, { hostId: 'other' });
    assertEq(again.schema.created.length, 0, '重开不重建（幂等）');
    assertEq(getMeta(again.db, META_KEYS.hostId), 'test-host', 'hostId 不被覆盖');
    store.db.close();
    again.db.close();
    assert(fs.existsSync(s.dbPath), '库文件存在');
  } finally {
    s.cleanup();
  }
});

test('表结构：与方案 §3.2 逐列一致（列名/类型/NOT NULL/默认值/主键）', () => {
  const s = makeSandbox();
  try {
    const store = openDocIndexStore(s.dbPath);
    const info = store.db.prepare('PRAGMA table_info(doc_index)').all();
    assertEq(info.length, COLUMNS.length, '列数');
    const actual = info.map((c) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      dflt: c.dflt_value,
      pk: c.pk,
    }));
    assertEq(actual, COLUMNS, '逐列比对');
    store.db.close();
  } finally {
    s.cleanup();
  }
});

test('meta：三键（schemaVersion / hostId / lastRunAt）在跑完一轮后齐备', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    const r = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md' }), deps: FAST, now: () => 1760000000000 });
    assertEq(r.status, 'ok', '状态');
    const store = openDocIndexStore(s.dbPath, { create: false });
    const meta = getMetaAll(store.db);
    assert(Boolean(meta.schemaVersion), 'schemaVersion');
    assert(Boolean(meta.hostId), 'hostId');
    assert(Boolean(meta.lastRunAt), 'lastRunAt');
    store.db.close();
  } finally {
    s.cleanup();
  }
});

test('UPSERT 幂等：同 path 覆盖不新增行；text_hash 相同则整条不重写', () => {
  const s = makeSandbox();
  try {
    const store = openDocIndexStore(s.dbPath);
    const base = { path: 'docs/a.md', mtime: 1, size: 10, textHash: 'h1', summary: 'S1', updatedAt: 1 };
    const r1 = upsertDocs(store.db, [base]);
    assertEq(r1, { inserted: 1, updated: 0, unchanged: 0 }, '首次插入');
    const r2 = upsertDocs(store.db, [{ ...base, mtime: 2, summary: 'S1-again' }]);
    assertEq(r2, { inserted: 0, updated: 0, unchanged: 1 }, '同哈希 ⇒ 不重写');
    assertEq(countRows(store.db), 1, '条数不变');
    assertEq(getRow(store.db, 'docs/a.md').mtime, 1, '同哈希时不更新 mtime');
    const r3 = upsertDocs(store.db, [{ ...base, textHash: 'h2', summary: 'S2' }]);
    assertEq(r3, { inserted: 0, updated: 1, unchanged: 0 }, '哈希变 ⇒ 更新');
    store.db.close();
  } finally {
    s.cleanup();
  }
});

test('默认值与多人口径：owner_user / visibility 落库可核对', () => {
  const s = makeSandbox();
  try {
    const store = openDocIndexStore(s.dbPath);
    upsertDocs(store.db, [{ path: 'docs/a.md', mtime: 1, size: 1, textHash: 'h', summary: 'S', updatedAt: 1 }]);
    const row = getRow(store.db, 'docs/a.md');
    assertEq(row.owner_user, 'LiJianXiao', 'owner_user 默认');
    assertEq(row.visibility, 'private_owner', 'visibility 默认');
    store.db.close();
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------- 2. 扫描面与粒度

test('扫描面：只收 .md，排除 变更流水/管家报告/坑库/_archive（按目录段）', () => {
  const s = makeSandbox();
  try {
    s.write('docs/keep.md', '# keep\n');
    s.write('docs/变更流水/2026-09.md', '# 流水\n');
    s.write('docs/管家报告/2026-09-21-x.md', '# 日报\n');
    s.write('docs/坑库/坑-sample.md', '# 坑\n');
    s.write('docs/_archive/old.md', '# 归档\n');
    s.write('docs/sub/keep2.md', '# keep2\n');
    s.write('docs/sub/坑库/inner.md', '# 内层坑\n');
    s.write('docs/notmd.txt', 'x');
    const rels = scanDocs(s.docsRoot, { dshRoot: s.dshRoot }).map((d) => d.rel);
    assertEq(rels, ['docs/keep.md', 'docs/sub/keep2.md'], '命中面');
    assertEq(EXCLUDE_DIRS.length, 4, '排除目录 4 类');
    assertEq(isExcludedRel('docs/坑库-a.md'), false, '文件名含"坑库"但非目录段 ⇒ 不排除');
    assertEq(isExcludedRel('docs/坑库/a.md'), true, '目录段命中 ⇒ 排除');
  } finally {
    s.cleanup();
  }
});

test('path 口径：相对 DSH 根、统一 / 分隔', () => {
  const drv = path.parse(process.cwd()).root;
  assertEq(toRelPath(path.join(drv, 'DSH', 'docs', 'a.md'), path.join(drv, 'DSH')), 'docs/a.md', '反斜杠归一');
  assertEq(toRelPath(path.join(drv, 'DSH', 'docs', 'sub', 'b.md'), path.join(drv, 'DSH')), 'docs/sub/b.md', '子目录');
});

test('结构解析：H1 作标题、引言与 `##` 小节分开、`###` 归入所属小节', () => {
  const st = parseStructure(SHORT_DOC);
  assertEq(st.title, '短文档 A', '标题');
  assert(st.intro.includes('短文档'), '引言');
  assertEq(st.sections.map((x) => x.title), ['一、第一节标题', '二、第二节标题'], '小节标题');
  const st2 = parseStructure('# T\n\n## A\n\n### A1\n\n正文A1\n\n## B\n\n正文B\n');
  assertEq(st2.sections.length, 2, '### 不另起小节');
  assert(st2.sections[0].body.includes('A1'), '### 归入所属小节');
});

test('粒度：短文档 1 条（主键 = path）；长文档按 ## 切 2~5 条（主键 = path#§N）', () => {
  const short = mkDoc('docs/s.md', SHORT_DOC);
  const rowsShort = planRows(short);
  assertEq(rowsShort.length, 1, '短文档 1 条');
  assertEq(rowsShort[0].key, 'docs/s.md', '短文档主键 = path');

  const text = longDoc(8, 3000);
  const long = mkDoc('docs/l.md', text);
  assert(long.chars > LONG_DOC_CHARS, `夹具应超 ${LONG_DOC_CHARS} 字（实际 ${long.chars}）`);
  const rowsLong = planRows(long);
  assert(rowsLong.length >= 2 && rowsLong.length <= 5, `长文档 2~5 条（实际 ${rowsLong.length}）`);
  assertEq(rowsLong.map((r) => r.key), rowsLong.map((_, i) => `docs/l.md#§${i + 1}`), '长文档主键 = path#§N');
  const allSections = rowsLong.flatMap((r) => r.sections.map((s) => s.title));
  assertEq(allSections, long.structure.sections.map((s) => s.title), '小节不丢不重（保序）');
});

test('粒度边界：无 ## 小节的超长文档退 1 条（无可聚合对象）；planRowCount 落在 2~5', () => {
  assertEq(planRowCount(1000, 5), 1, '短文档 1 条');
  assertEq(planRowCount(25000, 8), 2, '2 万字级 → 2 条');
  assertEq(planRowCount(200000, 30), 5, '超长 → 上限 5 条');
  assertEq(planRowCount(25000, 1), 1, '只有 1 个小节 ⇒ 退 1 条');
  const rows = planRows(mkDoc('docs/x.md', `# T\n\n${'正文。'.repeat(6000)}`));
  assertEq(rows.length, 1, '无 ## ⇒ 1 条');
});

test('切分确定性：splitSections 分组不丢条、组数恰为 k', () => {
  const secs = Array.from({ length: 7 }, (_, i) => ({ title: `s${i}`, chars: 10, body: '' }));
  const g = splitSections(secs, 3);
  assertEq(g.length, 3, '组数');
  assertEq(g.flat().map((s) => s.title), secs.map((s) => s.title), '保序且不丢');
});

// ---------------------------------------------------------------- 3. 摘要生成

test('摘要：每条 ≤500 字，含标题/关键章节/要点，且确定性（两次逐字节相同）', () => {
  const doc = mkDoc('docs/s.md', SHORT_DOC);
  const row = planRows(doc)[0];
  const a = buildRuleSummary(doc, row);
  const b = buildRuleSummary(doc, row);
  assertEq(a, b, '确定性');
  assert(a.length <= SUMMARY_MAX_CHARS, `≤${SUMMARY_MAX_CHARS} 字（实际 ${a.length}）`);
  assert(a.includes('短文档 A'), '含标题');
  assert(a.includes('关键章节：'), '含关键章节行');
  assert(a.includes('一、第一节标题'), '关键小节名在');
  assert(a.includes('要点：'), '含要点');
  // 说明行取自真正文（H1 后的第一段），不取引用块/表格 —— 引用块场景见下一条用例
  assert(a.includes('说明：引言：这是一份短文档'), '说明取自真正文');
});

test('摘要：长文档分段后各条互不重复关键章节（分组边界清晰）', () => {
  const doc = mkDoc('docs/l.md', longDoc(8, 3000));
  const rows = planRows(doc);
  const chapters = rows.map((r) => buildRuleSummary(doc, r).match(/关键章节：([^要]*)要点/)?.[1] ?? '');
  assertEq(new Set(chapters).size, chapters.length, '各段关键章节不同');
  for (const c of chapters) assert(c.trim().length > 0, '关键章节非空');
});

test('摘要清洗：引用块/表格/分隔线不进正文（否则所有索引条长一样）', () => {
  const body = '> ↑本主题总纲见 docs\\x.md\n\n---\n\n| a | b |\n|---|---|\n\n真正的正文在这里，讲的是部署流程。\n';
  const p = pickParagraph(body);
  assert(p.startsWith('真正的正文'), `应跳过引用块/分隔线/表格（实际：${p.slice(0, 30)}）`);
});

test('成本闸：调用/ token 任一达上限 ⇒ 拒绝', () => {
  assertEq(checkCostGate(emptyCost('2026-09-21')).allowed, true, '空账放行');
  assertEq(checkCostGate({ date: 'd', calls: LLM_LIMITS.callsPerDay, tokens: 0 }).allowed, false, '次数上限');
  assertEq(checkCostGate({ date: 'd', calls: 0, tokens: LLM_LIMITS.tokensPerDay }).allowed, false, 'token 上限');
  assertEq(rolloverCost({ date: '2026-09-20', calls: 99, tokens: 999 }, '2026-09-21'), emptyCost('2026-09-21'), '跨日重置');
  assertEq(LLM_LIMITS.callsPerDay, 20, '§3.5 次数上限 20/日');
  assertEq(LLM_LIMITS.tokensPerDay, 150000, '§3.5 token 上限 150K/日');
});

test('LLM 通路：mock fetch 返回 JSON ⇒ 摘要来自模型；压缩视图不是全文', async () => {
  const doc = mkDoc('docs/l.md', longDoc(4, 3000));
  const rows = planRows(doc);
  const view = buildLlmView(doc);
  assert(view.length < doc.chars, `压缩视图应小于全文（${view.length} < ${doc.chars}）`);
  let sent = null;
  const deps = {
    fetch: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: 'glm-test',
          choices: [
            {
              message: {
                content: JSON.stringify({ rows: rows.map((r) => ({ index: r.index, summary: `模型摘要-${r.index}` })) }),
              },
            },
          ],
          usage: { total_tokens: 1234 },
        }),
      };
    },
  };
  const res = await summarizeAll({
    docs: [doc],
    plans: new Map([[doc.rel, rows]]),
    mode: 'llm',
    cost: emptyCost('2026-09-21'),
    date: '2026-09-21',
    llm: { apiKey: 'k', baseUrl: 'https://x/api', model: 'glm-test' },
    deps,
  });
  assertEq(res.calls, 1, '一篇一次调用');
  assertEq(res.tokens, 1234, 'token 记账取 usage');
  for (const r of rows) assertEq(res.byKey.get(r.key).summary, `模型摘要-${r.index}`, '摘要来自模型');
  assert(!sent.body.messages[0].content.includes('第 1 节正文。第 1 节正文。第 1 节正文'), '提示里不应是全文');
});

test('LLM 解析：容忍 ```json 围栏与前后废话；解析失败降级规则摘要并记失败', async () => {
  assertEq(parseLlmRows('前言\n```json\n{"rows":[{"index":0,"summary":"S"}]}\n```\n后话')[0].summary, 'S', '围栏解析');
  const doc = mkDoc('docs/s.md', SHORT_DOC);
  const rows = planRows(doc);
  const deps = {
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '这不是 JSON' } }] }) }),
  };
  const res = await summarizeAll({
    docs: [doc],
    plans: new Map([[doc.rel, rows]]),
    mode: 'llm',
    cost: emptyCost('2026-09-21'),
    date: '2026-09-21',
    llm: { apiKey: 'k', baseUrl: 'https://x', model: 'm' },
    deps,
  });
  assertEq(res.failures.length, 1, '记一条失败');
  assertEq(res.byKey.get(rows[0].key).summary, buildRuleSummary(doc, rows[0]), '降级为规则摘要（不报错给主人）');
});

test('LLM 通路受成本闸：达上限后不再调用（stopped）', async () => {
  const doc = mkDoc('docs/s.md', SHORT_DOC);
  const rows = planRows(doc);
  let calls = 0;
  const res = await summarizeAll({
    docs: [doc, doc],
    plans: new Map([[doc.rel, rows]]),
    mode: 'llm',
    cost: { date: '2026-09-21', calls: LLM_LIMITS.callsPerDay, tokens: 0 },
    date: '2026-09-21',
    llm: { apiKey: 'k', baseUrl: 'https://x', model: 'm' },
    deps: { fetch: async () => { calls += 1; throw new Error('不该被调用'); } },
  });
  assertEq(calls, 0, '闸门内 0 次调用');
  assert(Boolean(res.stopped), 'stopped 有原因');
  assertEq(res.calls, 0, '记账 0');
});

test('D2 从严读：输入含家人标记 ⇒ 不送第三方，改用规则摘要并记录', async () => {
  const doc = mkDoc('docs/x.md', '# 家人档设计\n\n## 一、家人投喂口径\n\n家人相关数据的处置条目。\n');
  const rows = planRows(doc);
  let called = false;
  const res = await summarizeAll({
    docs: [doc],
    plans: new Map([[doc.rel, rows]]),
    mode: 'llm',
    cost: emptyCost('2026-09-21'),
    date: '2026-09-21',
    llm: { apiKey: 'k', baseUrl: 'https://x', model: 'm' },
    deps: { fetch: async () => { called = true; throw new Error('不该被调用'); } },
  });
  assertEq(called, false, '一次都没送出去');
  assertEq(res.skippedForFamily, ['docs/x.md'], '记入 skippedForFamily');
  assert(Boolean(res.byKey.get(rows[0].key)), '仍有规则摘要可用');
});

// ---------------------------------------------------------------- 4. 并发保护

test('busy 判据：只把"库被锁"当可重试（其它错误立即上抛，不掩盖真 bug）', () => {
  assertEq(isBusyError(new Error('database is locked')), true, 'locked');
  assertEq(isBusyError(new Error('SQLITE_BUSY: database table is locked')), true, 'SQLITE_BUSY');
  assertEq(isBusyError(new Error('no such column: foo')), false, '真错误不重试');
});

test('withBusyRetry：busy 重试到成功；非 busy 立即返回失败；超次数返回失败不抛', async () => {
  let n = 0;
  const ok = await withBusyRetry(
    () => {
      n += 1;
      if (n < 3) throw new Error('database is locked');
      return 'done';
    },
    { sleep: async () => {}, delaysMs: [1, 1, 1] },
  );
  assertEq(ok.ok, true, '重试后成功');
  assertEq(ok.value, 'done', '返回值');
  assertEq(ok.attempts, 3, '尝试次数');

  const bad = await withBusyRetry(() => { throw new Error('no such table'); }, { sleep: async () => {} });
  assertEq(bad.ok, false, '非 busy 失败');
  assertEq(bad.attempts, 1, '不重试');

  const exhausted = await withBusyRetry(() => { throw new Error('database is locked'); }, { sleep: async () => {}, delaysMs: [1, 1, 1] });
  assertEq(exhausted.ok, false, '超限失败');
  assertEq(exhausted.attempts, 4, '1 次 + 3 次重试');
  assert(exhausted.error.includes('locked'), '错误原文带上');
});

test('真锁库实测：另一个连接持 EXCLUSIVE ⇒ 本轮记 failed（不抛错、不写坏、旧条保留）', async () => {
  const s = makeSandbox();
  let lock = null;
  try {
    s.write('docs/a.md', SHORT_DOC);
    // 首轮正常落库
    const r1 = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md' }), deps: FAST });
    assertEq(r1.status, 'ok', '首轮 ok');
    const before = countAll(s.dbPath);
    // 改文档**首段**（摘要真的变 ⇒ 本轮确实要写库）+ 锁库
    s.touch('docs/a.md', SHORT_DOC.replace('引言：这是一份短文档', '引言：这是一份被改写过的短文档'));
    lock = new DatabaseSync(s.dbPath);
    lock.exec('BEGIN EXCLUSIVE');
    const r2 = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md' }), deps: FAST });
    assertEq(r2.status, 'failed', '锁住 ⇒ failed');
    assert(r2.stats.failedCount >= 1, '记了失败');
    assert(r2.stats.busyWaits >= 1, '确实触发了退避重试');
    assertEq(r2.stats.upserted, 0, '一条都没写进去');
    assert(r2.stats.failures[0].error.includes('locked'), `失败原文入 state：${r2.stats.failures[0].error}`);
    assertEq(countAll(s.dbPath), before, '旧条保留（不写坏）');
  } finally {
    try {
      if (lock) {
        lock.exec('ROLLBACK');
        lock.close();
      }
    } catch {
      /* ignore */
    }
    s.cleanup();
  }
});

test('锁释放后自愈：下一轮能把上一轮失败的篇补上（failCount 归零）', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md' }), deps: FAST }); // 先建库与目录
    s.touch('docs/a.md', SHORT_DOC.replace('引言：这是一份短文档', '引言：改写后待补'));
    const lock = new DatabaseSync(s.dbPath);
    lock.exec('BEGIN EXCLUSIVE');
    const r1 = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md' }), deps: FAST });
    assertEq(r1.status, 'failed', '锁住时 failed');
    assertEq(r1.state.paths['docs/a.md'].failCount, 1, 'failCount 1');
    lock.exec('ROLLBACK');
    lock.close();
    const r2 = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md' }), deps: FAST });
    assertEq(r2.status, 'ok', '解锁后 ok');
    assertEq(r2.stats.rebuilt, 1, '补上了这一篇');
    assertEq(r2.state.paths['docs/a.md'].failCount, 0, 'failCount 归零');
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------- 5. 幂等 / 变更感知 / 孤条

test('幂等：同一批连跑两次 ⇒ 条数不变、第二次全部跳过、无孤条', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    s.write('docs/l.md', longDoc(6, 4000));
    const flags = s.flags({ only: 'docs/a.md,docs/l.md' });
    const r1 = await runDocIndexOnce({ flags, deps: FAST });
    assertEq(r1.status, 'ok', '首轮 ok');
    assert(r1.stats.upserted > 0, '首轮有写入');
    const n1 = countAll(s.dbPath);
    const r2 = await runDocIndexOnce({ flags, deps: FAST });
    assertEq(r2.status, 'noop', '次轮 noop');
    assertEq(r2.stats.skipped, 2, '两篇都跳过');
    assertEq(r2.stats.rebuilt, 0, '重建 0');
    assertEq(r2.stats.upserted, 0, '写库 0（未变条目未重建）');
    assertEq(countAll(s.dbPath), n1, '条数不变');
    const paths = listRows(openRO(s.dbPath).db).map((r) => r.path);
    assertEq(paths.filter((p) => p === 'docs/a.md').length, 1, '短文档主条 1 条');
    assert(paths.filter((p) => p.startsWith('docs/l.md#§')).length >= 2, '长文档按 §N 分条（无主条）');
    assertEq(new Set(paths).size, paths.length, '无重复 path（无孤条）');
  } finally {
    s.cleanup();
  }
});

test('稳定性：连跑三轮都不振荡（跳过轮记 skipped 也算"已同步"，次轮不会再重算）', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    s.write('docs/l.md', longDoc(6, 4000));
    const flags = s.flags({ only: 'docs/a.md,docs/l.md' });
    const r1 = await runDocIndexOnce({ flags, deps: FAST });
    const r2 = await runDocIndexOnce({ flags, deps: FAST });
    const r3 = await runDocIndexOnce({ flags, deps: FAST });
    assertEq([r1.status, r2.status, r3.status], ['ok', 'noop', 'noop'], '状态序列');
    assertEq([r1.stats.rebuilt, r2.stats.rebuilt, r3.stats.rebuilt], [2, 0, 0], '重建次数');
    // 关键回归点：跳过轮的 lastResult 必须是 skipped（不是 failed/未同步），否则下一轮又重算
    assertEq(r2.state.paths['docs/l.md'].lastResult, 'skipped', '长文档跳过轮记 skipped');
    assertEq(r3.stats.decisions['docs/l.md'].reason, 'unchanged', '第三轮判据 = unchanged（无振荡）');
    assertEq(r3.stats.upserted, 0, '零写库');
  } finally {
    s.cleanup();
  }
});

test('日报行规模：跳过轮也显示库内真实规模（回归：曾显示"0 篇 / 0 条"）', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    s.write('docs/l.md', longDoc(6, 4000));
    const flags = s.flags({ only: 'docs/a.md,docs/l.md' });
    await runDocIndexOnce({ flags, deps: FAST });
    const total = countAll(s.dbPath);
    const r2 = await runDocIndexOnce({ flags, deps: FAST });
    assertEq(r2.stats.rebuilt, 0, '本轮没重建');
    assertEq(r2.stats.totalRows, total, '日报行规模 = 库内真实条数');
    assertEq(r2.stats.totalDocs, 2, '篇数 = 库内去重篇数');
    assert(r2.state.lastDailyLine.includes(`${total} 条`), `日报行含真实条数：${r2.state.lastDailyLine}`);
    assert(!r2.state.lastDailyLine.includes('0 篇 / 0 条'), '不再显示 0 篇/0 条');
  } finally {
    s.cleanup();
  }
});

test('变更感知：只动改过的那一篇（其它篇连 updated_at 都逐字不变）', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    s.write('docs/b.md', SHORT_DOC.replace('短文档 A', '短文档 B'));
    const r1 = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md,docs/b.md' }), deps: FAST });
    assertEq(r1.stats.rebuilt, 2, '首轮两篇');
    const snapshot = snapshotRows(s.dbPath);

    // 只改 a.md 的**首段**（内容 + mtime + size 都变 ⇒ 摘要跟着变）
    s.touch('docs/a.md', SHORT_DOC.replace('引言：这是一份短文档', '引言：这份短文档已被改写'));
    const r2 = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md,docs/b.md' }), deps: FAST });
    assertEq(r2.stats.rebuilt, 1, '只重建 1 篇');
    assertEq(r2.stats.skipped, 1, '跳过 1 篇');
    assertEq(r2.stats.decisions['docs/a.md'].reason, 'mtime-or-size-changed', '理由 = mtime/size 变');
    assertEq(r2.stats.decisions['docs/b.md'].reason, 'unchanged', 'b 未变');

    const after = snapshotRows(s.dbPath);
    assertEq(after['docs/b.md'], snapshot['docs/b.md'], 'b 条逐字未动（含 updated_at / text_hash）');
    assert(after['docs/a.md'].text_hash !== snapshot['docs/a.md'].text_hash, 'a 条已更新');
    assert(after['docs/a.md'].mtime > snapshot['docs/a.md'].mtime, 'a 条 mtime 跟随文档前进');
  } finally {
    s.cleanup();
  }
});

test('变更感知（边界）：只动文末 ⇒ 摘要不变 ⇒ 库里整行不动（但 state 记下新 mtime，不来回重建）', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    const flags = s.flags({ only: 'docs/a.md' });
    await runDocIndexOnce({ flags, deps: FAST });
    const before = snapshotRows(s.dbPath)['docs/a.md'];
    s.touch('docs/a.md', `${SHORT_DOC}\n文末追加一句（不影响摘要）。\n`);
    const r = await runDocIndexOnce({ flags, deps: FAST });
    assertEq(r.stats.rebuilt, 1, 'doc 变了 ⇒ 重算摘要');
    assertEq(r.stats.unchanged, 1, '摘要同哈希 ⇒ 不清写');
    assertEq(r.stats.upserted, 0, '写库 0');
    assertEq(snapshotRows(s.dbPath)['docs/a.md'], before, '库里整行逐字未变');
    assert(r.state.paths['docs/a.md'].mtime > before.mtime, 'state 记下新 mtime');
    // 下一轮：state 已对齐 ⇒ 直接跳过（不会每次都重算摘要）
    const r2 = await runDocIndexOnce({ flags, deps: FAST });
    assertEq(r2.stats.skipped, 1, '次轮跳过');
    assertEq(r2.stats.rebuilt, 0, '不再重算');
  } finally {
    s.cleanup();
  }
});

test('清孤条：文档由长变短 ⇒ 多余的 path#§N 被删除（不留孤条）', async () => {
  const s = makeSandbox();
  try {
    const text = longDoc(8, 3000);
    s.write('docs/l.md', text);
    const r1 = await runDocIndexOnce({ flags: s.flags({ only: 'docs/l.md' }), deps: FAST });
    const rows1 = listRows(openRO(s.dbPath).db).map((r) => r.path);
    assert(rows1.length >= 2, `首轮多条（实际 ${rows1.length}）`);

    // 缩短到 1 条（去掉大部分小节）
    s.touch('docs/l.md', `# 长文档 L\n\n引言。\n\n## 唯一小节\n\n${'短正文。'.repeat(50)}\n`);
    const r2 = await runDocIndexOnce({ flags: s.flags({ only: 'docs/l.md' }), deps: FAST });
    assertEq(r2.status, 'ok', 'ok');
    const rows2 = listRows(openRO(s.dbPath).db).map((r) => r.path);
    assertEq(rows2, ['docs/l.md'], '只剩主条');
    assertEq(r2.stats.staleDeleted, rows1.filter((p) => p !== 'docs/l.md').length, '清掉的孤条数');
  } finally {
    s.cleanup();
  }
});

test('库缺条自愈：手工删掉某篇的条 ⇒ 下一轮按 missing-in-db 重建', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md' }), deps: FAST });
    const db = openRO(s.dbPath).db;
    deleteDoc(db, 'docs/a.md');
    db.close();
    assertEq(countAll(s.dbPath), 0, '已清空');
    const r = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md' }), deps: FAST });
    assertEq(r.stats.decisions['docs/a.md'].reason, 'missing-in-db', '判据');
    assertEq(countAll(s.dbPath), 1, '补回');
  } finally {
    s.cleanup();
  }
});

test('diff 判据：force 忽略差分；lastResult 非 ok 也重建', () => {
  const doc = { rel: 'docs/a.md', mtime: 5, size: 5 };
  assertEq(needsRebuild({ doc, prevEntry: null, hasRow: false }).reason, 'new', '无 state');
  assertEq(needsRebuild({ doc, prevEntry: { mtime: 5, size: 5, lastResult: 'ok' }, hasRow: true }).rebuild, false, '一致 ⇒ 跳过');
  assertEq(needsRebuild({ doc, prevEntry: { mtime: 5, size: 5, lastResult: 'ok' }, hasRow: true, force: true }).reason, 'forced', 'force');
  assertEq(needsRebuild({ doc, prevEntry: { mtime: 4, size: 5, lastResult: 'ok' }, hasRow: true }).reason, 'mtime-or-size-changed', 'mtime 变');
  assertEq(needsRebuild({ doc, prevEntry: { mtime: 5, size: 4, lastResult: 'ok' }, hasRow: true }).reason, 'mtime-or-size-changed', 'size 变');
  assertEq(needsRebuild({ doc, prevEntry: { mtime: 5, size: 5, lastResult: 'failed' }, hasRow: true }).reason, 'last-failed', '上轮失败');
  assertEq(needsRebuild({ doc, prevEntry: { mtime: 5, size: 5, lastResult: 'ok' }, hasRow: false }).reason, 'missing-in-db', '库里没条');
});

test('摘要口径变化 ⇒ text_hash 变 ⇒ 即使 mtime/size 不变也会更新（"摘要变了也要更新"）', () => {
  const s = makeSandbox();
  try {
    const store = openDocIndexStore(s.dbPath);
    upsertDocs(store.db, [{ path: 'docs/a.md', mtime: 9, size: 9, textHash: 'old', summary: '旧摘要', updatedAt: 9 }]);
    const r = upsertDocs(store.db, [{ path: 'docs/a.md', mtime: 9, size: 9, textHash: 'new', summary: '新摘要', updatedAt: 9 }]);
    assertEq(r.updated, 1, '摘要变 ⇒ 更新');
    assertEq(getRow(store.db, 'docs/a.md').summary, '新摘要', '内容已换');
    store.db.close();
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------- 6. 范围 / 首期清单 / 逃生舱

test('范围：默认首期 10 篇（判据 = 文档总索引「最常用的 15 份」前 10）；--all / --only 可覆盖', () => {
  assertEq(FIRST_BATCH.length, 10, '首期 10 篇');
  assertEq(new Set(FIRST_BATCH).size, 10, '无重复');
  for (const p of FIRST_BATCH) assert(p.startsWith('docs/'), `相对 DSH 根口径：${p}`);
  const scanned = [
    { rel: 'docs/其它.md', abs: 'x', mtime: 1, size: 1 },
    { rel: 'docs/主人使用手册.md', abs: 'y', mtime: 1, size: 1 },
  ];
  const def = resolveScope({ scanned });
  assertEq(def.mode, 'first-batch', '默认模式');
  assertEq(def.docs.map((d) => d.rel), ['docs/主人使用手册.md'], '只取清单里存在的');
  assertEq(def.missing.length, 9, '缺的 9 篇如实报告');
  assertEq(resolveScope({ scanned, flags: { all: true } }).docs.length, 2, '--all');
  assertEq(resolveScope({ scanned, flags: { only: 'docs/其它.md' } }).docs.map((d) => d.rel), ['docs/其它.md'], '--only');
});

test('重建一致（逃生舱）：--rebuild 后条数与 path 集合与首跑一致、摘要逐字节相同', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    s.write('docs/l.md', longDoc(6, 4000));
    const flags = s.flags({ only: 'docs/a.md,docs/l.md' });
    await runDocIndexOnce({ flags, deps: FAST });
    const before = snapshotRows(s.dbPath);
    const r = await runDocIndexOnce({ flags: { ...flags, rebuild: true }, deps: FAST });
    assertEq(r.stats.rebuilt, 2, '强制重建 2 篇');
    const after = snapshotRows(s.dbPath);
    assertEq(Object.keys(after).sort(), Object.keys(before).sort(), 'path 集合一致');
    for (const k of Object.keys(before)) {
      assertEq(after[k].text_hash, before[k].text_hash, `${k} 摘要哈希一致（确定性）`);
      assertEq(after[k].summary, before[k].summary, `${k} 摘要逐字节一致`);
    }
  } finally {
    s.cleanup();
  }
});

test('回滚口径：deleteDoc 清掉主条 + 全部分条（path 与 path#§N）', () => {
  const s = makeSandbox();
  try {
    const store = openDocIndexStore(s.dbPath);
    upsertDocs(store.db, [
      { path: 'docs/l.md', mtime: 1, size: 1, textHash: 'h1', summary: 'A', updatedAt: 1 },
      { path: 'docs/l.md#§1', mtime: 1, size: 1, textHash: 'h2', summary: 'B', updatedAt: 1 },
      { path: 'docs/l.md#§2', mtime: 1, size: 1, textHash: 'h3', summary: 'C', updatedAt: 1 },
      { path: 'docs/other.md', mtime: 1, size: 1, textHash: 'h4', summary: 'D', updatedAt: 1 },
    ]);
    const n = deleteDoc(store.db, 'docs/l.md');
    assertEq(n, 3, '清 3 条（主条 + 2 分条）');
    assertEq(countRows(store.db), 1, '别的篇不受影响');
    assertEq(escapeLike('docs/a_b%c.md'), 'docs/a\\_b\\%c.md', 'LIKE 元字符转义');
    store.db.close();
  } finally {
    s.cleanup();
  }
});

// ---------------------------------------------------------------- 7. 状态文件 / 日报 / dry-run

test('state：per-path 记 mtime/size/lastResult/failCount；读文件失败 ⇒ failed 且 failCount 递增', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    s.write('docs/bad.md', '# B\n\n## C\n\n正文\n');
    const deps = {
      ...FAST,
      readDoc: (abs) => {
        if (abs.endsWith('bad.md')) throw new Error('模拟读取失败（权限/占用）');
        const text = fs.readFileSync(abs, 'utf8');
        return { text, chars: text.length };
      },
    };
    const r1 = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md,docs/bad.md' }), deps });
    assertEq(r1.status, 'failed', '有失败 ⇒ failed');
    assertEq(r1.state.paths['docs/a.md'].lastResult, 'ok', 'a ok');
    assertEq(r1.state.paths['docs/a.md'].failCount, 0, 'a 无失败');
    assertEq(r1.state.paths['docs/bad.md'].lastResult, 'failed', 'bad failed');
    assertEq(r1.state.paths['docs/bad.md'].failCount, 1, 'failCount 1');
    assert(r1.state.paths['docs/bad.md'].error.includes('读取/解析失败'), '错误原文入 state');
    const r2 = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md,docs/bad.md' }), deps });
    assertEq(r2.state.paths['docs/bad.md'].failCount, 2, 'failCount 递增');
    assertEq(r2.state.paths['docs/bad.md'].mtime > 0, true, 'mtime 仍记录（便于下轮对比）');
  } finally {
    s.cleanup();
  }
});

test('state：schemaVersion / 历史 / cost 段齐备，且原子写（同目录 tmp → rename）', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    const r = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md' }), deps: FAST });
    const st = JSON.parse(fs.readFileSync(s.stateFile, 'utf8'));
    assertEq(st.schemaVersion, 1, 'schemaVersion');
    assertEq(st.runs, 1, 'runs');
    assert(Array.isArray(st.history) && st.history.length === 1, 'history');
    assert(st.cost && typeof st.cost.calls === 'number', 'cost 段');
    assertEq(st.lastDailyLine, r.state.lastDailyLine, '日报行落在 state 里');
    assertEq(fs.readdirSync(path.dirname(s.stateFile)).filter((f) => f.includes('.tmp-')).length, 0, '不留 tmp 残件');
  } finally {
    s.cleanup();
  }
});

test('日报一行：段幂等（写两次内容相同、不重复追加）；日报不存在时不新建', () => {
  const s = makeSandbox();
  try {
    const dir = path.join(s.docsRoot, '管家报告');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '2026-09-21-TESTHOST.md');
    fs.writeFileSync(file, '# 大管家日报 · 2026-09-21\n\n## 🐳 队列推进提醒\n\n> x\n', 'utf8');
    const line = '📄 文档索引（doc-index）：10 篇 / 18 条 · 失败 0';
    const r1 = updateDailySection({ file, line });
    assertEq(r1.created, true, '首次新建段');
    const after1 = fs.readFileSync(file, 'utf8');
    assert(after1.includes(DAILY_SECTION_TITLE), '段标题在');
    assert(after1.includes('> ' + line), '行在');
    const r2 = updateDailySection({ file, line });
    assertEq(r2.created, false, '第二次不新建');
    assertEq(r2.reason, 'unchanged', '内容相同 ⇒ unchanged');
    assertEq(fs.readFileSync(file, 'utf8'), after1, '逐字节不变（幂等）');
    assertEq(after1.split(DAILY_SECTION_TITLE).length - 1, 1, '段只出现一次');
    // 更新内容（模拟下一轮）
    updateDailySection({ file, line: '📄 文档索引（doc-index）：10 篇 / 18 条 · 失败 2' });
    const after3 = fs.readFileSync(file, 'utf8');
    assert(after3.includes('失败 2'), '内容已更新');
    assertEq(after3.split(DAILY_SECTION_TITLE).length - 1, 1, '仍只有一段');
    assert(after3.includes('## 🐳 队列推进提醒'), '原有段保留');
    // 文件不存在 ⇒ 不新建
    const missing = path.join(dir, '2026-09-22-TESTHOST.md');
    assertEq(updateDailySection({ file: missing, line }).reason, 'daily-missing', '不新建');
    assertEq(fs.existsSync(missing), false, '确认没建文件');
  } finally {
    s.cleanup();
  }
});

test('日报路径口径：<docs>\\管家报告\\<YYYY-MM-DD>-<host>.md（与 report.mjs 同）', () => {
  const drv = path.parse(process.cwd()).root;
  const docsDir = path.join(drv, 'DSH', 'docs');
  const p = dailyReportPath({ docsDir, host: 'H', now: Date.UTC(2026, 8, 21, 4, 0, 0) });
  assertEq(path.basename(p), '2026-09-21-H.md', '文件名');
  assertEq(path.dirname(p), path.join(docsDir, '管家报告'), '目录');
});

test('renderDailyLine：把本轮统计/成本/失败渲染成一行（失败带 ⚠️ 摘要）', () => {
  const line = renderDailyLine({
    lastRun: { totalDocs: 10, totalRows: 18, rebuilt: 3, skipped: 7, upserted: 4, staleDeleted: 1, failed: [{ error: 'boom' }] },
    cost: { calls: 2, tokens: 3456 },
  });
  assert(line.includes('10 篇 / 18 条'), '规模');
  assert(line.includes('重建 3'), '重建');
  assert(line.includes('2 次调用 3456 token'), '成本');
  assert(line.includes('⚠️'), '失败标记');
});

test('dry-run：不建库、不改 state、不写日报（只算不写）', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    const dir = path.join(s.docsRoot, '管家报告');
    fs.mkdirSync(dir, { recursive: true });
    const daily = path.join(dir, '2026-09-21-TESTHOST.md');
    fs.writeFileSync(daily, '# 日报\n', 'utf8');
    const r = await runDocIndexOnce({ flags: s.flags({ only: 'docs/a.md', 'dry-run': true, 'no-daily': false }), deps: FAST });
    assertEq(fs.existsSync(s.dbPath), false, '不建库');
    assertEq(fs.existsSync(s.stateFile), false, '不写 state');
    assertEq(fs.readFileSync(daily, 'utf8'), '# 日报\n', '不写日报');
    assertEq(r.stats.totalRows > 0, true, '仍算了条数');
  } finally {
    s.cleanup();
  }
});

test('多人口径：--owner-user / --visibility 可显式覆盖（家人档预留）', async () => {
  const s = makeSandbox();
  try {
    s.write('docs/a.md', SHORT_DOC);
    await runDocIndexOnce({
      flags: s.flags({ only: 'docs/a.md', 'owner-user': 'someone', visibility: 'family' }),
      deps: FAST,
    });
    const row = getRow(openRO(s.dbPath).db, 'docs/a.md');
    assertEq(row.owner_user, 'someone', 'owner_user');
    assertEq(row.visibility, 'family', 'visibility');
  } finally {
    s.cleanup();
  }
});

test('分类标记：doc_index 与 memories 无关（不写主记忆库的机制保证）', () => {
  // 说明性断言：本模块只 import doc-index-store（独立库），不 import memory-source / memory.db
  const src = fs.readFileSync(new URL('../lib/doc-index.mjs', import.meta.url), 'utf8');
  assert(!src.includes('memory/memory.db'), '不引用主记忆库路径');
  assert(!src.includes('memories'), '不出现 memories 表名');
});

// ---------------------------------------------------------------- helpers

function countAll(dbPath) {
  const db = openRO(dbPath).db;
  const n = countRows(db);
  db.close();
  return n;
}

function openRO(dbPath) {
  return { db: new DatabaseSync(dbPath) };
}

function snapshotRows(dbPath) {
  const db = openRO(dbPath).db;
  const out = {};
  for (const r of db.prepare('SELECT * FROM doc_index ORDER BY path').all()) out[r.path] = r;
  db.close();
  return out;
}
