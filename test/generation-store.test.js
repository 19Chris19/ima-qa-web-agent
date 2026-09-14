const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commitStore } = require('../src/generation-store');
const lockfile = require('proper-lockfile');
const { promisify } = require('node:util');
const { spawn } = require('node:child_process');

const execFile = promisify(require('node:child_process').execFile);

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

test('cross-process writers use generation CAS and exactly one stale snapshot wins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-cas-race-'));
  try {
    const file = path.join(dir, 'accounts.json');
    commitStore(file, { generation: 0, accounts: [] });
    const worker = path.resolve(__dirname, '../scripts/storewriter-process.cjs');
    const results = await Promise.all([
      execFile(process.execPath, [worker, file, '1', 'alpha']),
      execFile(process.execPath, [worker, file, '1', 'bravo']),
    ].map(promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }))));
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => result.error?.code === 1).length, 1);
    const final = JSON.parse(fs.readFileSync(file));
    assert.equal(final.generation, 2);
    assert.ok(['alpha', 'bravo'].includes(final.marker));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a stale proper-lockfile lease left by a crashed writer is reclaimed safely', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-stale-lock-'));
  let release;
  try {
    const file = path.join(dir, 'accounts.json');
    commitStore(file, { generation: 0, accounts: [] });
    release = await lockfile.lock(file, { stale: 10000, update: 2000 });
    const leasePath = `${file}.lock`;
    const old = new Date(Date.now() - 30000);
    fs.utimesSync(leasePath, old, old);
    const next = commitStore(file, { generation: 1, recovered: true });
    assert.equal(next.generation, 2);
    assert.equal(JSON.parse(fs.readFileSync(file)).recovered, true);
  } finally {
    await release?.().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a killed lock holder is recovered without accepting its stale generation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-crashed-lock-'));
  let child;
  try {
    const file = path.join(dir, 'accounts.json');
    commitStore(file, { generation: 0, accounts: [] });
    const helper = path.resolve(__dirname, '../scripts/lockholder-process.cjs');
    child = spawn(process.execPath, [helper, file], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('lock_holder_timeout')), 5000);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('locked')) { clearTimeout(timer); resolve(); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { if (code !== null && code !== 0) { clearTimeout(timer); reject(new Error('lock_holder_failed')); } });
    });
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    const leasePath = `${file}.lock`;
    const old = new Date(Date.now() - 30000);
    fs.utimesSync(leasePath, old, old);
    assert.throws(() => commitStore(file, { generation: 0, stale: true }), { code: 'account_store_generation_conflict' });
    const recovered = commitStore(file, { generation: 1, recovered: true });
    assert.equal(recovered.generation, 2);
    assert.equal(JSON.parse(fs.readFileSync(file)).recovered, true);
    assert.equal(JSON.parse(fs.readFileSync(file)).stale, undefined);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
