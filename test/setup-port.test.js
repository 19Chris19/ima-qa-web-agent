const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('setup enrolment hint uses the selected host port without exposing secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-setup-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/setup-provider-a.mjs', '--kb', '999000111', '--allowed-origins', '', '--host-port', '3317', '--env', path.join(dir, '.env')], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /--server-url http:\/\/127\.0\.0\.1:3317/);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.equal(env.split('\n').find(line => line.startsWith('ALLOWED_ORIGINS=')), 'ALLOWED_ORIGINS=');
    const secret = env.match(/^IMA_QA_ADMIN_TOKEN=(.+)$/m)[1];
    assert.equal(result.stdout.includes(secret), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
