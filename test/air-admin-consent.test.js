'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { registerAdminRoutes } = require('../src/admin-routes');
const { registerAirAdminRoutes } = require('../src/air/admin');
const { KnowledgeAgentQualificationManager, KnowledgeAgentQualificationReportStore } = require('../src/air/knowledge-agent-qualification-job');

async function fixture(t, { air = true, disabled = false } = {}) {
  const account = { id: 'synthetic-account', name: 'Synthetic account', knowledgeBaseId: 'synthetic-kb',
    principalFingerprint: 'a'.repeat(64), events: [],
    runtime: { disabled, disabledReason: disabled ? 'pending_enrollment_qualification' : '' } };
  const calls = [], applied = [];
  const directory = {
    getAccount: id => id === account.id ? account : null,
    getPoolAccounts: () => [{ ...account, disabled: account.runtime.disabled,
      disabledReason: account.runtime.disabledReason, knowledgeAgentQualification: account.runtime.knowledgeAgentQualification }],
    listAccounts: () => [{ ...account, health: { status: 'ready' } }],
    applyKnowledgeAgentQualification(id, proof, binding) {
      assert.equal(id, account.id); assert.equal(binding.account, account);
      applied.push({ proof, activateEnrollment: binding.activateEnrollment });
      account.runtime.knowledgeAgentQualification = proof;
    },
    recordKnowledgeAgentQualifications(entries) { applied.push(...entries); },
  };
  const runner = count => async ({ beforeRequest, onRequest, onObservation }) => {
    for (let i = 0; i < count; i++) {
      beforeRequest(); onRequest(); calls.push(count === 1 ? 'basic' : 'advanced');
      onObservation({ phase: i ? 'matrix' : 'smoke', passed: true });
    }
    return { passed: true, requests: count, terminals: count, passedModes: count === 1 ? 1 : 6,
      knowledgeSources: 1, webSources: count === 1 ? 0 : 1, unknownSources: 0, totalMs: 1 };
  };
  const manager = new KnowledgeAgentQualificationManager({ accountDirectory: directory,
    pool: { stats: () => ({}), syncAccounts() {} },
    askQueue: { stats: () => ({ activeRequests: 0, queuedRequests: 0 }) },
    questionBank: { knowledge: 'Synthetic only' }, basicRunner: runner(1), runner: runner(7),
    reportStore: new KnowledgeAgentQualificationReportStore({ persist: false }) });
  const config = { qaProvider: 'ima-web-agent', security: { adminToken: 'your-synthetic-admin' },
    webAgent: { sharedKnowledgeBaseId: 'synthetic-kb' } };
  const app = express(); app.use(express.json());
  if (air) registerAirAdminRoutes(app, { config, accountDirectory: directory, manager });
  registerAdminRoutes(app, { config, accountDirectory: directory,
    enrollmentManager: { isAvailable: () => false, getActive: () => null } });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const request = async (route, body, token = 'your-synthetic-admin') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(2000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const start = body => request(`/api/admin/accounts/${account.id}/qualification`, body);
  return { request, start, manager, calls, applied };
}

test('Air bootstrap advertises basic enrollment consent without replacing batch or generic metadata', async t => {
  const air = await fixture(t);
  const { body, status } = await air.request('/api/admin/bootstrap');
  assert.equal(status, 200);
  assert.deepEqual(body.enrollment.qualification, { required: true, automatic: true, requestsPerTarget: 1 });
  assert.equal(body.enrollment.authorizationProtocol, 'shared_library_membership_v1');
  assert.equal(body.qualification.requestsPerTarget, 7);
  assert.equal(body.qualification.authorizedRequestCount, 7);
  const generic = await fixture(t, { air: false });
  const ordinary = (await generic.request('/api/admin/bootstrap')).body;
  assert.equal(Object.hasOwn(ordinary.enrollment, 'qualification'), false);
  assert.equal(Object.hasOwn(ordinary, 'qualification'), false);
  assert.deepEqual(air.calls, []);
});

test('old Air UI no-mode single-account consent dispatches exactly one basic request', async t => {
  const f = await fixture(t, { disabled: true });
  const response = await f.start({ confirm: true, authorizedRequestCount: 1 });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  const report = await f.manager.waitFor(response.body.qualification.runId);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.authorizedRequests, 1);
  assert.equal(report.usedRequests, 1);
  assert.deepEqual(f.calls, ['basic']);
  assert.equal(f.applied[0].proof.level, 'basic');
  assert.equal(f.applied[0].activateEnrollment, true);
});

test('explicit advanced retains seven requests; batch no-mode still uses its existing seven-request budget', async t => {
  for (const batch of [false, true]) {
    const f = await fixture(t);
    const bootstrap = f.manager.getBootstrap();
    const response = batch ? await f.request('/api/admin/qualifications', { confirm: true,
      authorizedRequestCount: 7, candidateSetDigest: bootstrap.candidateSetDigest })
      : await f.start({ mode: 'advanced', confirm: true, authorizedRequestCount: 7 });
    assert.equal(response.status, batch ? 201 : 202);
    const run = response.body[batch ? 'run' : 'qualification'];
    const report = await f.manager.waitFor(run.runId);
    assert.equal(report.status, 'succeeded');
    assert.equal(report.authorizedRequests, 7);
    assert.equal(report.usedRequests, 7);
    assert.deepEqual(f.calls, Array(7).fill('advanced'));
  }
});

test('Air single-account invalid budgets, absent consent and unknown modes dispatch nothing', async t => {
  const f = await fixture(t);
  for (const body of [
    { confirm: true, authorizedRequestCount: 7 },
    { mode: 'basic', confirm: true, authorizedRequestCount: 7 },
    { mode: 'advanced', confirm: true, authorizedRequestCount: 1 },
    { authorizedRequestCount: 1 },
    { confirm: true },
    { mode: 'typo', confirm: true, authorizedRequestCount: 7 },
    { mode: null, confirm: true, authorizedRequestCount: 1 },
  ]) {
    const response = await f.start(body);
    assert.ok([400, 409].includes(response.status), JSON.stringify({ body, response }));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.applied, []);
  }
  assert.equal((await f.request('/api/admin/accounts/synthetic-account/qualification',
    { confirm: true, authorizedRequestCount: 1 }, 'your-wrong-token')).status, 401);
  assert.deepEqual(f.calls, []);
});
