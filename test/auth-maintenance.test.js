const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthMaintenance } = require('../src/auth-maintenance');

function clock() {
  let now = 100000;
  const tasks = new Map();
  let sequence = 0;
  return {
    now: () => now,
    setTimer(fn, delay) { const id = ++sequence; tasks.set(id, { fn, at: now + delay }); return id; },
    clearTimer(id) { tasks.delete(id); },
    async next() {
      const [id, task] = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
      tasks.delete(id); now = task.at; await task.fn();
    },
    tasks,
  };
}

test('maintenance reports its actual timer, never executes on snapshot', async () => {
  const c = clock(); let calls = 0;
  const m = new AuthMaintenance({ ...c, interval: () => 60000, check: async () => { calls++; } });
  m.start();
  assert.equal(m.snapshot().nextCheckAt, new Date(160000).toISOString());
  assert.equal(calls, 0);
  await c.next();
  assert.equal(calls, 1);
  assert.equal(m.snapshot().nextCheckAt, new Date(220000).toISOString());
  m.stop(); assert.equal(c.tasks.size, 0);
  assert.equal(m.snapshot().nextCheckAt, null);
});

test('failures back off and never publish raw error text', async () => {
  const c = clock(); let fail = true;
  const m = new AuthMaintenance({ ...c, interval: () => 1000,
    check: async () => { if (fail) throw new Error('private-credential-must-not-escape'); } });
  m.start(); await c.next();
  assert.equal(m.snapshot().state, 'retry_wait');
  assert.equal(m.snapshot().nextRetryAt, new Date(103000).toISOString());
  assert.doesNotMatch(JSON.stringify(m.snapshot()), /private-credential/);
  await c.next(); assert.equal(m.snapshot().nextRetryAt, new Date(107000).toISOString());
  fail = false; await c.next();
  assert.equal(m.snapshot().failures, 0);
  assert.equal(m.snapshot().nextRetryAt, null);
});

test('stop during an in-flight check cannot resurrect a timer', async () => {
  const c = clock(); let finish;
  const m = new AuthMaintenance({ ...c, interval: () => 1000,
    check: () => new Promise(resolve => { finish = resolve; }) });
  m.start(); const pending = c.next();
  assert.equal(m.snapshot().state, 'checking');
  assert.equal(c.tasks.size, 0);
  m.stop(); finish(); await pending;
  assert.equal(c.tasks.size, 0);
  assert.equal(m.snapshot().state, 'disabled');
});

test('disabled maintenance creates no timer', () => {
  const c = clock();
  const m = new AuthMaintenance({ ...c, interval: () => 0, check: () => assert.fail() });
  m.start(); assert.equal(c.tasks.size, 0); assert.equal(m.snapshot().state, 'disabled');
});

test('startup never refreshes or persists a disabled imported account', async () => {
  const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
  let calls = 0;
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'synthetic-import', disabled: true }] }, {
    clientFactory: () => ({ ensureFreshAuth() { calls++; }, persistRuntimeEnv() { calls++; } }),
  });
  assert.equal(await pool.ensureFreshAuth(), false);
  assert.equal(calls, 0);
});

test('backoff is capped and restarting does not overlap the previous check', async () => {
  const c = clock(); let finish; let calls = 0;
  const m = new AuthMaintenance({ ...c, interval: () => 60000,
    check: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  m.start(); const pending = c.next(); m.start(); await c.next();
  assert.equal(calls, 1); finish(); await pending;
  assert.equal(c.tasks.size, 1);
  m.check = async () => { throw new Error('synthetic'); };
  for (let i = 0; i < 10; i++) await c.next();
  assert.equal(Date.parse(m.snapshot().nextRetryAt) - c.now(), 900000);
});

test('client preserves zero interval and persists successful automatic refresh via callback', async () => {
  const { IMAWebAgentClient } = require('../src/ima-web-agent-client');
  const client = new IMAWebAgentClient({ headers: {}, refreshIntervalMs: 0 }, () => assert.fail());
  let saved = 0;
  client.ensureFreshAuth = async () => true;
  client.startAutoRefresh(() => saved++);
  assert.equal(client.getAuthStatus().maintenance.state, 'disabled');
  await client.maintenance.check();
  assert.equal(saved, 1);
  client.stopAutoRefresh();
});

test('pool stops disabled and removed clients and wires automatic credential persistence', () => {
  const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
  const clients = new Map(); let saved = 0;
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'synthetic-a' }] }, {
    clientFactory(config) {
      const client = { stops: 0, applyConfig() {}, getConfigSnapshot: () => ({ id: config.id }),
        startAutoRefresh(fn) { this.callback = fn; }, stopAutoRefresh() { this.stops++; } };
      clients.set(config.id, client); return client;
    }, onAccountCredentialsChange() { saved++; },
  });
  pool.startAutoRefresh(); clients.get('synthetic-a').callback(); assert.equal(saved, 1);
  pool.syncAccounts([{ id: 'synthetic-a', disabled: true }]);
  assert.equal(clients.get('synthetic-a').stops, 1);
  pool.syncAccounts([]); assert.equal(clients.get('synthetic-a').stops, 2);
});
