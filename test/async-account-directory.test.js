const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const lockfile = require('proper-lockfile');
const { AsyncAccountDirectory } = require('../src/async-account-directory');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { WebReadiness } = require('../src/web-readiness');
const input = { id: 'synthetic', name: 'synthetic', knowledgeBaseId: '123', requireQualification: false,
  headers: { 'x-ima-cookie': 'IMA-UID=synthetic; IMA-TOKEN=fake; IMA-REFRESH-TOKEN=fake' } };
async function fixture(t, extra = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-persistence-')));
  fs.chmodSync(root, 0o700);
  const options = { storePath: path.join(root, 'accounts.json'), keyPath: path.join(root, 'key'), keyMaterial: 'synthetic-only-key', ...extra };
  const directory = await new AsyncAccountDirectory({ ...options, commitTimeoutMs: 2000 }).initialize();
  t.after(async () => { await directory.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  await directory.initializeWebMode('knowledge_agent'); await directory.addCapturedAccount({ ...input,
    ...(extra.runtimeExport ? { runtimeEnvPath: path.join(root, 'synthetic.env') } : {}) });
  directory.timeoutMs = extra.commitTimeoutMs || 20000;
  return { directory, root, options };
}
function faultFactory(fault, extra = {}) {
  let first = true;
  return (entry, options) => {
    if (!first) return new Worker(entry, options);
    first = false;
    return new Worker(path.join(__dirname, '../scripts/test-fixtures/account-persistence-fault-worker.cjs'), {
      workerData: { ...options.workerData, entry, fault, ...extra },
    });
  };
}
const observation = (totalRequests = 0, lastUsedAt = 0) => ({ id: 'synthetic', activeRequests: 0,
  totalRequests, lastUsedAt, cooldownUntil: 0, consecutiveErrors: 0, disabled: false, disabledReason: '', lastError: '' });

test('critical transactions serialize drafts, preserve encryption and acknowledge only committed generations', async t => {
  const { directory: d, options } = await fixture(t);
  const generation = d.load().generation;
  const first = d.setMaxConcurrent('synthetic', 2), second = d.recordEvent('synthetic', 'synthetic', 'synthetic');
  assert.equal(d.getAccount('synthetic').maxConcurrent, 1);
  await Promise.all([first, second]);
  assert.equal(d.load().generation, generation + 2);
  assert.equal(new WebAgentAccountDirectory(options).getAccount('synthetic').maxConcurrent, 2);
  assert.equal(fs.statSync(options.storePath).mode & 0o777, 0o600);
  assert.ok(d.getAccount('synthetic').secret.ciphertext);
  assert.equal(Object.isFrozen(d.load()), true);
});

test('idle maintenance writes nothing; statistics coalesce without changing qualification bindings', async t => {
  const { directory: d, options } = await fixture(t);
  const before = fs.readFileSync(options.storePath), binding = d.webQualificationBinding('synthetic');
  const count = d.metrics.commits;
  for (let i = 0; i < 10; i++) await d.recordRuntimeState(observation());
  assert.equal(d.metrics.commits, count); assert.equal(d.dirtyStats, false);
  for (let i = 1; i <= 50; i++) await d.recordRuntimeState(observation(i, i));
  assert.deepEqual(d.webQualificationBinding('synthetic'), binding);
  await new Promise(resolve => setTimeout(resolve, 1150));
  await d.flushStatistics();
  assert.equal(d.metrics.statsCommits, 1);
  assert.deepEqual(fs.readFileSync(options.storePath), before);
  assert.equal(d.getPoolAccounts()[0].totalRequests, 50);
  assert.equal(d.listAccounts()[0].totalRequests, 50);
  assert.equal(fs.statSync(`${options.storePath}.runtime-stats.json`).mode & 0o777, 0o600);
  await d.close({ mirrorStatistics: false });
  const restored = await new AsyncAccountDirectory(options).initialize();
  try {
    assert.equal(restored.getPoolAccounts()[0].totalRequests, 50);
    assert.equal(restored.getPoolAccounts()[0].activeRequests, 0);
  } finally { await restored.close(); }
});

test('pool idle auto-maintenance has zero account-store commits', async t => {
  const { directory: d } = await fixture(t);
  const pool = new IMAWebAgentPool({ accounts: d.getPoolAccounts() }, { managedPersistence: true,
    onAccountStateChange: snapshot => d.recordRuntimeState(snapshot),
    persistenceReady: () => d.persistenceReady,
    clientFactory: () => ({ credentialGeneration: 0, ensureFreshAuth: async () => false }),
  });
  const before = d.metrics.commits;
  for (let i = 0; i < 10; i++) await pool.accounts[0].client.runAutoMaintenance(async () => false);
  assert.equal(d.metrics.commits, before);
});

test('queued runtime observations preserve the latest error state and cannot enable an admin-disabled account', async t => {
  const { directory: d } = await fixture(t);
  await Promise.all([d.recordRuntimeState({ ...observation(), consecutiveErrors: 1, lastError: 'synthetic' }),
    d.recordRuntimeState(observation())]);
  assert.equal(d.getAccount('synthetic').runtime.consecutiveErrors, 0);
  await d.setDisabled('synthetic', true, 'disabled_by_admin');
  await d.recordRuntimeState(observation());
  assert.equal(d.getAccount('synthetic').runtime.disabled, true);
  assert.equal(d.getAccount('synthetic').runtime.disabledReason, 'disabled_by_admin');
});

test('async qualification remains valid across statistics writes and refresh never restores active leases', async t => {
  const { directory: d } = await fixture(t);
  const pool = new IMAWebAgentPool({ accounts: d.getPoolAccounts() });
  const ready = new WebReadiness({ directory: d, pool, clientFactory: () => ({ async *streamAsk(options) {
    options.onDispatch(); yield { type: 'delta', text: 'synthetic' };
    yield { type: 'sources', sources: [{}], sourceKinds: ['knowledge'] };
    await d.recordRuntimeState({ ...observation(1, 1), activeRequests: 1 }); await d.flushStatistics();
    yield { type: 'done' };
  } }) });
  const result = await ready.verify('synthetic');
  assert.equal(result.success, true); assert.equal(d.getAccount('synthetic').runtime.disabled, false);
});

test('fsync failure keeps old committed state and fails admission closed until reconciliation', async t => {
  const { directory: d } = await fixture(t, { workerFactory: faultFactory('fsync_failure') });
  await assert.rejects(d.setDisabled('synthetic', true), { code: 'account_store_commit_failed' });
  assert.equal(d.persistenceReady, false); assert.equal(d.getAccount('synthetic').runtime.disabled, false);
  assert.deepEqual(await d.reconcile(), { outcome: 'not_committed' });
  assert.equal(d.persistenceReady, true);
  await d.setDisabled('synthetic', true); assert.equal(d.getAccount('synthetic').runtime.disabled, true);
});

test('lost commit reply is reconciled by digest without a duplicate generation or replay', async t => {
  const { directory: d, options } = await fixture(t, { commitTimeoutMs: 150, workerFactory: faultFactory('lost_reply') });
  const generation = d.load().generation;
  await assert.rejects(d.setDisabled('synthetic', true), { code: 'account_store_commit_failed' });
  assert.equal(d.persistenceReady, false);
  assert.equal(JSON.parse(fs.readFileSync(options.storePath)).generation, generation + 1);
  assert.deepEqual(await d.reconcile(), { outcome: 'committed' });
  assert.equal(d.load().generation, generation + 1);
  assert.equal(d.getAccount('synthetic').runtime.disabled, true);
});

test('crash after rename preserves canonical state and the live service fence during worker recovery', async t => {
  const { directory: d, options } = await fixture(t, { workerFactory: faultFactory('crash_after_rename') });
  await assert.rejects(d.setDisabled('synthetic', true), { code: 'account_store_commit_failed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(d.persistenceReady, false);
  assert.equal(JSON.parse(fs.readFileSync(options.storePath)).accounts[0].runtime.disabled, true);
  // Age only this synthetic crashed write lock; never remove a live service fence.
  if (fs.existsSync(`${options.storePath}.lock`)) { const old = new Date(Date.now() - 30000); fs.utimesSync(`${options.storePath}.lock`, old, old); }
  assert.deepEqual(await d.reconcile(), { outcome: 'committed' });
  const other = new AsyncAccountDirectory(options);
  await assert.rejects(other.initialize(), { code: 'account_store_in_use' });
});

test('cross-process generation drift never overwrites newer credentials or silently reconciles unrelated data', async t => {
  const { directory: d, options } = await fixture(t);
  const external = new WebAgentAccountDirectory(options);
  external.setDisabled('synthetic', true, 'synthetic-external');
  await assert.rejects(d.recordEvent('synthetic', 'synthetic', 'synthetic'), { code: 'account_store_generation_conflict' });
  await assert.rejects(d.reconcile()); assert.equal(d.persistenceReady, false);
  assert.equal(new WebAgentAccountDirectory(options).getAccount('synthetic').runtime.disabled, true);
});

test('write-lock contention is visible and never blocks the HTTP thread', async t => {
  const { directory: d, options } = await fixture(t);
  const release = await lockfile.lock(options.storePath, { stale: 10000, update: 2000 });
  try { await assert.rejects(d.setDisabled('synthetic', true), { code: 'account_store_locked' }); }
  finally { await release(); }
  assert.equal(d.persistenceReady, false); await d.reconcile(); assert.equal(d.persistenceReady, true);
});

test('one inflight transaction and at most 64 waiting operations; overload does not accumulate', async t => {
  const { directory: d } = await fixture(t, { workerFactory: faultFactory('slow', { delayMs: 200 }) });
  const first = d.setDisabled('synthetic', true);
  const waiting = Array.from({ length: 64 }, () => d.recordEvent('synthetic', 'synthetic', 'synthetic'));
  await assert.rejects(d.recordEvent('synthetic', 'synthetic', 'synthetic'), { code: 'account_store_queue_full' });
  assert.equal(d.queue.length, 64);
  await Promise.all([first, ...waiting]);
});

for (const kind of ['missing', 'malformed', 'wrong-root', 'wrong-generation', 'unsafe-permissions']) {
  test(`existing ${kind} storage is never replaced with an empty account pool`, async t => {
    const { directory: d, options } = await fixture(t);
    if (kind === 'missing') fs.unlinkSync(options.storePath);
    else if (kind === 'unsafe-permissions') fs.chmodSync(options.storePath, 0o644);
    else fs.writeFileSync(options.storePath, kind === 'malformed' ? '{broken'
      : JSON.stringify(kind === 'wrong-root' ? { accounts: {} } : { accounts: [], generation: 'invalid' }));
    const before = kind === 'missing' ? null : fs.readFileSync(options.storePath);
    await assert.rejects(d.recordEvent('synthetic', 'synthetic', 'synthetic'), { code: 'account_store_invalid' });
    assert.equal(d.persistenceReady, false); assert.equal(d.listAccounts().length, 1);
    if (before) assert.deepEqual(fs.readFileSync(options.storePath), before);
    else assert.equal(fs.existsSync(options.storePath), false);
  });
}


test('a committed credential whose legacy export failed stays quarantined until both are reconciled', async t => {
  const { directory: d, options, root } = await fixture(t, { runtimeExport: true,
    workerFactory: faultFactory('fsync_failure', { faultMethod: 'updateCredentialsFromClient', faultNthSync: 3 }) });
  const config = d.getPoolAccounts()[0];
  await assert.rejects(d.updateCredentialsFromClient('synthetic', { ...config,
    headers: { 'x-ima-cookie': 'IMA-UID=synthetic; IMA-TOKEN=synthetic-new; IMA-REFRESH-TOKEN=fake' },
  }), { code: 'account_store_commit_failed' });
  assert.equal(d.persistenceReady, false);
  assert.match(new WebAgentAccountDirectory(options).getPoolAccounts()[0].headers['x-ima-cookie'], /synthetic-new/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'synthetic.env'), 'utf8'), /synthetic-new/);
  assert.deepEqual(await d.reconcile(), { outcome: 'committed' });
  assert.match(fs.readFileSync(path.join(root, 'synthetic.env'), 'utf8'), /synthetic-new/);
});

test('offline statistics finalizer refuses a live owner and merges the latest counters before rollback', async t => {
  const { directory: d, options } = await fixture(t);
  const { finalize } = require('../scripts/finalize-account-statistics.cjs');
  fs.writeFileSync(options.keyPath, 'synthetic-only-key', { mode: 0o600 });
  const args = ['--store', options.storePath, '--key', options.keyPath, '--confirm-offline'];
  await assert.rejects(finalize(args), { code: 'account_store_in_use' });
  await d.recordRuntimeState(observation(7, 7)); await d.flushStatistics();
  await d.close({ mirrorStatistics: false });
  assert.deepEqual(await finalize(args), { statisticsMirrored: true, accounts: 1, realIMA: false });
  const legacy = new WebAgentAccountDirectory({ ...options, keyMaterial: '' });
  assert.equal(legacy.getAccount('synthetic').runtime.totalRequests, 7);
  assert.equal(legacy.getAccount('synthetic').runtime.activeRequests, 0);
  assert.equal(fs.readFileSync(options.keyPath, 'utf8'), 'synthetic-only-key');
});

test('an existing encrypted pool with a missing key never creates a replacement key', async t => {
  const { directory: d, options } = await fixture(t);
  await d.close();
  const before = fs.readFileSync(options.storePath);
  const { execFileSync } = require('node:child_process');
  const result = execFileSync(process.execPath, ['-e', `
    const {AsyncAccountDirectory}=require('./src/async-account-directory');
    new AsyncAccountDirectory({storePath:process.argv[1],keyPath:process.argv[2]}).initialize()
      .then(()=>process.exit(1),error=>console.log(error.code));`, options.storePath, options.keyPath],
  { cwd: path.resolve(__dirname, '..'), env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(result.trim(), 'account_store_invalid');
  assert.equal(fs.existsSync(options.keyPath), false);
  assert.deepEqual(fs.readFileSync(options.storePath), before);
});

test('statistics cannot override credentials, admission or capacity, and unknown stored fields fail closed', async t => {
  const { directory: d, options } = await fixture(t);
  await d.recordRuntimeState(observation(1, 1)); await d.flushStatistics();
  const config = d.getPoolAccounts()[0];
  d.statistics.set('synthetic', { ...d.statistics.get('synthetic'), headers: {}, disabled: true, maxConcurrent: 99 });
  assert.deepEqual(d.getPoolAccounts()[0].headers, config.headers);
  assert.equal(d.getPoolAccounts()[0].disabled, false); assert.equal(d.getPoolAccounts()[0].maxConcurrent, 1);
  await d.close({ mirrorStatistics: false });
  const file = `${options.storePath}.runtime-stats.json`, data = JSON.parse(fs.readFileSync(file));
  data.accounts[0].disabled = false;
  fs.writeFileSync(file, JSON.stringify(data)); const before = fs.readFileSync(file);
  await assert.rejects(new AsyncAccountDirectory(options).initialize());
  assert.deepEqual(fs.readFileSync(file), before);
});

test('managed automatic refresh commits once and rejects callbacks from a replaced credential generation', async t => {
  const { directory: d } = await fixture(t);
  let requests = 0;
  const pool = new IMAWebAgentPool({ accounts: d.getPoolAccounts() }, {
    managedPersistence: true, persistenceReady: () => d.persistenceReady,
    onAccountStateChange: row => d.recordRuntimeState(row),
    onAccountCredentialsChange: (id, snapshot) => d.updateCredentialsFromClient(id, snapshot),
    fetchImpl: async url => {
      assert.match(url, /auth_login\/refresh/u); requests++;
      return Response.json({ code: 0, data: { userId: 'synthetic', token: 'synthetic-refreshed',
        refreshToken: 'synthetic-refresh', tokenValidTime: 7200 } });
    },
  });
  pool.startAutoRefresh(); t.after(() => pool.stopAutoRefresh());
  const client = pool.accounts[0].client; client.tokenExpiresAt = 1;
  const before = d.metrics.commits;
  await client.maintenance.check();
  assert.equal(requests, 1); assert.equal(d.metrics.commits, before + 1);
  assert.equal(client.pendingCredentialPersistence, false);
  assert.match(d.getPoolAccounts()[0].headers['x-ima-cookie'], /synthetic-refreshed/u);
  const oldGeneration = client.credentialGeneration, callback = client.onAutoRefreshed, old = client.getConfigSnapshot();
  await pool.withCredentialReplacement('synthetic', async () => {
    await d.replaceCapturedAccount('synthetic', { ...input,
      headers: { 'x-ima-cookie': 'IMA-UID=synthetic; IMA-TOKEN=synthetic-replaced; IMA-REFRESH-TOKEN=fake' } });
    pool.syncAccounts(d.getPoolAccounts());
  });
  const committed = d.metrics.commits;
  await callback(old, oldGeneration);
  assert.equal(d.metrics.commits, committed);
  assert.match(d.getPoolAccounts()[0].headers['x-ima-cookie'], /synthetic-replaced/u);
});
