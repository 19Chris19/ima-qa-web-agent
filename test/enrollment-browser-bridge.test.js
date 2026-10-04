const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEndpoint, connectEnrollmentBrowser } = require('../src/enrollment-browser-bridge');
const endpoint = `ws://host.docker.internal:13318/${'a'.repeat(64)}`;
test('maintenance bridge restricts endpoints and requires a secret path', () => {
  assert.equal(validateEndpoint(endpoint), endpoint);
  for (const bad of ['ws://example.com:13318/', 'http://127.0.0.1:13318/', endpoint + '?key=x', 'ws://127.0.0.1:13318/short']) {
    assert.throws(() => validateEndpoint(bad));
  }
});
test('each enrollment gets a fresh context and disconnects after cleanup', async () => {
  const calls = [];
  const context = await connectEnrollmentBrowser(endpoint, async () => ({
    newContext: async () => ({ close: async () => calls.push('context') }),
    close: async () => calls.push('disconnect'),
  }));
  assert.equal(context.__imaEnrollmentBrowserVisible, true);
  await context.close();
  assert.deepEqual(calls, ['context', 'disconnect']);
});
test('bridge connection errors never disclose credentials', async () => {
  await assert.rejects(connectEnrollmentBrowser(endpoint, async () => { throw new Error(endpoint); }),
    error => !error.message.includes('aaaa') && error.message.includes('扫码助手'));
});
