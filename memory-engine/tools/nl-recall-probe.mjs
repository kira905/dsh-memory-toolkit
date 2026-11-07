// 记忆引擎 · 坑库召回判据探针（只读）
//
// 用法：
//   node memory-engine/tools/nl-recall-probe.mjs --set <集合.json>
//   node memory-engine/tools/nl-recall-probe.mjs --set <技术档>.json --top-k 3 --json <输出.json>
//   （技术档 = …\questions\probes\pitfall-tech-10.json。2026-10-22 起两份题面挪进 questions\probes\
//     —— 它们是本探针的输入，不是 run-eval 的题目，放题库顶层会让 run-eval 加载崩掉）
//
// 判据：期望 id 是否进 top-K（默认 3）。输出每题命中位次 + 总命中率。
// 只读：只读 vectors.db / butler-pitfalls.json（`openVectorsStore` 以只读方式打开由 recall 侧保证不写行），
//   不 sync、不重建、不改任何语料。要测「关掉白话别名」的反向对照，请在**旧向量库**上跑（别名已烘进向量）。
// 入口守卫：目录链接（junction/symlink）下 import.meta.url 会解析成物理路径 ⇒ 双方 realpath 再比。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRuntime, parseArgs, num } from '../lib/cli-util.mjs';
import { recall, buildVectorIndex } from '../lib/recall.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function isMain() {
  try {
    const a = fs.realpathSync(fileURLToPath(import.meta.url));
    const b = fs.realpathSync(process.argv[1]);
    return a === b;
  } catch {
    return false;
  }
}

/** 集合文件两种形状都收：白话档 {items:[{ask,expectId}]} / 技术档 {questions:[{question,id}]} */
function loadSet(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.questions) ? raw.questions : null;
  if (!rows) throw new Error(`集合文件形状不认识（需 items[] 或 questions[]）：${file}`);
  return rows.map((r, i) => ({
    id: r.id ?? `Q${String(i + 1).padStart(2, '0')}`,
    ask: String(r.ask ?? r.question ?? '').trim(),
    expectId: String(r.expectId ?? r.id ?? ''),
  })).filter((r) => r.ask && r.expectId);
}

async function main() {
  const { flags } = parseArgs();
  const setFile = flags.set ? String(flags.set) : null;
  if (!setFile) {
    console.error('用法：node tools\\nl-recall-probe.mjs --set <集合.json> [--top-k 3] [--json <out>]');
    process.exitCode = 2;
    return;
  }
  const topK = num(flags['top-k'], 3);
  const items = loadSet(setFile);
  // 默认就是坑源（本探针只判坑库召回；要换源显式 --source）
  const rt = await openRuntime({ ...flags, source: flags.source ?? 'pitfall' });
  try {
    const index = buildVectorIndex(rt.store.db, { source: rt.sourceName });
    const results = [];
    for (const it of items) {
      const r = await recall({
        query: it.ask,
        store: rt.store,
        source: rt.source,
        embedder: rt.embedder,
        index,
        sourceName: rt.sourceName,
        vectorTopK: Math.max(topK, 10),
        ftsTopK: 0,
        rrfK: rt.config.rrfK,
        resultTopK: topK,
        log: () => {},
      });
      const ids = (r.hits || []).map((h) => String(h.refId));
      const rank = ids.indexOf(it.expectId);
      results.push({
        id: it.id,
        ask: it.ask,
        expectId: it.expectId,
        topKIds: ids,
        hit: rank >= 0,
        hitRank: rank >= 0 ? rank + 1 : null,
        ms: Math.round((r.timings?.totalMs ?? 0) * 100) / 100,
      });
    }
    const hits = results.filter((x) => x.hit).length;
    const out = {
      at: new Date().toISOString(),
      set: setFile,
      source: rt.sourceName,
      vectorsDb: rt.config.vectorsDb,
      indexSize: index.count,
      model: rt.config.modelId,
      topK,
      total: results.length,
      hits,
      rate: results.length ? hits / results.length : 0,
      items: results,
    };
    if (flags.json) {
      const p = String(flags.json === true ? path.join(HERE, 'nl-recall-out.json') : flags.json);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n', 'utf8');
    }
    if (flags.json) {
      // --json 时日志走 stderr（机器只读 stdout）
      for (const r of results) {
        process.stderr.write(`${r.hit ? '✅' : '❌'} ${r.id} 期望 ${r.expectId} · 命中位次 ${r.hitRank ?? '-'}\n`);
      }
      process.stderr.write(`\n命中：${hits}/${results.length} ⇒ ${out.rate >= 0.7 ? 'PASS（判据 ≥7/10）' : 'FAIL'}\n`);
    } else {
      console.log(`=== 坑库召回探针 · ${path.basename(setFile)} · 索引 ${index.count} 条 ===`);
      for (const r of results) {
        console.log(
          `${r.hit ? '✅' : '❌'} [${r.id}] 期望 ${r.expectId} · 位次 ${r.hitRank ?? '-'} · top${topK}=[${r.topKIds.join(', ')}] · ${r.ms}ms`,
        );
        console.log(`     问：${r.ask}`);
      }
      console.log(`\n命中：${hits}/${results.length} = ${(out.rate * 100).toFixed(1)}% ⇒ ${out.rate >= 0.7 ? 'PASS（判据 ≥7/10）' : 'FAIL'}`);
    }
    process.exitCode = 0;
  } finally {
    rt.close();
  }
}

if (isMain()) await main();
