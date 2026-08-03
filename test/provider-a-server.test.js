const assert = require('node:assert/strict');
const test = require('node:test');
const { assertProviderA } = require('../provider-a-server');

test('Provider A release entrypoint refuses other providers', () => {
  assert.doesNotThrow(() => assertProviderA({ qaProvider: 'ima-web-agent' }));
  assert.throws(
    () => assertProviderA({ qaProvider: 'openapi-mimo' }),
    /只支持 Provider A/,
  );
});
