'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { ElasticAccountScheduler, normalizeElasticScheduling } = require('../src/elastic-account-scheduler');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { createAskQueue } = require('../src/ask-queue');
const { synchronizeProviderAQueueCapacity, providerAExecutionCapacity } = require('../src/provider-a-capacity');
const { getConfig } = require('../src/config');
const fingerprint = 'a'.repeat(64);
const descriptor = { accountId: 'fixture', principalFingerprint: fingerprint, mode: 'classic_knowledge', modelId: 'fixture-model', modelType: 3 };

const tick = () => new Promise(resolve => setImmediate(resolve));
async function collect(stream) { const events = []; for await (const event of stream) events.push(event); return events; }
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
class Clock {
  time = 1000;
  timers = new Map();
  id = 0;
  now = () => this.time;
  setTimeout = (fn, delay) => { const id = ++this.id; this.timers.set(id, { fn, at: this.time + delay }); return id; };
  clearTimeout = id => this.timers.delete(id);
  async advance(ms) {
    const end = this.time + ms;
    for (let count = 0; count < 10000; count++) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); await tick();
      if (count === 9999) assert.fail('timer spin');
    }
    this.time = end; await tick();
  }
}
function harness(overrides = {}, count = 1) {
  const clock = new Clock(); const calls = []; const hold = gate();
  const accounts = Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, maxConcurrent: 1, principalFingerprint: fingerprint, modelId: 'fixture-model', modelType: 3 }));
  const pool = new IMAWebAgentPool({ accounts, elasticScheduling: { enabled: true, initialConcurrent: 5, accountLimits: accounts.flatMap(account => ['classic_knowledge', 'knowledge_agent'].map(mode => ({ accountId: account.id, principalFingerprint: fingerprint, mode, modelId: 'fixture-model', modelType: 3, validatedMaxConcurrent: 20, initialConcurrent: overrides.initialConcurrent || 5 }))), ...overrides } }, {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    clientFactory: account => ({ async *streamAsk(options) {
      calls.push({ account: account.id, session: options.sessionId, at: clock.now() });
      yield { type: 'delta', text: options.sessionId || 'fixture' };
      await hold.promise; yield { type: 'done' };
    } }),
  });
  return { clock, calls, hold, pool, accounts };
}

test('opt-in validates hard ceilings, integer bounds, and default legacy behavior', () => {
  assert.equal(normalizeElasticScheduling().enabled, false);
  assert.equal(normalizeElasticScheduling().maxPerAccount, 20);
  assert.equal(normalizeElasticScheduling().maxGlobal, 100);
  for (const config of [{ maxPerAccount: 21 }, { maxGlobal: 101 }, { initialConcurrent: 21 },
    { initialConcurrent: 6, maxPerAccount: 5 }, { minStartSpacingMs: 0 }, { maxWaiters: 0 },
    { maxWaitMs: 0 }, { growthIntervalMs: NaN }, { enabled: 'true' }]) {
    assert.throws(() => normalizeElasticScheduling(config));
  }
  const env = { IMA_QA_PROVIDER: 'ima-web-agent', IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID: '123' };
  assert.equal(getConfig(env).webAgent.elasticScheduling.enabled, false);
  assert.equal(getConfig({ ...env, IMA_QA_ELASTIC_ENABLED: 'true', IMA_QA_ELASTIC_MAX_GLOBAL: '70' }).webAgent.elasticScheduling.maxGlobal, 70);
  assert.throws(() => getConfig({ ...env, IMA_QA_ELASTIC_MAX_GLOBAL: '101' }));
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'legacy', maxConcurrent: 7 }] }, { clientFactory: () => ({}) });
  assert.equal(pool.stats().capacity, 7); assert.equal(pool.elastic, null);
});

test('one account has five distinct live sessions with paced starts and one wake timer', async () => {
  const h = harness(); const work = [];
  for (let i = 0; i < 5; i++) work.push(collect(h.pool.streamAsk({ sessionId: `s${i}` })));
  await tick(); assert.equal(h.calls.length, 1);
  for (let i = 1; i < 5; i++) {
    await h.clock.advance(2999); assert.equal(h.calls.length, i);
    await h.clock.advance(1); assert.equal(h.calls.length, i + 1);
    assert.ok(h.clock.timers.size <= 5, 'one availability timer plus bounded wait deadlines');
  }
  assert.equal(h.pool.stats().activeRequests, 5);
  assert.equal(new Set(h.calls.map(call => call.session)).size, 5);
  assert.deepEqual(h.calls.map(call => call.at), [1000, 4000, 7000, 10000, 13000]);
  h.hold.resolve(); await Promise.all(work); h.pool.closeScheduling();
  assert.equal(h.pool.stats().activeRequests, 0); assert.equal(h.clock.timers.size, 0);
});

test('explicit trial runs five paced sessions without claiming acceptance or leaking to other scopes', async () => {
  const account = { id: 'trial', principalFingerprint: fingerprint, modelId: 'fixture-model', modelType: 3 };
  const row = { accountId: account.id, principalFingerprint: fingerprint, mode: 'knowledge_agent', modelId: 'fixture-model', modelType: 3, maxConcurrent: 5, initialConcurrent: 5 };
  const clock = new Clock(), calls = [], hold = gate();
  const pool = new IMAWebAgentPool({ accounts: [account], elasticScheduling: { enabled: true, maxPerAccount: 5, maxGlobal: 25, trialLimits: [row] } }, {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    clientFactory: () => ({ async *streamAsk(options) { calls.push({ at: clock.now(), session: options.sessionId }); yield { type: 'delta', text: 'fixture' }; await hold.promise; yield { type: 'done' }; } }),
  });
  const work = [];
  for (let i = 0; i < 5; i++) work.push(collect(pool.streamAsk({ mode: 'knowledge_agent', sessionId: `trial-${i}` })));
  await tick(); for (let i = 1; i < 5; i++) await clock.advance(3000);
  assert.equal(pool.accounts[0].activeRequests, 5);
  assert.deepEqual(calls.map(row => row.at), [1000, 4000, 7000, 10000, 13000]);
  const state = pool.elastic.snapshot(pool.accounts[0], { ...row });
  assert.equal(state.limitBasis, 'operator_trial'); assert.equal(state.configuredMaxConcurrent, 5);
  assert.equal(state.validatedMaxConcurrent, 1); assert.equal(pool.elastic.config.accountLimits.length, 0);
  assert.equal(pool.accountCapacity(pool.accounts[0], { mode: 'classic_knowledge' }), 1);
  pool.elastic.congestion(pool.accounts[0]); assert.equal(pool.accountCapacity(pool.accounts[0], { mode: 'knowledge_agent' }), 2);
  assert.equal(pool.elastic.canStart(pool.accounts[0]), false);
  hold.resolve(); await Promise.all(work); pool.closeScheduling(); assert.equal(clock.timers.size, 0);
  const scheduler = new ElasticAccountScheduler({ enabled: true, trialLimits: [row] }); scheduler.sync([account]);
  assert.equal(scheduler.ceiling(account, { ...row, modelId: 'changed-model' }), 1);
  assert.equal(scheduler.ceiling(account, { ...row, principalFingerprint: 'b'.repeat(64) }), 1);
  assert.equal(scheduler.ceiling({ ...account, id: 'other' }, row), 1);
  assert.throws(() => normalizeElasticScheduling({ trialLimits: [{ ...row, maxConcurrent: 6 }] }));
  assert.throws(() => normalizeElasticScheduling({ trialLimits: [{ ...row, validatedMaxConcurrent: 5 }] }));
  assert.throws(() => normalizeElasticScheduling({ trialLimits: [row], accountLimits: [{ ...descriptor, accountId: 'trial', mode: 'knowledge_agent', validatedMaxConcurrent: 5 }] }));
  assert.equal(getConfig({ IMA_QA_PROVIDER: 'ima-web-agent', IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID: '123',
    IMA_QA_ELASTIC_TRIAL_LIMITS_JSON: JSON.stringify([row]) }).webAgent.elasticScheduling.trialLimits[0].maxConcurrent, 5);
});

test('existing account-store base64url principal fingerprints match exactly without rewriting identity', () => {
  const { createHmac } = require('node:crypto');
  const principalFingerprint = createHmac('sha256', 'synthetic-only-key').update('synthetic-only-principal').digest('base64url');
  const row = { ...descriptor, principalFingerprint, maxConcurrent: 5, initialConcurrent: 5 };
  const scheduler = new ElasticAccountScheduler({ enabled: true, trialLimits: [row] });
  const account = { id: descriptor.accountId, principalFingerprint, modelId: descriptor.modelId, modelType: descriptor.modelType };
  scheduler.sync([account]); assert.equal(scheduler.ceiling(account, row), 5);
  assert.equal(scheduler.config.trialLimits[0].principalFingerprint, principalFingerprint);
  assert.equal(scheduler.ceiling(account, { ...row, principalFingerprint: principalFingerprint.toLowerCase() }), 1);
  assert.throws(() => normalizeElasticScheduling({ trialLimits: [{ ...row, principalFingerprint: 'a'.repeat(43) }] }));
  assert.throws(() => normalizeElasticScheduling({ trialLimits: [{ ...row, principalFingerprint: principalFingerprint + '=' }] }));
});

test('one session is serialized by the pool, another can execute concurrently', async () => {
  const h = harness();
  const one = collect(h.pool.streamAsk({ accountId: 'fixture-0', sessionId: 'same' }));
  await tick(); await h.clock.advance(3000);
  const two = collect(h.pool.streamAsk({ accountId: 'fixture-0', sessionId: 'same' }));
  const other = collect(h.pool.streamAsk({ accountId: 'fixture-0', sessionId: 'other' }));
  await tick(); assert.deepEqual(h.calls.map(call => call.session), ['same', 'other']);
  h.hold.resolve(); await tick(); await h.clock.advance(3000);
  await Promise.all([one, two, other]); assert.equal(h.calls.length, 3);
  assert.equal(h.pool.activeSessions.size, 0); h.pool.closeScheduling();
});

test('five accounts can reach 100 mock slots, never 101, without a shared start-rate burst', async () => {
  const h = harness({ initialConcurrent: 20 }, 5); const leases = [];
  for (let wave = 0; wave < 20; wave++) {
    for (let account = 0; account < 5; account++) {
      const lease = h.pool.tryAcquireSlot({ accountId: `fixture-${account}`, sessionId: `w${wave}` });
      assert.ok(lease); leases.push(lease);
    }
    if (wave < 19) await h.clock.advance(3000);
  }
  assert.equal(h.pool.stats().activeRequests, 100); assert.equal(h.pool.stats().capacity, 100);
  assert.equal(h.pool.tryAcquireSlot({ sessionId: 'overflow' }), null);
  assert.ok(h.pool.accounts.every(account => account.activeRequests === 20));
  for (const lease of leases) lease.release(); h.pool.closeScheduling();
});

test('a lower global cap applies even when there are more accounts and free per-account slots', async () => {
  const h = harness({ initialConcurrent: 20, maxGlobal: 7 }, 6); const leases = [];
  for (let i = 0; i < 6; i++) leases.push(h.pool.tryAcquireSlot({ accountId: `fixture-${i}` }));
  await h.clock.advance(3000); leases.push(h.pool.tryAcquireSlot({}));
  assert.equal(h.pool.tryAcquireSlot({}), null);
  assert.equal(h.pool.stats().availableSlots, 0); assert.equal(h.pool.stats().capacity, 7);
  assert.equal(providerAExecutionCapacity({ pool: h.pool }), 7);
  for (const lease of leases) lease.release(); h.pool.closeScheduling();
});

test('capacity grows only after healthy saturated demand, by one, to at most 20', () => {
  let now = 0; const account = { id: 'fixture', activeRequests: 1, ...descriptor }; account.id = 'fixture';
  const scheduler = new ElasticAccountScheduler({ enabled: true, successesToGrow: 2, growthIntervalMs: 100, accountLimits: [{ ...descriptor, initialConcurrent: 1, validatedMaxConcurrent: 20 }] }, () => now);
  scheduler.sync([account]); now = 100;
  for (let i = 0; i < 10; i++) scheduler.success(account, scheduler.reserve(account, descriptor));
  assert.equal(scheduler.capacity(account, descriptor), 1, 'serial success alone is not unmet demand');
  for (let target = 2; target <= 21; target++) {
    now += 100; account.activeRequests = scheduler.capacity(account, descriptor); scheduler.markDemand(account);
    scheduler.success(account, scheduler.reserve(account, descriptor)); scheduler.success(account, scheduler.reserve(account, descriptor));
    assert.equal(scheduler.capacity(account, descriptor), Math.min(20, target));
  }
});

test('congestion halves only its own window, increases pacing/backoff, and stale success cannot undo it', async () => {
  const h = harness({ initialConcurrent: 8 }, 2); const account = h.pool.accounts[0];
  const lease = h.pool.tryAcquireSlot({ accountId: account.id });
  const ticket = h.pool.taskLeases.get(lease.value).elasticTicket;
  const error = Object.assign(new Error('upstream_quota'), { code: 'upstream_quota' });
  h.pool._markFailure(account, error);
  assert.equal(h.pool.accountCapacity(account), 4); assert.equal(account.disabled, false);
  assert.equal(h.pool.elastic.snapshot(account).startSpacingMs, 6000);
  const blockedUntil = h.pool.elastic.state(account).nextStartAt;
  h.pool._markSuccess(account, ticket);
  assert.equal(h.pool.elastic.state(account).nextStartAt, blockedUntil);
  assert.equal(account.consecutiveErrors, 1);
  assert.equal(h.pool.accountCapacity(h.pool.accounts[1]), 8);
  assert.equal(h.pool.canAcquireSlot({ accountId: account.id }), false);
  await h.clock.advance(15000); assert.equal(h.pool.canAcquireSlot({ accountId: account.id }), true);
  for (let i = 0; i < 20; i++) h.pool._markFailure(account, error);
  assert.equal(h.pool.accountCapacity(account), 1);
  assert.equal(h.pool.elastic.snapshot(account).startSpacingMs, 30000);
  assert.equal(h.pool.elastic.snapshot(account).nextStartInMs, 120000);
  assert.equal(account.disabled, false); lease.release(); h.pool.closeScheduling();
});

test('temporary upstream errors back off; explicit auth failure still isolates the account', () => {
  const h = harness(); const account = h.pool.accounts[0];
  h.pool._markFailure(account, Object.assign(new Error('upstream_temporary'), { code: 'upstream_temporary', completionCode: 3 }));
  assert.equal(h.pool.accountCapacity(account), 2); assert.equal(account.disabled, false);
  h.pool._markFailure(account, Object.assign(new Error('upstream_auth'), { code: 'upstream_auth' }));
  assert.equal(account.disabled, true); h.pool.closeScheduling();
});

test('shrinking below active count preserves in-flight streams and does not replay failure', async () => {
  const h = harness({ minStartSpacingMs: 1 }); const jobs = [];
  for (let i = 0; i < 5; i++) { jobs.push(collect(h.pool.streamAsk({ sessionId: `s${i}` }))); await h.clock.advance(1); }
  assert.equal(h.calls.length, 5);
  h.pool._markFailure(h.pool.accounts[0], new Error('HTTP 429'));
  assert.equal(h.pool.accountCapacity(h.pool.accounts[0]), 2); assert.equal(h.pool.stats().activeRequests, 5);
  h.hold.resolve(); const result = await Promise.all(jobs);
  assert.equal(result.length, 5); assert.equal(h.calls.length, 5);
  assert.equal(h.pool.accountCapacity(h.pool.accounts[0]), 2); h.pool.closeScheduling();
});

test('bounded direct waiting handles cancellation, timeout, and shutdown without dispatch or leaks', async () => {
  const h = harness({ maxWaiters: 1, maxWaitMs: 100 });
  const first = h.pool.tryAcquireSlot({ sessionId: 'held' });
  const aborter = new AbortController();
  const cancelled = collect(h.pool.streamAsk({ sessionId: 'cancel', signal: aborter.signal }));
  await assert.rejects(collect(h.pool.streamAsk({ sessionId: 'overflow' })), { code: 'account_wait_queue_full' });
  const rejected = assert.rejects(cancelled, /request_aborted/); aborter.abort(); await rejected;
  const timed = assert.rejects(collect(h.pool.streamAsk({ sessionId: 'timeout' })), { code: 'account_wait_timeout' });
  await h.clock.advance(100); await timed;
  const closed = assert.rejects(collect(h.pool.streamAsk({ sessionId: 'closed' })), /停止/);
  h.pool.closeScheduling(); await closed; first.release();
  assert.equal(h.pool.slotWaiters, 0); assert.equal(h.pool.cancelSlotWaiters.size, 0);
  assert.equal(h.clock.timers.size, 0); assert.equal(h.calls.length, 0);
});

test('sync preserves learned limits, removes departed state; credential replacement resets learning', () => {
  const h = harness(); const account = h.pool.accounts[0];
  h.pool._markFailure(account, new Error('HTTP 429'));
  h.pool.syncAccounts(h.accounts); assert.equal(h.pool.accountCapacity(account), 2);
  const stale = h.pool.elastic.reserve(account);
  h.pool.withCredentialReplacement(account.id, () => {});
  assert.equal(h.pool.accountCapacity(account), 5);
  assert.equal(h.pool.elastic.success(account, stale), false);
  h.pool.syncAccounts([]); assert.equal(h.pool.elastic.states.size, 0); h.pool.closeScheduling();
});

test('fair durable queue wakes after pacing, serializes session lanes, and rejects overflow', async () => {
  const h = harness({ minStartSpacingMs: 100 }); const queue = createAskQueue({ maxConcurrent: 5, queueLimit: 2 });
  const unsubscribe = h.pool.onAvailability(() => queue.wake());
  const run = (session, signal) => queue.run(lease => collect(h.pool.streamAsk({ sessionId: session, accountLease: lease })), {
    applicationKey: 'app', visitorKey: 'visitor', laneKey: session, signal,
    isRunnable: () => h.pool.canAcquireSlot({ sessionId: session }),
    tryAcquire: () => h.pool.tryAcquireSlot({ sessionId: session }),
  });
  const first = run('one'); const same = run('one'); const other = run('two');
  await assert.rejects(run('overflow'), /当前访问人数/); await tick();
  await h.clock.advance(100); assert.deepEqual(h.calls.map(call => call.session), ['one', 'two']);
  h.hold.resolve(); await tick(); await h.clock.advance(100); await Promise.all([first, same, other]);
  await tick(); assert.equal(queue.stats().activeRequests, 0); assert.equal(queue.stats().queuedRequests, 0);
  const askQueue = createAskQueue({ maxConcurrent: 1 });
  synchronizeProviderAQueueCapacity({ askQueue, pool: h.pool, config: { concurrency: { autoScaleWithAccounts: true } } });
  assert.equal(askQueue.stats().maxConcurrent, 5);
  h.pool._markFailure(h.pool.accounts[0], new Error('HTTP 429'));
  synchronizeProviderAQueueCapacity({ askQueue, pool: h.pool, config: { concurrency: { autoScaleWithAccounts: true } } });
  assert.equal(askQueue.stats().maxConcurrent, 2); unsubscribe(); h.pool.closeScheduling();
});

test('reservation pacing is atomic even when a synchronous observer attempts reentry', () => {
  const h = harness(); let nested; let reentry = false;
  h.pool.onAccountStateChange = () => {
    if (!reentry) { reentry = true; nested = h.pool.tryAcquireSlot({ sessionId: 'nested' }); }
  };
  const lease = h.pool.tryAcquireSlot({ sessionId: 'first' });
  assert.ok(lease); assert.equal(nested, null); assert.equal(h.pool.stats().activeRequests, 1);
  lease.release(); h.pool.closeScheduling();
});

test('cold wait wakes without polling; real authentication failure is not erased by another old success', async () => {
  const h = harness(); const account = h.pool.accounts[0];
  account.cooldownUntil = h.clock.now() + 4000;
  const work = collect(h.pool.streamAsk({ accountId: account.id, sessionId: 'cold' }));
  await h.clock.advance(3999); assert.equal(h.calls.length, 0);
  await h.clock.advance(1); assert.equal(h.calls.length, 1);
  const ticket = h.pool.elastic.reserve(account);
  h.pool._markFailure(account, Object.assign(new Error('upstream_auth'), { code: 'upstream_auth' }));
  h.pool._markSuccess(account, ticket);
  assert.equal(account.disabled, true); assert.equal(account.lastError, 'upstream_auth');
  h.hold.resolve(); await work; assert.equal(account.lastError, 'upstream_auth'); h.pool.closeScheduling();
});

test('Air/readiness capacity follows effective limits, global free slots, and preserves policy gates', async () => {
  const { AirPolicyCapacity } = require('../src/air/policy-capacity');
  const { AirWebReadiness } = require('../src/air/web-readiness');
  const { answerProfileContractDigest } = require('../src/ima-answer-profile');
  const h = harness({ maxGlobal: 7 }, 3);
  for (const account of h.accounts) account.retrievalPolicyQualifications = { group_knowledge: {
    answerBasis: 'knowledge', capabilityDigest: answerProfileContractDigest('classic_knowledge'),
  } };
  const directory = { load: () => ({ generation: 1, settings: { webMode: 'classic_knowledge' } }),
    getPoolAccounts: () => h.accounts, getAccount: id => ({ id, runtime: {} }),
    listAccounts: () => h.accounts.map(account => ({ id: account.id, health: {} })) };
  const policies = new AirPolicyCapacity({ directory, pool: h.pool });
  const readiness = new AirWebReadiness({ directory, pool: h.pool, policies });
  assert.equal(readiness.snapshot().capacity, 7);
  assert.equal(policies.policyCapacitySnapshot().group_knowledge, 7);
  assert.equal(policies.policyCapacitySnapshot().web, 0);
  const leases = [h.pool.tryAcquireSlot({ accountId: 'fixture-0' }), h.pool.tryAcquireSlot({ accountId: 'fixture-1' })];
  await h.clock.advance(3000);
  assert.equal(readiness.snapshot().schedulable, 5);
  h.pool._markFailure(h.pool.accounts[0], new Error('HTTP 429'));
  assert.equal(h.pool.elastic.state(h.pool.accounts[0]).demand, false, 'reading health must not create demand');
  assert.equal(readiness.snapshot().accounts[0].maxConcurrent, 2);
  assert.equal(policies.policyCapacitySnapshot().web, 0);
  assert.equal(providerAExecutionCapacity({ pool: h.pool, webReadiness: readiness, airPolicyCapacity: policies }), 7);
  for (const lease of leases) lease.release(); h.pool.closeScheduling();
});

test('duplicate account IDs cannot multiply the configured per-account ceiling', () => {
  assert.throws(() => new IMAWebAgentPool({ accounts: [{ id: 'same' }, { id: 'same' }],
    elasticScheduling: { enabled: true } }, { clientFactory: () => ({}) }), /Duplicate/);
});

test('sanitized real observation preserves five-stream overlap and the burst failure boundary', () => {
  const fixture = require('./fixtures/elastic-five-session-observation.json');
  const { classifyCompletionCode } = require('../src/ima-upstream-protocol');
  assert.equal(fixture.burst.success, 3); assert.equal(fixture.burst.temporaryFailures, 2);
  assert.equal(classifyCompletionCode(fixture.burst.completionCode), 'temporary');
  assert.equal(fixture.burst.universalRateLimitKnown, false);
  const sessions = fixture.paced.sessions;
  assert.equal(sessions.length, 5);
  assert.ok(sessions.every(row => row.oneTerminal && row.sessionMatchesExisting && row.markerCorrect));
  assert.equal(Math.min(...sessions.map(row => row.lastTextMs)) - Math.max(...sessions.map(row => row.firstTextMs)), 3348);
  assert.ok(fixture.paced.textEventsPerSessionInsideOverlap.every(count => count > 0));
  assert.equal(fixture.scopeLimitations.length, 5);
  assert.doesNotMatch(JSON.stringify(fixture), /https?:|cookie|token|session_id|question|knowledgeBaseId/iu);
});

test('an actual failed mock submission is never automatically repeated', async () => {
  const h = harness(); let calls = 0;
  h.pool.accounts[0].client.streamAsk = async function* () {
    calls++; throw Object.assign(new Error('upstream_quota'), { code: 'upstream_quota' });
  };
  await assert.rejects(collect(h.pool.streamAsk({ sessionId: 'failed' })), /upstream_quota/);
  await h.clock.advance(300000);
  assert.equal(calls, 1); assert.equal(h.pool.accounts[0].disabled, false);
  assert.equal(h.pool.stats().activeRequests, 0); assert.equal(h.pool.activeSessions.size, 0);
  h.pool.closeScheduling();
});

test('an account lease cannot be reused for a different known session', async () => {
  const h = harness(); const lease = h.pool.tryAcquireSlot({ sessionId: 'original' });
  await assert.rejects(collect(h.pool.streamAsk({ sessionId: 'different', accountLease: lease.value })), /Invalid account lease/);
  assert.equal(h.calls.length, 0); lease.release(); h.pool.closeScheduling();
  assert.equal(h.pool.activeSessions.size, 0);
});

test('a direct caller stays alive while awaiting the paced second submission', async () => {
  const { execFile } = require('node:child_process');
  const code = `const { IMAWebAgentPool } = require(${JSON.stringify(require.resolve('../src/ima-web-agent-pool'))});
    (async () => {
      let count = 0;
      const pool = new IMAWebAgentPool({ accounts: [{id:'fixture'}], elasticScheduling: {
        enabled:true, minStartSpacingMs:20, maxWaitMs:1000 } }, {clientFactory:()=>({
          async *streamAsk(){count++; yield {type:'delta',text:'fixture'}; yield {type:'done'};}
        })});
      for(let i=0;i<2;i++) for await(const event of pool.streamAsk({sessionId:'s'+i})) void event;
      pool.closeScheduling(); console.log('completed:'+count);
    })().catch(error=>{ console.error(error.message); process.exitCode=1; });`;
  const stdout = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', code], { timeout: 3000 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.equal(stdout.trim(), 'completed:2');
});
