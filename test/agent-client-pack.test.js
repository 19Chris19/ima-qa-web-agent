'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

test('Provider tarball retains standalone client sources without bundling nested dependencies', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const [pack] = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const files = pack.files.map(file => file.path.replace(/\\/gu, '/'));
  const nestedDependencies = files.filter(file => /(^|\/)node_modules\//u.test(file));
  assert.equal(nestedDependencies.length, 0,
    `Provider releases must exclude installed client dependencies: ${nestedDependencies.slice(0, 3).join(', ')}`);
  for (const file of ['package.json', 'npm-shrinkwrap.json', 'LICENSE', 'README.md',
    'bin/ima-qa.mjs', 'src/client.mjs', 'src/install.mjs', 'src/mcp.mjs', 'src/update.mjs',
    'skills/ima-qa/SKILL.md', 'skills/ima-qa/references/setup.md']) {
    assert.ok(files.includes(`packages/ima-qa-client/${file}`), file);
  }
});
