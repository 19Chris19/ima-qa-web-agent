'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFailureReason } = require('../src/app');
const { safeTaskFailureReason } = require('../src/durable-qa-failure');

test('nested fetch transport failures retain a public category without private exception text', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET']) {
    const error = new TypeError('synthetic private URL and response text', { cause: Object.assign(new Error('synthetic private detail'), { code }) });
    assert.equal(classifyFailureReason(error), 'upstream_connection_interrupted');
    assert.equal(safeTaskFailureReason(classifyFailureReason(error)), 'upstream_connection_interrupted');
  }
});

test('transport header/body timeouts keep existing separate categories and unknown errors stay unknown', () => {
  for (const [code, expected] of [['UND_ERR_CONNECT_TIMEOUT', 'upstream_headers_timeout'], ['UND_ERR_HEADERS_TIMEOUT', 'upstream_headers_timeout'], ['UND_ERR_BODY_TIMEOUT', 'upstream_idle_timeout']]) {
    assert.equal(classifyFailureReason(new TypeError('fetch failed', { cause: { code } })), expected);
  }
  assert.equal(classifyFailureReason(new TypeError('fetch failed')), 'unknown', 'a generic message is not proof of a transport cause');
  assert.equal(classifyFailureReason({ code: 'synthetic-private-value', message: 'synthetic-private-value' }), 'unknown');
  const cycle = {}; cycle.cause = cycle;
  assert.equal(classifyFailureReason(cycle), 'unknown');
  assert.equal(classifyFailureReason({ code: 'retrieval_policy_unsatisfied', cause: { code: 'ECONNRESET' } }), 'retrieval_policy_unsatisfied');
});
