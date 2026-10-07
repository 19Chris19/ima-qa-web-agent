#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const command = process.argv[2] || 'choose';
  const args = process.argv.slice(3);
  if (['choose', 'doctor', 'preflight'].includes(command)) {
    // Native entry points work even before application dependencies exist.
    const windows = process.platform === 'win32';
    const child = spawnSync(windows ? 'powershell.exe' : 'sh', windows
      ? ['-NoProfile', '-File', path.join(root, 'onboard.ps1'), command, ...args]
      : [path.join(root, 'onboard.sh'), command, ...args], { stdio: 'inherit' });
    process.exitCode = child.status ?? 2;
  } else {
    const indexes = args.flatMap((value, i) => value === '--deployment-mode' ? [i] : []);
    if (indexes.length !== 1 || args[indexes[0] + 1] !== 'independent') {
      throw Object.assign(new Error(), { code: 'deployment_mode_required' });
    }
    args.splice(indexes[0], 2);
    // Do not load runtime modules (or touch configuration) before the choice.
    const { default: deployment } = await import('../src/guided-deployment.js');
    const options = deployment.parseOptions(args);
    if (command === 'runtime') console.log(process.execPath);
    else await deployment.guided(root, command, options);
  }
} catch (error) {
  const code = /^[a-z_]+$/.test(error.code || '') ? error.code : 'guided_operation_failed';
  console.error(JSON.stringify({ stage: 'blocked', code, missing: [code], credentialsPrinted: false,
    next: 'Ask online/shared/independent before installation. Read docs/AGENT_DEPLOYMENT.md; do not reinitialize existing state.' }));
  process.exitCode = 1;
}
