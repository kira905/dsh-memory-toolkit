// 10 · 坑库向量同步钩子（标记 → 消费）：原子写 / stale 判定 / 判据 7 并发正确性
//
// 判据 7（方案 §A.7，2026-10-08 回修 C5 新增）：并发「置标记 + 清标记」100 轮后
//   ① 标记文件**不出现半截 JSON**（每轮读都 JSON.parse 成功）
//   ② **无标记丢失**（更新的标记不会被旧消费方清掉）
//   ③ 每次被清掉的标记，其 `updatedAt` **一律早于**清标记方的消费起点
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, assert, assertEq, assertThrows } from './harness.mjs';
import { makeTempRoot, samplePitfalls, makePitfallJson, makeFlakyEmbedder, makeMemoryDb, sampleRows } from './fixtures.mjs';
import { openVectorsStore, countVectors } from '../lib/vectors-store.mjs';
import { openPitfallSource } from '../lib/pitfall-source.mjs';
import { openMemorySource } from '../lib/memory-source.mjs';
import { createStubEmbedder } from '../lib/embedder.mjs';
import { readMarker, markDirty, clearMarkerIfStale, runPitfallHook, atomicWriteJson } from '../lib/tick-hook.mjs';

export const __section = '10 · 坑库向量钩子（标记/消费 · 并发正确性）';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function worker(mode, markerPath, ms) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, '_tickhook-worker.mjs'), mode, markerPath, String(ms)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch (e) {
        resolve({ error: String(e && e.message), raw: out.slice(-400) });
      }
    });
  });
}

test('置标记 = 原子写 + 必带 updatedAt；读标记永不抛错', () => {
  const t = makeTempRoot();
  const p = t.paths.pitfallDirtyFile;
  try {
    assertEq(readMarker(p), { present: false, marker: null, error: null }, '文件不在 ⇒ present:false（不算错）');
    const at = 1_760_000_000_123;
    markDirty(p, { at, reason: '单测' });
    const r = readMarker(p);
    assertEq(r.present, true, '置完可读');
    assertEq(r.marker.updatedAt, at, '必须写 updatedAt（stale 判定的唯一依据）');
    assertEq(r.marker.schemaVersion, 1, 'schemaVersion');
    assertEq(r.marker.reason, '单测', 'reason 落盘');
    // 半截 JSON 给 error 而不是抛
    fs.writeFileSync(p, '{"schemaVersion":1,"updat', 'utf8');
    const bad = readMarker(p);
    assertEq(bad.present, false, '半截 JSON ⇒ present:false');
    assert(bad.error && /JSON/.test(bad.error), '带 error 说明（调用方据此 fail-closed）');
    t.cleanup();
  } finally {
    t.cleanup();
  }
});

test('clearMarkerIfStale：stale 清、fresh 留、缺失 no-marker', () => {
  const t = makeTempRoot();
  const p = t.paths.pitfallDirtyFile;
  try {
    assertEq(clearMarkerIfStale(p, 1000).reason, 'no-marker', '无标记');
    markDirty(p, { at: 500 });
    const keep = clearMarkerIfStale(p, 500);
    assertEq(keep.cleared, false, 'updatedAt == 消费起点 ⇒ 保留（不是这次要消费的）');
    assertEq(keep.reason, 'fresh-marker-kept', '保留原因');
    assertEq(fs.existsSync(p), true, '文件仍在');
    const ok = clearMarkerIfStale(p, 501);
    assertEq(ok.cleared, true, 'updatedAt < 消费起点 ⇒ 清掉');
    assertEq(ok.consumedUpdatedAt, 500, '记录被消费的 updatedAt');
    assertEq(fs.existsSync(p), false, '清掉后文件不存在（正常态）');
  } finally {
    t.cleanup();
  }
});

test('runPitfallHook：无标记跳过；有标记跑坑源增量并清标记；失败保留标记', async () => {
  const t = makeTempRoot();
  try {
    makePitfallJson(t.paths.pitfallsFile, samplePitfalls(8));
    const store = openVectorsStore(t.paths.vectorsDb);
    const source = openPitfallSource(t.paths.pitfallsFile);
    const embedder = createStubEmbedder({ dim: 512 });
    const base = { markerPath: t.paths.pitfallDirtyFile, store, source, embedder, modelId: 'stub-ngram', dim: 512 };

    const r0 = await runPitfallHook(base);
    assertEq(r0.skipped, 'no-marker', '没标记 ⇒ 不空转');
    assertEq(countVectors(store.db, 'pitfall'), 0, '没写任何向量');

    markDirty(t.paths.pitfallDirtyFile, { at: Date.now() - 10_000, reason: 'pitfall job' });
    const r1 = await runPitfallHook(base);
    assertEq(r1.ok, true, '跑通');
    assertEq(r1.stats.encoded, 8, '编码 8 条坑');
    assertEq(countVectors(store.db, 'pitfall'), 8, '落库 8 条');
    assertEq(r1.cleared.cleared, true, '成功后清标记');
    assertEq(fs.existsSync(t.paths.pitfallDirtyFile), false, '标记已摘除');

    // dry-run：不清标记、不写向量
    markDirty(t.paths.pitfallDirtyFile, { at: Date.now() - 10_000 });
    const r2 = await runPitfallHook({ ...base, dryRun: true });
    assertEq(r2.cleared.reason, 'dry-run', 'dry-run 不清标记');
    assertEq(fs.existsSync(t.paths.pitfallDirtyFile), true, '标记仍在');

    // 同步失败 ⇒ 保留标记（下轮重试）
    const failEmbedder = makeFlakyEmbedder(embedder, { failOnBatchCall: 1 });
    const r3 = await runPitfallHook({ ...base, embedder: failEmbedder, full: true });
    assertEq(r3.ok, false, '编码崩溃 ⇒ 本轮不 ok');
    assertEq(r3.cleared.reason, 'sync-failed-keep-marker', '失败**保留**标记');
    assertEq(fs.existsSync(t.paths.pitfallDirtyFile), true, '标记仍在（下轮重试）');
    source.close();
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('判据7（顺序 100 轮）：无半截 JSON / 无标记丢失 / 清除项一律早于消费起点', () => {
  const t = makeTempRoot();
  const p = t.paths.pitfallDirtyFile;
  try {
    const violations = { parse: 0, lost: 0, freshCleared: 0 };
    let base = 1_760_000_000_000;
    for (let i = 0; i < 100; i += 1) {
      // 交替两种顺序，覆盖"先置后清"与"先清后置"
      const produceFirst = i % 2 === 0;
      const at = base + i * 7;
      const consumeStart = base + i * 7 + 3; // 每轮窗口错开
      if (produceFirst) {
        markDirty(p, { at });
        // ① 每轮读都必须是合法 JSON
        try {
          JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
          violations.parse += 1;
        }
        const r = clearMarkerIfStale(p, consumeStart);
        if (r.cleared && !(Number(r.consumedUpdatedAt) < consumeStart)) violations.freshCleared += 1;
        if (r.cleared && Number(r.consumedUpdatedAt) !== at) violations.lost += 1;
      } else {
        const r = clearMarkerIfStale(p, consumeStart);
        if (r.cleared && !(Number(r.consumedUpdatedAt) < consumeStart)) violations.freshCleared += 1;
        // 清完之后再置 ⇒ 标记必须存在（不能被上一步吞掉）
        markDirty(p, { at });
        const after = readMarker(p);
        if (!after.present || after.marker.updatedAt !== at) violations.lost += 1;
      }
    }
    assertEq(violations, { parse: 0, lost: 0, freshCleared: 0 }, `100 轮不变量（实际 ${JSON.stringify(violations)}）`);
    assertEq(fs.existsSync(p), true, '最后一轮是"先清后置" ⇒ 标记留在位（无丢失）');
  } finally {
    t.cleanup();
  }
});

test('判据7（真并发 2 进程）：置标记 × 清标记同时跑，父进程持续读，全程无半截 JSON', async () => {
  const t = makeTempRoot();
  const p = t.paths.pitfallDirtyFile;
  try {
    // 父进程：高频探测"每次都能 parse"
    let reads = 0;
    let parseErrors = 0;
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        reads += 1;
        try {
          JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (e) {
          if (e && e.code !== 'ENOENT') parseErrors += 1;
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    const [mk, cn] = await Promise.all([worker('mark', p, 1500), worker('consume', p, 1500)]);
    stop = true;
    await reader;

    assert(!mk.error && !cn.error, `子进程正常退出：${JSON.stringify({ mk: mk.error, cn: cn.error })}`);
    assertEq(mk.errors, [], `置标记方零错误（原生 rename 竞态已由有限重试兜住）：${JSON.stringify(mk.errors.slice(0, 3))}`);
    assertEq(cn.errors, [], `清标记方零错误：${JSON.stringify(cn.errors.slice(0, 3))}`);
    assert(mk.n > 5 && cn.n > 5, `两进程都真跑了（mark ${mk.n} 次 / consume ${cn.n} 次）`);
    assertEq(cn.violations, 0, '不变量③：被清掉的标记 updatedAt 一律早于清标记方消费起点（子进程内计数）');
    assertEq(parseErrors, 0, `不变量①：父进程 ${reads} 次读无一例半截 JSON`);
    // 不变量②：每次"清除"消费的标记都必须落在置标记方的真实写入窗口内（无幽灵标记、无丢标记）
    const cleared = cn.events.filter((e) => e.cleared);
    for (const e of cleared) {
      assertEq(e.consumedUpdatedAt < e.consumeStart, true, '③ 逐条：consumedUpdatedAt < consumeStart');
      assert(
        e.consumedUpdatedAt >= mk.minAt - 5 && e.consumedUpdatedAt <= mk.maxAt + 5,
        `② 被清的标记必须来自置标记方的真实写入（${e.consumedUpdatedAt} 不在 [${mk.minAt}, ${mk.maxAt}] = 幽灵标记）`,
      );
    }
    console.log(
      `     ↳ 并发读数：mark ${mk.n} 次（${mk.minAt}~${mk.maxAt}）/ consume ${cn.n} 次（清掉 ${cleared.length} 次）/ 父进程读 ${reads} 次`,
    );
  } finally {
    t.cleanup();
  }
});

test('守卫：把非坑源传给 runPitfallHook ⇒ 拒跑（防把别的来源错标成 pitfall 向量）', async () => {
  const t = makeTempRoot();
  try {
    makeMemoryDb(t.paths.memoryDb, sampleRows(3));
    makePitfallJson(t.paths.pitfallsFile, samplePitfalls(3));
    const store = openVectorsStore(t.paths.vectorsDb);
    const mem = openMemorySource(t.paths.memoryDb);
    const pit = openPitfallSource(t.paths.pitfallsFile);
    const e = await assertThrows(
      () =>
        runPitfallHook({
          markerPath: t.paths.pitfallDirtyFile,
          store,
          source: mem,
          embedder: createStubEmbedder({ dim: 512 }),
          modelId: 'stub-ngram',
          dim: 512,
        }),
      '记忆源当坑源时必须拒跑',
    );
    assert(/只接受坑源/.test(e.message), `报错要写清原因：${e.message}`);
    assertEq(countVectors(store.db, 'pitfall'), 0, '拒跑 ⇒ 一条都没写');
    mem.close();
    pit.close();
    store.db.close();
  } finally {
    t.cleanup();
  }
});

test('atomicWriteJson：同目录临时文件 + rename（读者看不到半截）', () => {
  const t = makeTempRoot();
  const p = path.join(t.root, 'x', 'm.json');
  try {
    atomicWriteJson(p, { a: 1 });
    assertEq(JSON.parse(fs.readFileSync(p, 'utf8')).a, 1, '写入可读');
    atomicWriteJson(p, { a: 2 });
    assertEq(JSON.parse(fs.readFileSync(p, 'utf8')).a, 2, '覆盖写');
    const leftovers = fs.readdirSync(path.dirname(p)).filter((f) => f.includes('.tmp-'));
    assertEq(leftovers.length, 0, '不留临时文件');
  } finally {
    t.cleanup();
  }
});
