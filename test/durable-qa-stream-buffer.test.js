'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { DurableQATaskStore } = require('../src/durable-qa-store');
const { DurableQAStreamBuffer } = require('../src/durable-qa-stream-buffer');
const { DurableQATasks } = require('../src/durable-qa-tasks');
const { ConversationStore } = require('../src/conversation-store');
const { createAskQueue } = require('../src/ask-queue');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-stream-test-'));
  let clock = 1000;
  const store = new DurableQATaskStore({ directory, now: () => clock, ...options.storeOptions });
  const { task } = store.create({ ownerKey: 'synthetic-owner', scope: 'ordinary', key: 'synthetic',
    input: { conversationId: 'synthetic-conversation', question: 'Synthetic question only' } });
  store.running(task.id);
  const seen = [], errors = [];
  const buffer = new DurableQAStreamBuffer({ store, id: task.id, ...options.bufferOptions,
    publish: current => {
      // A subscriber must never observe an event ID or text ahead of disk.
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, `${task.id}.json`), 'utf8')), current);
      seen.push(current);
    }, onError: error => errors.push(error) });
  t.after(() => { buffer.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, task, buffer, seen, errors, clock(value) { clock = value; },
    current: () => store.tasks.get(task.id), text: () => store.tasks.get(task.id).events.filter(e => e.event === 'delta').map(e => e.data.text).join('') };
}

test('first text is immediately durable; a burst is coalesced with exact Unicode and whitespace', t => {
  const f = fixture(t);
  const chunks = ['首', ' 次', '\n\n', '😀', 'e\u0301', ' 末尾  \n'];
  f.buffer.append('delta', { text: chunks[0] });
  assert.equal(f.seen.length, 1);
  assert.equal(f.text(), chunks[0]);
  for (const text of chunks.slice(1)) {
    f.buffer.activity(10); f.buffer.upstream({ type: 'delta', text });
    f.buffer.append('delta', { text });
  }
  assert.equal(f.seen.length, 1);
  assert.equal(f.current().events.length, 3);
  f.buffer.flush();
  assert.equal(f.text(), chunks.join(''));
  assert.equal(f.seen.length, 2);
  assert.equal(f.current().trace.rawUpstreamChunks, chunks.length - 1);
  assert.equal(f.current().trace.upstreamEvents, chunks.length - 1);
  assert.equal(f.current().trace.firstAnswerDeltaAt, 1000);
  assert.deepEqual(f.current().events.map(e => e.id), [1, 2, 3, 4]);
});

test('a pending suffix is emitted by the short timer even if upstream falls silent', async t => {
  const f = fixture(t, { bufferOptions: { deltaMs: 10 } });
  f.buffer.append('delta', { text: 'first' });
  f.buffer.append('delta', { text: ' last' });
  await pause(60);
  assert.equal(f.text(), 'first last');
  assert.equal(f.seen.length, 2);
  assert.deepEqual(f.errors, []);
});

test('process, sources and structured deltas retain their order and payloads', t => {
  const f = fixture(t);
  f.buffer.append('delta', { text: 'A' });
  f.buffer.append('delta', { text: 'B' });
  f.buffer.append('sources', { sources: [{ title: 'Synthetic source' }], sourceCount: 1 });
  f.buffer.append('delta', { text: 'C' });
  f.buffer.append('process', { text: 'Synthetic process' });
  f.buffer.append('delta', { text: 'D', extra: 'preserved' });
  const events = f.current().events.slice(2);
  assert.deepEqual(events.map(e => e.event), ['delta', 'delta', 'sources', 'delta', 'process', 'delta']);
  assert.equal(f.text(), 'ABCD');
  assert.deepEqual(events.at(-1).data, { text: 'D', extra: 'preserved' });
});

test('metadata alone checkpoints without inventing events or requiring subscribers', async t => {
  const f = fixture(t, { bufferOptions: { traceMs: 10 } });
  for (let i = 0; i < 100; i++) f.buffer.activity(7);
  await pause(60);
  assert.equal(f.current().trace.rawUpstreamChunks, 100);
  assert.equal(f.current().trace.rawUpstreamBytes, 700);
  assert.equal(f.current().events.length, 2);
  assert.equal(f.seen.length, 0);
});

test('original upstream limits apply before a batched checkpoint can hide excess events', t => {
  const f = fixture(t, { storeOptions: { maxEvents: 3 } });
  for (let i = 0; i < 3; i++) f.buffer.upstream({ type: 'process' });
  assert.throws(() => f.buffer.upstream({ type: 'process' }), /task_capacity/);
  f.buffer.flush();
  assert.equal(f.current().trace.upstreamEvents, 3);
  assert.equal(f.current().events.length, 2);
});

test('the byte limit flushes a burst before the timer and preserves every character', t => {
  const f = fixture(t, { bufferOptions: { maxDeltaBytes: 8 } });
  f.buffer.append('delta', { text: 'A' });
  f.buffer.append('delta', { text: '中中中' });
  assert.equal(f.text(), 'A中中中');
  assert.equal(f.seen.length, 2);
});

test('a checkpoint preserves concurrent subscription diagnostics and independent task buffers', t => {
  const a = fixture(t), b = fixture(t);
  a.buffer.append('delta', { text: 'A' }); b.buffer.append('delta', { text: 'B' });
  a.buffer.activity(7); a.buffer.upstream({ type: 'delta', text: 'a' });
  a.buffer.append('delta', { text: 'a' }); b.buffer.append('delta', { text: 'b' });
  a.store.update(a.task.id, task => { task.trace.subscriptions = 2; task.trace.disconnects = 1; }, true);
  b.buffer.flush(); a.buffer.flush();
  assert.equal(a.text(), 'Aa'); assert.equal(b.text(), 'Bb');
  assert.equal(a.current().trace.subscriptions, 2); assert.equal(a.current().trace.disconnects, 1);
  assert.equal(a.current().trace.firstUpstreamActivityAt, 1000);
  assert.equal(b.current().trace.rawUpstreamChunks, 0);
});

test('a failed fsync publishes nothing and closes the store', t => {
  const f = fixture(t);
  const fsync = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw new Error('Synthetic fsync fault'); };
    assert.throws(() => f.buffer.append('delta', { text: 'unpublished' }), /task_store_unavailable/);
  } finally { fs.fsyncSync = fsync; }
  assert.equal(f.seen.length, 0);
  assert.equal(f.store.available, false);
  assert.equal(f.text(), '');
});

test('a timer write fault is reported and does not publish a memory-only suffix', async t => {
  const f = fixture(t, { bufferOptions: { deltaMs: 10 } });
  f.buffer.append('delta', { text: 'durable' });
  f.buffer.append('delta', { text: ' unpublished' });
  f.store.directory = path.join(f.directory, 'missing-parent');
  await pause(60);
  assert.equal(f.errors.length, 1);
  assert.equal(f.store.available, false);
  assert.equal(f.text(), 'durable');
  assert.equal(f.seen.length, 1);
});

test('closing discards only unpublished text and cancels pending timers', async t => {
  const f = fixture(t, { bufferOptions: { deltaMs: 10 } });
  f.buffer.append('delta', { text: 'durable' });
  f.buffer.append('delta', { text: ' pending' });
  f.buffer.close();
  await pause(60);
  assert.equal(f.text(), 'durable');
  assert.equal(f.seen.length, 1);
  assert.deepEqual(f.errors, []);
});

test('success drains the suffix before history and terminal events; restart cannot redispatch', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-batch-integration-'));
  const storePath = path.join(directory, 'history.json');
  const conversations = new ConversationStore({ storePath });
  const conversationId = conversations.create('synthetic-owner').conversationId;
  let calls = 0;
  const manager = new DurableQATasks({ directory: path.join(directory, 'tasks'), conversations,
    queue: createAskQueue({}), async execute({ task, res, conversationStore, onDispatch, onUpstreamActivity, onUpstreamEvent }) {
      calls++; onDispatch();
      for (const text of ['  First', '\n\n', '尾巴  \n']) {
        onUpstreamActivity({ bytes: 20 }); onUpstreamEvent({ type: 'delta', text });
        res.write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
      }
      conversationStore.appendTurn(conversationId, task.input.question, '  First\n\n尾巴  \n', {});
      res.write('event: done\ndata: {}\n\n'); res.end();
    } });
  t.after(() => { manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const input = { conversationId, question: 'Synthetic question' };
  const { task } = manager.submit({ ownerKey: 'synthetic-owner', scope: 'ordinary', key: 'synthetic', input });
  for (let i = 0; i < 100 && manager.store.tasks.get(task.id).status !== 'succeeded'; i++) await pause(10);
  const saved = manager.store.tasks.get(task.id);
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.events.filter(e => e.event === 'delta').map(e => e.data.text).join(''), '  First\n\n尾巴  \n');
  assert.equal(saved.trace.upstreamEvents, 3); assert.equal(saved.trace.rawUpstreamChunks, 3);
  assert.equal(conversations.getHistory(conversationId, 'synthetic-owner')[1].content, '  First\n\n尾巴  \n');
  manager.close();
  const recovered = new DurableQATasks({ directory: path.join(directory, 'tasks'), conversations: new ConversationStore({ storePath }),
    queue: createAskQueue({}), execute() { calls++; } });
  try {
    assert.equal(recovered.submit({ ownerKey: 'synthetic-owner', scope: 'ordinary', key: 'synthetic', input }).isNew, false);
    assert.equal(calls, 1);
    assert.equal(recovered.store.tasks.get(task.id).status, 'succeeded');
  } finally { recovered.close(); }
});

test('restart after an interrupted batch retains the durable prefix and never redispatches running work', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-batch-interrupted-'));
  const storePath = path.join(directory, 'history.json');
  const conversations = new ConversationStore({ storePath });
  const conversationId = conversations.create('synthetic-owner').conversationId;
  const tasksDirectory = path.join(directory, 'tasks');
  const store = new DurableQATaskStore({ directory: tasksDirectory });
  const { task } = store.create({ ownerKey: 'synthetic-owner', scope: 'ordinary', key: 'synthetic',
    input: { conversationId, question: 'Synthetic interrupted task' } });
  store.running(task.id);
  const buffer = new DurableQAStreamBuffer({ store, id: task.id, publish: () => {}, onError: assert.fail });
  buffer.append('delta', { text: 'durable-prefix' });
  buffer.append('delta', { text: ' unpublished-suffix' });
  // Closing without a flush models the persisted state visible after a crash.
  buffer.close(); store.close();
  let calls = 0;
  const recovered = new DurableQATasks({ directory: tasksDirectory, conversations: new ConversationStore({ storePath }),
    queue: createAskQueue({}), execute() { calls++; } });
  try {
    const saved = recovered.store.tasks.get(task.id);
    assert.equal(saved.status, 'indeterminate');
    assert.equal(saved.events.filter(e => e.event === 'delta').map(e => e.data.text).join(''), 'durable-prefix');
    assert.deepEqual(saved.events.map(e => e.id), saved.events.map((_, i) => i + 1));
    assert.equal(calls, 0);
  } finally { recovered.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a timer capacity failure persists its reason before a synchronous abort handler can overwrite it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-batch-capacity-'));
  const conversations = new ConversationStore({ storePath: path.join(directory, 'history.json') });
  const conversationId = conversations.create('synthetic-owner').conversationId;
  let aborted = false;
  const manager = new DurableQATasks({ directory: path.join(directory, 'tasks'), conversations,
    queue: createAskQueue({}), async execute({ task, res, signal, onDispatch }) {
      onDispatch(); res.write('event: delta\ndata: {"text":"prefix"}\n\n');
      manager.store.maxTaskBytes = manager.store.bytes.get(task.id) + 100;
      res.write(`event: delta\ndata: ${JSON.stringify({ text: 'x'.repeat(200) })}\n\n`);
      await new Promise(resolve => signal.addEventListener('abort', () => {
        aborted = true;
        res.write('event: error\ndata: {"failureReason":"competing_abort"}\n\n');
        resolve();
      }, { once: true }));
    } });
  t.after(() => { manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const { task } = manager.submit({ ownerKey: 'synthetic-owner', scope: 'ordinary', key: 'synthetic',
    input: { conversationId, question: 'Synthetic capacity test' } });
  for (let i = 0; i < 100 && !aborted; i++) await pause(10);
  assert.equal(aborted, true);
  const saved = manager.store.tasks.get(task.id);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.trace.terminalReason, 'task_capacity');
  assert.equal(saved.events.filter(e => e.event === 'error').length, 1);
});
