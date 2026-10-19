// 记忆引擎 v2 · 离线层 —— 启动自检 CLI
//
// 用法：node cli/selfcheck.mjs [--json] [--stub-embedder] [--memory-db X] [--vectors-db Y] [--model-dir Z]
// 退出码：0 = 全过（warn 不算失败）· 1 = 有 fail · 2 = 运行异常
import { isMainEntry, parseArgs, makeLogger, openRuntime } from '../lib/cli-util.mjs';
import { runSelfcheck } from '../lib/selfcheck.mjs';

const ICON = { ok: '✅', warn: '⚠️ ', fail: '❌', info: 'ℹ️ ' };

async function main() {
  const { flags } = parseArgs();
  const json = Boolean(flags.json);
  const log = makeLogger({ json, quiet: Boolean(flags.quiet) });
  let rt = null;
  try {
    rt = await openRuntime(flags);
    const result = await runSelfcheck({
      store: rt.store,
      source: rt.source,
      embedder: rt.embedder,
      config: rt.config,
      allowHostMismatch: !flags['strict-host'],
    });
    const out = {
      ok: result.ok,
      host: rt.config.hostId,
      memoryDb: rt.config.memoryDb,
      vectorsDb: rt.config.vectorsDb,
      modelId: rt.config.modelId,
      modelDir: rt.config.modelDir,
      embedder: rt.embedder.describe(),
      ...result,
    };
    if (json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    else {
      log('=== 启动自检 ===');
      log(`主机        : ${rt.config.hostId}`);
      log(`记忆库      : ${rt.config.memoryDb}`);
      log(`向量库      : ${rt.config.vectorsDb}`);
      log(`编码器      : ${JSON.stringify(rt.embedder.describe())}`);
      log('');
      for (const c of result.checks) log(`${ICON[c.status] || '·'} ${c.name}：${c.detail}`);
      log('');
      log(result.ok ? `✅ 自检通过（warn ${result.warned}）` : `❌ 自检失败（fail ${result.failed}）`);
    }
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) {
    const msg = String(e && e.stack ? e.stack : e);
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
    else log(`❌ ${msg}`);
    process.exitCode = 2;
  } finally {
    if (rt) rt.close();
  }
}

if (isMainEntry(import.meta.url)) await main();
