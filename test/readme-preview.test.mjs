import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('README capture server stays loopback, read-only and synthetic', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['assets/readme/source/preview.mjs', String(port)], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH },
  });
  const exited = once(child, 'exit');
  let output = '';
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Synthetic preview did not start')), 10000);
      child.stdout.on('data', data => { output += data; if (output.includes('Synthetic HTTP only:')) resolve(); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Synthetic preview exited before readiness')));
    });
    clearTimeout(timer);
    const fixtures = JSON.parse(await readFile(new URL('../assets/readme/source/synthetic-http.json', import.meta.url), 'utf8'));
    const base = 'http://127.0.0.1:' + port;
    const request = (route, options) => fetch(base + route, { signal: AbortSignal.timeout(5000), ...options });
    const [route, expected] = Object.entries(fixtures.responses)[0];
    assert.deepEqual(await (await request(route)).json(), expected);
    assert.equal((await request(route, { method: 'POST', body: 'synthetic-write-must-fail' })).status, 405);
    assert.equal((await request('/api/unrecognized')).status, 404);
    assert.equal((await request('/internal/secrets')).status, 404);
    assert.equal((await request('/assets/%2e%2e%2fpackage.json')).status, 403);
    assert.equal((await request('/public/%2e%2e%2fpackage.json')).status, 403);
    assert.equal((await request('/assets/readme/source/synthetic-http.json')).status, 200);
    const preview = await request('/readme-preview');
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /<h1/);
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(kill);
  }
});
