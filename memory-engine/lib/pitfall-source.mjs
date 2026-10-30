// 坑库的只读数据源：把 `butler-pitfalls.json` 摆成与记忆源一模一样的形状。
//
// 为什么要有它：开工简报原来固定取"出现最多的三条"，跟本轮任务毫无关系；
// 有了这个源，坑条目也能按语义被召回。
//
// 四条不许破的口径：
//   1. 只读那个 JSON，一个字节都不回写；`readOnly:true` 是自证字段。
//   2. 方法与记忆源一一对应（下游按名字硬调，少一个当场 is not a function）：
//      count / maxUpdatedAt / idRange / pinnedIds / incrementalPage / segment /
//      getById / allTexts / allTags / ftsSearch / close。注意名字是 maxUpdatedAt。
//   3. 分页与分段吐出来的行必须带 id / text / updated_at —— 上层直接取，
//      缺了不会报错，只会把 undefined 写进向量行。
//   4. 坑没有数字 id 段：idRange 给"排序后的下标区间"，排序键是 lastSeen 升序、
//      平局按 id 字典序；分页沿用同一套顺序做游标，所以集合中途变了也只多扫不漏、不重复。

import fs from 'node:fs';

const SEED_MARK = '[seed]';
const CURSOR_WIDTH = 16;

/** 一条坑进向量的文本：seed 标记 + 分类前缀 + 正文 + 工具后缀；建议文本一律不进（会随建议漂移）。 */
export function pitfallText(row) {
  const seed = String(row.source || '') === 'seed' ? SEED_MARK : '';
  const label = row.category ? `[${row.category}] ` : '';
  const tools = row.tools && typeof row.tools === 'object' ? Object.keys(row.tools).join(',') : '';
  const suffix = tools ? ` | tools=${tools}` : '';
  return `${seed}${label}${row.normText ?? ''}${suffix}`;
}

// 工具字段的规范形态：对象取键名拼串，其它一律空串。
function toolsText(item) {
  if (!item.tools || typeof item.tools !== 'object') return '';
  return Object.keys(item.tools).join(',');
}

// 稳定顺序：先 lastSeen，再 id 字典序。平局必须先定死，否则翻页会来回抖。
function byLastSeenThenId(a, b) {
  if (a.updated_at !== b.updated_at) return a.updated_at - b.updated_at;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

// 游标的可比较形态：时间戳左补零到定长，再接 '|' 与 id ⇒ 字典序正好等于上面的顺序。
function cursorOf(updatedAt, id) {
  return `${String(updatedAt).padStart(CURSOR_WIDTH, '0')}|${id}`;
}

// 内层行 → 向量层要的形状（pinned 恒 0：坑库没有这个字段）
function toPageRow(row) {
  return { id: row.id, text: row.text, tags: row.tags, pinned: 0, updated_at: row.updated_at };
}

// 解析文件并取出条目数组：顶层直接是数组、或外面套一层 `pitfalls` 都认。
function readEntryList(jsonPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    const why = e && e.message ? e.message : String(e);
    throw new Error(`坑库解析失败: ${jsonPath}（${why}）`);
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.pitfalls) ? parsed.pitfalls : null;
  if (!list) throw new Error(`坑库结构不认识（应含 pitfalls 数组）: ${jsonPath}`);
  return list;
}

/**
 * 打开坑库（只读）。
 * @param {string} jsonPath `butler-pitfalls.json`
 */
export function openPitfallSource(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`坑库不存在: ${jsonPath}`);
  }

  const rows = readEntryList(jsonPath)
    .filter((item) => item && item.id != null)
    .map((item) => ({
      id: String(item.id),
      text: pitfallText(item),
      tags: toolsText(item),
      updated_at: Number(item.lastSeen || 0),
    }))
    .sort(byLastSeenThenId);
  const index = new Map(rows.map((row) => [row.id, row]));

  let shut = false;
  return {
    dbPath: jsonPath,
    readOnly: true,
    /** 自证：下游日志/自检按它报"逐来源" */
    sourceName: 'pitfall',
    /** 条目总数（观测用，等于 rows.length） */
    n: rows.length,

    count: () => rows.length,

    maxUpdatedAt: () => rows.reduce((peak, row) => (row.updated_at > peak ? row.updated_at : peak), 0),

    /** 坑没有数字 id ⇒ 给稳定等价量：排序后的下标闭区间。 */
    idRange: () => (rows.length ? { lo: 0, hi: rows.length - 1, n: rows.length } : { lo: null, hi: null, n: 0 }),

    /** 坑库没有 pinned 概念 ⇒ 永远空集（召回侧据此不排除任何条目）。 */
    pinnedIds: () => [],

    /**
     * 增量页：取 `updated_at >= sinceTs` 的条目，按 (lastSeen, id) 升序往后翻，
     * 游标就是上一页末条的 id。游标按"键比较"而不是按下标 ⇒ 中途删改也不会重也不会漏。
     */
    incrementalPage: (sinceTs, afterId, limit) => {
      const since = Number(sinceTs) || 0;
      const cap = Number(limit) || 0;
      if (!rows.length || cap <= 0) return [];
      const cursorId = afterId == null || afterId === '' ? null : String(afterId);
      let floor = '';
      if (cursorId != null) {
        const known = index.get(cursorId);
        // 游标条已经被删：退化成"从这个 id 起步"，整体仍然单调
        floor = known ? cursorOf(known.updated_at, known.id) : cursorOf(0, cursorId);
      }
      const page = [];
      for (const row of rows) {
        if (row.updated_at < since) continue;
        if (floor && cursorOf(row.updated_at, row.id) <= floor) continue;
        page.push(toPageRow(row));
        if (page.length >= cap) break;
      }
      return page;
    },

    /** 段（下标闭区间，顺序 = lastSeen 升序）：行里必须带 text 与 updated_at，上层直接取。 */
    segment: (lo, hi) => {
      const begin = Number(lo);
      const end = Number(hi);
      if (!Number.isFinite(begin) || !Number.isFinite(end)) return [];
      const from = Math.max(0, begin);
      return rows.slice(from, Math.max(0, end) + 1).map(toPageRow);
    },

    getById: (id) => {
      const found = index.get(String(id));
      if (!found) return null;
      return {
        id: found.id,
        text: found.text,
        tags: found.tags,
        pinned: 0,
        created_at: found.updated_at,
        updated_at: found.updated_at,
      };
    },

    allTexts: () => rows.map((row) => ({ id: row.id, text: row.text })),

    allTags: () => rows.map((row) => ({ id: row.id, tags: row.tags })),

    /**
     * 坑库没有 FTS5 ⇒ 这里必须回一个对象而不是抛错：
     * 召回侧拿对象就走"无关键词补位"那条路，抛错会整条链断掉。
     */
    ftsSearch: () => ({ error: '坑库无 FTS5（pitfall source 无 FTS 补位路）' }),

    close() {
      // 幂等：调用方常在 finally 里再关一次，重复关不许抛
      shut = true;
    },
    get closed() {
      return shut;
    },
  };
}
