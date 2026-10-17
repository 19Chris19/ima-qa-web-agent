const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateCatalog, inspectPublicBundle, checkScrubbedFixture } = require('../src/ima-contract-catalog');
const native = require('../src/ima-knowledge-agent-contract');
const root = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'contracts/ima-capabilities.v1.json')));
const sourceUrl = 'https://fe-static.ima.myqcloud.com/ima/assets/chat/assets/fixture.js';

test('all requested operations have evidence, unresolved fields and independent validation stages', () => {
  const result = validateCatalog(catalog, root);
  assert.equal(result.capabilities, 41);
  assert.equal(result.executableFromCatalog, false);
  assert.ok(result.pendingReal > 0);
  for (const mutate of [c => c.capabilities.pop(), c => c.capabilities[0].evidenceRefs.push('missing.ref'),
    c => c.capabilities.find(x => x.id === 'ppt.create').validation.release = 'published',
    c => c.capabilities.find(x => x.id === 'memory.read').runtimeImplemented = true,
    c => c.capabilities[0].callableFromCatalog = true]) {
    const changed = structuredClone(catalog); mutate(changed); assert.throws(() => validateCatalog(changed, root));
  }
});
test('native session and QA wire shapes match the independently stored scrubbed golden', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'contracts/fixtures/native-qa.json')));
  assert.equal(checkScrubbedFixture(fixture), true);
  assert.deepEqual(native.buildIMAKnowledgeAgentSessionRequest(fixture.session.input), fixture.session.expected);
  assert.deepEqual(native.buildIMAKnowledgeAgentRequest(fixture.qa.input), fixture.qa.expected);
});
test('bundle inspection does not execute code or invent prefix/suffix pairings', () => {
  const bytes = Buffer.from('globalThis.__IMA_EXECUTED=true;throw Error("do not execute");this.urlPrefix,"/get_models";toConstantValue("model_manage");');
  const result = inspectPublicBundle(bytes, { sourceUrl, sampledAt: '2026-10-17T00:00:00Z' });
  assert.equal(globalThis.__IMA_EXECUTED, undefined);
  assert.equal(result.callable, false);
  assert.deepEqual(result.candidatePaths, []);
  assert.deepEqual(result.methodSuffixes, ['/get_models']);
  assert.deepEqual(result.servicePrefixCandidates, ['model_manage']);
  assert.equal(result.sha256.length, 64);
  assert.throws(() => inspectPublicBundle(bytes, { sourceUrl: sourceUrl + '?token=SCRUBBED', sampledAt: '2026-10-17' }));
  assert.throws(() => inspectPublicBundle(new Uint8Array(8 * 1024 * 1024 + 1), { sourceUrl, sampledAt: '2026-10-17' }));
});
test('fixtures reject unsanitized prose, real URLs and credential fields', () => {
  for (const fixture of [{ question: 'unredacted question' }, { url: 'https://ima.qq.com/wikis' },
    { cookie: 'SCRUBBED' }, { authorization: 'SCRUBBED' }, { text: 'eyJabcdefghijklmnopqrstuv.SCRUBBED' }]) {
    assert.throws(() => checkScrubbedFixture(fixture));
  }
  assert.equal(checkScrubbedFixture({ question: 'Scrubbed question', url: 'https://example.org/fixture' }), true);
});
test('public-script receipts retain hashes and candidate limits, not raw bundles', () => {
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'contracts/evidence/public-bundle-0.json')));
  assert.equal(receipt.callable, false);
  assert.equal(receipt.evidenceLevel, 'public_script_candidate');
  assert.ok(receipt.methodSuffixes.includes('/get_models'));
  assert.ok(receipt.methodSuffixes.includes('/cancel_task'));
  assert.ok(!Object.hasOwn(receipt, 'source'));
});
