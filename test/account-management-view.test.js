const test = require('node:test');
const assert = require('node:assert/strict');
const { accountManagementView } = require('../src/account-management-view');

test('knowledge evidence is independent of general web health', () => {
  const view = accountManagementView({ health: { web_ready: false, session_valid: true } }, null,
    { state: 'ready', qualified: true, schedulable: true, verifiedAt: '2026-01-01T00:00:00Z' });
  assert.equal(view.knowledge.state, 'ready');
  assert.equal(view.web.state, 'unavailable');
  assert.equal(view.schedulable, true);
});

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
