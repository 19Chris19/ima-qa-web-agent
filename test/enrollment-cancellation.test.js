const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebAgentEnrollmentManager } = require('../src/web-agent-enrollment');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
const { IMAWebAgentClient } = require('../src/ima-web-agent-client');
const { WebReadiness } = require('../src/web-readiness');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Synthetic enrollment did not settle');
}

async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-enrollment-cancel-'));
  const directory = new WebAgentAccountDirectory({ storePath: path.join(root, 'accounts.json'),
    keyPath: path.join(root, 'accounts.key'), keyMaterial: 'synthetic-enrollment-test-key' });
  const page = { goto: async () => {}, evaluate: async () => ({ x: 0, y: 0, width: 100, height: 100 }),
    screenshot: async () => Buffer.from('synthetic-qr') };
  const context = { pages: () => [page], close: async () => {} };
  const state = { auth: null, now: Date.now() };
  const pool = { accounts: [], now: () => state.now,
    syncAccounts(rows) { this.accounts = rows.map(row => Object.assign(this.accounts.find(a => a.id === row.id) || {}, row, { activeRequests: 0 })); },
    _requireAccount(id) { return this.accounts.find(a => a.id === id); }, _notifyAvailability() {} };
  const manager = new WebAgentEnrollmentManager({ accountDirectory: directory, pool,
    config: { webAgent: { sharedKnowledgeBaseId: 'synthetic-kb', browserPath: process.execPath } },
    now: () => state.now, browserLauncher: async () => context, captureAuth: async () => state.auth,
    clientFactory: () => ({ initSession: async () => {} }), sleep: () => new Promise(resolve => setTimeout(resolve, 1)),
    ...overrides,
  });
  t.after(async () => { await manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const { taskId } = await manager.start({ name: 'synthetic-account', timeoutMs: 30000 });
  await waitFor(() => manager.get(taskId).state === 'waiting_for_scan');
  const job = manager.jobs.get(taskId);
  function scan() {
    state.auth = { headers: { 'x-ima-cookie': 'IMA-UID=synthetic; IMA-TOKEN=synthetic-old; IMA-REFRESH-TOKEN=synthetic-refresh', 'x-ima-bkn': '123' } };
  }
  return { manager, directory, pool, state, page, context, job, taskId, scan };
}

for (const action of ['cancel', 'shutdown', 'expiry']) {
  test(`${action} aborts enrollment init and a late expired response cannot start refresh`, async t => {
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const requests = [];
    const f = await fixture(t, { clientFactory: config => new IMAWebAgentClient(config, async (url, options) => {
      requests.push({ url, signal: options.signal });
      if (requests.length === 1) { entered.resolve(); await release.promise; return Response.json({ code: 41 }); }
      if (url.endsWith('/refresh')) return Response.json({ code: 0, account_info: { token: 'synthetic-new' } });
      return Response.json({ code: 0, session_id: 'synthetic-session' });
    }) });
    f.scan(); await entered.promise;
    if (action === 'cancel') await f.manager.cancel(f.taskId);
    else if (action === 'shutdown') await f.manager.shutdown();
    else { f.state.now = f.job.expiresAt; await f.manager._checkPending(f.job); }
    release.resolve(); await f.job.monitorPromise;
    assert.equal(requests[0].signal?.aborted, true);
    assert.equal(requests.length, 1);
    assert.equal(f.directory.listAccounts().length, 0);
    assert.equal(f.job.pendingAuth, null);
  });
}

test('cancellation during credential refresh rejects late credentials without mutating the client', async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  let client, calls = 0;
  const f = await fixture(t, { clientFactory: config => {
    client = new IMAWebAgentClient(config, async url => {
      calls++;
      if (url.endsWith('/refresh')) {
        entered.resolve(); await release.promise;
        return Response.json({ code: 0, account_info: { token: 'synthetic-new', refresh_token: 'synthetic-new-refresh' } });
      }
      return Response.json(calls === 1 ? { code: 41 } : { code: 0, session_id: 'synthetic-session' });
    });
    return client;
  } });
  f.scan(); await entered.promise;
  const before = { ...client.headers };
  await f.manager.cancel(f.taskId); release.resolve(); await f.job.monitorPromise;
  assert.deepEqual(client.headers, before);
  assert.equal(calls, 2);
  assert.equal(f.directory.listAccounts().length, 0);
});

for (const action of ['cancel', 'shutdown']) {
  test(`${action} propagates to the one onEnrolled probe and blocks late proof/sync`, async t => {
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve());
    const f = await fixture(t);
    let signal, dispatches = 0, syncs = 0;
    const readiness = new WebReadiness({ directory: f.directory, pool: f.pool,
      clientFactory: () => ({ async *streamAsk(options) {
        signal = options.signal; options.onDispatch(); dispatches++; entered.resolve(); await release.promise;
        yield { type: 'sources', sources: [{}], sourceKinds: ['knowledge'] };
        yield { type: 'delta', text: 'Synthetic answer' }; yield { type: 'done' };
      } }),
    });
    f.manager.onEnrolled = (id, question) => readiness.verify(id, question);
    f.manager.onCancelVerification = id => readiness.cancel(id);
    f.manager.onAccountsSynced = () => { syncs++; };
    f.scan(); await entered.promise;
    const before = syncs;
    if (action === 'cancel') await f.manager.cancel(f.taskId);
    else await f.manager.shutdown();
    const aborted = signal.aborted;
    release.resolve(); await f.job.monitorPromise;
    assert.equal(aborted, true);
    assert.equal(dispatches, 1);
    assert.equal(f.directory.getAccount('synthetic-account').runtime.webQualification, null);
    assert.equal(syncs, before);
    assert.equal(f.job.state, 'cancelled');
  });
}

for (const action of ['cancel', 'shutdown', 'expiry']) {
  test(`late QR screenshot cannot repopulate credentials after ${action}`, async t => {
    const f = await fixture(t);
    const entered = deferred(), release = deferred();
    t.after(() => release.resolve(Buffer.from('synthetic-late-qr')));
    f.page.screenshot = () => { entered.resolve(); return release.promise; };
    const pending = f.manager._captureScreenshot(f.job); await entered.promise;
    if (action === 'cancel') await f.manager.cancel(f.taskId);
    else if (action === 'shutdown') await f.manager.shutdown();
    else { f.state.now = f.job.expiresAt; await f.manager._checkPending(f.job); }
    release.resolve(Buffer.from('synthetic-late-qr'));
    assert.equal(await pending, null);
    assert.equal(f.job.qr, null);
    assert.equal(f.job.pendingAuth, null);
  });
}

test('login expiry is not a total deadline; the single post-login probe has its own bounded timeout', async t => {
  const f = await fixture(t);
  let calls = 0, result;
  const readiness = new WebReadiness({ directory: f.directory, pool: f.pool, timeoutMs: 15,
    clientFactory: () => ({ async *streamAsk(options) {
      calls++; options.onDispatch();
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    } }),
  });
  f.manager.onEnrolled = async (id, question) => {
    assert.equal(f.job.expiryTimer, null);
    f.state.now = f.job.expiresAt + 1;
    result = await readiness.verify(id, question);
    return result;
  };
  f.scan(); await waitFor(() => f.job.state === 'completed');
  assert.equal(calls, 1);
  assert.equal(result.code, 'probe_timeout');
  assert.equal(f.directory.getAccount('synthetic-account').runtime.webQualification, null);
});
