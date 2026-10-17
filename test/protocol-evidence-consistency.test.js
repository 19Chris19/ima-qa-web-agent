const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { normalizeIMAWebAgentEvent } = require('../src/ima-upstream-protocol');
const { classifyIMAKnowledgeAgentSource } = require('../src/ima-knowledge-agent-contract');
const { inspectWebEvidence } = require('../src/source-evidence-contract');
const scoped = (item, event) => classifyIMAKnowledgeAgentSource(item, {
  expectedKnowledgeScopeRef: crypto.createHash('sha256').update('SCRUBBED_KB').digest('hex'), sourceEventName: event.eventName,
}).kind;
const web = { sourceType: 0, title: 'Scrubbed web', jumpUrl: 'https://example.org/fixture', content: 'Scrubbed excerpt' };

test('keyed context dictionaries retain typed sources and exact one-to-many relationships', () => {
  const event = { eventName: 'CONTEXT_REFERENCES', data: { '42': [web, { ...web, jumpUrl: 'https://example.org/second' }], '7': [web] } };
  const result = normalizeIMAWebAgentEvent(event, new Set(), { sourceClassifier: scoped });
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sourceKinds, ['web', 'web']);
  assert.equal(result.citationMap['context:42'].sources.length, 2);
  assert.equal(result.citationMap['context:7'].sources[0].url, web.jumpUrl);
  assert.deepEqual(inspectWebEvidence({ citationMap: result.citationMap, done: { source_count: 2, web_source_count: 2,
    knowledge_source_count: 0, answer_basis: 'web' }, terminal: true }), { webEvidence: true, webEvidenceStatus: 'verified' });
});
test('missing, null and coerced types never prove web or knowledge provenance', () => {
  for (const sourceType of [undefined, null, false, '', '0', '1']) {
    const item = { ...web, sourceType }; if (sourceType === undefined) delete item.sourceType;
    const diagnostics = [];
    const result = normalizeIMAWebAgentEvent({ eventName: 'CONTEXT_REFERENCES', data: { '42': [item] } }, new Set(),
      { sourceClassifier: scoped, onCitationDiagnostic: d => diagnostics.push(d) });
    assert.equal(result.citationMap['context:42'].type, 'unknown');
    assert.deepEqual(result.sourceKinds, ['unknown']);
    assert.equal(diagnostics[0].phase, 'normalization');
    assert.doesNotMatch(JSON.stringify(diagnostics), /https:|Scrubbed excerpt|Scrubbed web/);
  }
  const result = normalizeIMAWebAgentEvent({ eventName: 'CONTEXT_REFERENCES', data: { '42': [{ title: 'Scrubbed source' }] } });
  assert.equal(result.citationMap['context:42'].type, 'unknown');
  assert.deepEqual(result.sourceKinds, ['unknown']);
});
test('one admitted classifier is used by sources and citations; diagnostics cannot fail an answer', () => {
  const result = normalizeIMAWebAgentEvent({ eventName: 'CONTEXT_REFERENCES', data: { '3': [{ ...web, sourceType: undefined }] } },
    new Set(), { sourceClassifier: () => 'web', onCitationDiagnostic: () => { throw Error('SCRUBBED'); } });
  assert.equal(result.citationMap['context:3'].type, result.sourceKinds[0]);
});
test('web evidence is independent of intent, preserves zero and rejects contradictory counts', () => {
  const map = { 'context:42': { type: 'web', sources: [{ url: 'https://example.org/fixture' }] } };
  assert.equal(inspectWebEvidence({ sourceIntent: 'web' }).webEvidenceStatus, 'unverified');
  assert.equal(inspectWebEvidence({ done: { web_source_count: 0 }, terminal: true }).webEvidenceStatus, 'not_observed');
  assert.equal(inspectWebEvidence({ citationMap: map }).webEvidenceStatus, 'verified');
  for (const done of [{ web_source_count: 0 }, { web_source_count: -1 }, { web_source_count: 1, webSourceCount: 0 },
    { source_count: 0, web_source_count: 1 }, { source_count: 1, knowledge_source_count: 1, web_source_count: 1 },
    { source_count: 1, web_source_count: 1, answer_basis: 'knowledge' }]) {
    assert.equal(inspectWebEvidence({ citationMap: map, done, terminal: true }).webEvidenceStatus, 'unverified');
  }
  assert.equal(inspectWebEvidence({ citationMap: { a: { type: 'web', sources: [{ url: 'javascript:SCRUBBED' }] } } }).webEvidence, false);
});
