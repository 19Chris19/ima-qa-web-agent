#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { getConfig } = require('../src/config');
const { loadRuntimeEnv } = require('../src/runtime-env');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const apply = process.argv.slice(2).includes('--apply');
  loadRuntimeEnv({ appDir });
  const config = getConfig(process.env);
  if (config.qaProvider !== 'ima-web-agent') {
    throw new Error('此工具只适用于 Provider A（IMA Web Agent）');
  }

  const directory = new WebAgentAccountDirectory({
    storePath: config.webAgent.accountStorePath,
    keyPath: config.webAgent.accountStoreKeyPath,
  });
  const candidates = directory.listAccounts().filter((account) => account.runtimeEnvPath);
  if (!candidates.length) {
    console.log('没有需要处理的旧式明文账号 env 导出。');
    return;
  }

  if (!apply) {
    console.log(`检测到 ${candidates.length} 个旧式账号 env 导出。`);
    console.log('确认后运行：npm run admin:seal-runtime -- --apply');
    return;
  }

  let removedManagedRuntimeEnvCount = 0;
  for (const account of candidates) {
    const result = directory.disableRuntimeEnvExport(account.id);
    if (result.removedManagedRuntimeEnv) {
      removedManagedRuntimeEnvCount += 1;
    }
  }
  console.log(`已封存 ${candidates.length} 个账号的运行期凭证导出；已删除 ${removedManagedRuntimeEnvCount} 个受管明文文件。`);
  console.log('请重启 Provider A 服务，使运行中的账号池重新读取加密账号库。');
}

try {
  main();
} catch (error) {
  console.error(`迁移失败：${error.message}`);
  process.exit(1);
}
