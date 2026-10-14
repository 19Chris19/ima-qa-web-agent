'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DurableQATaskStore, readTaskRecord, writePrivateJson } = require('../src/durable-qa-store');
const { makeCheckpoint } = require('../src/durable-qa-jsonl');
const { DurableQATasks } = require('../src/durable-qa-tasks');
const { ConversationStore } = require('../src/conversation-store');
const { createAskQueue } = require('../src/ask-queue');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-jsonl-'));
  let store = new DurableQATaskStore({ directory, ...options });
  const input = { conversationId: 'synthetic-conversation', question: 'Synthetic question' };
  const { task } = store.create({ ownerKey: 'owner', scope: 'ordinary', key: 'same-request', input });
  const file = path.join(directory, `${task.id}.json`);
  const restart = () => { store.close(); store = new DurableQATaskStore({ directory, ...options }); return store; };
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, task, input, store: () => store, restart };
}
function sourcesFixture() {
  const paragraphs = Array.from({ length: 6 }, (_, i) => `Synthetic excerpt ${i}: ` + `${i}中文引用摘要 `.repeat(400));
  const events = [], sources = [], citationMap = {};
  for (let i = 0; i < 33; i++) {
    const page = i % 6, key = `index:${i < 31 ? i + 1 : i - 30}`;
    const source = { url: `https://example.org/source-${page}`, title: `Source ${page}`, snippet: paragraphs[page] };
    // Preserve different relations even when URL and exact excerpt repeat.
    sources.push(source); citationMap[key] = { type: 'web', sources: [source] };
    events.push({ sources: sources.slice(), citationMap: structuredClone(citationMap) });
  }
  return { events, citationMap, paragraphs };
}

test('cumulative reference replay stays below the original disk budget and preserves exact SSE bodies and IDs', t => {
  const f = fixture(t), original = [], data = sourcesFixture();
  f.store().running(f.task.id);
  for (const item of data.events) original.push(f.store().append(f.task.id, 'sources', item).events.at(-1));
  const rawBytes = Buffer.byteLength(JSON.stringify(f.store().tasks.get(f.task.id)));
  assert.ok(rawBytes > 2 * 1024 * 1024, 'fixture reproduces the original failure');
  assert.ok(f.store().bytes.get(f.task.id) < 512 * 1024, 'references replace repeated excerpt bytes on disk');
  assert.ok(f.store().metrics.checkpointBytes + f.store().metrics.appendBytes < rawBytes / 3);
  const recovered = f.restart().tasks.get(f.task.id);
  assert.deepEqual(recovered.events.slice(2), original);
  assert.deepEqual(recovered.events.at(-1).data.citationMap, data.citationMap);
  assert.equal(f.store().create({ ownerKey: 'owner', scope: 'ordinary', key: 'same-request', input: f.input }).isNew, false);
  assert.throws(() => f.store().owned(f.task.id, 'other', 'ordinary'), /task_not_found/);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${f.file}l`).mode & 0o777, 0o600);
});

test('rich-source generation completes, archives and recovers exactly once without another execution', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-jsonl-completion-'));
  const storePath = path.join(directory, 'history.json'), conversations = new ConversationStore({ storePath });
  const conversationId = conversations.create('owner').conversationId;
  const data = sourcesFixture(), answer = 'Synthetic answer[7](@index-ref?id=1)\n' + '正文 '.repeat(1000);
  let calls = 0;
  const manager = new DurableQATasks({ directory: path.join(directory, 'tasks'), conversations, queue: createAskQueue({}),
    async execute({ onDispatch, onUpstreamEvent, res, conversationStore }) {
      calls++; onDispatch();
      for (const item of data.events) res.write(`event: sources\ndata: ${JSON.stringify(item)}\n\n`);
      for (let i = 0; i < answer.length; i += 40) {
        const text = answer.slice(i, i + 40); onUpstreamEvent({ type: 'delta', text });
        res.write(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
      }
      const metadata = { citationMap: data.citationMap, suggestions: ['Follow up'], process: [{ phase: 'web', status: 'completed' }] };
      conversationStore.appendTurn(conversationId, 'Synthetic question', answer, metadata, 'owner');
      res.write(`event: done\ndata: ${JSON.stringify({ conversationId, ...metadata })}\n\n`);
    } });
  t.after(() => { manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const input = { conversationId, question: 'Synthetic question' };
  const { task } = manager.submit({ ownerKey: 'owner', scope: 'ordinary', key: 'completion-request', input });
  for (let i = 0; i < 200 && !['succeeded', 'failed'].includes(manager.store.tasks.get(task.id).status); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const saved = manager.store.tasks.get(task.id);
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.events.filter(e => e.event === 'done').length, 1);
  assert.equal(saved.events.filter(e => e.event === 'delta').map(e => e.data.text).join(''), answer);
  assert.equal(conversations.getHistory(conversationId, 'owner').length, 2);
  manager.close();
  const recovered = new DurableQATasks({ directory: path.join(directory, 'tasks'), conversations: new ConversationStore({ storePath }),
    queue: createAskQueue({}), execute: () => assert.fail('never reexecute a committed task') });
  try {
    assert.equal(recovered.store.tasks.get(task.id).status, 'succeeded');
    assert.equal(recovered.conversations.getHistory(conversationId, 'owner').length, 2);
    assert.equal(recovered.submit({ ownerKey: 'owner', scope: 'ordinary', key: 'completion-request', input }).isNew, false);
  } finally { recovered.close(); }
  assert.equal(calls, 1);
});

test('legacy records remain readable and are privately backed up before their first JSONL update', t => {
  const f = fixture(t), legacy = structuredClone(f.store().tasks.get(f.task.id));
  f.store().close(); writePrivateJson(f.file, legacy); fs.unlinkSync(`${f.file}l`);
  const original = fs.readFileSync(f.file);
  f.restart(); assert.equal(JSON.parse(fs.readFileSync(f.file)).version, 1);
  f.store().append(f.task.id, 'delta', { text: 'new text' });
  const backup = path.join(f.directory, '.legacy-v1', path.basename(f.file));
  assert.deepEqual(fs.readFileSync(backup), original); assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).version, 2);
  assert.equal(f.restart().tasks.get(f.task.id).events.at(-1).data.text, 'new text');
});

test('torn UTF-8 tail is trimmed under the store lock; complete corrupt transactions are never silently skipped', t => {
  const f = fixture(t); f.store().append(f.task.id, 'delta', { text: '完整中文 😀' });
  const length = fs.statSync(`${f.file}l`).size;
  f.store().close(); fs.appendFileSync(`${f.file}l`, Buffer.from([123, 34, 228, 184]));
  assert.equal(f.restart().tasks.get(f.task.id).events.at(-1).data.text, '完整中文 😀');
  assert.equal(fs.statSync(`${f.file}l`).size, length);
  f.store().close(); fs.appendFileSync(`${f.file}l`, '{"version":2,"checksum":"corrupt"}\n');
  assert.throws(() => new DurableQATaskStore({ directory: f.directory }), /task_store_unavailable/);
});

test('a committed checkpoint wins over a stale log after an interrupted compaction', t => {
  const f = fixture(t); f.store().append(f.task.id, 'delta', { text: 'prefix' });
  const expected = structuredClone(f.store().tasks.get(f.task.id));
  f.store().close(); writePrivateJson(f.file, makeCheckpoint(expected).record);
  assert.deepEqual(f.restart().tasks.get(f.task.id), expected);
  f.store().append(f.task.id, 'delta', { text: 'suffix' });
  assert.equal(f.restart().tasks.get(f.task.id).events.filter(e => e.event === 'delta').map(e => e.data.text).join(''), 'prefixsuffix');
});

test('pressure compaction retains all event IDs while reducing obsolete trace writes', t => {
  const f = fixture(t, { maxTaskBytes: 8192 });
  for (let i = 0; i < 100; i++) f.store().update(f.task.id, task => { task.trace.rawUpstreamChunks = i; });
  f.store().append(f.task.id, 'delta', { text: 'retained' });
  assert.ok(f.store().metrics.checkpoints > 1); assert.ok(f.store().metrics.appends > 1);
  const task = f.restart().tasks.get(f.task.id);
  assert.equal(task.trace.rawUpstreamChunks, 99); assert.deepEqual(task.events.map(e => e.id), [1, 2]);
  assert.ok(f.store().bytes.get(task.id) <= 8192);
});

test('replay expansion remains bounded even when identical source strings compress extremely well', t => {
  const f = fixture(t); f.store().maxTaskReplayBytes = f.store().measureReplay(f.store().tasks.get(f.task.id)) + 100;
  assert.throws(() => f.store().append(f.task.id, 'sources', { sources: Array(100).fill({ snippet: 'x'.repeat(1000) }) }),
    error => error.code === 'task_capacity' && error.capacityKind === 'task_replay_bytes');
  f.store().finish(f.task.id, 'failed', { failureReason: 'task_capacity' });
  assert.equal(f.restart().tasks.get(f.task.id).trace.capacityKind, 'task_replay_bytes');
});

test('JSONL symlinks are refused and exact string interning does not merge distinct excerpts or special JSON keys', t => {
  const f = fixture(t);
  const data = JSON.parse('{"__proto__":"' + 'private literal '.repeat(30) + '","sources":[{"url":"https://example.org","snippet":"' + 'a'.repeat(300) + '"},{"url":"https://example.org","snippet":"' + 'b'.repeat(300) + '"}]}');
  f.store().append(f.task.id, 'sources', data);
  assert.deepEqual(readTaskRecord(f.file).events.at(-1).data, data); assert.equal({}.polluted, undefined);
  f.store().close(); fs.unlinkSync(`${f.file}l`); fs.symlinkSync(f.file, `${f.file}l`);
  assert.throws(() => new DurableQATaskStore({ directory: f.directory }), /task_store_unavailable/);
});

test('partial append failures close admission and cannot publish or lose a committed prefix', t => {
  const f = fixture(t);
  f.store().running(f.task.id); f.store().append(f.task.id, 'delta', { text: 'committed' });
  const previous = readTaskRecord(f.file), write = fs.writeFileSync;
  fs.writeFileSync = (fd, data, ...args) => {
    if (typeof fd === 'number' && Buffer.isBuffer(data)) {
      write(fd, data.subarray(0, 23)); throw Object.assign(new Error('synthetic partial write'), { code: 'EIO' });
    }
    return write(fd, data, ...args);
  };
  try {
    assert.throws(() => f.store().append(f.task.id, 'delta', { text: 'not published' }), /task_store_unavailable/);
    assert.equal(f.store().available, false);
  } finally { fs.writeFileSync = write; }
  assert.deepEqual(readTaskRecord(f.file), previous);
  assert.deepEqual(f.restart().tasks.get(f.task.id), previous);
});

test('unexpected log size is preserved for investigation and orphan logs fail closed', t => {
  const f = fixture(t); f.store().append(f.task.id, 'delta', { text: 'committed' });
  fs.appendFileSync(`${f.file}l`, 'unexpected external suffix');
  const before = fs.readFileSync(`${f.file}l`);
  assert.throws(() => f.store().append(f.task.id, 'delta', { text: 'reject' }), /task_store_unavailable/);
  assert.deepEqual(fs.readFileSync(`${f.file}l`), before);
  f.store().close(); fs.unlinkSync(f.file);
  assert.throws(() => new DurableQATaskStore({ directory: f.directory }), /task_store_unavailable/);
});

test('startup rejects expanded replay over budget and does not trim a corrupt committed prefix', t => {
  const f = fixture(t);
  f.store().append(f.task.id, 'sources', { snippet: 'a'.repeat(20000) });
  f.store().close();
  assert.throws(() => new DurableQATaskStore({ directory: f.directory, maxTaskReplayBytes: 100 }), /task_store_unavailable/);
  fs.appendFileSync(`${f.file}l`, '{"checksum":"bad"}\npartial');
  const bytes = fs.readFileSync(`${f.file}l`);
  assert.throws(() => new DurableQATaskStore({ directory: f.directory }), /task_store_unavailable/);
  assert.deepEqual(fs.readFileSync(`${f.file}l`), bytes);
});
