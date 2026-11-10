const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerAdminRoutes } = require('../src/admin-routes');

test('preflight and continue require admin auth, and remote imports verify before insertion', async () => {
  const app = express(); app.use(express.json()); let stored = 0; let membership = 'unknown'; const resolutions = []; const starts = [];
  registerAdminRoutes(app, {
    config: { qaProvider: 'ima-web-agent', security: { adminToken: 'synthetic-admin' }, webAgent: {
      sharedKnowledgeBaseId: '123', sharedKnowledgeBaseShareUrl: 'https://ima.qq.com/wiki/?shareId=' + 'a'.repeat(64) } },
    accountDirectory: { listAccounts: () => [], getPoolAccounts: () => [], upsertCapturedAccount: input => { stored++; return { id: input.id }; } },
    membershipVerifier: async () => ({ membership }),
    enrollmentManager: { isAvailable: () => true, getActive: () => null,
      preflight: async () => ({ ready: false, code: 'browser_helper_unavailable_or_incompatible' }),
      start: async (options) => { starts.push(options); return { state: 'waiting_for_scan' }; },
      continueVerification: async () => ({ state: 'waiting_for_membership', canContinue: true }),
      get: () => ({ state: 'identity_conflict' }),
      resolveIdentityConflict: async (id, options) => { resolutions.push({ id, options }); return { state: 'completed' }; } },
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer synthetic-admin', 'content-type': 'application/json' };
  try {
    for (const path of ['/api/admin/enrollment-preflight', '/api/admin/enrollments/synthetic/continue']) {
      assert.equal((await fetch(base + path, { method: 'POST' })).status, 401);
      assert.equal((await fetch(base + path, { method: 'POST', headers })).status, 200);
    }
    const identityPath = '/api/admin/enrollments/synthetic/identity';
    assert.equal((await fetch(base + identityPath, { method: 'POST' })).status, 401);
    assert.equal(resolutions.length, 0);
    assert.equal((await fetch(base + '/api/admin/enrollments/synthetic', { headers })).status, 200);
    assert.equal(resolutions.length, 0);
    assert.equal((await fetch(base + identityPath, { method: 'POST', headers,
      body: JSON.stringify({ action: 'add', name: 'synthetic-new', replace: true }) })).status, 200);
    assert.deepEqual(resolutions, [{ id: 'synthetic', options: { action: 'add', name: 'synthetic-new' } }]);
    assert.equal((await fetch(base + '/api/admin/enrollments', { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(base + '/api/admin/enrollments', { method: 'POST', headers,
      body: JSON.stringify({ matchExistingAccount: true }) })).status, 201);
    assert.equal(starts.length, 1); assert.equal(starts[0].matchExistingAccount, true);
    assert.equal(starts[0].reauthAccountId, undefined);
    assert.equal(starts[0].autoMatchExistingAccount, false);
    assert.equal((await fetch(base + '/api/admin/enrollments', { method: 'POST', headers,
      body: JSON.stringify({ name: 'synthetic-normal-enrollment' }) })).status, 201);
    assert.equal(starts[1].autoMatchExistingAccount, true);
    assert.equal(starts[1].replace, false);
    assert.equal((await fetch(base + '/api/admin/enrollments', { method: 'POST', headers,
      body: JSON.stringify({ name: 'synthetic-explicit-legacy', autoMatchExistingAccount: false }) })).status, 201);
    assert.equal(starts[2].autoMatchExistingAccount, false);
    const submit = () => fetch(base + '/api/admin/accounts', { method: 'POST', headers,
      body: JSON.stringify({ id: 'synthetic', name: 'synthetic', knowledgeBaseId: '123', headers: { 'x-ima-cookie': 'synthetic', 'x-ima-bkn': '123' } }) });
    assert.equal((await submit()).status, 409); assert.equal(stored, 0);
    membership = 'joined'; assert.equal((await submit()).status, 200); assert.equal(stored, 1);
  } finally { await new Promise(r => server.close(r)); }
});
