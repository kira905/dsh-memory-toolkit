// 号段哨兵（单机退化版）：看「下一条新 id 会不会落到不属于这台机的号段里」。
//
// 单机 / 多机怎么退化：
//   · 缺省（配置里只有一条 band）= **单写者检查**：只读本机库的 sqlite_sequence，
//     判 nextId 是否落在 [base, base+width)；不 ssh、不猜别的机器、不假装知道对端。
//   · 配置里有多条 band 且给了 remote（ssh 别名 + 远端 node 路径）时，才逐台去读。
//     **任一远端读不到 ⇒ 结论写「未探测 / 不可达」，退出码不得为 4**
//     （4 只留给「本机库读不到」这种真失败 —— 这是生产件踩过的坑，别改回去）。
//
// 判据（沿用生产件的好口径，实现自己写）：
//   ① 主判据：seq 决定的下一条新 id 必须 ∈ [base, base+width)；低了下界 / 冲了上界都判红；
//   ② 出现**更高位段**的行 ⇒ 红（更高位 id 不可能由这一台合法产生）；
//   ③ 出现**更低位的别台段**行 ⇒ 只披露不判红（历史搬入 / 合并搬入共用段，删行=删记忆）；
//   ④ 本机库读不到 / 打不开 ⇒ rc=4（fail-closed，不算通过）。
//
// 本文件纯只读：零 INSERT/UPDATE/DELETE，不碰 sqlite_sequence，不 VACUUM、不 checkpoint。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readJsonFile, defaultBandsConfigPath } from './layers.mjs';

export const VERSION = '1.0.0';
export const MARK = 'K5BAND:';
export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2, BAND: 3, LOCAL_UNREADABLE: 4, UNPROBED: 5 });

const DEFAULTS = Object.freeze({ width: 1_000_000, base: 2_000_000 });
const HOST_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

function positiveInt(value, where) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${where} 必须是正整数，实际是 ${JSON.stringify(value)}`);
  return n;
}

/**
 * 读号段配置。号段表**只在配置里**：代码里没有 ROG / M6800 / TUF 这类主机名，
 * 也没有任何"三台机"的假设。
 */
export function loadBandConfig({ file = null, env = process.env } = {}) {
  const cfgPath = file ? path.resolve(file) : path.resolve(env.MEMORY_ENGINE_BANDS_FILE || defaultBandsConfigPath());
  const disk = readJsonFile(cfgPath);
  const warnings = [];
  if (!disk.ok && disk.reason !== 'missing') throw new Error(`号段配置读不了（${cfgPath}）：${disk.reason}`);
  if (!disk.ok) warnings.push(`号段配置不在（${cfgPath}）⇒ 用单机兜底：base=${DEFAULTS.base} width=${DEFAULTS.width}`);
  const raw = disk.ok && disk.value && typeof disk.value === 'object' ? disk.value : {};

  const width = positiveInt(raw.width ?? DEFAULTS.width, '配置 width');
  const list = Array.isArray(raw.bands) && raw.bands.length ? raw.bands : [{ host: 'local', base: DEFAULTS.base }];
  const seen = new Set();
  const bands = list.map((item, index) => {
    const host = String(item?.host ?? '').trim() || `band${index}`;
    if (!HOST_KEY.test(host)) throw new Error(`第 ${index + 1} 条 band 的 host 不合法：${JSON.stringify(host)}`);
    if (seen.has(host.toLowerCase())) throw new Error(`band 的 host 重复：${host}`);
    seen.add(host.toLowerCase());
    const base = positiveInt(item?.base ?? DEFAULTS.base + index * width, `band「${host}」的 base`);
    const remote = item?.remote && typeof item.remote === 'object' ? { ...item.remote } : null;
    if (remote) {
      if (!remote.ssh) throw new Error(`band「${host}」的 remote 缺 ssh 别名`);
      remote.node = String(remote.node || 'node');
      remote.db = remote.db ? String(remote.db) : '';
    }
    return { host, base, remote };
  });

  const sorted = [...bands].sort((a, b) => a.base - b.base);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].base < sorted[i - 1].base + width) {
      throw new Error(`号段重叠：${sorted[i - 1].host} 的 [${sorted[i - 1].base}, ${sorted[i - 1].base + width}) 与 ${sorted[i].host} 的起点 ${sorted[i].base} 相交`);
    }
  }

  const self = String(raw.self ?? bands[0].host).trim();
  const selfBand = bands.find((b) => b.host.toLowerCase() === self.toLowerCase());
  if (!selfBand) throw new Error(`配置 self=「${self}」不在 bands 里（有一台机没写进号段表）`);

  return { file: cfgPath, fileUsed: disk.ok, width, bands, self: selfBand.host, warnings };
}

/** 每一段的闭开区间 [lo, hi) + 首段下界之上/末段上界之外的兜底两段。 */
export function bandRanges(cfg) {
  const sorted = [...cfg.bands].sort((a, b) => a.base - b.base);
  return sorted.map((b) => [b.base, b.base + cfg.width]);
}

function emptyCounts(n) {
  const counts = new Array(n).fill(0);
  return { counts, below: 0, above: 0 };
}

/** 本机（或任意本地文件）只读快照。 */
export function snapshotLocal(dbPath, ranges) {
  const abs = path.resolve(dbPath);
  const out = {
    ok: false,
    via: 'local',
    dbPath: abs,
    host: os.hostname(),
    node: process.version,
    seq: null,
    rows: null,
    minId: null,
    maxId: null,
    counts: emptyCounts(ranges.length).counts,
    below: 0,
    above: 0,
    error: null,
  };
  if (!fs.existsSync(abs)) {
    out.error = `库文件不存在：${abs}`;
    return out;
  }
  let db = null;
  try {
    db = new DatabaseSync(abs, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000;');
    const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'memories'").get();
    out.seq = seqRow && seqRow.seq !== undefined ? Number(seqRow.seq) : null;
    const agg = db.prepare('SELECT COUNT(*) AS n, MIN(id) AS lo, MAX(id) AS hi FROM memories').get();
    out.rows = Number(agg.n);
    out.minId = agg.lo === null ? null : Number(agg.lo);
    out.maxId = agg.hi === null ? null : Number(agg.hi);
    const between = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id >= ? AND id < ?');
    out.counts = ranges.map(([lo, hi]) => Number(between.get(Number(lo), Number(hi)).n));
    const first = ranges[0];
    const last = ranges[ranges.length - 1];
    out.below = Number(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id < ?').get(Number(first[0])).n);
    out.above = Number(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id >= ?').get(Number(last[1])).n);
    out.ok = true;
  } catch (e) {
    out.error = `读不动：${e && e.message}`;
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 远端一段的取数脚本（经 stdin 喂给对端 node，对端不落任何文件）。 */
export function remoteScript({ dbPath = '', ranges }) {
  const db = JSON.stringify(String(dbPath || ''));
  const rg = JSON.stringify(ranges);
  return [
    "const {DatabaseSync}=require('node:sqlite');",
    "const os=require('node:os'),path=require('node:path');",
    `const DB=${db};const R=${rg};`,
    "const p=DB||path.join(process.env.USERPROFILE||os.homedir(),'.dsh','memory','memory.db');",
    "const o={host:os.hostname(),node:process.version,db:p};",
    'try{',
    'const d=new DatabaseSync(p,{readOnly:true});',
    'const s=d.prepare("SELECT seq FROM sqlite_sequence WHERE name=\'memories\'").get();',
    'o.seq=s&&s.seq!==undefined?Number(s.seq):null;',
    "const a=d.prepare('SELECT COUNT(*) n,MIN(id) lo,MAX(id) hi FROM memories').get();",
    'o.rows=Number(a.n);o.minId=a.lo===null?null:Number(a.lo);o.maxId=a.hi===null?null:Number(a.hi);',
    "const q=d.prepare('SELECT COUNT(*) n FROM memories WHERE id>=? AND id<?');",
    'o.counts=R.map(function(r){return Number(q.get(r[0],r[1]).n)});',
    "o.below=Number(d.prepare('SELECT COUNT(*) n FROM memories WHERE id<?').get(R[0][0]).n);",
    "o.above=Number(d.prepare('SELECT COUNT(*) n FROM memories WHERE id>=?').get(R[R.length-1][1]).n);",
    'd.close();',
    '}catch(e){o.error=String((e&&e.message)||e)}',
    `process.stdout.write('${MARK}'+JSON.stringify(o)+'\\\\n');`,
  ].join('\n');
}

function firstLine(text) {
  return String(text || '').trim().split(/\r?\n/).filter(Boolean)[0] || '';
}

/** 远端一段：连不上 / 没吐约定 JSON ⇒ unreachable（**不是** 本机失败）。 */
export function probeRemote(band, { ranges, timeoutMs = 20000 } = {}) {
  const remote = band.remote;
  if (!remote || !remote.ssh) {
    return { ok: false, via: 'unconfigured', unreachable: true, host: band.host, error: '配置里没给 remote.ssh（这一段未探测）' };
  }
  const script = remoteScript({ dbPath: remote.db, ranges });
  const argv = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', remote.ssh, `${remote.node} -`];
  const r = spawnSync('ssh', argv, {
    input: script,
    timeout: Math.max(1000, Number(timeoutMs) || 20000),
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8') : String(r.stdout ?? '');
  const stderr = Buffer.isBuffer(r.stderr) ? r.stderr.toString('utf8') : String(r.stderr ?? '');
  const hit = stdout.split(/\r?\n/).find((line) => line.startsWith(MARK));
  if (!hit) {
    const why = r.error
      ? `ssh 调起失败：${r.error.message}`
      : r.status === 255
        ? `连不上「${remote.ssh}」${stderr ? `：${firstLine(stderr)}` : ''}`
        : `对端没吐出约定 JSON（rc=${r.status}）${stderr ? `：${firstLine(stderr)}` : ''}`;
    return { ok: false, via: `ssh:${remote.ssh}`, unreachable: true, host: band.host, error: why };
  }
  let data;
  try {
    data = JSON.parse(hit.slice(MARK.length));
  } catch (e) {
    return { ok: false, via: `ssh:${remote.ssh}`, unreachable: true, host: band.host, error: `对端 JSON 解不开：${e && e.message}` };
  }
  if (data.error) {
    return { ok: false, via: `ssh:${remote.ssh}`, unreachable: true, host: band.host, dbPath: data.db, error: `对端读库失败：${data.error}` };
  }
  return {
    ok: true,
    via: `ssh:${remote.ssh}`,
    host: data.host || band.host,
    node: data.node,
    dbPath: data.db,
    seq: data.seq === undefined ? null : Number(data.seq),
    rows: Number(data.rows),
    minId: data.minId === null ? null : Number(data.minId),
    maxId: data.maxId === null ? null : Number(data.maxId),
    counts: Array.isArray(data.counts) ? data.counts.map(Number) : [],
    below: Number(data.below ?? 0),
    above: Number(data.above ?? 0),
    error: null,
  };
}

/** 一台的判据：problems 判红、disclosures 只披露、warnings 提醒。 */
export function judgeSnapshot(rec, { bands, width, selfHost }) {
  const problems = [];
  const disclosures = [];
  const warnings = [];
  const label = rec.host || rec.label || '?';
  const ownIndex = bands.findIndex((b) => b.host.toLowerCase() === String(label).toLowerCase());
  const band = bands[ownIndex];
  if (!band) {
    problems.push(`「${label}」不在号段表里 —— 无法判它的段`);
    return { problems, disclosures, warnings };
  }
  const lo = band.base;
  const hi = band.base + width;

  if (rec.seq === null || rec.seq === undefined) {
    problems.push('读不到 sqlite_sequence（memories）⇒ 判不了下一条新 id');
  } else {
    const nextId = rec.seq + 1;
    rec.nextId = nextId;
    if (nextId < lo) {
      problems.push(`seq=${rec.seq} ⇒ 下一条新 id=${nextId} 低于本段下界 ${lo}（号段未落位 / 被回退，应落在 [${lo}, ${hi})）`);
    } else if (nextId >= hi) {
      problems.push(`seq=${rec.seq} ⇒ 下一条新 id=${nextId} 冲出本段上界 [${lo}, ${hi})（号段被顶高）`);
    }
  }

  const counts = rec.counts || [];
  for (let i = 0; i < bands.length; i += 1) {
    const n = Number(counts[i] ?? 0);
    if (n <= 0 || i === ownIndex) continue;
    const other = bands[i];
    if (other.base > band.base) {
      problems.push(`出现更高位段 ${n} 行（[${other.base}, ${other.base + width}) 属于「${other.host}」）—— 更高位 id 不可能由「${label}」合法产生`);
    } else {
      disclosures.push(`历史搬入行 ${n} 行（[${other.base}, ${other.base + width}) 属于「${other.host}」，比本段低）—— 不判红：删行=删记忆，且不影响后续新 id`);
    }
  }
  const above = Number(rec.above ?? 0);
  if (above > 0) problems.push(`出现 ${above} 行超出全部号段（id ≥ ${bands[bands.length - 1].base + width}）—— 号段表里没这一段`);
  const below = Number(rec.below ?? 0);
  if (below > 0) disclosures.push(`更低位段 ${below} 行（id < ${bands[0].base}，历史遗留/合并搬入）—— 不判红`);

  const own = Number(counts[ownIndex] ?? 0);
  rec.ownBandIndex = ownIndex;
  rec.ownBandRows = own;
  if (own === 0) warnings.push(`本段 [${lo}, ${hi}) 暂时没有行（只说明还没写过新记忆，不判异常）`);
  return { problems, disclosures, warnings };
}

/**
 * 跑一遍哨兵。
 * @returns 报告对象（含 verdict / exitCode / hosts / problems / disclosures / warnings）
 */
export function evaluate({ config, dbPath, only = null, overrides = {}, timeoutMs = 20000 } = {}) {
  const bands = config.bands.map((b) => {
    const key = b.host.toLowerCase();
    const override = overrides[key];
    return override ? { ...b, base: Number(override) } : b;
  });
  const ranges = bandRanges({ ...config, bands });
  const wanted = only && only.length ? new Set(only.map((s) => s.toLowerCase())) : null;

  const report = {
    tool: 'band-sentinel',
    version: VERSION,
    at: new Date().toISOString(),
    onHost: os.hostname(),
    node: process.version,
    config: { file: config.file, fileUsed: config.fileUsed, self: config.self, width: config.width, bands },
    mode: bands.length > 1 ? 'multi' : 'single',
    criterion:
      'seq 决定的下一条新 id 必须落在本段内；出现更高位段的行判红；更低位的别台段行只披露不判红；本机库读不到才 rc=4',
    hosts: [],
    problems: [],
    disclosures: [...config.warnings],
    warnings: [],
    unprobed: [],
    localUnreadable: false,
    verdict: 'PASS',
    exitCode: EXIT.OK,
  };

  for (const band of bands) {
    if (wanted && !wanted.has(band.host.toLowerCase())) continue;
    const isSelf = band.host.toLowerCase() === String(config.self).toLowerCase();
    let rec;
    let localFailure = false;
    if (isSelf) {
      rec = snapshotLocal(dbPath, ranges);
      rec.osHost = rec.host;
      rec.host = band.host;
      rec.label = band.host;
      localFailure = !rec.ok;
    } else if (!band.remote) {
      report.unprobed.push(`${band.host}：未探测（配置里没给 remote.ssh）`);
      report.hosts.push({ host: band.host, label: band.host, via: 'unconfigured', ok: false, unprobed: true, base: band.base, error: '未探测（配置里没给 remote.ssh）' });
      continue;
    } else {
      rec = probeRemote(band, { ranges, timeoutMs });
      rec.osHost = rec.host;
      rec.host = band.host;
      rec.label = band.host;
    }
    rec.base = band.base;
    rec.isSelf = isSelf;
    rec.seq = rec.seq === undefined ? null : rec.seq;

    if (!rec.ok) {
      rec.problems = [];
      rec.disclosures = [];
      rec.warnings = [];
      report.hosts.push(rec);
      if (localFailure) {
        report.localUnreadable = true;
        report.problems.push(`${band.host}：本机库读不到（fail-closed，不算通过）—— ${rec.error || '未知原因'}`);
      } else {
        report.unprobed.push(`${band.host}：未探测 / 不可达 —— ${rec.error || '未知原因'}`);
      }
      continue;
    }
    const verdict = judgeSnapshot(rec, { bands, width: config.width, selfHost: config.self });
    rec.problems = verdict.problems;
    rec.disclosures = verdict.disclosures;
    rec.warnings = verdict.warnings;
    for (const p of verdict.problems) report.problems.push(`${band.host}：${p}`);
    for (const d of verdict.disclosures) report.disclosures.push(`${band.host}：${d}`);
    for (const w of verdict.warnings) report.warnings.push(`${band.host}：${w}`);
    report.hosts.push(rec);
  }

  if (report.localUnreadable) {
    report.verdict = 'LOCAL-UNREADABLE';
    report.exitCode = EXIT.LOCAL_UNREADABLE;
  } else if (report.problems.length) {
    report.verdict = 'FAIL';
    report.exitCode = EXIT.BAND;
  } else if (report.unprobed.length) {
    report.verdict = 'PARTIAL';
    report.exitCode = EXIT.OK;
  } else {
    report.verdict = 'PASS';
    report.exitCode = EXIT.OK;
  }
  return report;
}

/** 报告里的时间一律本地时（ISO 里存的是 UTC，人读的还是本地钟点）。 */
function localStamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatLine(report) {
  const bits = report.hosts.map((h) => {
    if (h.unprobed) return `${h.host}=未探测`;
    if (!h.ok) return `${h.host}=读不到`;
    const mark = h.problems.length ? '✗' : '✓';
    return `${h.host} seq=${h.seq}→${h.nextId ?? '?'}${mark}`;
  });
  return `[号段哨兵] ${localStamp(report.at)} ${report.verdict} · ${bits.join(' · ')}`;
}

export function formatHuman(report) {
  const lines = [];
  lines.push(`[band-sentinel] v${VERSION} · ${localStamp(report.at)} · 本机=${report.onHost} · node ${report.node}`);
  lines.push(`  模式：${report.mode === 'single' ? '单机（单写者号段检查，不 ssh）' : `多机（${report.config.bands.length} 段）`} · 本机段=${report.config.self} · 段宽=${report.config.width}`);
  lines.push(`  配置：${report.config.file}${report.config.fileUsed ? '' : '（文件不在 ⇒ 用兜底）'}`);
  for (const h of report.hosts) {
    if (h.unprobed) {
      lines.push(`  ${String(h.host).padEnd(8)} ⚠️ 未探测 —— ${h.error}`);
      continue;
    }
    if (!h.ok) {
      lines.push(`  ${String(h.host).padEnd(8)} ✗ 读不到 [${h.via}] ${h.error}`);
      continue;
    }
    const mark = h.problems.length ? '✗' : '✓';
    const ownRows = h.ownBandRows === undefined ? '?' : h.ownBandRows;
    lines.push(
      `  ${String(h.host).padEnd(8)} ${mark} seq=${h.seq} → 下一条 ${h.nextId ?? '?'}｜期望 [${h.base}, ${h.base + report.config.width})｜` +
        `本段 ${ownRows} 行｜取数 ${h.via}${h.dbPath ? `｜库 ${h.dbPath}` : ''}`,
    );
    for (const p of h.problems) lines.push(`        ✗ ${p}`);
    for (const d of h.disclosures) lines.push(`        ℹ️ ${d}`);
    for (const w of h.warnings) lines.push(`        ⚠️ ${w}`);
  }
  if (report.problems.length) lines.push(`  结论 FAIL（${report.problems.length} 条异常，rc=${report.exitCode}）`);
  else if (report.unprobed.length) lines.push(`  结论 PARTIAL（${report.unprobed.length} 段未探测 / 不可达，rc=${report.exitCode} —— 不算红，但也别当全部正常）`);
  else lines.push(`  结论 PASS（${report.hosts.length} 段全部正常）`);
  return lines.join('\n');
}
