'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { persistenceDiagnostic } = require('../src/account-persistence-diagnostic');

test('persistence errors expose fixed classifications, never exception content', () => {
  for (const [message, code] of [
    ['Account not found', 'account_not_found'],
    ['Account maxConcurrent must be a positive integer', 'account_capacity_invalid'],
    ['IMA_WEB_AGENT_HEADERS_JSON must be valid JSON', 'account_credential_encoding_invalid'],
    ['账号 synthetic-private-name 已存在；如确认要重新绑定登录态，请显式使用 replace', 'account_name_conflict'],
  ]) {
    const result = persistenceDiagnostic(Object.assign(new Error(message), { statusCode: 409 }),
      { operation: 'upsertCapturedAccount', phase: 'apply_operation' });
    assert.equal(result.code, code);
    assert.equal(result.phase, 'apply_operation');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-name|stack|message/);
  }
  const result = persistenceDiagnostic(Object.assign(new Error('IMA-TOKEN=synthetic-secret /private/synthetic'),
    { code: 'EACCES', stack: 'synthetic-secret' }), { operation: 'upsertCapturedAccount', phase: 'runtime_export' });
  assert.equal(result.reason, 'permission_denied');
  assert.doesNotMatch(JSON.stringify(result), /synthetic|private|TOKEN|stack|message/);
  assert.equal(persistenceDiagnostic(new TypeError('synthetic-secret')).reason, 'type_error');
});

test('unknown diagnostic phase and operation are rejected', () => {
  const result = persistenceDiagnostic(new Error('synthetic-secret'),
    { operation: '/private/synthetic-secret', phase: 'synthetic-secret' });
  assert.equal(result.operation, 'unknown'); assert.equal(result.phase, 'dispatch');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
});
