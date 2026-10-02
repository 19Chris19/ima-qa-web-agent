const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildIMAKnowledgeAgentHeaders } = require('../src/ima-knowledge-agent-contract');
const options = { knowledgeBaseId: 'synthetic-scope' };
test('fresh enrollment without a version gets matching client metadata', () => {
  const h = buildIMAKnowledgeAgentHeaders({ 'x-ima-cookie': 'IMA-TOKEN=synthetic; IMA-UID=synthetic', 'x-ima-bkn': '123' }, options);
  assert.equal(h['x-ima-cookie'], `IMA-TOKEN=synthetic; IMA-UID=synthetic; WEB-VERSION=${h.extension_version}`);
});
test('existing version is replaced once and ambiguous duplicate versions rejected', () => {
  const h = buildIMAKnowledgeAgentHeaders({ 'x-ima-cookie': 'IMA-TOKEN=synthetic; WEB-VERSION=old', 'x-ima-bkn': '123' }, options);
  assert.equal(h['x-ima-cookie'], `IMA-TOKEN=synthetic; WEB-VERSION=${h.extension_version}`);
  assert.throws(() => buildIMAKnowledgeAgentHeaders({ 'x-ima-cookie': 'WEB-VERSION=old; WEB-VERSION=other', 'x-ima-bkn': '123' }, options));
});
test('missing authentication material is still rejected', () => {
  assert.throws(() => buildIMAKnowledgeAgentHeaders({ 'x-ima-bkn': '123' }, options));
});
