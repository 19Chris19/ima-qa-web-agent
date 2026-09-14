const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commitStore } = require('../src/generation-store');

test('stale enable cannot overwrite a newer qualification', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-cas-'));
  try {
    const file = path.join(dir, 'accounts.json');
    const initial = commitStore(file, { accounts: [], generation: 0 });
    const newer = commitStore(file, { ...initial, qualification: 'synthetic-proof' });
    assert.throws(() => commitStore(file, { ...initial, enabled: true }), { code: 'account_store_generation_conflict' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), newer);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('legacy storage is backed up privately before generation migration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-migrate-'));
  try {
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(file, JSON.stringify({ accounts: [] }));
    const result = commitStore(file, { accounts: [], generation: 0 });
    assert.equal(result.generation, 1);
    assert.equal(fs.statSync(`${file}.pre-generation-backup`).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
