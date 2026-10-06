const test = require('node:test');
const assert = require('node:assert/strict');
const { accountManagementView } = require('../src/account-management-view');

test('knowledge proof is independent of legacy web health', () => {
  const view = accountManagementView({ health: { web_ready: false, session_valid: true } }, null,
    { state: 'ready', qualified: true, schedulable: true, verifiedAt: '2026-01-01T00:00:00Z' });
  assert.equal(view.knowledge.state, 'ready');
  assert.equal(view.web.state, 'unknown');
  assert.equal(view.schedulable, true);
});

for (const webReady of [true, false, null, undefined]) {
  test(`legacy web_ready=${webReady} never proves generic web search`, () => {
    const view = accountManagementView({ health: { web_ready: webReady, session_valid: true } });
    assert.equal(view.web.state, 'unknown');
    assert.equal(view.session.state, 'ready');
  });
}

for (const state of ['ready', 'busy', 'cooling']) {
  for (const knowledgeReady of [true, false, null]) {
    test(`unqualified classic ${state} with knowledge health ${knowledgeReady} stays unproved`, () => {
      const view = accountManagementView({ health: { knowledge_ready: knowledgeReady } }, null,
        { state, qualified: false, schedulable: state === 'ready', verifiedAt: 'synthetic-stale-time' });
      assert.equal(view.knowledge.state, 'pending');
      assert.equal(view.knowledge.qualified, false);
      assert.equal(view.knowledge.verifiedAt, null);
      assert.equal(view.schedulable, state === 'ready');
    });
  }
}

test('a bound knowledge proof remains valid despite unrelated legacy health flags', () => {
  const view = accountManagementView({ health: { knowledge_ready: false, web_ready: false } }, null,
    { state: 'ready', qualified: true, schedulable: true, verifiedAt: 'synthetic-proof-time' });
  assert.deepEqual(view.knowledge, { state: 'ready', qualified: true, verifiedAt: 'synthetic-proof-time' });
  assert.equal(view.web.state, 'unknown');
  assert.equal(view.schedulable, true);
});

for (const state of ['disabled', 'needs_login', 'verifying', 'pending']) {
  test(`unqualified knowledge retains operational ${state}`, () => {
    const view = accountManagementView({ health: {} }, null, { state, qualified: false });
    assert.equal(view.knowledge.state, state);
    assert.equal(view.knowledge.qualified, false);
  });
}

test('missing observations do not fabricate qualification, expiry or next check', () => {
  const view = accountManagementView({ health: { knowledge_ready: true } });
  assert.equal(view.knowledge.state, 'pending');
  assert.equal(view.knowledge.qualified, false);
  assert.equal(view.maintenance.state, 'unobserved');
  assert.equal(view.maintenance.nextCheckAt, null);
  assert.equal(view.maintenance.tokenExpiresAt, null);
});

test('live credential snapshot wins over stale account metadata and failed refresh timestamps', () => {
  const view = accountManagementView({ tokenExpiresAt: 'old', health: { last_refresh_at: 'failed', last_refresh_code: 'auth_expired' } },
    { auth: { tokenExpiresAt: null, refreshTokenExpiresAt: null, maintenance: { state: 'scheduled', nextCheckAt: 'actual-timer' } } });
  assert.equal(view.maintenance.nextCheckAt, 'actual-timer');
  assert.equal(view.maintenance.tokenExpiresAt, null);
  assert.equal(view.maintenance.lastSuccessfulRefreshAt, null);
});
