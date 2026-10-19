/**
 * FORK-EDIT(2026-09-21): S2b 单测夹具 —— 临时目录里的记忆库/向量库（**绝不落生产路径**）。
 *
 * 口径（家规「测试不得写生产路径」）：一切路径来自 `fs.mkdtempSync(os.tmpdir())`，
 * 由调用方显式传给被测模块（config.memoryDb / config.vectorsDb / config.logsDir）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
// FORK-EDIT(2026-09-22): U3 adapter 接入 —— 夹具造注入事件用的事件名取自适配层唯一源（值恒等）。
import { EV } from '../src/host-adapter.js';

export const DIM = 512;

/** 确定性 stub 向量（char n-gram 哈希 → dim 维 + L2 归一化）。仅供单测，无任何语义质量。 */
export function stubVector(text, dim = DIM) {
  const v = new Float32Array(dim);
  const s = String(text ?? '').toLowerCase();
  const grams = [];
  for (let n = 1; n <= 3; n += 1) {
    for (let i = 0; i + n <= s.length; i += 1) grams.push(s.slice(i, i + n));
  }
  for (const g of grams) {
    const h = crypto.createHash('md5').update(g).digest();
    const idx = ((h[0] << 8) | h[1]) % dim;
    const sign = h[2] % 2 === 0 ? 1 : -1;
    v[idx] += sign;
  }
  let norm = 0;
  for (let i = 0; i < dim; i += 1) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i += 1) v[i] /= norm;
  return v;
}

const MEMORY_DDL = `
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

const VECTORS_DDL = `
  CREATE TABLE IF NOT EXISTS vectors (
    source TEXT NOT NULL, ref_id TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL,
    vec BLOB NOT NULL, text_hash TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (source, ref_id)
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

/**
 * 造一个隔离环境（临时目录 + 两侧库 + 记忆条目）。
 * @param {object} [opts]
 * @param {Array<{text:string,tags?:string,pinned?:boolean,updated_at?:number}>} [opts.memories]
 * @param {boolean} [opts.makeVectors] 是否建 vectors.db（false = 模拟"向量库不存在"）
 * @param {boolean} [opts.makeMemory] 是否建 memory.db
 * @param {boolean} [opts.writeAutonomy] 是否写 butler-autonomy.json
 * @param {boolean} [opts.moduleEnabled] 模块位开关值
 * @param {boolean} [opts.writeLogsDir] 是否预建 logs 目录
 */
export function makeTempEnv(opts = {}) {
  const {
    memories = [],
    makeVectors = true,
    makeMemory = true,
    writeAutonomy = true,
    moduleEnabled = true,
    writeLogsDir = true,
    modelId = 'stub-ngram',
  } = opts;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g24-s2b-'));
  const home = path.join(root, '.dsh');
  const memoryDb = path.join(home, 'memory', 'memory.db');
  const vectorsDb = path.join(home, 'memory-vectors', 'vectors.db');
  const logsDir = path.join(home, 'logs');
  fs.mkdirSync(path.dirname(memoryDb), { recursive: true });
  if (writeLogsDir) fs.mkdirSync(logsDir, { recursive: true });

  const inserted = [];
  if (makeMemory) {
    const db = new DatabaseSync(memoryDb);
    db.exec(MEMORY_DDL);
    const stmt = db.prepare(
      'INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    memories.forEach((m, i) => {
      const ts = m.updated_at ?? 1700000000000 + i * 86400000;
      const r = stmt.run(String(m.text), String(m.tags ?? ''), m.pinned ? 1 : 0, ts, ts);
      inserted.push({ id: Number(r.lastInsertRowid), text: String(m.text), tags: String(m.tags ?? ''), pinned: Boolean(m.pinned), updated_at: ts });
    });
    db.close();
  }

  if (makeVectors) {
    fs.mkdirSync(path.dirname(vectorsDb), { recursive: true });
    const vdb = new DatabaseSync(vectorsDb);
    vdb.exec(VECTORS_DDL);
    const ins = vdb.prepare(
      'INSERT INTO vectors (source, ref_id, model, dim, vec, text_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const rec of inserted) {
      const vec = stubVector(rec.text);
      ins.run(
        'memory',
        String(rec.id),
        modelId,
        DIM,
        Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
        crypto.createHash('sha256').update(rec.text).digest('hex').slice(0, 16),
        rec.updated_at,
      );
    }
    vdb.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schemaVersion', '1');
    vdb.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('modelId', modelId);
    vdb.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('dim', String(DIM));
    vdb.close();
  }

  if (writeAutonomy) {
    fs.writeFileSync(
      path.join(home, 'butler-autonomy.json'),
      `${JSON.stringify({ schemaVersion: 1, modules: { 'memory-recall': { enabled: Boolean(moduleEnabled), since: '2026-09-21T00:00:00.000Z', by: 'test', why: 's2b unittest' } } }, null, 2)}\n`,
      'utf8',
    );
  }

  return {
    root,
    home,
    memoryDb,
    vectorsDb,
    logsDir,
    inserted,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

/** 内存 logger（可注入；不落盘）。 */
export function memoryLogger() {
  const lines = [];
  return {
    log: (obj) => {
      lines.push(obj);
      return true;
    },
    sweep: () => {},
    path: '(memory)',
    stats: () => ({ written: lines.length, errors: 0 }),
    lines,
    find: (event) => lines.filter((l) => l.event === event),
  };
}

/** 结构化 stub 桥（可注入；可控 ready / 延迟 / 报错）。 */
export function stubBridge({ ready = true, delayMs = 0, throwOnEncode = null, dim = DIM } = {}) {
  const calls = { probe: 0, encode: 0 };
  return {
    host: '127.0.0.1',
    port: 8201,
    kind: 'stub',
    calls,
    async probe() {
      calls.probe += 1;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return ready
        ? { ok: true, port: 8201, dim, model: 'stub-ngram', error: null }
        : { ok: false, port: null, dim: 0, model: null, error: 'ECONNREFUSED' };
    },
    async health() {
      return this.probe();
    },
    async encode(text) {
      calls.encode += 1;
      if (throwOnEncode) throw new Error(throwOnEncode);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return stubVector(String(text), dim);
    },
    stats: () => ({ encodeCalls: calls.encode }),
  };
}

/** 假 agent（surface 可见性测试用）：nodes/events 结构照 dsh-session 形态。 */
export function fakeAgent(events) {
  const list = events || [];
  return {
    id: 'test-session',
    session: {
      events: list,
      surface: { nodes: list.map((_, i) => i) },
    },
  };
}

/** 造一条"注入消息"事件（形态与插件注入一致）。 */
export function injectionEvent(text, ids = [], seq = 0) {
  return { seq, type: EV.USER_MESSAGE, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'memory-recall', version: 1, items: ids } } };
}
