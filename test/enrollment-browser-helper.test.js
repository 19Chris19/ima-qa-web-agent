const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

test('helper rejects malformed private configuration without disclosing its contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ima-helper-test-'));
  const file = join(directory, 'private.json');
  const secret = 'synthetic-private-helper-value';
  try {
    for (const data of [`{"key":"${secret}",broken}`, JSON.stringify({ key: 'a'.repeat(64), port: 0, browserPath: '/not-a-browser' })]) {
      writeFileSync(file, data, { mode: 0o600 });
      const result = spawnSync(process.execPath, ['scripts/enrollment-browser-helper.mjs', file], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr.trim(), 'Enrollment browser helper failed to start.');
      assert.ok(!result.stderr.includes(secret));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
