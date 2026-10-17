'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = [require('./fixtures/ima-web-native/wire.json'), require('./fixtures/ima-web-native/deep-thinking.json')];
function verify(value, key = '') {
  if (/cookie|credential|password|authorization|refresh.?token|api.?token/iu.test(key)) throw Error('fixture_credential_field');
  if (Array.isArray(value)) { value.forEach(x => verify(x)); return; }
  if (value && typeof value === 'object') { for (const [k, v] of Object.entries(value)) verify(v, k); return; }
  if (typeof value !== 'string') return;
  if (/https?:\/\//iu.test(value)) throw Error('fixture_url');
  if (/^(question|title|name|model_name|Message|Tips)$/u.test(key) && value && !value.startsWith('Scrubbed ')) throw Error('fixture_private_text');
  if (/^(.*_id|.*Id|Id|id|relatedUrl|cursor|version|uskey|uskey_bus_infos_input)$/u.test(key) && value && !value.startsWith('SCRUBBED_')) throw Error('fixture_private_identity');
}
test('native golden samples contain only synthetic text and identity, with no credential fields or URLs', () => {
  fixtures.forEach(x => verify(x));
});
test('privacy checks reject nested raw identities, actual prose and authentication fields', () => {
  for (const value of [{ nested: { model_id: 'unscrubbed-id' } }, { title: 'private title' }, { password: 'SCRUBBED' }, { url: 'https://example.invalid/' }]) assert.throws(() => verify(value));
});
