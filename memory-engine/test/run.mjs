// 记忆引擎 v2 · 离线层 —— 测试入口
// 用法：node test/run.mjs            （全部）
//       node test/run.mjs sync      （只跑文件名含 sync 的）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runAll } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = fs
  .readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

console.log(`记忆引擎 v2 · 离线层 单测（夹具目录 = 系统临时区）`);
console.log(`node ${process.version} · ${process.platform} · ${osLabel()}`);
console.log(`用例文件：${files.join(', ') || '(无)'}`);

for (const f of files) {
  const mod = await import(pathToFileURL(path.join(here, f)).href);
  if (mod?.__section) console.log(`\n▶ ${mod.__section}`);
}

const res = await runAll();
process.exitCode = res.failed ? 1 : 0;

function osLabel() {
  try {
    return `${process.env.COMPUTERNAME || 'unknown-host'}`;
  } catch {
    return 'unknown-host';
  }
}
