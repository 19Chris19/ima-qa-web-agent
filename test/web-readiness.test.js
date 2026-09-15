const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
const { WebReadiness } = require('../src/web-readiness');

function fixture(t, streamAsk) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = new WebAgentAccountDirectory({ storePath: path.join(root, 'accounts.json'), keyPath: path.join(root, 'key') });
  directory.upsertCapturedAccount({ id: 'synthetic', name: 'Synthetic', knowledgeBaseId: 'synthetic-kb',
    headers: { 'x-ima-cookie': 'IMA-UID=synthetic-user; IMA-TOKEN=synthetic-token' } });
  const pool = { accounts: [], now: Date.now,
    syncAccounts(rows) { this.accounts = rows.map(row => Object.assign(this.accounts.find(a => a.id === row.id) || {}, row, { activeRequests: 0 })); },
    _requireAccount(id) { return this.accounts.find(a => a.id === id); }, _notifyAvailability() {} };
  const readiness = new WebReadiness({ directory, pool, timeoutMs: 20, clientFactory: () => ({ streamAsk }) });
  return { directory, pool, readiness };
}

async function* success(options) {
  assert.equal(options.allowAuthRefresh, false);
  options.onDispatch();
  yield { type: 'sources', sources: [{ title: 'Synthetic evidence' }], sourceKinds: ['knowledge'] };
  yield { type: 'delta', text: 'Synthetic answer' };
  yield { type: 'done' };
}

test('one proved answer qualifies without storing question or answer', async t => {
  const { readiness, directory } = fixture(t, success);
  const result = await readiness.verify('synthetic', 'Synthetic private question');
  assert.equal(result.success, true);
  assert.equal(result.schedulable, 1);
  assert.equal(result.capacity, 1);
  assert.equal(result.generation, directory.load().generation);
  assert.equal(readiness.appliedGeneration, directory.load().generation);
  const disk = fs.readFileSync(directory.storePath, 'utf8');
  assert.equal(disk.includes('Synthetic private question'), false);
  assert.equal(disk.includes('Synthetic answer'), false);
});

test('web-only revalidation removes an old qualification and releases maintenance', async t => {
  const { readiness, pool } = fixture(t, success);
  await readiness.verify('synthetic');
  readiness.clientFactory = () => ({ async *streamAsk(options) {
    options.onDispatch();
    yield { type: 'sources', sources: [{}], sourceKinds: ['web'] };
    yield { type: 'delta', text: 'Synthetic' };
    yield { type: 'done' };
  } });
  const result = await readiness.verify('synthetic');
  assert.equal(result.code, 'probe_evidence_insufficient');
  assert.equal(result.schedulable, 0);
  assert.equal(result.capacity, 0);
  assert.equal(pool.accounts[0].maintenanceOperation, '');
});

test('a concurrent directory change rejects stale probe proof', async t => {
  const { readiness, directory } = fixture(t, success);
  readiness.clientFactory = () => ({ async *streamAsk(options) {
    const other = new WebAgentAccountDirectory({ storePath: directory.storePath, keyPath: directory.keyPath });
    other.setDisabled('synthetic', true);
    yield* success(options);
  } });
  const result = await readiness.verify('synthetic');
  assert.equal(result.success, false);
  assert.equal(result.code, 'account_store_generation_conflict');
  assert.equal(directory.reload().accounts[0].runtime.webQualification, null);
  assert.equal(readiness.pool.accounts[0].disabled, true);
});

test('cancelled probe releases maintenance and never qualifies', async t => {
  const { readiness, pool } = fixture(t, async function* (options) {
    options.onDispatch();
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
  });
  const pending = readiness.verify('synthetic');
  readiness.cancel('synthetic');
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(result.code, 'probe_cancelled');
  assert.equal(pool.accounts[0].maintenanceOperation, '');
});
