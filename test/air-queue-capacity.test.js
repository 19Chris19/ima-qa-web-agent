const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { AirPolicyCapacity } = require('../src/air/policy-capacity');
const { AirWebReadiness } = require('../src/air/web-readiness');
const { createAskQueue } = require('../src/ask-queue');
const { synchronizeProviderAQueueCapacity, providerAExecutionCapacity } = require('../src/provider-a-capacity');
const { answerProfileContractDigest } = require('../src/ima-answer-profile');
const { knowledgeAgentContractDigest } = require('../src/ima-knowledge-agent-contract');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const nativeProof = { contract: knowledgeAgentContractDigest(), principalFingerprint: hash('synthetic-principal'),
  scope: hash('synthetic-kb'), requests: 1, terminals: 1 };
const proof = policy => ({ answerBasis: policy === 'group_knowledge' ? 'knowledge' : policy === 'web' ? 'web' : 'mixed',
  capabilityDigest: answerProfileContractDigest(policy === 'group_knowledge' ? 'classic_knowledge' : 'ima_agent_auto') });
function fixture(rows, { mode = 'knowledge_agent', air = true, autoScale = true } = {}) {
  const accounts = rows.map(row => ({ knowledgeBaseId: 'synthetic-kb', principalFingerprint: hash('synthetic-principal'),
    maxConcurrent: 1, headers: {}, ...row }));
  const state = { generation: 1, settings: { webMode: mode } };
  const directory = { load: () => state, getPoolAccounts: () => accounts,
    getAccount: id => ({ ...accounts.find(row => row.id === id), runtime: {} }),
    listAccounts: () => accounts.map(row => ({ id: row.id, health: {} })) };
  let policies;
  const calls = [];
  const pool = new IMAWebAgentPool({ accounts }, { now: () => 1000,
    policyEligibility: (row, options) => policies.eligible(policies.accounts().find(a => a.id === row.id), options.retrievalPolicy),
    clientFactory: account => ({ async *streamAsk(options) { calls.push({ id: account.id, policy: options.retrievalPolicy });
      yield { type: 'delta', text: 'Synthetic answer' }; yield { type: 'done' }; } }),
  });
  policies = new AirPolicyCapacity({ directory, pool, now: () => 1000, profile: 'ima_agent_auto',
    capabilityDigest: answerProfileContractDigest('ima_agent_auto') });
  const webReadiness = new AirWebReadiness({ directory, pool, policies });
  const askQueue = createAskQueue({ maxConcurrent: 9, queueLimit: 10 });
  const sync = () => synchronizeProviderAQueueCapacity({ askQueue, pool, webReadiness,
    ...(air ? { airPolicyCapacity: policies } : {}), config: { concurrency: { autoScaleWithAccounts: autoScale } } });
  return { accounts, state, pool, policies, webReadiness, askQueue, sync, calls };
}

test('native website with classic-only bot accounts keeps their real shared slots runnable', async () => {
  const f = fixture([{ id: 'classic', maxConcurrent: 3, retrievalPolicyQualifications: { group_knowledge: proof('group_knowledge') } }]);
  assert.equal(f.webReadiness.snapshot().capacity, 0);
  assert.equal(f.policies.policyCapacitySnapshot().group_knowledge, 3);
  assert.equal(providerAExecutionCapacity({ pool: f.pool, webReadiness: f.webReadiness, airPolicyCapacity: f.policies }), 3);
  f.sync();
  assert.equal(f.askQueue.stats().maxConcurrent, 3);
  const controller = new AbortController();
  const options = { retrievalPolicy: 'group_knowledge', mode: 'classic_knowledge', signal: controller.signal };
  const events = await f.askQueue.run(async accountLease => {
    const result = [];
    for await (const event of f.pool.streamAsk({ ...options, accountLease, question: 'Synthetic question' })) result.push(event.type);
    return result;
  }, { signal: controller.signal, applicationKey: 'application:synthetic-bot', visitorKey: 'synthetic-owner', laneKey: 'synthetic-conversation',
    isRunnable: () => f.pool.canAcquireSlot(options), tryAcquire: () => f.pool.tryAcquireSlot(options) });
  assert.ok(events.includes('done'));
  assert.deepEqual(f.calls, [{ id: 'classic', policy: 'group_knowledge' }]);
  assert.equal(f.pool.stats().activeRequests, 0);
});

test('policy union deduplicates overlapping native/classic/web accounts and retains busy slots', () => {
  const f = fixture([
    { id: 'overlap', maxConcurrent: 3, webQualification: nativeProof,
      retrievalPolicyQualifications: { group_knowledge: proof('group_knowledge'), web: proof('web'), mixed: proof('mixed') } },
    { id: 'web-only', maxConcurrent: 2, retrievalPolicyQualifications: { web: proof('web') } },
    { id: 'unqualified', maxConcurrent: 7 },
  ]);
  f.pool.accounts[0].activeRequests = 3;
  f.sync();
  assert.equal(f.askQueue.stats().maxConcurrent, 5);
  assert.equal(f.webReadiness.snapshot().capacity, 3);
  assert.equal(f.webReadiness.snapshot().schedulable, 0);
  f.pool.accounts[1].cooldownUntil = 2000; f.sync(); assert.equal(f.askQueue.stats().maxConcurrent, 3);
  f.pool.accounts[0].maintenanceOperation = 'qualification'; f.sync(); assert.equal(f.askQueue.stats().maxConcurrent, 0);
  f.pool.accounts[1].cooldownUntil = 0; f.pool.accounts[1].disabled = true; f.sync(); assert.equal(f.askQueue.stats().maxConcurrent, 0);
  f.pool.accounts[1].disabled = false; f.sync(); assert.equal(f.askQueue.stats().maxConcurrent, 2);
});

test('live proof, routing lane and slot updates change the union without inventing native eligibility', () => {
  const f = fixture([{ id: 'bot', maxConcurrent: 4, retrievalPolicyQualifications: { web: proof('web') } }]);
  f.sync(); assert.equal(f.askQueue.stats().maxConcurrent, 4);
  f.accounts[0].routingLane = 'knowledge'; f.sync(); assert.equal(f.askQueue.stats().maxConcurrent, 0);
  f.accounts[0].routingLane = 'agent'; f.sync(); assert.equal(f.askQueue.stats().maxConcurrent, 4);
  f.accounts[0].retrievalPolicyQualifications = {}; f.sync(); assert.equal(f.askQueue.stats().maxConcurrent, 0);
  f.accounts[0].retrievalPolicyQualifications = { web: proof('web') };
  f.accounts[0].maxConcurrent = 2; f.pool.syncAccounts(f.accounts); f.sync();
  assert.equal(f.askQueue.stats().maxConcurrent, 2);
  assert.equal(f.webReadiness.snapshot().knowledgeAgentCapacity, 0);
});

test('public non-Air retains native-only ceiling and fixed concurrency is untouched', () => {
  const rows = [{ id: 'bot', maxConcurrent: 3, retrievalPolicyQualifications: { group_knowledge: proof('group_knowledge') } }];
  const publicOnly = fixture(rows, { air: false }); publicOnly.sync();
  assert.equal(publicOnly.askQueue.stats().maxConcurrent, 0);
  publicOnly.accounts[0].webQualification = nativeProof;
  publicOnly.pool.syncAccounts(publicOnly.accounts); publicOnly.sync();
  assert.equal(publicOnly.askQueue.stats().maxConcurrent, 3);
  const fixed = fixture(rows, { autoScale: false }); fixed.sync();
  assert.equal(fixed.askQueue.stats().maxConcurrent, 9);
});

test('Air classic website route retains its existing operational slots without bot proof', () => {
  const f = fixture([{ id: 'classic-website', maxConcurrent: 2 }], { mode: 'classic_knowledge' });
  assert.equal(f.policies.policyCapacitySnapshot().knowledge_agent, 0);
  f.sync(); assert.equal(f.askQueue.stats().maxConcurrent, 2);
});

test('blocking auto profile removes only its accounts, not independent native and classic slots', () => {
  const f = fixture([
    { id: 'native', maxConcurrent: 2, webQualification: nativeProof },
    { id: 'classic', maxConcurrent: 3, retrievalPolicyQualifications: { group_knowledge: proof('group_knowledge') } },
    { id: 'auto', maxConcurrent: 4, retrievalPolicyQualifications: { web: proof('web') } },
  ]);
  f.sync(); assert.equal(f.askQueue.stats().maxConcurrent, 9);
  f.policies.profileController.block();
  f.sync(); assert.equal(f.askQueue.stats().maxConcurrent, 5);
});
