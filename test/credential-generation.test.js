const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { IMAWebAgentClient, buildRuntimeEnvText } = require('../src/ima-web-agent-client');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
const { WebAgentEnrollmentManager } = require('../src/web-agent-enrollment');
const { registerAdminRoutes } = require('../src/admin-routes');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const headers = token => ({ 'x-ima-cookie':
  `IMA-UID=synthetic-user; IMA-TOKEN=${token}; IMA-REFRESH-TOKEN=synthetic-refresh` });
const response = token => Response.json({ code: 0, data: { userId: 'synthetic-user',
  token, refreshToken: 'synthetic-rotated-refresh', tokenValidTime: 7200 } });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-public-generation-'));
  const options = { storePath: path.join(root, 'accounts.json'), keyPath: path.join(root, 'key'),
    keyMaterial: 'synthetic-public-generation-key' };
  const directory = new WebAgentAccountDirectory(options);
  const runtimeEnvPath = path.join(root, 'synthetic.env');
  const input = token => ({ id: 'synthetic', name: 'synthetic', knowledgeBaseId: '123',
    headers: headers(token), tokenExpiresAt: null, requireQualification: true, replace: true, runtimeEnvPath });
  directory.upsertCapturedAccount({ ...input('synthetic-old'), tokenExpiresAt: 1,
    requireQualification: false, replace: false });
  const pending = deferred(); let requests = 0, writes = 0;
  const pool = new IMAWebAgentPool({ accounts: directory.getPoolAccounts() }, {
    fetchImpl: () => { requests++; return pending.promise; },
    onAccountCredentialsChange: (id, snapshot) => { writes++; directory.updateCredentialsFromClient(id, snapshot); },
  });
  pool.startAutoRefresh();
  const manager = new WebAgentEnrollmentManager({ accountDirectory: directory, pool,
    config: { webAgent: { sharedKnowledgeBaseId: '123', browserPath: process.execPath } },
    clientFactory: config => new IMAWebAgentClient(config, async () => Response.json({ code: 0, session_id: 'synthetic-session' })),
  });
  manager._launch = async () => {};
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method,
    (url, ...handlers) => routes.set(`${method} ${url}`, handlers.at(-1))]));
  registerAdminRoutes(app, { accountDirectory: directory, imaWebAgentClient: pool,
    config: { security: { adminToken: 'synthetic-unused' }, webAgent: { sharedKnowledgeBaseId: '123' } } });
  t.after(async () => { await manager.shutdown(); pool.stopAutoRefresh(); fs.rmSync(root, { recursive: true, force: true }); });
  return { directory, pool, manager, pending, input, client: pool.accounts[0].client,
    requests: () => requests, writes: () => writes,
    disk: () => new WebAgentAccountDirectory(options).getPoolAccounts()[0],
    runtime: () => fs.readFileSync(runtimeEnvPath, 'utf8'),
    async capture(entry, token = 'synthetic-new') {
      if (entry === 'enrollment') {
        const { taskId } = await manager.start({ reauthAccountId: 'synthetic' });
        const job = manager.jobs.get(taskId);
        await manager._acceptAuth(job, { headers: headers(token), tokenExpiresAt: null });
        return job;
      }
      const body = input(token);
      if (entry === 'import') body.runtimeEnvText = buildRuntimeEnvText(body);
      let result, status = 200;
      const res = { status(code) { status = code; return this; }, json(value) { result = value; return this; } };
      await routes.get(`post /api/admin/accounts${entry === 'import' ? '/import-runtime' : ''}`)({ body }, res);
      return { status, result };
    },
  };
}

for (const entry of ['enrollment', 'capture', 'import']) {
  for (const fault of ['none', 'before-sync', 'after-sync']) {
    test(`${entry}: late old refresh cannot overwrite capture across ${fault}`, async t => {
      const f = fixture(t);
      const refresh = f.client.maintenance.check().catch(error => error);
      assert.equal(f.requests(), 1);
      const sync = f.pool.syncAccounts.bind(f.pool);
      if (fault !== 'none') f.pool.syncAccounts = rows => {
        if (fault === 'after-sync') sync(rows);
        throw new Error('synthetic-sync-failure');
      };
      await f.capture(entry).catch(error => error);
      assert.match(f.disk().headers['x-ima-cookie'], /synthetic-new/);
      f.pending.resolve(response('synthetic-late-old')); await refresh;
      assert.match(f.disk().headers['x-ima-cookie'], /synthetic-new/);
      assert.match(f.runtime(), /synthetic-new/);
      assert.equal(f.writes(), 0);
      if (fault !== 'before-sync') assert.match(f.client.headers['x-ima-cookie'], /synthetic-new/);
      assert.equal(f.disk().disabled, true);
      assert.equal(f.pool._leaseAccount(), null);
    });
  }
}

test('ordinary refresh still persists runtime and encrypted credentials', async t => {
  const f = fixture(t);
  const refresh = f.client.maintenance.check();
  f.pending.resolve(response('synthetic-normal-refresh')); await refresh;
  assert.equal(f.writes(), 1);
  assert.match(f.disk().headers['x-ima-cookie'], /synthetic-normal-refresh/);
  assert.match(f.runtime(), /synthetic-normal-refresh/);
});

test('public config replacement still accepts earlier or unknown expiry', t => {
  const f = fixture(t);
  f.client.applyConfig({ headers: headers('synthetic-earlier'), tokenExpiresAt: 0 });
  assert.match(f.client.headers['x-ima-cookie'], /synthetic-earlier/);
  f.client.applyConfig({ headers: headers('synthetic-unknown'), tokenExpiresAt: null });
  assert.match(f.client.headers['x-ima-cookie'], /synthetic-unknown/);
});

test('cancel after capture cannot resurrect a pre-capture background refresh', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  f.manager.onEnrolled = async () => { entered.resolve(); await release.promise; return { success: false }; };
  const refresh = f.client.maintenance.check().catch(error => error);
  const capture = f.capture('enrollment'); await entered.promise;
  const job = [...f.manager.jobs.values()][0];
  await f.manager.cancel(job.id);
  f.pending.resolve(response('synthetic-late-old')); release.resolve();
  await refresh; await capture;
  assert.equal(job.state, 'cancelled');
  assert.match(f.disk().headers['x-ima-cookie'], /synthetic-new/);
  assert.match(f.runtime(), /synthetic-new/);
});

test('multiple replacements reject stale callbacks and preserve the newest refresh promise', async t => {
  const f = fixture(t), middle = deferred(), newest = deferred();
  const callback = f.client.onAutoRefreshed;
  const generation = f.client.credentialGeneration;
  const snapshot = f.client.getConfigSnapshot();
  const first = f.client.maintenance.check().catch(error => error);
  await f.capture('capture', 'synthetic-middle');
  f.client.fetchImpl = () => middle.promise;
  const second = f.client.refreshAuth().catch(error => error);
  await f.capture('capture', 'synthetic-newest');
  f.client.fetchImpl = () => newest.promise;
  const third = f.client.refreshAuth();
  const currentPromise = f.client.refreshPromise;
  f.pending.resolve(response('synthetic-obsolete-first'));
  middle.resolve(response('synthetic-obsolete-second'));
  await first; await second;
  assert.equal(f.client.refreshPromise, currentPromise);
  await callback(snapshot, generation);
  assert.equal(f.writes(), 0);
  assert.match(f.disk().headers['x-ima-cookie'], /synthetic-newest/);
  newest.resolve(response('synthetic-current')); await third;
  assert.match(f.client.headers['x-ima-cookie'], /synthetic-current/);
});

test('body delayed after config replacement cannot persist old credentials', async t => {
  const f = fixture(t), body = deferred(), entered = deferred();
  const refresh = f.client.maintenance.check().catch(error => error);
  f.pending.resolve({ ok: true, status: 200, text: () => { entered.resolve(); return body.promise; } });
  await entered.promise;
  await f.capture('capture');
  body.resolve(await response('synthetic-late-old').text()); await refresh;
  assert.match(f.runtime(), /synthetic-new/);
  assert.equal(f.writes(), 0);
});

test('aborted deferred refresh retains existing public cancellation protection', async t => {
  const f = fixture(t), controller = new AbortController();
  const refresh = f.client.refreshAuth({ signal: controller.signal }).catch(error => error);
  controller.abort(); f.pending.resolve(response('synthetic-cancelled')); await refresh;
  assert.match(f.client.headers['x-ima-cookie'], /synthetic-old/);
  assert.match(f.disk().headers['x-ima-cookie'], /synthetic-old/);
  assert.doesNotMatch(f.runtime(), /synthetic-cancelled/);
});

test('unchanged enabled config does not discard an ordinary refresh', async t => {
  const f = fixture(t);
  const refresh = f.client.maintenance.check();
  f.pool.syncAccounts(f.directory.getPoolAccounts());
  f.pending.resolve(response('synthetic-normal-refresh')); await refresh;
  assert.equal(f.writes(), 1);
  assert.match(f.disk().headers['x-ima-cookie'], /synthetic-normal-refresh/);
});

for (const fault of ['store-write', 'runtime-export']) {
  test(`capture ${fault} failure fences old refresh without claiming persistence succeeded`, async t => {
    const f = fixture(t);
    const refresh = f.client.maintenance.check().catch(error => error);
    if (fault === 'store-write') f.directory._writeStore = () => { throw new Error('synthetic-store-write-failure'); };
    else f.directory.writeRuntimeEnvFile = () => { throw new Error('synthetic-runtime-export-failure'); };
    await assert.rejects(f.capture('enrollment'), /synthetic-/);
    const runtimeBefore = f.runtime();
    f.pending.resolve(response('synthetic-late-old')); await refresh;
    assert.equal(f.writes(), 0);
    assert.equal(f.runtime(), runtimeBefore);
    assert.match(f.disk().headers['x-ima-cookie'], fault === 'store-write' ? /synthetic-old/ : /synthetic-new/);
    assert.equal(f.pool.accounts[0].maintenanceOperation, 'qualification');
    assert.equal(f.pool._leaseAccount(), null);
  });
}

test('disabled sync without capture invalidates the old refresh before qualification', async t => {
  const f = fixture(t);
  const refresh = f.client.maintenance.check().catch(error => error);
  f.directory.beginWebQualification('synthetic');
  f.pool.syncAccounts(f.directory.getPoolAccounts());
  f.pending.resolve(response('synthetic-late-old')); await refresh;
  assert.equal(f.writes(), 0);
  assert.match(f.disk().headers['x-ima-cookie'], /synthetic-old/);
  assert.doesNotMatch(f.runtime(), /synthetic-late-old/);
});
