'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createClassicKnowledgeSourceClassifier,
  knowledgeScopeDigest,
  verifyClassicKnowledgeQualification,
} = require('../src/air/classic-knowledge-contract-proof');

test('Classic proof requires the expected local knowledge scope digest', () => {
  const scope = knowledgeScopeDigest('synthetic-shared-kb');
  assert.equal(scope.length, 64);
  assert.throws(
    () => createClassicKnowledgeSourceClassifier({
      knowledgeBaseId: 'synthetic-other-kb',
      expectedKnowledgeScopeRef: scope,
    }),
    /knowledge_scope_mismatch/u,
  );
});

test('Classic-bound classifier treats recognized non-Web records as knowledge', () => {
  const knowledgeBaseId = 'synthetic-shared-kb';
  const classify = createClassicKnowledgeSourceClassifier({
    knowledgeBaseId,
    expectedKnowledgeScopeRef: knowledgeScopeDigest(knowledgeBaseId),
  });

  assert.equal(classify(
    { id: 'synthetic-one', sourceType: 2 },
    { eventName: 'SEARCH_MEDIAS' },
  ), 'knowledge');
  assert.equal(classify(
    { id: 'synthetic-two' },
    { eventName: 'SEARCH_MEDIAS' },
  ), 'knowledge');
  assert.equal(classify(
    { id: 'synthetic-web', sourceType: 0, jumpUrl: 'https://example.invalid' },
    { eventName: 'SEARCH_MEDIAS' },
  ), 'web');
  assert.equal(classify(
    { id: 'synthetic-reference' },
    { eventName: 'CONTEXT_REFERENCES' },
  ), 'web');
  assert.equal(classify(
    { id: 'synthetic-bound-reference', sourceType: 1 },
    { eventName: 'CONTEXT_REFERENCES' },
  ), 'knowledge');
  assert.equal(classify(
    { jumpUrl: 'https://ima.qq.com/knowledge/synthetic', title: 'Synthetic' },
    { eventName: 'STRUCTURED_BLOCK' },
  ), 'knowledge');
});

test('source type alone outside the bound classifier is not qualification proof', () => {
  assert.throws(
    () => verifyClassicKnowledgeQualification({
      knowledgeBaseId: 'synthetic-shared-kb',
      expectedKnowledgeScopeRef: knowledgeScopeDigest('synthetic-shared-kb'),
      providerRequests: 1,
      terminalCount: 1,
      answerBasis: 'knowledge',
      sourceCount: 1,
      webSourceCount: 0,
      unknownSourceCount: 0,
      answerPresent: true,
      classicContractObserved: false,
    }),
    /classic_contract_not_observed/u,
  );
});

test('Classic qualification requires one terminal, answer, sources and zero Web', () => {
  const knowledgeBaseId = 'synthetic-shared-kb';
  const base = {
    knowledgeBaseId,
    expectedKnowledgeScopeRef: knowledgeScopeDigest(knowledgeBaseId),
    providerRequests: 1,
    terminalCount: 1,
    answerBasis: 'knowledge',
    sourceCount: 3,
    webSourceCount: 0,
    unknownSourceCount: 0,
    answerPresent: true,
    classicContractObserved: true,
  };
  assert.deepEqual(verifyClassicKnowledgeQualification(base), {
    qualified: true,
    proofCategory: 'classic_contract_bound',
  });
  assert.throws(
    () => verifyClassicKnowledgeQualification({ ...base, webSourceCount: 1 }),
    /classic_knowledge_qualification_invalid/u,
  );
  assert.throws(
    () => verifyClassicKnowledgeQualification({ ...base, terminalCount: 0 }),
    /classic_knowledge_qualification_invalid/u,
  );
  assert.throws(
    () => verifyClassicKnowledgeQualification({ ...base, sourceCount: 0 }),
    /classic_knowledge_qualification_invalid/u,
  );
});
