const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DurableQATaskStore, RETENTION_MS } = require('../src/durable-qa-store');
const { DurableQATasks } = require('../src/durable-qa-tasks');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { botRoutingOptions } = require('../src/bot-pair-routing');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function routing(task) {
  return botRoutingOptions(task.input.botContract, task.applicationKey, task.ownerKey);
}
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-pair-retention-'));
  let now = 1000;
  let store = new DurableQATaskStore({ directory, now: () => now });
  let manager;
  t.after(() => { manager?.close(); store?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  function add(pair, leg, status = 'succeeded', accountId = leg === 'knowledge' ? 'a' : 'b') {
    const task = store.create({ ownerKey: 'synthetic-owner', scope: 'internal', applicationKey: 'internal',
      key: `${pair}-${leg}`, input: { conversationId: `${pair}-${leg}`, question: 'SYNTHETIC_QUESTION_BODY',
        botContract: { parallelPairRef: hash(pair), parallelLeg: leg,
          retrievalPolicy: leg === 'knowledge' ? 'group_knowledge' : 'web', contextBody: 'SYNTHETIC_CONTEXT_BODY' } } }).task;
    if (status !== 'queued') {
      store.running(task.id);
      if (accountId) store.update(task.id, current => { current.upstreamBinding = { accountId }; });
      store.finish(task.id, status, {});
    }
    return task;
  }
  function restart(maxParallelPairs = 4096) {
    manager?.close(); manager = null;
    store.close();
    const pool = new IMAWebAgentPool({ accounts: [{ id: 'a', maxConcurrent: 2 }, { id: 'b', maxConcurrent: 2 }] }, {
      now: () => now, maxParallelPairs,
      clientFactory: () => ({ async *streamAsk() { assert.fail('no real or synthetic dispatch expected'); } }),
    });
    manager = new DurableQATasks({ directory, storeOptions: { now: () => now }, accountPool: pool,
      queue: { canAccept: () => false }, execute: () => assert.fail('queued task must not dispatch'), routingOptions: routing,
      conversations: { getUpstream: () => ({}), require: () => ({ mode: 'classic_knowledge' }) } });
    store = manager.store;
    return { pool, manager };
  }
  return { add, restart, advance: ms => { now += ms; }, get store() { return store; }, directory };
}

for (const explicitPrune of [false, true]) test(`24h prune preserves incomplete pair across restart (explicit=${explicitPrune})`, t => {
  const f = fixture(t);
  const first = f.add('unfinished', 'knowledge');
  const second = f.add('unfinished', 'web', 'queued');
  f.advance(RETENTION_MS + 1);
  if (explicitPrune) f.store.prune();
  for (let restart = 0; restart < 2; restart++) {
    const { pool, manager } = f.restart();
    assert.throws(() => pool.tryAcquireSlot({ ...routing(second), accountId: 'a' }), /账号/u);
    const lease = pool.tryAcquireSlot({ ...routing(second), accountId: 'b' });
    assert.ok(lease); lease.release();
    assert.equal(manager.pending.size, 1);
    const receipt = f.store.tasks.get(first.id);
    assert.equal(receipt.status, 'succeeded');
    assert.deepEqual(receipt.input, { conversationId: first.input.conversationId });
    assert.deepEqual(receipt.events, []);
    const raw = fs.readFileSync(path.join(f.directory, `${first.id}.json`), 'utf8');
    assert.ok(!raw.includes('SYNTHETIC_QUESTION_BODY') && !raw.includes('SYNTHETIC_CONTEXT_BODY'));
    assert.equal(f.store.publicTask(receipt).pairReceipt, undefined);
  }
});

test('completed pair keeps original absolute deadline across repeated restarts', t => {
  const f = fixture(t);
  const first = f.add('complete', 'knowledge'); f.add('complete', 'web');
  const key = routing(first).parallelPairKey;
  f.advance(60_000);
  assert.equal(f.restart().pool.parallelPairs.get(key).expiresAt, 301000);
  f.advance(60_000);
  assert.equal(f.restart().pool.parallelPairs.get(key).expiresAt, 301000);
  f.advance(180_001);
  assert.equal(f.restart().pool.parallelPairs.size, 0);
});

test('expired completed history larger than pool limit does not crowd out unfinished pair', t => {
  const f = fixture(t);
  for (let i = 0; i < 4; i++) { f.add(`complete-${i}`, 'knowledge'); f.add(`complete-${i}`, 'web'); }
  f.add('unfinished', 'knowledge');
  const second = f.add('unfinished', 'web', 'queued');
  f.advance(RETENTION_MS + 1);
  const { pool, manager } = f.restart(2);
  assert.equal(manager.available, true);
  assert.equal(pool.parallelPairs.size, 1);
  assert.throws(() => pool.tryAcquireSlot({ ...routing(second), accountId: 'a' }), /账号/u);
});

test('pruned unknown dispatched account remains fail closed', t => {
  const f = fixture(t);
  f.add('unknown', 'knowledge', 'indeterminate', '');
  const second = f.add('unknown', 'web', 'queued');
  f.advance(RETENTION_MS + 1);
  const { pool } = f.restart();
  assert.throws(() => pool.tryAcquireSlot(routing(second)), /可用账号/u);
});

test('legacy unpruned records migrate before pruning without changing trusted application or binding scope', t => {
  const f = fixture(t);
  const first = f.add('legacy', 'knowledge');
  const second = f.add('legacy', 'web', 'queued');
  f.store.close();
  const binding = { account_id: 'synthetic-binding-account', group_id: 'synthetic-binding-group',
    route_ref: 'synthetic-route', route_generation: 1, feature_generation: 2 };
  for (const [i, task] of [first, second].entries()) {
    const file = path.join(f.directory, `${task.id}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete saved.pairReceipt;
    saved.applicationKey = 'application:synthetic-bot-app';
    saved.ownerKey = `synthetic-visitor-${i}`;
    saved.input.botContract.recentContextBinding = binding;
    fs.writeFileSync(file, JSON.stringify(saved));
    Object.assign(task, saved);
  }
  f.advance(RETENTION_MS + 1);
  const { pool } = f.restart();
  assert.throws(() => pool.tryAcquireSlot({ ...routing(second), accountId: 'a' }), /账号/u);
  assert.equal(f.store.tasks.get(first.id).applicationKey, 'application:synthetic-bot-app');
  const raw = fs.readFileSync(path.join(f.directory, `${first.id}.json`), 'utf8');
  assert.ok(!raw.includes('synthetic-binding-account') && !raw.includes('synthetic-binding-group'));
  assert.equal(f.store.tasks.get(first.id).pairReceipt.parallelPairKey, routing(second).parallelPairKey);
});

test('more than 4096 expired complete pairs plus unfinished pair fit the default restart map', t => {
  const f = fixture(t);
  const template = f.add('template', 'knowledge');
  f.add('unfinished', 'knowledge');
  const second = f.add('unfinished', 'web', 'queued');
  const saved = structuredClone(f.store.tasks.get(template.id));
  f.store.close();
  fs.unlinkSync(path.join(f.directory, `${template.id}.json`));
  // Serialized synthetic receipts avoid thousands of fsyncs while exercising the real loader.
  for (let pair = 0; pair < 4097; pair++) {
    for (const leg of ['knowledge', 'web']) {
      const row = structuredClone(saved);
      row.id = crypto.randomUUID();
      row.input = { conversationId: `expired-${pair}-${leg}` };
      row.events = []; row.eventsExpired = true; row.lastEventId = 3;
      row.keyHash = row.requestKey = hash(row.id);
      row.upstreamBinding = { accountId: leg === 'knowledge' ? 'a' : 'b' };
      row.pairReceipt = { parallelPairKey: hash(`expired-scope-${pair}`), parallelPairRef: hash(`expired-${pair}`),
        parallelLeg: leg, retrievalPolicy: leg === 'knowledge' ? 'group_knowledge' : 'web', accountId: row.upstreamBinding.accountId };
      fs.writeFileSync(path.join(f.directory, `${row.id}.json`), JSON.stringify(row), { mode: 0o600 });
    }
  }
  f.advance(RETENTION_MS + 1);
  const { pool, manager } = f.restart();
  assert.equal(manager.available, true);
  assert.equal(f.store.tasks.size, 8196);
  assert.equal(pool.parallelPairs.size, 1);
  assert.throws(() => pool.tryAcquireSlot({ ...routing(second), accountId: 'a' }), /账号/u);
});

test('unfinished pairs over the map bound fail closed instead of dropping exclusions', t => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++) f.add(`unfinished-${i}`, 'knowledge');
  f.advance(RETENTION_MS + 1);
  assert.throws(() => f.restart(2), /task_store_unavailable/u);
});

test('cancelled undispatched task does not invent an unknown dispatched pair', t => {
  const f = fixture(t);
  const task = f.add('cancelled', 'knowledge', 'queued');
  f.store.finish(task.id, 'cancelled', {});
  f.advance(RETENTION_MS + 1);
  assert.equal(f.restart().pool.parallelPairs.size, 0);
});
