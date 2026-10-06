const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const phase of ['startup', 'enrollment_contract', 'synthetic-private-value']) {
  test(`container verifier reports only allowlisted failure phase: ${phase}`, { skip: process.platform === 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-test-'));
    try {
      fs.writeFileSync(path.join(dir, 'docker'), `#!/usr/bin/env node
if(process.argv[2]==='exec') {
  console.log(JSON.stringify({failureStage:process.env.SYNTHETIC_PHASE}));
  console.error('synthetic-private-stderr');process.exit(1);
}
console.log('synthetic-container');
`, { mode: 0o700 });
      const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/verify-onboarding-container.mjs'), 'synthetic:image'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, SYNTHETIC_PHASE: phase },
      });
      assert.equal(result.status, 1);
      assert.deepEqual(JSON.parse(result.stderr), { emptyPool: false,
        phase: phase === 'synthetic-private-value' ? 'container_checks' : phase, credentialsPrinted: false });
      assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
