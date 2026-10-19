// 记忆引擎 v2 · 离线层 —— **坑库只读数据源**（方案 §3 A 点 · 第二向量来源 source='pitfall'）
//
// 为什么需要它：开工简报原来无差别取 `topN(pitfalls,3)`（与本次任务语义无关，229 条里永远只看最高 3 条）。
// A 点要把「坑库」变成向量库里的第二个来源，让开工简报按任务语义召回相关坑。
//
// 铁律（方案 §A.2 / §A.4）：
//   1. **只读** `butler-pitfalls.json`（A 点不写它）；`readOnly: true` 是自证字段。
//   2. 接口必须与 `memory-source.mjs` 的 `openMemorySource` **同形状**（硬契约）——
//      下游三个消费面按方法名硬调用：`sync.mjs:81 incrementalPage` / `sweep.mjs:36 idRange`+`:69 segment`
//      / `recall.mjs:120 pinnedIds`+`:141 ftsSearch`。少一个方法 = 第一次跑就 `is not a function`。
//      ⚠️ 方案旧文写的 `{ list(), count(), maxSeen() }` 是**错的**（`maxSeen` 在对照物里不存在，实际名 `maxUpdatedAt`）。
//   3. `segment()` / `incrementalPage()` 返回行**必须含 `id / text / updated_at`**：
//      `sweep.mjs:77` 读 `r.text`、`:110` 取 `r.updated_at`，缺 `updated_at` 不报错、只会把 `undefined` 写进向量行。
//   4. 轮转语义**不是 id 段**：坑无数字 id 段 ⇒ `idRange()` 给 `{lo:0,hi:n-1,n}`（稳定等价量，= 排序后下标），
//      `segment(lo,hi)` 按 `lastSeen` 升序（平局按 `id` 字典序）切片；`incrementalPage` 用同一排序做**稳定游标**。
import fs from 'node:fs';

/** 坑条目的向量文本（方案 §A.3 定稿；**不含**建议文本 —— 候选池的 suggested/why 不进向量，避免建议变化导致向量漂移） */
export function pitfallText(row) {
  const cat = row.category ? `[${row.category}] ` : '';
  const seed = String(row.source || '') === 'seed' ? '[seed]' : '';
  const tools = row.tools && typeof row.tools === 'object' ? Object.keys(row.tools).join(',') : '';
  return `${seed}${cat}${row.normText ?? ''}${tools ? ` | tools=${tools}` : ''}`;
}

function sortRows(rows) {
  return rows
    .slice()
    .sort((a, b) => a.updated_at - b.updated_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 稳定游标键：`<lastSeen 补零>|<id>`（同 `sortRows` 的序即字符串序，平局按 id 字典序） */
function cursorKey(lastSeen, id) {
  return `${String(lastSeen).padStart(16, '0')}|${id}`;
}

function mapRow(r) {
  return {
    id: r.id,
    text: r.text,
    tags: r.tags,
    pinned: 0,
    updated_at: r.updated_at,
  };
}

/**
 * 打开坑库（只读）。
 * @param {string} jsonPath `butler-pitfalls.json`
 */
export function openPitfallSource(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`坑库不存在: ${jsonPath}`);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    throw new Error(`坑库解析失败: ${jsonPath}（${String(e && e.message ? e.message : e)}）`);
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.pitfalls) ? raw.pitfalls : null;
  if (!list) throw new Error(`坑库结构不认识（应含 pitfalls 数组）: ${jsonPath}`);

  const rows = sortRows(
    list
      .filter((x) => x && x.id != null)
      .map((x) => ({
        id: String(x.id),
        text: pitfallText(x),
        tags: x.tools && typeof x.tools === 'object' ? Object.keys(x.tools).join(',') : '',
        updated_at: Number(x.lastSeen || 0),
      })),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));

  let closed = false;
  return {
    dbPath: jsonPath,
    readOnly: true,
    /** 自证：来源名（下游日志/自检按它报"逐 source"） */
    sourceName: 'pitfall',
    /** 原始条目数（= rows.length；观测用） */
    n: rows.length,

    count() {
      return rows.length;
    },

    maxUpdatedAt() {
      let m = 0;
      for (const r of rows) if (r.updated_at > m) m = r.updated_at;
      return m;
    },

    /** 坑无数字 id 段 ⇒ 给稳定等价量（排序后下标区间） */
    idRange() {
      if (!rows.length) return { lo: null, hi: null, n: 0 };
      return { lo: 0, hi: rows.length - 1, n: rows.length };
    },

    /** 坑库无 pinned 概念 ⇒ 空集（召回侧据此不排除任何条目） */
    pinnedIds() {
      return [];
    },

    /**
     * 增量页：`updated_at >= sinceTs`，按 (lastSeen, id) 升序，游标 = 上一页末条 `id`。
     * 游标按「键比较」而非仅按下标：翻页期间即使集合变化也不会重复/跳过（键比较天然幂等）。
     */
    incrementalPage(sinceTs, afterId, limit) {
      const since = Number(sinceTs) || 0;
      const lim = Number(limit) || 0;
      if (!rows.length || lim <= 0) return [];
      const cur = afterId == null || afterId === '' ? null : String(afterId);
      let floor = '';
      if (cur != null) {
        const hit = byId.get(cur);
        if (hit) floor = cursorKey(hit.updated_at, hit.id);
        else floor = cursorKey(0, cur); // 游标条已被删：退化成"按 id 起步"（仍单调、不重复）
      }
      const out = [];
      for (const r of rows) {
        if (r.updated_at < since) continue;
        if (floor && cursorKey(r.updated_at, r.id) <= floor) continue;
        out.push(mapRow(r));
        if (out.length >= lim) break;
      }
      return out;
    },

    /** 段（下标区间，排序 = lastSeen 升序）：返回行含 id/text/updated_at（sweep 硬契约） */
    segment(lo, hi) {
      const a = Number(lo);
      const b = Number(hi);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
      return rows.slice(Math.max(0, a), Math.max(0, b) + 1).map(mapRow);
    },

    getById(id) {
      const r = byId.get(String(id));
      if (!r) return null;
      return { id: r.id, text: r.text, tags: r.tags, pinned: 0, created_at: r.updated_at, updated_at: r.updated_at };
    },

    allTexts() {
      return rows.map((r) => ({ id: r.id, text: r.text }));
    },

    allTags() {
      return rows.map((r) => ({ id: r.id, tags: r.tags }));
    },

    /**
     * ⚠️ 坑库**没有 FTS5** ⇒ 必须返回对象而不是抛错（`recall.mjs:141` 期望拿到对象、拿数组才走补位路）。
     * 照 `memory-source.mjs:86-101` 的兜底形状。
     */
    ftsSearch() {
      return { error: '坑库无 FTS5（pitfall source 无 FTS 补位路）' };
    },

    close() {
      // 幂等：重复 close 不得抛错（调用方常在 finally 里再关一次）
      if (closed) return;
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}
