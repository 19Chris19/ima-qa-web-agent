const test = require('node:test');
const assert = require('node:assert/strict');
const { parseShareUrl, parseShareHtml, resolveSharedTarget, verifySharedMembership } = require('../src/shared-kb-target');
const { fixture } = require('./helpers/share-metadata');

const shareId = 'a'.repeat(64);
const url = `https://ima.qq.com/wiki/?shareId=${shareId}`;

test('only canonical official share links are allowed', () => {
  assert.equal(parseShareUrl(url).shareId, shareId);
  for (const input of ['http://ima.qq.com/wiki/?shareId=' + shareId,
    'https://ima.qq.com.evil.test/wiki/?shareId=' + shareId,
    'https://user:secret@ima.qq.com/wiki/?shareId=' + shareId,
    'https://ima.qq.com/wiki/?shareId=not-a-share', 'https://ima.qq.com/internal']) {
    assert.throws(() => parseShareUrl(input), /official_share_url_required/);
  }
});
test('parse the confirmed official metadata without running JavaScript', () => {
  const target = parseShareHtml(fixture(), url);
  assert.equal(target.knowledgeBaseId, '123456789');
  assert.equal(target.name, 'Synthetic library');
  assert.equal(target.membership, 'not_joined');
  assert.equal(parseShareHtml(fixture({ role: 100 }), url).membership, 'joined');
  assert.equal(parseShareHtml(fixture({ role: 42 }), url).membership, 'unknown');
  assert.throws(() => parseShareHtml(fixture({ id: shareId }), url), /share_metadata_unverified/);
  assert.throws(() => parseShareHtml(fixture({ share: 'b'.repeat(64) }), url), /share_metadata_unverified/);
  assert.throws(() => parseShareHtml('<script>process.exit()</script>', url), /share_metadata_unverified/);
});
test('reject redirects, oversized responses and mismatched bindings', async () => {
  assert.equal((await resolveSharedTarget(url, { fetchImpl: async () => new Response(fixture()), expectedId: '123456789' })).knowledgeBaseId, '123456789');
  await assert.rejects(resolveSharedTarget(url, { fetchImpl: async () => new Response('', { status: 302 }) }), /share_unavailable/);
  await assert.rejects(resolveSharedTarget(url, { fetchImpl: async () => new Response('x'.repeat(1_048_577)) }), /share_too_large/);
  await assert.rejects(resolveSharedTarget(url, { fetchImpl: async () => new Response(fixture()), expectedId: '987' }), /knowledge_base_mismatch/);
});
test('authenticated membership is bound to the configured target and fails closed', async () => {
  const options = { expectedId: '123', headers: { 'x-ima-cookie': 'IMA-UID=synthetic; IMA-TOKEN=synthetic', 'x-ima-bkn': '123' } };
  const fetchImpl = role => async (target, request) => {
    assert.equal(target, 'https://ima.qq.com/cgi-bin/knowledge_share_get/get_share_info');
    assert.equal(JSON.parse(request.body).share_id, shareId);
    return Response.json({ code: 0, knowledge_base_info: { id: '123', user_permission_info: { role_type: role } } });
  };
  assert.equal((await verifySharedMembership(url, { ...options, fetchImpl: fetchImpl(100) })).membership, 'joined');
  assert.equal((await verifySharedMembership(url, { ...options, fetchImpl: fetchImpl(0) })).membership, 'unknown');
  await assert.rejects(verifySharedMembership(url, { ...options, expectedId: '456', fetchImpl: fetchImpl(100) }), /membership_unverified/);
  await assert.rejects(verifySharedMembership(url, { ...options, fetchImpl: async () => { throw new Error('synthetic offline'); } }), /synthetic offline/);
});
