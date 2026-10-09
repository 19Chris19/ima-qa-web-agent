'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { ConversationStore } = require('../src/conversation-store');
const { FIELDS } = require('../src/bot-compat');
const { DurableQATasks } = require('../src/durable-qa-tasks');
const { createAskQueue } = require('../src/ask-queue');

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const scope = hash('synthetic-kb');
const binding = { account_id: 'synthetic-account', group_id: 'synthetic-group',
  route_ref: 'synthetic-route', route_generation: 2, feature_generation: 3 };
const context = { messages: [{ sender_display_name: 'Synthetic speaker', text: 'Synthetic recent evidence' }],
  sourceMessageCount: 3, selectedMessageCount: 1, truncationReason: 'safety_count', watermarkCategory: 'watermark_known' };
const contract = { retrieval_policy: 'group_knowledge', knowledge_scope_ref: scope,
  recent_context_ref: `ctx_${hash('synthetic-context')}`, recent_context_binding: binding,
  source_decision_digest: hash('synthetic-decision') };
const until = async fn => {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('synthetic condition did not settle');
};

async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-mount-'));
  const store = new ConversationStore({ storePath: path.join(dir, 'history.json') });
  const owner = 'synthetic-owner';
  const mode = options.mode || 'classic_knowledge';
  const cid = store.create(owner, { mode }).conversationId;
  store.setUpstream(cid, { accountId: 'synthetic-account', sessionId: 'synthetic-session' }, owner);
  const consumed = [], calls = [], routing = [], leases = [];
  const state = { generation: 9, profile: { answer_profile: 'classic_knowledge', ready: true,
    profile_generation: 2, capability_digest: hash('synthetic-profile') },
  policyCapacity: { knowledge_agent: 2, auto: 2, group_knowledge: 2, web: 1, mixed: 1 },
  laneCapacity: { knowledge: 1, agent: 1, flex: 0 }, pairedCapacity: 1,
  features: { future_bot_contract_v9: true, recent_context_v2: true } };
  const config = { qaProvider: 'ima-web-agent', mimo: {}, webAgent: { sharedKnowledgeBaseId: 'synthetic-kb', mode },
    security: { apiToken: 'synthetic-api', internalServiceToken: 'synthetic-internal', applications: [
      { id: 'bot', apiTokens: ['synthetic-bot-api'], internalServiceTokens: ['synthetic-bot-internal'] },
      { id: 'other', apiTokens: ['synthetic-other-api'], internalServiceTokens: ['synthetic-other-internal'] },
    ] },
    conversations: { storePath: store.storePath }, limits: { maxQuestionLength: 2000 },
    concurrency: { maxConcurrentAsk: 1, queueLimit: options.queueLimit ?? 10, requestTimeoutMs: 10000 },
    rateLimit: { windowMs: 0, max: 0 } };
  const pool = {
    canAcquireSlot(args) { routing.push(args); return true; },
    tryAcquireSlot(args) { routing.push(args); const lease = { accountId: 'synthetic-account', released: false,
      release() { this.released = true; } }; leases.push(lease); return { value: lease, release: () => lease.release() }; },
    async *streamAsk(args) {
      calls.push(args); args.onDispatch?.();
      if (options.stream) { yield* options.stream(args); return; }
      yield { type: 'sources', sources: [{ index: 1, title: 'Synthetic source', snippet: 'Synthetic evidence' }],
        sourceKinds: [options.sourceKind || 'knowledge'] };
      yield { type: 'delta', text: 'Synthetic answer' };
      yield { type: 'done' };
    },
  };
  const adapter = { snapshot: () => state, ...(options.adapter || {}) };
  const app = createApp({ config, conversationStore: store, imaWebAgentClient: pool,
    webReadiness: { mode: options.serverMode || mode, snapshot: () => ({ mode: options.serverMode || mode, generation: 4, capacity: 2, totalSlots: 2,
      schedulable: 2, eligibleAccounts: 2, totalAccounts: 2, schedulableAccounts: 2, knowledgeAgentCapacity: 2 }) },
    ...(options.disabled ? {} : options.airPolicyCapacity ? { airPolicyCapacity: {
      profileSnapshot: () => state.profile, policyCapacitySnapshot: () => state.policyCapacity,
      laneCapacitySnapshot: () => state.laneCapacity,
      pairedCapacitySnapshot: () => ({ knowledge_web_parallel: state.pairedCapacity }), features: state.features,
    } } : { botCompatibility: adapter }),
    recentContextConsumer: { async consume(ref, args) {
      consumed.push({ ref, ...args });
      if (options.consumeError) throw new Error('synthetic-private-secret');
      return options.context || context;
    } },
    observationExporter: options.observationExporter,
    healthCapabilities: options.healthCapabilities,
    qualificationMonitor: options.qualificationMonitor,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, init = {}, token = 'synthetic-internal', visitor = owner) => fetch(base + url, {
    ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
      'x-ima-client-id': visitor, ...init.headers },
  });
  const post = (url = '/internal/provider-a/deep-ask', body = {}, key = hash('synthetic-key'), init = {}, token) => request(url, {
    method: 'POST', ...init, headers: { 'Idempotency-Key': key, ...init.headers },
    body: JSON.stringify({ question: 'Synthetic original question', conversationId: cid, ...contract, ...body }),
  }, token);
  t.after(async () => { app.locals.durableQATasks?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, app, store, cid, owner, request, post, calls, consumed, routing, leases, state };
}

test('ordinary routes reject every bot field even when empty; internal validation is scoped and keyed', async t => {
  const f = await fixture(t);
  for (const url of ['/api/ask', '/api/tasks']) for (const field of FIELDS) {
    const response = await f.request(url, { method: 'POST', headers: { 'Idempotency-Key': 'ordinary-key' },
      body: JSON.stringify({ question: 'Synthetic question', conversationId: f.cid, [field]: '' }) }, 'synthetic-api');
    assert.equal(response.status, 400, `${url}:${field}`);
  }
  assert.equal((await f.post(undefined, {}, 'invalid-key')).status, 400);
  assert.equal((await f.post(undefined, { knowledge_scope_ref: hash('wrong') })).status, 403);
  assert.equal((await f.post(undefined, { knowledge_base_id: 'synthetic-raw-id' })).status, 400);
  assert.equal((await f.post(undefined, { recent_context_binding: { ...binding, extra: 'no' } })).status, 400);
  assert.equal((await f.post(undefined, { question: { text: 'Synthetic object question' } })).status, 400);
  assert.equal((await f.post(undefined, { question: 'Synthetic\u0000invalid' })).status, 400);
  assert.equal((await f.post(undefined, { parallel_pair_ref: hash('pair'), parallel_leg: 'web' })).status, 400);
  assert.equal(f.consumed.length, 0);
  assert.equal(f.calls.length, 0);
});

for (const mode of ['classic_knowledge', 'knowledge_agent']) for (const format of ['json', 'sse', 'task']) {
  test(`${mode}/${format}: admitted prompt once, actual evidence, original history and lease/mode preserved`, async t => {
    const f = await fixture(t, { mode });
    const isTask = format === 'task';
    const policy = mode === 'knowledge_agent' ? 'knowledge_agent' : 'group_knowledge';
    const response = await f.post(isTask ? '/internal/provider-a/tasks' : undefined, { retrieval_policy: policy }, undefined,
      { headers: format === 'sse' ? { Accept: 'text/event-stream' } : {} });
    assert.equal(response.status, isTask ? 202 : 200);
    let result;
    if (isTask) {
      const { task } = await response.json();
      await until(async () => (await (await f.request(`/internal/provider-a/tasks/${task.id}`)).json()).task.status === 'succeeded');
      const detail = await (await f.request(`/internal/provider-a/tasks/${task.id}`)).json();
      result = detail.snapshot.events.find(event => event.event === 'done').data;
    } else if (format === 'sse') {
      const text = await response.text();
      result = JSON.parse(/event: done\ndata: (.+)/u.exec(text)?.[1] || '{}');
      assert.doesNotMatch(text, /event: error/u);
    } else result = await response.json();
    assert.equal(f.consumed.length, 1);
    assert.deepEqual(f.consumed[0].binding, binding);
    assert.equal(f.calls.length, 1);
    const args = f.calls[0];
    assert.equal(args.question.match(/Synthetic recent evidence/gu)?.length, 1);
    assert.equal(args.question.match(/Synthetic original question/gu)?.length, 1);
    assert.equal(args.recentContext, undefined, 'client must not augment context again');
    assert.equal(args.retrievalPolicy, policy);
    assert.equal(args.accountLease, f.leases[0]);
    assert.equal(args.mode, mode);
    assert.equal(args.accountId, 'synthetic-account');
    assert.equal(args.sessionId, 'synthetic-session');
    assert.equal(f.routing.every(item => item.mode === mode && item.retrievalPolicy === policy), true);
    assert.equal(result.answer_basis, 'knowledge');
    assert.equal(result.source_count, 1);
    assert.equal(result.l0_context_count, 1);
    assert.equal(result.l0_source_count, 3);
    assert.equal(result.l0_omitted_count, 2);
    const reloaded = new ConversationStore({ storePath: f.store.storePath }).getDetail(f.cid, f.owner);
    assert.equal(reloaded.messages[0].content, 'Synthetic original question');
    assert.equal(reloaded.messages[1].l0_context_count, 1);
  });
}

test('legacy replay and changed context binding never consume or dispatch again', async t => {
  const f = await fixture(t);
  assert.equal((await f.post()).status, 200);
  const replay = await (await f.post()).json();
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.l0_context_count, 1);
  for (const field of Object.keys(binding)) {
    const value = binding[field];
    const response = await f.post(undefined, { recent_context_binding: { ...binding,
      [field]: typeof value === 'number' ? value + 1 : `${value}-different` } });
    assert.equal(response.status, 409, field);
  }
  assert.equal((await f.post(undefined, { question: 'Different original question' })).status, 409);
  assert.equal((await f.post(undefined, {}, undefined, { headers: { Accept: 'text/event-stream' } })).status, 409);
  assert.equal(f.consumed.length, 1);
  assert.equal(f.calls.length, 1);
});

test('durable replay/conflict, subscriptions and blocked policy never consume again', async t => {
  const f = await fixture(t);
  const url = '/internal/provider-a/tasks';
  const { task } = await (await f.post(url)).json();
  await until(async () => (await (await f.request(`${url}/${task.id}`)).json()).task.status === 'succeeded');
  f.state.policyCapacity.group_knowledge = 0;
  const replay = await f.post(url);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).task.id, task.id);
  assert.equal((await f.post(url, { recent_context_binding: { ...binding, route_generation: 9 } })).status, 409);
  for (let i = 0; i < 2; i++) assert.match(await (await f.request(`${url}/${task.id}/events?after=0`)).text(), /event: done/u);
  assert.equal((await f.post(url, {}, hash('different-key'))).status, 503);
  assert.equal(f.consumed.length, 1);
  assert.equal(f.calls.length, 1);
});

test('queued task cancellation happens before single-use context consumption', async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { async *stream() { await hold; yield { type: 'delta', text: 'Synthetic answer' }; yield { type: 'done' }; } });
  t.after(() => release());
  const first = await (await f.post('/internal/provider-a/tasks')).json();
  await until(() => f.calls.length === 1);
  const next = f.store.create(f.owner).conversationId;
  const { task } = await (await f.post('/internal/provider-a/tasks', { conversationId: next }, hash('queued'))).json();
  assert.equal(task.status, 'queued');
  await f.request(`/internal/provider-a/tasks/${task.id}`, { method: 'DELETE' });
  release();
  await until(() => f.app.locals.imaQaAskQueue.stats().activeRequests === 0);
  assert.equal(f.consumed.length, 1);
  assert.equal(f.calls.length, 1);
  assert.ok(first.task.id);
});

test('bot policy is enforced from actual source kinds before success/history', async t => {
  const f = await fixture(t, { sourceKind: 'web' });
  const response = await f.post();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).failureReason, 'retrieval_policy_unsatisfied');
  assert.equal(f.store.getHistory(f.cid, f.owner).length, 0);
});

test('context failure is sanitized and never dispatches upstream', async t => {
  const f = await fixture(t, { consumeError: true });
  const { task } = await (await f.post('/internal/provider-a/tasks')).json();
  let detail;
  await until(async () => { detail = await (await f.request(`/internal/provider-a/tasks/${task.id}`)).json(); return detail.task.status === 'failed'; });
  assert.equal(detail.snapshot.events.find(event => event.event === 'error').data.failureReason, 'recent_context_unavailable');
  assert.doesNotMatch(JSON.stringify(detail), /synthetic-private-secret/u);
  assert.equal(f.calls.length, 0);
});

test('v4 capacity preserves website metrics/features and unknown boolean bot capability; missing readiness fails closed', async t => {
  const f = await fixture(t);
  const response = await f.request('/internal/provider-a/capacity');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.schema_version, 'provider.a.capacity.v4');
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.generation, 9);
  assert.equal(result.maxConcurrent, 2);
  assert.equal(result.max_concurrent, 2);
  assert.equal(result.paired_capacity.knowledge_web_parallel, 1);
  assert.equal(result.features.future_bot_contract_v9, true);
  assert.equal(result.features.durable_qa_tasks_v1, true);
  delete f.state.policyCapacity.mixed;
  assert.deepEqual((await (await f.request('/internal/provider-a/capacity')).json()).policies.mixed, { ready: false, max_concurrent: 0 });
  f.state.profile.capability_digest = '';
  assert.equal((await f.request('/internal/provider-a/capacity')).status, 503);
  assert.equal((await f.request('/internal/provider-a/capacity', {}, 'synthetic-api')).status, 401);
});

test('disabled adapter rejects extra bot fields and keeps website capacity shape', async t => {
  const f = await fixture(t, { disabled: true });
  assert.equal((await f.post()).status, 400);
  const result = await (await f.request('/internal/provider-a/capacity')).json();
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.schema_version, undefined);
  assert.equal(result.features.durable_qa_tasks_v1, true);
  assert.equal(f.consumed.length, 0);
});

test('trusted application owns tasks; forged application headers cannot cross scope', async t => {
  const f = await fixture(t);
  const conversation = await (await f.request('/api/conversations', { method: 'POST' }, 'synthetic-bot-api')).json();
  const { task } = await (await f.post('/internal/provider-a/tasks', { conversationId: conversation.conversation.conversationId },
    undefined, {}, 'synthetic-bot-internal')).json();
  const url = `/internal/provider-a/tasks/${task.id}`;
  assert.equal((await f.request(url, { headers: { 'x-application-id': 'bot' } }, 'synthetic-other-internal')).status, 404);
  assert.equal((await f.request(url, {}, 'synthetic-bot-api')).status, 401);
  assert.equal((await f.request(`/api/tasks/${task.id}`, {}, 'synthetic-bot-api')).status, 404);
  assert.equal((await f.request(url, {}, 'synthetic-bot-internal')).status, 200);
});

test('source intent is appended once without changing the history or idempotency question', async t => {
  const f = await fixture(t, { mode: 'knowledge_agent' });
  const body = { retrieval_policy: 'knowledge_agent', source_intent: 'web_requested', question: 'Q'.repeat(2000) };
  const response = await f.post(undefined, body);
  assert.equal(response.status, 200);
  assert.equal(f.calls[0].question.match(/Retrieve verifiable web evidence/gu)?.length, 1);
  assert.equal(f.calls[0].question.match(/Q{2000}/gu)?.length, 1);
  assert.equal(f.store.getDetail(f.cid, f.owner).messages[0].content, body.question);
  assert.equal((await f.post(undefined, { ...body, source_intent: '' })).status, 409);
  assert.equal(f.consumed.length, 1);
});

test('queue rejection does not consume context for either durable or legacy requests', async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { queueLimit: 0, async *stream() {
    await hold; yield { type: 'delta', text: 'Synthetic answer' }; yield { type: 'done' };
  } });
  t.after(() => release());
  await f.post('/internal/provider-a/tasks');
  await until(() => f.calls.length === 1);
  const other = f.store.create(f.owner).conversationId;
  assert.equal((await f.post('/internal/provider-a/tasks', { conversationId: other }, hash('full-task'))).status, 429);
  assert.equal((await f.post(undefined, { conversationId: other }, hash('full-legacy'))).status, 429);
  assert.equal(f.consumed.length, 1);
  release();
});

test('trusted scope resolver receives authenticated application identity, not forged headers', async t => {
  const identities = [];
  const f = await fixture(t, { adapter: { resolveKnowledgeScopeRef({ applicationKey }) {
    identities.push(applicationKey); return applicationKey === 'application:bot' ? scope : hash('different-trusted-scope');
  } } });
  const response = await f.post(undefined, {}, undefined, { headers: { 'x-application-id': 'bot' } });
  assert.equal(response.status, 403);
  assert.deepEqual([...new Set(identities)], ['internal']);
  assert.equal(f.consumed.length, 0);
});

test('unknown source kinds cannot be promoted to verified bot evidence', async t => {
  const f = await fixture(t, { sourceKind: 'unverified' });
  const response = await f.post();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).failureReason, 'bot_evidence_invalid');
  assert.equal(f.store.getHistory(f.cid, f.owner).length, 0);
});

for (const task of [false, true]) test(`native-only ${task ? 'task' : 'legacy'} bypasses bot profile and preserves original intent suffix`, async t => {
  const f = await fixture(t, { mode: 'knowledge_agent' });
  f.state.profile.ready = false;
  f.state.policyCapacity.knowledge_agent = 0;
  const body = { question: 'Synthetic native question', conversationId: f.cid,
    retrieval_policy: 'knowledge_agent', knowledge_scope_ref: scope, source_intent: 'web_requested' };
  const response = await f.request(task ? '/internal/provider-a/tasks' : '/internal/provider-a/deep-ask', {
    method: 'POST', headers: { 'Idempotency-Key': 'native-website-key' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, task ? 202 : 200);
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].mode, 'knowledge_agent');
  assert.equal(f.calls[0].question, `${body.question}\n\n本轮请同时检索可验证的网页资料；若没有取得网页来源，请直接说明，不要把知识库资料称作网页来源。`);
  assert.equal(f.consumed.length, 0);
  if (task) {
    const { task: result } = await response.json();
    await until(async () => (await (await f.request(`/internal/provider-a/tasks/${result.id}`)).json()).task.status === 'succeeded');
  } else assert.equal((await response.json()).success, true);
});

test('observer receives sanitized lifecycle/protocol records and cannot break completion', async t => {
  const samples = [];
  const f = await fixture(t, { observationExporter: { sample(event) { samples.push(event); throw new Error('synthetic observer unavailable'); } },
    healthCapabilities: { existing_bot_contract: 'v7' }, qualificationMonitor: { snapshot: () => ({ ready: true }) } });
  const response = await f.post();
  assert.equal(response.status, 200);
  assert.deepEqual(samples.map(event => event.outcome), ['started', 'success']);
  assert.doesNotMatch(JSON.stringify(samples), /Synthetic|synthetic|question|group|route_ref|account_id|Bearer|token|ctx_/u);
  const health = await (await f.request('/healthz')).json();
  assert.equal(health.capabilities.existing_bot_contract, 'v7');
  assert.deepEqual(health.capabilities.recent_context_contract_versions, ['v1', 'v2']);
  assert.deepEqual(health.qualificationMonitor, { ready: true });
  assert.equal(health.policyCapacity.group_knowledge, 2);
  assert.deepEqual(health.recentContext, { enabled: true, contracts: ['v1', 'v2'] });
  assert.equal(health.knowledge_agent_qualification, undefined);
  f.app.locals.knowledgeAgentQualificationManager = { synthetic: true };
  const qualified = await (await f.request('/healthz')).json();
  assert.equal(qualified.capabilities.knowledge_agent_qualification, 'v1');
  assert.equal(qualified.knowledge_agent_qualification, 'v1');
});

test('protocol failure keeps live observer event shape without leaking raw upstream data', async t => {
  const samples = [];
  const f = await fixture(t, { observationExporter: { sample: event => samples.push(event) },
    async *stream() { yield { type: 'delta', text: 'Synthetic unfinished answer' }; } });
  assert.equal((await f.post()).status, 500);
  assert.deepEqual(samples.at(-1), { component: 'provider_a_protocol', stage: 'upstream_stream',
    category: 'upstream_terminal_missing', outcome: 'failure', evidenceClass: 'observed' });
});

for (const policy of ['knowledge_agent', 'group_knowledge', 'auto', 'web', 'mixed']) {
  test(`native server creates ${policy} bot conversation in its correct mode`, async t => {
    const kinds = policy === 'web' ? ['web'] : policy === 'mixed' ? ['knowledge', 'web'] : ['knowledge'];
    const f = await fixture(t, { serverMode: 'knowledge_agent', async *stream(args) {
      const answerProfile = ['knowledge_agent', 'group_knowledge'].includes(policy) ? 'classic_knowledge' : 'ima_agent_auto';
      args.onSession('synthetic-created-session', { answerProfile });
      yield { type: 'sources', answerProfile, sourceKinds: kinds, sources: kinds.map(kind => ({ title: `Synthetic ${kind}`, snippet: 'Synthetic source' })) };
      yield { type: 'delta', answerProfile, text: 'Synthetic answer' };
      yield { type: 'done', answerProfile };
    } });
    const response = await f.post(undefined, { conversationId: '', retrieval_policy: policy,
      recent_context_ref: null, recent_context_binding: null });
    assert.equal(response.status, 200);
    const body = await response.json();
    const mode = policy === 'knowledge_agent' ? 'knowledge_agent' : 'classic_knowledge';
    assert.equal(f.calls[0].mode, mode);
    assert.equal(f.store.require(body.conversationId, f.owner).mode, mode);
    assert.equal(f.consumed.length, 0);
    assert.equal(body.answer_basis, policy === 'web' ? 'web' : policy === 'mixed' ? 'mixed' : 'knowledge');
    assert.equal(f.store.getUpstream(body.conversationId, f.owner).sessionAnswerProfile,
      policy === 'knowledge_agent' || policy === 'group_knowledge' ? 'classic_knowledge' : 'ima_agent_auto');
  });
}

test('bound bot conversation mode mismatch returns 409 without consuming, resetting or dispatching', async t => {
  const f = await fixture(t, { mode: 'knowledge_agent' });
  for (const route of ['/internal/provider-a/deep-ask', '/internal/provider-a/tasks']) {
    assert.equal((await f.post(route)).status, 409);
  }
  assert.equal(f.consumed.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.getUpstream(f.cid, f.owner).sessionId, 'synthetic-session');
  assert.equal(f.store.require(f.cid, f.owner).mode, 'knowledge_agent');
});

test('actual answerProfile carried on ordinary events determines general-answer evidence', async t => {
  const f = await fixture(t, { async *stream(args) {
    yield { type: 'delta', text: 'Synthetic general answer', answerProfile: 'ima_agent_auto' };
    yield { type: 'done', answerProfile: 'ima_agent_auto' };
  } });
  const response = await f.post(undefined, { retrieval_policy: 'auto', recent_context_ref: null, recent_context_binding: null });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).answer_basis, 'agent_general');
  assert.equal(f.store.getUpstream(f.cid, f.owner).sessionAnswerProfile, 'ima_agent_auto');
});

test('Air startup policy adapter mounts v4 capacity with stable changing generation', async t => {
  const f = await fixture(t, { airPolicyCapacity: true });
  const get = async () => (await f.request('/internal/provider-a/capacity')).json();
  const before = await get();
  assert.equal(before.schema_version, 'provider.a.capacity.v4');
  assert.equal(before.generation, (await get()).generation);
  assert.equal(before.features.future_bot_contract_v9, true);
  f.state.policyCapacity.web = 0;
  const after = await get();
  assert.equal(after.generation, before.generation + 1);
  assert.equal(after.policies.web.ready, false);
});

test('session profile conflict is explicit before consume and never resets upstream binding', async t => {
  const f = await fixture(t);
  f.store.setUpstream(f.cid, { accountId: 'synthetic-account', sessionId: 'synthetic-session',
    sessionAnswerProfile: 'ima_agent_auto' }, f.owner);
  const response = await f.post();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).failureReason, 'session_profile_conflict');
  assert.equal(f.consumed.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.getUpstream(f.cid, f.owner).sessionAnswerProfile, 'ima_agent_auto');
});

for (const mode of ['classic_knowledge', 'knowledge_agent']) {
  test(`${mode}: completion journal recovers exact raw answer, L0 evidence and observed profile once`, async t => {
    const raw = `  Synthetic answer\n${'word '.repeat(2000)}\n\n`;
    const f = await fixture(t, { mode, async *stream(args) {
      args.onSession('synthetic-session', { answerProfile: 'classic_knowledge' });
      yield { type: 'delta', text: raw, answerProfile: 'classic_knowledge' };
      yield { type: 'done', answerProfile: 'classic_knowledge' };
    } });
    f.store.appendTaskTurn = () => { throw new Error('synthetic history write fault'); };
    const response = await f.post('/internal/provider-a/tasks', { retrieval_policy: mode === 'knowledge_agent' ? 'knowledge_agent' : 'group_knowledge' });
    assert.equal(response.status, 202);
    const { task } = await response.json();
    await until(() => !f.app.locals.durableQATasks.available);
    const directory = f.app.locals.durableQATasks.store.directory;
    const saved = JSON.parse(fs.readFileSync(path.join(directory, `${task.id}.json`)));
    assert.equal(saved.completion.upstream.sessionAnswerProfile, 'classic_knowledge');
    assert.equal(saved.completion.answer, raw);
    f.app.locals.durableQATasks.close();
    for (let restart = 0; restart < 2; restart++) {
      const history = new ConversationStore({ storePath: f.store.storePath });
      const recovered = new DurableQATasks({ directory, conversations: history, queue: createAskQueue({}),
        execute: () => assert.fail('completed task must never dispatch again') });
      try {
        assert.equal(recovered.store.tasks.get(task.id).status, 'succeeded');
        const messages = history.getDetail(f.cid, f.owner).messages;
        assert.equal(messages.length, 2);
        assert.equal(messages[1].content, raw);
        for (const [key, value] of Object.entries(saved.completion.done)) if (key.startsWith('l0_')) assert.equal(messages[1][key], value, key);
        assert.equal(history.getUpstream(f.cid, f.owner).sessionAnswerProfile, 'classic_knowledge');
        assert.equal(history.require(f.cid, f.owner).mode, mode);
      } finally { recovered.close(); }
    }
    assert.equal(f.consumed.length, 1);
    assert.equal(f.calls.length, 1);
  });
}

test('old history remains profile-free; invalid L0 bundles and unknown profiles are not invented on reload', async t => {
  const f = await fixture(t);
  f.store.appendTurn(f.cid, 'Synthetic old question', 'Synthetic old answer', { answer_basis: 'knowledge', source_count: 0,
    l0_context_count: 2, l0_source_count: 1, l0_snapshot_count: 1, l0_injected_count: 2,
    l0_omitted_count: -1, l0_truncation_reason: 'none' }, f.owner);
  f.store.setUpstream(f.cid, { accountId: 'synthetic-account', sessionId: 'synthetic-session', sessionAnswerProfile: 'unverified' }, f.owner);
  const history = new ConversationStore({ storePath: f.store.storePath });
  assert.equal(history.getUpstream(f.cid, f.owner).sessionAnswerProfile, undefined);
  assert.equal(history.getDetail(f.cid, f.owner).messages[1].l0_context_count, undefined);
  assert.equal(history.getDetail(f.cid, f.owner).messages[1].answer_basis, 'knowledge');
});

test('intent suffix shares the prompt budget and L0 counters describe only complete injected messages', async t => {
  const messages = Array.from({ length: 256 }, (_, i) => ({ sender_display_name: 'Synthetic speaker', text: `${i}: ${'x'.repeat(100)}` }));
  const f = await fixture(t, { mode: 'knowledge_agent', context: { ...context, messages, sourceMessageCount: 300 } });
  const response = await f.post(undefined, { retrieval_policy: 'knowledge_agent', source_intent: 'web_requested', question: 'Q'.repeat(2000) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(Array.from(f.calls[0].question).length <= 18000);
  assert.equal(result.l0_source_count, 300);
  assert.equal(result.l0_snapshot_count, 256);
  assert.equal(result.l0_truncation_reason, 'prompt_budget');
  assert.equal(result.l0_injected_count, f.calls[0].question.match(/Synthetic speaker:/gu).length);
  assert.equal(result.l0_omitted_count, 300 - result.l0_injected_count);
  assert.equal(f.store.getDetail(f.cid, f.owner).messages[1].l0_source_count, 300);
});
