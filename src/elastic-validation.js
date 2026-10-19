'use strict';

const MODES = new Set(['classic_knowledge', 'knowledge_agent', 'ima_agent', 'ima_agent_auto']);
const fields = ['accountId', 'principalFingerprint', 'mode', 'modelId', 'modelType', 'initialConcurrent', 'validatedMaxConcurrent'];
const invalid = () => new TypeError('Invalid elastic account validation limits');
const validFingerprint = value => typeof value === 'string' && (/^[a-f0-9]{64}$/u.test(value)
  || (/^[A-Za-z0-9_-]{43}$/u.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value));

function normalizeAccountLimits(value = [], maxPerAccount = 20, initialConcurrent = 1) {
  if (!Array.isArray(value) || value.length > 256) throw invalid();
  const seen = new Set();
  return value.map(input => {
    const row = input && { ...input, initialConcurrent: input.initialConcurrent ?? Math.min(initialConcurrent, input.validatedMaxConcurrent) };
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !fields.includes(key))
        || typeof row.accountId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(row.accountId)
        || !validFingerprint(row.principalFingerprint) || !MODES.has(row.mode)
        || typeof row.modelId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(row.modelId)
        || !Number.isSafeInteger(row.modelType) || row.modelType < 0 || row.modelType > 100
        || !Number.isSafeInteger(row.validatedMaxConcurrent) || row.validatedMaxConcurrent < 1 || row.validatedMaxConcurrent > maxPerAccount
        || !Number.isSafeInteger(row.initialConcurrent) || row.initialConcurrent < 1 || row.initialConcurrent > row.validatedMaxConcurrent) throw invalid();
    const key = JSON.stringify(fields.slice(0, 5).map(field => row[field]));
    if (seen.has(key)) throw invalid(); seen.add(key);
    return Object.freeze({ ...row });
  });
}

// Resolve from the actual adapter/model configuration, never a browser's label
// or a client-supplied validation/ceiling field. New adapter modes default to 1.
function accountDescriptor(account, options = {}, defaultMode = 'classic_knowledge') {
  const policy = options.retrievalPolicy;
  const mode = options.mode === 'knowledge_agent' || policy === 'knowledge_agent' ? 'knowledge_agent'
    : policy === 'group_knowledge' ? 'classic_knowledge'
      : ['auto', 'web', 'mixed'].includes(policy) ? 'ima_agent_auto'
        : options.sessionAnswerProfile || options.answerProfile || account.client?.answerProfile || options.mode || defaultMode;
  return { accountId: account.id, principalFingerprint: account.principalFingerprint,
    mode, modelId: account.client?.modelId ?? account.modelId, modelType: Number(account.client?.modelType ?? account.modelType) };
}

function matchingLimit(account, descriptor, limits) {
  return limits.find(row => row.accountId === account.id && fields.slice(1, 5).every(key => row[key] === descriptor[key]));
}

// Operator-approved trials are deliberately separate from acceptance evidence.
// Trial scope is exact and capped at five; it never creates a validated grant.
function normalizeTrialLimits(value = [], maxPerAccount = 20, initialConcurrent = 1) {
  const allowed = [...fields.slice(0, 5), 'maxConcurrent', 'initialConcurrent'];
  if (!Array.isArray(value) || value.length > 256) throw invalid();
  const rows = value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some(key => !allowed.includes(key))) throw invalid();
    const { maxConcurrent, ...rest } = row;
    return { ...rest, validatedMaxConcurrent: maxConcurrent };
  });
  return normalizeAccountLimits(rows, Math.min(5, maxPerAccount), initialConcurrent).map(row => {
    const { validatedMaxConcurrent, ...rest } = row;
    return Object.freeze({ ...rest, maxConcurrent: validatedMaxConcurrent });
  });
}

module.exports = { normalizeAccountLimits, normalizeTrialLimits, accountDescriptor, matchingLimit };
