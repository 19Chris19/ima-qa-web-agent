'use strict';

const { createHash } = require('node:crypto');

function knowledgeScopeDigest(knowledgeBaseId) {
  const value = boundedScope(knowledgeBaseId);
  return createHash('sha256').update(value).digest('hex');
}

function createClassicKnowledgeSourceClassifier({
  knowledgeBaseId,
  expectedKnowledgeScopeRef,
} = {}) {
  assertScopeMatches(knowledgeBaseId, expectedKnowledgeScopeRef);
  return (item, event) => {
    if (isWebSource(item, event)) return 'web';
    if (isRecognizedKnowledgeSource(item, event)) return 'knowledge';
    return 'unknown';
  };
}

function verifyClassicKnowledgeQualification(input = {}) {
  assertScopeMatches(input.knowledgeBaseId, input.expectedKnowledgeScopeRef);
  if (input.classicContractObserved !== true) {
    throw proofError('classic_contract_not_observed');
  }
  const valid = Number(input.providerRequests) === 1
    && Number(input.terminalCount) === 1
    && input.answerPresent === true
    && input.answerBasis === 'knowledge'
    && Number.isInteger(Number(input.sourceCount))
    && Number(input.sourceCount) > 0
    && Number(input.webSourceCount) === 0
    && Number(input.unknownSourceCount) === 0;
  if (!valid) throw proofError('classic_knowledge_qualification_invalid');
  return Object.freeze({
    qualified: true,
    proofCategory: 'classic_contract_bound',
  });
}

function assertScopeMatches(knowledgeBaseId, expectedKnowledgeScopeRef) {
  const expected = String(expectedKnowledgeScopeRef || '').trim();
  if (!/^[0-9a-f]{64}$/u.test(expected)) throw proofError('knowledge_scope_ref_invalid');
  if (knowledgeScopeDigest(knowledgeBaseId) !== expected) {
    throw proofError('knowledge_scope_mismatch');
  }
}

function isWebSource(item, event) {
  if (item?.sourceType !== undefined && item?.sourceType !== null) {
    return Number(item.sourceType) === 0;
  }
  const eventName = compactEventName(event);
  if (eventName === 'contextreferences') return true;
  return false;
}

function isRecognizedKnowledgeSource(item, event) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const sourceType = item.sourceType;
  if (sourceType !== undefined && sourceType !== null) {
    return [1, 2].includes(Number(sourceType));
  }
  return ['searchmedias', 'structuredblock'].includes(compactEventName(event));
}

function compactEventName(event) {
  return String(event?.eventName || '')
    .replace(/[_\s-]/gu, '')
    .toLowerCase();
}

function boundedScope(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 512 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw proofError('knowledge_scope_invalid');
  }
  return text;
}

function proofError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  createClassicKnowledgeSourceClassifier,
  knowledgeScopeDigest,
  verifyClassicKnowledgeQualification,
};
