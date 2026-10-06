const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const backendRoot = process.env.PROVIDER_ADMIN_CONTRACT_ROOT;
const tick = () => new Promise(resolve => setImmediate(resolve));

test('actual management and identity route responses interoperate with the admin UI without network', {
  skip: !backendRoot && 'Set PROVIDER_ADMIN_CONTRACT_ROOT to the integrated backend checkout',
}, async t => {
  const { registerAdminRoutes } = require(path.resolve(backendRoot, 'src/admin-routes.js'));
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method,
    (url, ...handlers) => routes.set(`${method.toUpperCase()} ${url}`, handlers.at(-1))]));
  const original = { id: 'synthetic-original', name: 'synthetic-original', status: 'active',
    health: { session_valid: true, knowledge_ready: false, web_ready: false, last_check_code: 'web_context_missing' } };
  const resolutions = [];
  let enrollment = { taskId: 'synthetic-task', state: 'identity_conflict',
    identityConflict: { actions: ['add', 'cancel'] }, qrAvailable: false };
  registerAdminRoutes(app, {
    config: { security: { adminToken: 'synthetic-unused' }, webAgent: {} },
    accountDirectory: { listAccounts: () => [original], getPoolAccounts: () => [] },
    imaWebAgentClient: { stats: () => ({ accounts: [{ id: original.id, status: 'idle', auth: {
      tokenExpiresAt: null, refreshTokenExpiresAt: null, lastRefreshAt: '2026-10-06T00:00:00Z',
      maintenance: { state: 'retry_wait', nextRetryAt: '2026-10-06T02:00:00Z', nextCheckAt: null },
    } }] }) },
    webReadiness: { sync() {}, snapshot: () => ({ mode: 'knowledge_agent', basicHealthy: 0,
      capacity: 1, schedulable: 1, pending: 0, accounts: [{ id: original.id, state: 'ready',
        qualified: true, schedulable: true, verifiedAt: '2026-10-06T01:00:00Z' }] }) },
    enrollmentManager: { get: () => enrollment, resolveIdentityConflict: async (id, options) => {
      resolutions.push({ id, options });
      enrollment = { ...enrollment, state: 'completed', account: { name: options.name } };
      return enrollment;
    } },
  });
  const invoke = async (method, route, body = {}, params = {}) => {
    let result;
    const handler = routes.get(`${method} ${route}`);
    assert.ok(handler, `Actual route exists: ${method} ${route}`);
    // Auth has separate backend tests; invoke the actual serialization handler only.
    const response = { json(value) { result = value; return this; }, status() { return this; } };
    await handler({ query: { details: '1' }, body, params }, response);
    return result;
  };
  const payload = await invoke('GET', '/api/admin/accounts');
  const management = payload.accounts[0].management;
  assert.equal(management.knowledge.state, 'ready');
  assert.equal(management.web.state, 'unavailable');
  assert.equal(management.session.state, 'ready');
  assert.equal(management.maintenance.state, 'retry_wait');
  assert.equal(management.maintenance.lastSuccessfulRefreshAt, '2026-10-06T00:00:00Z');
  assert.equal(management.maintenance.expiryKnown, false);

  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8'), {
    url: 'https://synthetic.test/admin', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url, method });
    let result;
    if (url === '/api/admin/bootstrap') result = { enrollment: { supportsAdminPageQr: true, activeEnrollment: enrollment } };
    else if (url.startsWith('/api/admin/accounts?')) result = await invoke('GET', '/api/admin/accounts');
    else if (url === '/api/admin/enrollments/synthetic-task') result = await invoke('GET', '/api/admin/enrollments/:enrollmentId', {}, { enrollmentId: 'synthetic-task' });
    else if (url === '/api/admin/enrollments/synthetic-task/identity') result = await invoke(method,
      '/api/admin/enrollments/:enrollmentId/identity', JSON.parse(options.body), { enrollmentId: 'synthetic-task' });
    else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => result };
  };
  window.eval(fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8'));
  await tick();
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(resolutions.length, 0);
  assert.match(document.querySelector('#accountList').textContent, /可用于问答.*不可用.*等待重试/s);
  assert.match(document.querySelector('.admin-account-details').textContent, /未知（上游未提供）/);
  assert.match(document.querySelector('.admin-account-details').textContent, /上次成功续期2026/);
  document.querySelector('#addAccountButton').click();
  await tick();
  assert.equal(document.querySelector('#enrollmentIdentityConflict').hidden, false);
  document.querySelector('#identityConflictName').value = 'synthetic-added';
  document.querySelector('#addConflictIdentityButton').click();
  await tick(); await tick();
  assert.deepEqual(resolutions, [{ id: 'synthetic-task', options: { action: 'add', name: 'synthetic-added' } }]);
  assert.equal(original.id, 'synthetic-original');
  assert.equal(calls.filter(call => call.method !== 'GET').length, 1);
  assert.equal(document.querySelector('#enrollmentIdentityConflict').hidden, true);
});
