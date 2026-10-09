const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const request = (leg, key = 'trusted-app-owner-pair') => ({ parallelPairRef: hash('synthetic-pair'),
  parallelPairKey: hash(key), parallelLeg: leg, retrievalPolicy: leg === 'web' ? 'web' : 'group_knowledge' });
const drain = async stream => { const events = []; for await (const event of stream) events.push(event); return events; };
function fixture(options = {}) {
  let now = 1000;
  const calls = [];
  const pool = new IMAWebAgentPool({ accounts: options.accounts || [{ id: 'a', maxConcurrent: 2 }, { id: 'b', maxConcurrent: 2 }] }, {
    now: () => now, maxParallelPairs: options.maxParallelPairs,
    policyEligibility: options.policyEligibility,
    clientFactory: account => ({ async *streamAsk(args) {
      calls.push({ id: account.id, args });
      args.onDispatch?.();
      yield { type: 'delta', text: 'Synthetic answer' };
      yield { type: 'done' };
    } }),
  });
  return { pool, calls, advance: ms => { now += ms; } };
}

test('pair slots reserve distinct accounts before dispatch even with two slots per account', async () => {
  const { pool, calls } = fixture();
  const k = pool.tryAcquireSlot(request('knowledge'));
  const w = pool.tryAcquireSlot(request('web'));
  await Promise.all([drain(pool.streamAsk({ ...request('knowledge'), accountLease: k.value })),
    drain(pool.streamAsk({ ...request('web'), accountLease: w.value }))]);
  assert.equal(new Set(calls.map(call => call.id)).size, 2);
  assert.ok(calls.every(call => call.args.parallelPairKey === undefined));
  k.release(); w.release();
  assert.equal(pool.stats().activeRequests, 0);
});

test('one two-slot account cannot satisfy a pair; preferred session cannot override exclusion', async () => {
  const single = fixture({ accounts: [{ id: 'a', maxConcurrent: 2 }] });
  assert.throws(() => single.pool.tryAcquireSlot(request('knowledge')), /可用账号/u);
  assert.equal(single.pool.stats().activeRequests, 0);
  const { pool } = fixture();
  const k = pool.tryAcquireSlot({ ...request('knowledge'), accountId: 'a' });
  assert.throws(() => pool.tryAcquireSlot({ ...request('web'), accountId: 'a' }), /账号/u);
  k.release();
});

test('active and unfinished pairs never expire; completed retention and record count are bounded', async () => {
  const { pool, advance } = fixture({ maxParallelPairs: 1 });
  const k = pool.tryAcquireSlot(request('knowledge'));
  advance(24 * 60 * 60_000);
  assert.equal(pool.parallelPairCapacity(), 0);
  assert.throws(() => pool.tryAcquireSlot({ ...request('web'), accountId: 'a' }), /账号/u);
  await drain(pool.streamAsk({ ...request('knowledge'), accountLease: k.value }));
  advance(24 * 60 * 60_000);
  assert.throws(() => pool.tryAcquireSlot(request('knowledge', 'another-pair')), /parallel_pair_capacity/u);
  const w = pool.tryAcquireSlot(request('web'));
  await drain(pool.streamAsk({ ...request('web'), accountLease: w.value }));
  advance(5 * 60_000 + 1);
  const next = pool.tryAcquireSlot(request('knowledge', 'another-pair'));
  next.release();
  assert.equal(pool.parallelPairs.size, 0);
  assert.equal(pool.parallelPairCapacity(), 1);
  assert.equal(pool.stats().activeRequests, 0);
});

test('cancel before consumption releases pair reservation exactly once and scope isolates same ref', async () => {
  const { pool } = fixture();
  const k = pool.tryAcquireSlot({ ...request('knowledge'), accountId: 'a' });
  const other = pool.tryAcquireSlot({ ...request('web', 'other-trusted-owner'), accountId: 'a' });
  other.release(); other.release(); k.release(); k.release();
  assert.equal(pool.parallelPairs.size, 0);
  assert.equal(pool.stats().activeRequests, 0);
  assert.throws(() => pool.tryAcquireSlot({ ...request('knowledge'), parallelPairKey: undefined }), /parallel_contract_invalid/u);
});

test('direct paired stream and cancellation wait use the same reservation guard', async () => {
  const { pool, calls } = fixture();
  await Promise.all([drain(pool.streamAsk(request('knowledge'))), drain(pool.streamAsk(request('web')))]);
  assert.equal(new Set(calls.map(call => call.id)).size, 2);
  const hold1 = pool.tryAcquireSlot({ accountId: 'a' });
  const hold2 = pool.tryAcquireSlot({ accountId: 'a' });
  const controller = new AbortController();
  const pending = drain(pool.streamAsk({ ...request('knowledge', 'waiting-pair'), accountId: 'a', signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, /request_aborted/u);
  hold1.release(); hold2.release();
  assert.equal(pool.availabilityListeners.size, 0);
  assert.equal(pool.stats().activeRequests, 0);
});

test('lease cannot be rebound to another pair scope or leg; caller can release failed consumption', async () => {
  const { pool, calls } = fixture();
  const lease = pool.tryAcquireSlot(request('knowledge'));
  await assert.rejects(drain(pool.streamAsk({ ...request('knowledge', 'different-scope'), accountLease: lease.value })), /Invalid account lease/u);
  lease.release();
  assert.equal(calls.length, 0);
  assert.equal(pool.stats().activeRequests, 0);
  assert.equal(pool.parallelPairs.size, 0);
});

test('first leg preserves a distinct policy-eligible account for its counterpart', async () => {
  const { pool, calls } = fixture({ policyEligibility: (account, options) => options.retrievalPolicy !== 'web' || account.id === 'a' });
  await drain(pool.streamAsk(request('knowledge')));
  await drain(pool.streamAsk(request('web')));
  assert.deepEqual(calls.map(call => call.id), ['b', 'a']);
});

test('restored durable pair affinity excludes the first account; missing dispatched affinity fails closed', async () => {
  const { pool, calls, advance } = fixture();
  pool.restoreParallelPairBinding({ ...request('knowledge'), accountId: 'a' });
  advance(24 * 60 * 60_000);
  await drain(pool.streamAsk(request('web')));
  assert.equal(calls[0].id, 'b');
  pool.restoreParallelPairBinding(request('knowledge', 'unknown-dispatched-pair'));
  assert.throws(() => pool.tryAcquireSlot(request('web', 'unknown-dispatched-pair')), /可用账号/u);
});
