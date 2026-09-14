const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyAccountHealthError,
  healthMessage,
} = require('../src/account-health');

test('account health errors use stable categories and Chinese operator messages', () => {
  assert.equal(
    classifyAccountHealthError(new Error('IMA Web login expired and refresh credentials are unavailable'), 'refresh'),
    'auth_expired',
  );
  assert.equal(classifyAccountHealthError(new Error('HTTP 403 forbidden'), 'check'), 'auth_rejected');
  assert.equal(
    classifyAccountHealthError(new Error('knowledge base permission denied'), 'check'),
    'knowledge_base_unavailable',
  );
  assert.equal(classifyAccountHealthError(new Error('fetch failed'), 'check'), 'upstream_temporary');
  assert.match(healthMessage('auth_expired'), /重新扫码登录/);
});
