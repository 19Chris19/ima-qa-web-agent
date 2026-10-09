'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { POLICIES, FIELDS, validateBotRetrievalContract, prepareBotAsk, buildBotAnswerEvidence,
  buildBotCapacitySnapshot } = require('../src/bot-compat');

const scope = 'a'.repeat(64);
const ref = `ctx_${'b'.repeat(64)}`;
const binding = { account_id: 'synthetic-account', group_id: 'synthetic-group', route_ref: 'synthetic-route', route_generation: 0, feature_generation: 1 };
const options = { internal: true, expectedKnowledgeScopeRef: scope };
const parse = body => validateBotRetrievalContract(body, options);

test('all live retrieval policies retain canonical fields, while ordinary callers cannot add internal fields', () => {
  for (const policy of POLICIES) {
    const contract = parse({ retrieval_policy: policy, knowledge_scope_ref: scope });
    assert.equal(contract.retrievalPolicy, policy);
    assert.equal(contract.knowledgeScopeRef, scope);
    assert.equal(contract.hasRetrievalContract, true);
    assert.equal(JSON.parse(contract.requestBinding).retrieval_policy, policy);
  }
  assert.equal(validateBotRetrievalContract({ question: 'Synthetic question' }).hasRetrievalContract, false);
  for (const field of FIELDS) assert.throws(() => validateBotRetrievalContract({ [field]: null }), { code: 'internal_retrieval_contract_required' });
  for (const field of ['knowledge_base_id', 'knowledgeBaseId', 'kb_id', 'kbId', 'IMA_SHARED_KNOWLEDGE_BASE_ID']) {
    assert.throws(() => parse({ [field]: 'synthetic' }), { code: 'raw_knowledge_scope_forbidden' });
  }
});

test('scope, web intent, paired legs and recent context bindings fail closed', () => {
  for (const body of [
    { retrieval_policy: 'unknown' }, { retrieval_policy: 'mixed' },
    { retrieval_policy: 'knowledge_agent' }, { source_intent: 'web_requested', retrieval_policy: 'web' },
    { parallel_pair_ref: scope }, { parallel_leg: 'web', parallel_pair_ref: scope, retrieval_policy: 'group_knowledge', knowledge_scope_ref: scope },
    { recent_context_ref: ref }, { recent_context_binding: binding },
    { recent_context_ref: ref, recent_context_binding: { ...binding, route_generation: '0' } },
    { recent_context_ref: ref, recent_context_binding: { ...binding, extra: 'ignored?' } },
    { retrieval_policy: 'web', knowledge_scope_ref: 'c'.repeat(64) },
  ]) assert.throws(() => parse(body));
  assert.throws(() => validateBotRetrievalContract({ knowledge_scope_ref: scope }, { internal: true }), { statusCode: 403 });
  assert.equal(parse({ retrieval_policy: 'group_knowledge', recent_context_ref: ref, recent_context_binding: binding }).knowledgeScopeRef, '');
  assert.equal(parse({ retrieval_policy: 'web', parallel_pair_ref: scope, parallel_leg: 'web' }).parallelLeg, 'web');
});

test('idempotency fingerprint binds every group context field, independent of input key order', () => {
  const body = { retrieval_policy: 'group_knowledge', recent_context_ref: ref, recent_context_binding: binding };
  const original = parse(body).requestBinding;
  for (const key of Object.keys(binding)) {
    const changed = typeof binding[key] === 'number' ? binding[key] + 1 : `${binding[key]}-changed`;
    assert.notEqual(parse({ ...body, recent_context_binding: { ...binding, [key]: changed } }).requestBinding, original);
  }
  assert.equal(parse({ ...body, recent_context_binding: Object.fromEntries(Object.entries(binding).reverse()) }).requestBinding, original);
});

test('preparation rejects incompatible followups before consume and preserves compatible affinity', async () => {
  const contract = parse({ retrieval_policy: 'group_knowledge', recent_context_ref: ref, recent_context_binding: binding });
  let calls = 0;
  await assert.rejects(prepareBotAsk({ contract, question: 'Synthetic question', upstream: { accountId: 'account', sessionId: 'synthetic-session', sessionAnswerProfile: 'ima_agent_auto' },
    recentContextConsumer: { consume() { calls++; } } }), { code: 'session_profile_conflict', statusCode: 409 });
  assert.equal(calls, 0);
  const prepared = await prepareBotAsk({ contract, question: 'Synthetic question', upstream: { accountId: 'account', sessionId: 'synthetic-session', sessionAnswerProfile: 'classic_knowledge' },
    recentContextConsumer: { async consume(actual, opts) { calls++; assert.equal(actual, ref); assert.deepEqual(opts.binding, binding); return { messages: [] }; } } });
  assert.equal(calls, 1);
  assert.equal(prepared.sessionId, 'synthetic-session');
  assert.equal(prepared.accountId, 'account');
  assert.equal(prepared.question, 'Synthetic question');
  await assert.rejects(prepareBotAsk({ contract, question: 'Synthetic question' }), { code: 'recent_context_unavailable' });
  await assert.rejects(prepareBotAsk({ contract, question: 'Synthetic question', signal: AbortSignal.abort(),
    recentContextConsumer: { consume() { calls++; } } }), { code: 'request_aborted' });
  assert.equal(calls, 1);
  const web = parse({ retrieval_policy: 'knowledge_agent', knowledge_scope_ref: scope, source_intent: 'web_requested' });
  const request = await prepareBotAsk({ contract: web, question: 'Synthetic question', upstream: { sessionId: 'same', sessionAnswerProfile: 'classic_knowledge', mode: 'untrusted-old-mode' } });
  assert.equal(request.sessionId, 'same');
  assert.equal(request.mode, undefined);
  assert.match(request.question, /Synthetic question/);
  assert.match(request.question, /verifiable web evidence/);
});

test('legacy unknown profile preserves account and session and still consumes context once', async () => {
  const contract = parse({ retrieval_policy: 'group_knowledge', recent_context_ref: ref, recent_context_binding: binding });
  let consumed = 0;
  const prepared = await prepareBotAsk({ contract, question: 'Synthetic question',
    upstream: { accountId: 'synthetic-account', sessionId: 'synthetic-session' },
    recentContextConsumer: { async consume() { consumed++; return { messages: [] }; } } });
  assert.equal(prepared.accountId, 'synthetic-account');
  assert.equal(prepared.sessionId, 'synthetic-session');
  assert.equal(prepared.sessionAnswerProfile, undefined);
  assert.equal(consumed, 1);
});

test('source evidence distinguishes actual knowledge/web/L0 from general text and rejects unsatisfied policy', () => {
  assert.equal(buildBotAnswerEvidence({ retrievalPolicy: 'knowledge_agent', answer: 'Synthetic' }).answer_basis, 'agent_general');
  const contextPlan = { sourceMessageCount: 5, selectedMessageCount: 3, injectedMessageCount: 2, truncationReason: 'prompt_budget' };
  const evidence = buildBotAnswerEvidence({ retrievalPolicy: 'mixed', answer: 'Synthetic', sourceKinds: ['web'], contextPlan });
  assert.equal(evidence.answer_basis, 'mixed');
  assert.equal(evidence.source_count, 1);
  assert.equal(evidence.knowledge_source_count, 0);
  assert.equal(evidence.l0_injected_count, 2);
  assert.equal(evidence.l0_omitted_count, 3);
  assert.throws(() => buildBotAnswerEvidence({ retrievalPolicy: 'group_knowledge', answer: 'Synthetic', sourceKinds: ['web'], contextPlan }), { code: 'retrieval_policy_unsatisfied' });
  assert.throws(() => buildBotAnswerEvidence({ retrievalPolicy: 'web', answer: 'Synthetic', sourceKinds: ['knowledge'] }), { code: 'retrieval_policy_unsatisfied' });
  assert.throws(() => buildBotAnswerEvidence({ sourceKinds: ['unknown'] }), { code: 'bot_evidence_invalid' });
  assert.throws(() => buildBotAnswerEvidence({ contextPlan: { ...contextPlan, injectedMessageCount: 4 } }), { code: 'bot_evidence_invalid' });
});

test('dual capacity shape preserves website flags and never invents policies or minimum-one capacity', () => {
  const website = { generation: 3, maxConcurrent: 4, available: 2, active: 2, queued: 1,
    features: { durable_qa_tasks_v1: true }, privateAccount: 'must-not-escape' };
  const profile = { answer_profile: 'classic_knowledge', profile_generation: 2, capability_digest: scope, ready: true };
  const data = buildBotCapacitySnapshot({ website, profile, policyCapacity: { knowledge_agent: 4, group_knowledge: 3, web: 2 }, pairedCapacity: 9, now: 1000 });
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.schema_version, 'provider.a.capacity.v4');
  assert.equal(data.max_concurrent, 4);
  assert.equal(data.policies.auto.max_concurrent, 0);
  assert.equal(data.paired_capacity.knowledge_web_parallel, 2);
  assert.equal(data.features.durable_qa_tasks_v1, true);
  assert.equal(data.features.source_intent_web_requested_v1, false);
  assert.equal(data.privateAccount, undefined);
  const zero = buildBotCapacitySnapshot({ website: { ...website, maxConcurrent: 0 }, profile, policyCapacity: { knowledge_agent: 4 } });
  assert.equal(zero.max_concurrent, 0);
  assert.equal(zero.ready, false);
  const blocked = buildBotCapacitySnapshot({ website, profile: { ...profile, ready: false }, policyCapacity: { web: 2 } });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.profile_block_category, 'answer_profile_probe_failed');
  const native = buildBotCapacitySnapshot({ website, profile: { ...profile, ready: false }, policyCapacity: { knowledge_agent: 3, web: 2 } });
  assert.equal(native.answer_profile_ready, false);
  assert.equal(native.policies.knowledge_agent.max_concurrent, 3);
  assert.equal(native.policies.web.max_concurrent, 0);
  assert.equal(native.ready, true);
  assert.throws(() => buildBotCapacitySnapshot({ website, profile: {} }), { code: 'bot_capacity_unavailable' });
});
