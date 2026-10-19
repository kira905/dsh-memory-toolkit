// 记忆引擎 v2 · 离线层 —— 测试夹具
//
// 铁律：测试输出路径一律落 os.tmpdir() 下的临时目录（可注入），绝不写生产路径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** 建独立临时根；返回 { root, cleanup } */
export function makeTempRoot(prefix = 'dsh-mem-engine-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    paths: {
      memoryDb: path.join(root, 'memory', 'memory.db'),
      vectorsDb: path.join(root, 'memory-vectors', 'vectors.db'),
      stateFile: path.join(root, 'butler-memory-vectors-state.json'),
      pitfallsFile: path.join(root, 'butler-pitfalls.json'),
      pitfallDirtyFile: path.join(root, 'butler-pitfall-vector-dirty.json'),
      modelDir: path.join(root, 'models'),
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

const DDL = `
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, content='memories', content_rowid='id');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
  INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
END;
`;

/**
 * 造夹具记忆库（与生产同构：memories + external content FTS5 + 3 触发器）。
 * @param {string} dbPath
 * @param {Array<{id?:number,text:string,tags?:string,pinned?:number,updated_at:number,created_at?:number}>} rows
 */
export function makeMemoryDb(dbPath, rows) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  const ins = db.prepare(
    'INSERT INTO memories (id, text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    ins.run(
      r.id ?? null,
      r.text,
      r.tags ?? '',
      r.pinned ?? 0,
      r.created_at ?? r.updated_at,
      r.updated_at,
    );
  }
  db.close();
  return dbPath;
}

/** 直接改 text 而**不动 updated_at**（复刻 A7 的 apply-pinned-refine.mjs 行为） */
export function silentTextUpdate(dbPath, id, newText) {
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE memories SET text = ? WHERE id = ?').run(newText, Number(id));
  db.close();
}

/** 直接改 pinned（测试排除 pinned 用） */
export function setPinned(dbPath, id, pinned) {
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE memories SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, Number(id));
  db.close();
}

/** 读取向量库里某条的 text_hash */
export function readVectorHash(db, source, refId) {
  const r = db.prepare('SELECT text_hash FROM vectors WHERE source = ? AND ref_id = ?').get(source, String(refId));
  return r ? r.text_hash : null;
}

// ─────────────────────────── 坑库夹具（2026-10-10 · 补坑库联动A） ───────────────────────────

/** 16 位 hex 稳定 id（与生产同形：sigKey sha1 前 16 位） */
export function pitfallId(i) {
  return (i + 1).toString(16).padStart(16, '0');
}

/**
 * 造 `butler-pitfalls.json` 夹具（与生产同构：`{schemaVersion,updatedAt,device,counters,pitfalls[],seedSources}`）。
 * @param {Array<object>} rows 见 samplePitfalls
 */
export function makePitfallJson(jsonPath, rows) {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  const doc = {
    schemaVersion: 1,
    updatedAt: Math.max(...rows.map((r) => r.lastSeen), 0),
    device: 'TEST-HOST',
    counters: { scans: 0, findings: rows.length, excluded: 0 },
    pitfalls: rows,
    seedSources: { keng: 0, persona: 0, memory: 0 },
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return jsonPath;
}

/**
 * 生成 N 条坑（含**同一 lastSeen 的平局条**，用来验稳定游标 = lastSeen 升序 + id 字典序）。
 * 前 2 条按 `source:'seed'`（无 tools）造，验 seed 文本前缀分支。
 */
export function samplePitfalls(n, baseTs = 1_760_000_000_000) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    // 每 3 条共用同一 lastSeen（制造平局）；其余递增
    const lastSeen = baseTs + Math.floor(i / 3) * 1000;
    const seed = i < 2;
    rows.push({
      id: pitfallId(i),
      sigKey: `Error|NO_CODE|夹具坑 ${i}`,
      name: seed ? '' : `Error${i}`,
      code: seed ? '' : `E${i}`,
      normText: `夹具坑 ${i}：${i % 2 ? '跨机同步挡推口径' : '看板卡验收双判据'}`,
      category: i % 2 ? '同步' : '看板',
      tools: seed ? {} : { edit: i + 1, bash: 1 },
      count: i + 1,
      firstSeen: lastSeen - 500,
      lastSeen,
      sessions: [],
      devices: [],
      samples: [],
      source: seed ? 'seed' : 'scan',
      excluded: 0,
    });
  }
  return rows;
}

/** 造一个"第 N 次 encodeBatch 必炸"的编码器（测失败保留进度） */
export function makeFlakyEmbedder(base, { failOnBatchCall = 2 } = {}) {
  let calls = 0;
  return {
    kind: 'flaky',
    get modelId() {
      return base.modelId;
    },
    get dim() {
      return base.dim;
    },
    describe: () => ({ kind: 'flaky', wrapped: base.describe() }),
    health: () => base.health(),
    encode: (t) => base.encode(t),
    async encodeBatch(texts) {
      calls += 1;
      if (calls === failOnBatchCall) throw new Error(`模拟编码崩溃（第 ${calls} 次 encodeBatch）`);
      return base.encodeBatch(texts);
    },
  };
}

/** 生成 N 条中文记忆（表意稳定、便于断言） */
export function sampleRows(n, baseTs = 1_760_000_000_000) {
  const topics = [
    '跨机同步的挡推裁决口径与三仓推送顺序',
    '守护鱼崩溃链路与分身唤醒条件',
    '看板卡的验收双判据与执行会话绑定',
    '生图角色一致性参考图与提示词模板',
    '记忆库的 FTS5 分词实测结论与召回策略',
    '任务看板 ledger 并回与版本门',
    '权限默认值的部署 override 注入路径',
    '会话归档与 zstd 多帧修复流程',
    '代理自控脚本的直连优先判断',
    '本地 ComfyUI 栈的启动与模型切换',
  ];
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      id: i + 1,
      text: `#${i + 1} ${topics[i % topics.length]}（第 ${i + 1} 条样本，含 task-board 与 3080 关键词）`,
      tags: i % 3 === 0 ? 'task-board, 同步' : '技术',
      pinned: 0,
      created_at: baseTs + i * 1000,
      updated_at: baseTs + i * 1000,
    });
  }
  return rows;
}
