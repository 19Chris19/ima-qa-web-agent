const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerAdminRoutes } = require('../src/admin-routes');

test('preflight and continue require admin auth, and remote imports verify before insertion', async () => {
  const app = express(); app.use(express.json()); let stored = 0; let membership = 'unknown';
  registerAdminRoutes(app, {
    config: { qaProvider: 'ima-web-agent', security: { adminToken: 'synthetic-admin' }, webAgent: {
      sharedKnowledgeBaseId: '123', sharedKnowledgeBaseShareUrl: 'https://ima.qq.com/wiki/?shareId=' + 'a'.repeat(64) } },
    accountDirectory: { listAccounts: () => [], getPoolAccounts: () => [], upsertCapturedAccount: input => { stored++; return { id: input.id }; } },
    membershipVerifier: async () => ({ membership }),
    enrollmentManager: { isAvailable: () => true, getActive: () => null,
      preflight: async () => ({ ready: false, code: 'browser_helper_unavailable_or_incompatible' }),
      continueVerification: async () => ({ state: 'waiting_for_membership', canContinue: true }) },
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer synthetic-admin', 'content-type': 'application/json' };
  try {
    for (const path of ['/api/admin/enrollment-preflight', '/api/admin/enrollments/synthetic/continue']) {
      assert.equal((await fetch(base + path, { method: 'POST' })).status, 401);
      assert.equal((await fetch(base + path, { method: 'POST', headers })).status, 200);
    }
    const submit = () => fetch(base + '/api/admin/accounts', { method: 'POST', headers,
      body: JSON.stringify({ id: 'synthetic', name: 'synthetic', knowledgeBaseId: '123', headers: { 'x-ima-cookie': 'synthetic', 'x-ima-bkn': '123' } }) });
    assert.equal((await submit()).status, 409); assert.equal(stored, 0);
    membership = 'joined'; assert.equal((await submit()).status, 200); assert.equal(stored, 1);
  } finally { await new Promise(r => server.close(r)); }
});
