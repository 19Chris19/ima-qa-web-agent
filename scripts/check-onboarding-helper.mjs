import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

// A no-IMA probe: no page, login, account volume or question is created.
const { values } = parseArgs({ options: { directory: { type: 'string' }, image: { type: 'string' } } });
let temporary;
try {
  if (!values.directory || !/^[a-z0-9][a-z0-9./:_@-]+$/.test(values.image || '')) throw Error();
  const state = JSON.parse(fs.readFileSync(path.join(values.directory, 'helper-state.json')));
  const config = JSON.parse(fs.readFileSync(state.config));
  if (!/^[a-f0-9]{64}$/.test(config.key) || !Number.isInteger(config.port)) throw Error();
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-helper-probe-'));
  const env = path.join(temporary, 'probe.env');
  fs.writeFileSync(env, `HELPER_ENDPOINT=ws://host.docker.internal:${config.port}/${config.key}\n`, { mode: 0o600, flag: 'wx' });
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['run', '--rm', '--env-file', env, '--entrypoint', 'node', values.image, '-e',
      "require('playwright-core').chromium.connect(process.env.HELPER_ENDPOINT,{timeout:5000}).then(async b=>{await b.close();process.exit(0)}).catch(()=>process.exit(1))"], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(Error()); }, 30000);
    child.once('error', () => { clearTimeout(timer); reject(Error()); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error()); });
  });
  console.log(JSON.stringify({ containerToMaintenanceBrowser: true, realQaVerified: false }));
} catch {
  console.error(JSON.stringify({ containerToMaintenanceBrowser: false, credentialsPrinted: false })); process.exitCode = 1;
} finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
