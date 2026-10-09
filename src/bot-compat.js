'use strict';

const { timingSafeEqual } = require('node:crypto');
const { classifyIMAAnswerBasis } = require('./ima-answer-profile');

const POLICIES = Object.freeze(['knowledge_agent', 'auto', 'group_knowledge', 'web', 'mixed']);
const FIELDS = Object.freeze(['retrieval_policy', 'knowledge_scope_ref', 'recent_context_ref',
  'recent_context_binding', 'source_decision_digest', 'parallel_pair_ref', 'parallel_leg', 'source_intent']);
const DIGEST = /^[0-9a-f]{64}$/u;

function fault(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, reason: code, statusCode });
}

function optionalText(value, pattern) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !pattern.test(value.trim())) throw fault('bot_contract_invalid');
  return value.trim();
}

function normalizeRecentContextBinding(value) {
  const keys = ['account_id', 'group_id', 'route_ref', 'route_generation', 'feature_generation'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    throw fault('recent_context_binding_invalid');
  }
  const binding = {};
  for (const key of keys.slice(0, 3)) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 256
        || /[\u0000-\u001f\u007f]/u.test(value[key])) throw fault('recent_context_binding_invalid');
    binding[key] = value[key].trim();
  }
  for (const key of keys.slice(3)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < (key === 'feature_generation' ? 1 : 0)) {
      throw fault('recent_context_binding_invalid');
    }
    binding[key] = value[key];
  }
  return Object.freeze(binding);
}

// `internal` and expected scope must come from trusted server authentication/config.
function validateBotRetrievalContract(body, { internal = false, expectedKnowledgeScopeRef = '' } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fault('bot_contract_invalid');
  const present = FIELDS.some(key => Object.hasOwn(body, key));
  if (present && internal !== true) throw fault('internal_retrieval_contract_required');
  if (['knowledge_base_id', 'knowledgeBaseId', 'kb_id', 'kbId', 'IMA_SHARED_KNOWLEDGE_BASE_ID']
    .some(key => Object.hasOwn(body, key))) throw fault('raw_knowledge_scope_forbidden');
  const retrievalPolicy = optionalText(body.retrieval_policy, /^(knowledge_agent|auto|group_knowledge|web|mixed)$/u);
  const knowledgeScopeRef = optionalText(body.knowledge_scope_ref, DIGEST);
  const recentContextRef = optionalText(body.recent_context_ref, /^ctx_[0-9a-f]{64}$/u);
  const recentContextBinding = body.recent_context_binding == null ? null : normalizeRecentContextBinding(body.recent_context_binding);
  const sourceDecisionDigest = optionalText(body.source_decision_digest, DIGEST);
  const parallelPairRef = optionalText(body.parallel_pair_ref, DIGEST);
  const parallelLeg = optionalText(body.parallel_leg, /^(knowledge|web)$/u);
  const sourceIntent = optionalText(body.source_intent, /^web_requested$/u);
  if (knowledgeScopeRef && (!DIGEST.test(expectedKnowledgeScopeRef)
      || !timingSafeEqual(Buffer.from(knowledgeScopeRef), Buffer.from(expectedKnowledgeScopeRef)))) {
    throw fault('knowledge_scope_mismatch', 403);
  }
  if (Boolean(recentContextRef) !== Boolean(recentContextBinding)) throw fault('recent_context_binding_required');
  if (sourceIntent && retrievalPolicy !== 'knowledge_agent') throw fault('source_intent_invalid');
  if (['knowledge_agent', 'group_knowledge'].includes(retrievalPolicy) && !knowledgeScopeRef && !recentContextRef) {
    throw fault('knowledge_scope_required');
  }
  if (retrievalPolicy === 'mixed' && !knowledgeScopeRef) throw fault('knowledge_scope_required');
  if (Boolean(parallelPairRef) !== Boolean(parallelLeg)
      || (parallelLeg && retrievalPolicy !== (parallelLeg === 'knowledge' ? 'group_knowledge' : 'web'))) {
    throw fault('parallel_contract_invalid');
  }
  const hasRetrievalContract = Boolean(retrievalPolicy || knowledgeScopeRef || recentContextRef
    || sourceDecisionDigest || parallelPairRef || sourceIntent);
  const requestBinding = hasRetrievalContract ? JSON.stringify({
    retrieval_policy: retrievalPolicy, knowledge_scope_ref: knowledgeScopeRef,
    recent_context_ref: recentContextRef, recent_context_binding: recentContextBinding,
    source_decision_digest: sourceDecisionDigest, parallel_pair_ref: parallelPairRef,
    parallel_leg: parallelLeg, source_intent: sourceIntent,
  }) : '';
  return Object.freeze({ retrievalPolicy, knowledgeScopeRef, recentContextRef, recentContextBinding,
    sourceDecisionDigest, parallelPairRef, parallelLeg, sourceIntent, hasRetrievalContract, requestBinding });
}

async function prepareBotAsk({ contract, question, upstream = {}, recentContextConsumer, signal }) {
  if (signal?.aborted) throw fault('request_aborted', 499);
  const requiredProfile = ['knowledge_agent', 'group_knowledge'].includes(contract.retrievalPolicy)
    ? 'classic_knowledge' : 'ima_agent_auto';
  if (contract.retrievalPolicy && upstream.sessionId && upstream.sessionAnswerProfile !== requiredProfile) {
    throw fault('session_profile_conflict', 409);
  }
  let recentContext = null;
  if (contract.recentContextRef) {
    if (typeof recentContextConsumer?.consume !== 'function') throw fault('recent_context_unavailable', 503);
    recentContext = await recentContextConsumer.consume(contract.recentContextRef, { binding: contract.recentContextBinding, signal });
  }
  if (signal?.aborted) throw fault('request_aborted', 499);
  const session = Object.fromEntries(['accountId', 'sessionId', 'sessionAnswerProfile']
    .filter(key => typeof upstream[key] === 'string').map(key => [key, upstream[key]]));
  return {
    ...session,
    question: contract.sourceIntent === 'web_requested'
      ? `${question}\n\nRetrieve verifiable web evidence for this turn. Distinguish web sources from knowledge-base sources; do not claim web access without web evidence.` : question,
    signal,
    retrievalPolicy: contract.retrievalPolicy, knowledgeScopeRef: contract.knowledgeScopeRef,
    recentContextRef: contract.recentContextRef, recentContext,
    parallelPairRef: contract.parallelPairRef, parallelLeg: contract.parallelLeg,
  };
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fault('bot_evidence_invalid', 503);
  return value;
}

function buildBotAnswerEvidence({ retrievalPolicy = '', sourceIntent = '', profile = 'classic_knowledge', answer = '', sourceKinds = [], contextPlan = null }) {
  if (retrievalPolicy && !POLICIES.includes(retrievalPolicy)) throw fault('bot_contract_invalid');
  if (sourceIntent && (sourceIntent !== 'web_requested' || retrievalPolicy !== 'knowledge_agent')) throw fault('source_intent_invalid');
  if (!Array.isArray(sourceKinds) || sourceKinds.some(kind => !['knowledge', 'web'].includes(kind))) {
    throw fault('bot_evidence_invalid', 503);
  }
  const sourceCount = count(contextPlan?.sourceMessageCount ?? 0);
  const selected = count(contextPlan?.selectedMessageCount ?? 0);
  const injected = count(contextPlan?.injectedMessageCount ?? 0);
  const reason = contextPlan?.truncationReason || 'none';
  if (injected > selected || selected > sourceCount || !['none', 'payload_bytes', 'safety_count', 'prompt_budget'].includes(reason)) {
    throw fault('bot_evidence_invalid', 503);
  }
  const knowledge = sourceKinds.filter(kind => kind === 'knowledge').length;
  const web = sourceKinds.filter(kind => kind === 'web').length;
  let basis;
  if (String(answer).trim() && injected > 0) basis = web ? 'mixed' : 'knowledge';
  else if (retrievalPolicy === 'knowledge_agent' && String(answer).trim() && !sourceKinds.length) basis = 'agent_general';
  else basis = classifyIMAAnswerBasis({ profile, answer, sourceKinds }).answerBasis;
  const expected = { group_knowledge: 'knowledge', web: 'web', mixed: 'mixed' }[retrievalPolicy];
  if (expected && basis !== expected) throw fault('retrieval_policy_unsatisfied', 503);
  return Object.freeze({ answer_basis: basis, source_count: sourceKinds.length,
    source_intent: sourceIntent,
    knowledge_source_count: knowledge, web_source_count: web,
    l0_context_count: injected, l0_source_count: sourceCount, l0_snapshot_count: selected,
    l0_injected_count: injected, l0_omitted_count: sourceCount - injected, l0_truncation_reason: reason });
}

// Add the bot wire shape to a sanitized website snapshot; never infer unsupported policies.
function buildBotCapacitySnapshot({ website, profile, policyCapacity = {}, laneCapacity = {}, pairedCapacity = 0, now = Date.now() }) {
  if (!website || !Number.isSafeInteger(website.generation) || website.generation < 1
      || !['classic_knowledge', 'ima_agent', 'ima_agent_auto'].includes(profile?.answer_profile)
      || !Number.isSafeInteger(profile.profile_generation) || profile.profile_generation < 1
      || !DIGEST.test(profile.capability_digest || '')) throw fault('bot_capacity_unavailable', 503);
  const ceiling = count(website.maxConcurrent);
  if (ceiling > 1024) throw fault('bot_capacity_unavailable', 503);
  const capacities = (names, source) => Object.fromEntries(names.map(name => {
    // Native/classic policy proofs are independent of the elected auto profile.
    const ready = profile.ready === true || ['knowledge_agent', 'group_knowledge'].includes(name)
      || !POLICIES.includes(name);
    const capacity = ready ? Math.min(ceiling, count(source[name] ?? 0)) : 0;
    return [name, { ready: capacity > 0, max_concurrent: capacity }];
  }));
  const policies = capacities(POLICIES, policyCapacity);
  const maxConcurrent = Math.max(...Object.values(policies).map(entry => entry.max_concurrent));
  const features = Object.fromEntries(['knowledge_agent_keyed_sse_v1', 'source_intent_web_requested_v1', 'durable_qa_tasks_v1']
    .map(key => [key, website.features?.[key] === true]));
  return { schemaVersion: 1, schema_version: 'provider.a.capacity.v4', generation: website.generation,
    maxConcurrent: ceiling, available: Math.min(ceiling, count(website.available ?? 0)),
    totalSlots: count(website.totalSlots ?? ceiling), eligibleAccounts: count(website.eligibleAccounts ?? 0),
    totalAccounts: count(website.totalAccounts ?? 0), schedulableAccounts: count(website.schedulableAccounts ?? 0),
    ready: maxConcurrent > 0, max_concurrent: maxConcurrent,
    active: count(website.active ?? 0), queued: count(website.queued ?? 0),
    answer_profile: profile.answer_profile, answer_profile_ready: profile.ready === true,
    profile_generation: profile.profile_generation, capability_digest: profile.capability_digest,
    profile_block_category: profile.ready === true ? '' : 'answer_profile_probe_failed',
    policies, policy_capacity: Object.fromEntries(['knowledge_agent', 'group_knowledge', 'web'].map(key => [key, policies[key].max_concurrent])),
    lanes: capacities(['knowledge', 'agent', 'flex'], laneCapacity),
    paired_capacity: { knowledge_web_parallel: Math.min(count(pairedCapacity), Math.floor(ceiling / 2), policies.group_knowledge.max_concurrent, policies.web.max_concurrent) },
    features, observed_at: new Date(now).toISOString() };
}

module.exports = { POLICIES, FIELDS, normalizeRecentContextBinding, validateBotRetrievalContract,
  prepareBotAsk, buildBotAnswerEvidence, buildBotCapacitySnapshot };
