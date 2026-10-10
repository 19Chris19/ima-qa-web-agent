'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, webcrypto } = require('node:crypto');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const publicRoot = path.resolve(__dirname, '../public');
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function waitFor(predicate) {
  for (let i = 0; i < 150; i += 1) { if (predicate()) return; await tick(); }
  assert.fail('Synthetic UI did not settle');
}

async function page(t, options = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(publicRoot, `${options.mode || 'index'}.html`), 'utf8'), {
    url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  w.TextDecoder = TextDecoder;
  w.TextEncoder = TextEncoder;
  Object.defineProperty(w, 'crypto', { value: webcrypto });
  const calls = [], copied = [], delays = [], records = options.records || [];
  const streams = new Map(), histories = options.histories || {};
  let nextConversation = 0;
  if (options.conversationId) w.localStorage.setItem('ima-qa-conversation-id', options.conversationId);
  if (options.reference) w.localStorage.setItem('ima-qa-task-reference', JSON.stringify(options.reference));
  const originalTimeout = w.setTimeout.bind(w);
  w.setTimeout = (callback, ms, ...args) => {
    if (options.blackholePost && ms === 15000) return originalTimeout(callback, 10, ...args);
    if ([500, 1000, 2000, 4000, 8000].includes(ms)) { delays.push(ms); return originalTimeout(callback, 1, ...args); }
    return originalTimeout(callback, ms, ...args);
  };
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => copied.push(text) } });
  const metadata = record => ({ ...record.task, lastEventId: record.events.length });
  w.fetch = async (url, init = {}) => {
    calls.push({ url, ...init });
    const custom = await options.intercept?.(url, init, records);
    if (custom) return custom;
    if (url === '/healthz') return Response.json({ provider: options.provider || 'ima-web-agent', model: 'synthetic' });
    if (url === '/api/capabilities') return Response.json({ features: { durable_qa_tasks_v1: options.capability !== false } });
    if (url.startsWith('/api/conversations?')) return Response.json({ conversations: [
      { conversationId: options.conversationId || 'synthetic-conversation-1', title: 'Synthetic history' },
      { conversationId: 'synthetic-other', title: 'Synthetic other' },
    ] });
    if (url === '/api/conversations') return Response.json({ conversation: { conversationId: `synthetic-conversation-${++nextConversation}` } });
    if (url.startsWith('/api/conversations/')) {
      const conversationId = decodeURIComponent(url.split('/').pop());
      return Response.json({ conversation: { conversationId }, messages: histories[conversationId] || [] });
    }
    if (url === '/api/tasks' && init.method === 'POST') {
      const payload = JSON.parse(init.body);
      const record = { task: {
        id: `synthetic-task-${records.length + 1}`, conversationId: payload.conversationId, status: 'running',
        requestKey: createHash('sha256').update(init.headers['Idempotency-Key']).digest('hex'),
      }, events: [] };
      records.push(record);
      if (options.blackholePost) return new Promise(() => {});
      if (options.losePost) throw new TypeError('synthetic lost POST acknowledgement');
      return Response.json({ task: metadata(record) }, { status: 202 });
    }
    if (url.startsWith('/api/tasks?')) {
      const query = new URL(url, w.location.href).searchParams;
      return Response.json({ tasks: records.filter(record =>
        (!query.get('conversationId') || query.get('conversationId') === record.task.conversationId)
        && (!query.get('requestKey') || query.get('requestKey') === record.task.requestKey)).map(metadata) });
    }
    const match = /^\/api\/tasks\/([^/?]+)(\/events\?after=(\d+))?$/.exec(url);
    if (match) {
      const record = records.find(item => item.task.id === match[1]);
      if (!record) return Response.json({ error: 'synthetic missing' }, { status: 404 });
      if (init.method === 'DELETE') {
        emit(record.task.id, 'error', { error: 'synthetic cancelled' });
        record.task.status = 'cancelled';
        emit(record.task.id, 'task.status', { status: 'cancelled' });
        return Response.json({ task: metadata(record) });
      }
      if (match[2]) {
        return new Response(new ReadableStream({ start(controller) { streams.set(record.task.id, controller); },
          cancel() { streams.delete(record.task.id); } }));
      }
      return Response.json({ task: metadata(record), snapshot: {
        events: record.expired ? [] : record.events, eventsExpired: Boolean(record.expired),
      } });
    }
    throw new Error(`Unexpected synthetic URL: ${url}`);
  };
  function emit(id, event, data, sequence) {
    const record = records.find(item => item.task.id === id);
    const item = { id: sequence || record.events.length + 1, event, data };
    if (!sequence) record.events.push(item);
    streams.get(id)?.enqueue(new TextEncoder().encode(`id: ${item.id}\r\nevent: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`));
  }
  for (const file of ['vendor/marked.umd.js', 'vendor/purify.min.js', 'answer-renderer.js', 'qa-experience.js', 'qa-tasks.js', 'client.js']) {
    w.eval(fs.readFileSync(path.join(publicRoot, file), 'utf8'));
  }
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); });
  await waitFor(() => calls.some(call => call.url.startsWith('/api/conversations?')));
  await tick();
  return { w, d, calls, copied, delays, records, streams, histories, emit,
    submit(text = 'synthetic question') {
      d.querySelector('#questionInput').value = text;
      d.querySelector('#askForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
    },
    complete(id = records[0].task.id, status = 'succeeded') {
      records.find(record => record.task.id === id).task.status = status;
      emit(id, status === 'succeeded' ? 'done' : 'error', status === 'succeeded' ? {} : { error: 'synthetic terminal' });
      emit(id, 'task.status', { status });
    },
  };
}

for (const mode of ['index', 'embed']) {
  test(`${mode}: one UUID-keyed task POST, raw Markdown/sources, busy draft and explicit DELETE stop`, async t => {
    const p = await page(t, { mode });
    p.submit();
    await waitFor(() => p.streams.size === 1);
    const taskPost = p.calls.find(call => call.url === '/api/tasks');
    assert.match(taskPost.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
    assert.deepEqual(JSON.parse(taskPost.body), { question: 'synthetic question', conversationId: 'synthetic-conversation-1' });
    const input = p.d.querySelector('#questionInput');
    const primary = p.d.querySelector('#sendButton');
    input.value = 'retained draft'; input.dispatchEvent(new p.w.Event('input'));
    input.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const raw = '\n| A | B |\n| --- | --- |\n| **value** [1] | `code[1]` |\n';
    p.emit('synthetic-task-1', 'sources', { sources: [{ index: 1, title: 'synthetic source' }] });
    p.emit('synthetic-task-1', 'delta', { text: raw });
    await waitFor(() => p.d.querySelector('table'));
    primary.click();
    await waitFor(() => primary.getAttribute('aria-label') === '发送');
    assert.equal(p.calls.filter(call => call.url === '/api/tasks' && call.method === 'POST').length, 1);
    assert.equal(p.calls.filter(call => call.method === 'DELETE').length, 1);
    assert.equal(input.value, 'retained draft');
    assert.match(p.d.querySelector('.answer-failure').textContent, /已停止/);
    p.d.querySelector('.answer-copy').click(); await tick();
    assert.deepEqual(p.copied, [raw.replace('**value** [1]', '**value** ')]);
    assert.equal(p.calls.some(call => call.url.includes('/internal/') || call.url === '/api/ask'), false);
    if (mode === 'embed') {
      const owner = taskPost.headers['X-IMA-Client-Id'];
      assert.match(owner, /^embed-/);
      for (const call of p.calls) assert.equal(call.headers['X-IMA-Client-Id'], owner);
    } else assert.equal(taskPost.headers.Authorization, undefined);
  });
}

test('EOF resumes GET same task, snapshot and SSE duplicates never duplicate delta, terminal needs no EOF', async t => {
  const p = await page(t);
  p.submit(); await waitFor(() => p.streams.size === 1);
  p.emit('synthetic-task-1', 'delta', { text: 'first ' });
  p.streams.get('synthetic-task-1').close(); p.streams.delete('synthetic-task-1');
  await waitFor(() => p.calls.some(call => call.url.endsWith('/events?after=1')));
  await waitFor(() => p.streams.size === 1);
  p.emit('synthetic-task-1', 'delta', { text: 'first ' }, 1);
  p.emit('synthetic-task-1', 'delta', { text: 'second' });
  p.complete();
  await waitFor(() => p.d.querySelector('#sendButton').getAttribute('aria-label') === '发送');
  assert.equal(p.d.querySelector('.message:last-child .answer-markdown').textContent.trim(), 'first second');
  assert.equal(p.calls.filter(call => call.method === 'POST' && call.url === '/api/tasks').length, 1);
  assert.equal(p.calls.some(call => call.method === 'DELETE'), false);
  assert.ok(p.delays.length);
});

test('network failure retries only GET with bounded backoff and keeps unknown task blocked until reconnect', async t => {
  let fail = true;
  const p = await page(t, { intercept: (url) => {
    if (url === '/api/tasks/synthetic-task-1' && fail) throw new TypeError('synthetic offline');
  } });
  p.submit();
  await waitFor(() => !p.d.querySelector('#readingActions .source-toggle').hidden);
  assert.deepEqual(p.delays, [1000, 2000, 4000, 8000, 8000]);
  assert.equal(p.d.querySelector('#sendButton').getAttribute('aria-label'), '停止回答');
  assert.equal(p.calls.filter(call => call.url === '/api/tasks').length, 1);
  fail = false;
  p.d.querySelector('#readingActions .source-toggle').click();
  await waitFor(() => p.streams.size === 1);
  p.emit('synthetic-task-1', 'delta', { text: 'recovered' }); p.complete();
  await waitFor(() => p.d.querySelector('.answer-copy'));
  assert.equal(p.calls.filter(call => call.url === '/api/tasks').length, 1);
});

test('lost POST acknowledgement recovers exact requestKey through GET, never resubmits', async t => {
  const p = await page(t, { losePost: true });
  p.submit(); await waitFor(() => p.streams.size === 1);
  const key = p.records[0].task.requestKey;
  assert.ok(p.calls.some(call => call.url.includes(`requestKey=${key}`)));
  assert.equal(p.calls.filter(call => call.url === '/api/tasks').length, 1);
  p.complete();
  await waitFor(() => p.d.querySelector('#sendButton').getAttribute('aria-label') === '发送');
});

test('blackholed POST acknowledgement retains request identity and recovers with GET only', async t => {
  const p = await page(t, { blackholePost: true });
  p.submit(); await waitFor(() => p.streams.size === 1);
  const posted = p.calls.find(call => call.url === '/api/tasks');
  assert.equal(posted.signal.aborted, true);
  const reference = JSON.parse(p.w.localStorage.getItem('ima-qa-task-reference'));
  assert.equal(reference.requestKey, p.records[0].task.requestKey);
  assert.equal(reference.id, p.records[0].task.id);
  assert.ok(p.calls.some(call => call.url.includes(`requestKey=${reference.requestKey}`)));
  assert.equal(p.calls.filter(call => call.url === '/api/tasks').length, 1);
  assert.equal(p.calls.some(call => call.method === 'DELETE'), false);
  p.complete();
  await waitFor(() => p.d.querySelector('#sendButton').getAttribute('aria-label') === '发送');
});

for (const expired of [false, true]) {
  test(`refresh terminal (expired=${expired}) uses saved history exactly once without POST or cancel`, async t => {
    const cid = 'synthetic-history';
    const raw = '\n**Saved exact** [1]\n';
    const p = await page(t, { conversationId: cid, reference: { conversationId: cid, id: 'synthetic-terminal' },
      records: [{ task: { id: 'synthetic-terminal', conversationId: cid, status: 'succeeded' }, expired,
        events: [{ id: 1, event: 'delta', data: { text: raw } }] }],
      histories: { [cid]: [{ role: 'user', content: 'past question' },
        { role: 'assistant', content: raw, sources: [{ index: 1, title: 'saved source' }] }] },
    });
    await waitFor(() => p.w.localStorage.getItem('ima-qa-task-reference') === null);
    assert.equal(p.d.querySelectorAll('.message.assistant').length, 1);
    p.d.querySelector('.answer-copy').click(); await tick();
    assert.deepEqual(p.copied, [raw.replace('[1]', '')]);
    assert.equal(p.calls.some(call => call.method === 'POST' || call.method === 'DELETE' || call.url.includes('/events?')), false);
  });
}

test('refresh discovers active task from ordinary owner list and reconstructs it without POST', async t => {
  const cid = 'synthetic-active';
  const p = await page(t, { conversationId: cid, records: [{ task: {
    id: 'synthetic-task-1', conversationId: cid, status: 'running',
  }, events: [{ id: 1, event: 'delta', data: { text: 'partial ' } }] }] });
  await waitFor(() => p.streams.size === 1);
  assert.ok(p.calls.some(call => call.url.endsWith('/events?after=1')));
  assert.match(p.d.querySelector('.message:last-child .answer-markdown').textContent, /partial/);
  p.histories[cid] = [{ role: 'assistant', content: 'partial complete' }];
  p.emit('synthetic-task-1', 'delta', { text: 'complete' }); p.complete();
  await waitFor(() => p.d.querySelector('#sendButton').getAttribute('aria-label') === '发送');
  assert.equal(p.d.querySelectorAll('.message.assistant').length, 1);
  assert.equal(p.calls.some(call => call.method === 'POST' || call.method === 'DELETE'), false);
});

test('new conversation detaches, leaves task running, and stale events cannot change current view', async t => {
  const p = await page(t);
  p.submit(); await waitFor(() => p.streams.size === 1);
  p.emit('synthetic-task-1', 'delta', { text: 'old task' });
  p.d.querySelector('#newConversationButton').click();
  await waitFor(() => p.w.localStorage.getItem('ima-qa-conversation-id') === 'synthetic-conversation-2');
  p.emit('synthetic-task-1', 'delta', { text: 'late old task' });
  await tick();
  assert.doesNotMatch(p.d.querySelector('#chatLog').textContent, /old task/);
  assert.equal(p.records[0].task.status, 'running');
  assert.equal(p.calls.some(call => call.method === 'DELETE'), false);
  assert.equal(p.d.querySelector('#sendButton').getAttribute('aria-label'), '发送');
});

for (const status of ['failed', 'indeterminate']) {
  test(`${status} is terminal, preserves received partial and never starts another task`, async t => {
    const p = await page(t);
    p.submit(); await waitFor(() => p.streams.size === 1);
    p.emit('synthetic-task-1', 'delta', { text: '**partial**' }); p.complete('synthetic-task-1', status);
    await waitFor(() => p.d.querySelector('.answer-failure'));
    assert.match(p.d.querySelector('.answer-copy').getAttribute('aria-label'), /部分/);
    assert.equal(p.d.querySelector('#statusPill').textContent, status === 'failed' ? '未完成' : '结果未知');
    assert.equal(p.calls.filter(call => call.url === '/api/tasks').length, 1);
  });
}

test('native IMA without capability is explicitly unavailable and never silently uses legacy ask', async t => {
  const p = await page(t, { capability: false });
  p.submit(); await tick();
  assert.equal(p.d.querySelector('#sendButton').disabled, true);
  assert.match(p.d.querySelector('#composerNotice').textContent, /持久任务暂不可用/);
  assert.equal(p.calls.some(call => call.method === 'POST' || call.url.startsWith('/internal/')), false);
});

test('refresh of failed task keeps replayed partial text even when history contains no completed turn', async t => {
  const cid = 'synthetic-failed-history';
  const p = await page(t, { conversationId: cid, reference: { conversationId: cid, id: 'synthetic-failed' },
    records: [{ task: { id: 'synthetic-failed', conversationId: cid, status: 'failed' }, events: [
      { id: 1, event: 'delta', data: { text: '**received partial**' } },
      { id: 2, event: 'error', data: { error: 'synthetic failure' } },
      { id: 3, event: 'task.status', data: { status: 'failed' } },
    ] }],
  });
  await waitFor(() => p.d.querySelector('.answer-copy'));
  p.d.querySelector('.answer-copy').click(); await tick();
  assert.deepEqual(p.copied, ['**received partial**']);
  assert.match(p.d.querySelector('.answer-failure').textContent, /synthetic failure/);
  assert.equal(p.calls.some(call => call.method === 'POST'), false);
});

test('sequence gap reconnects through full snapshot and does not commit an out-of-order delta', async t => {
  const p = await page(t);
  p.submit(); await waitFor(() => p.streams.size === 1);
  p.emit('synthetic-task-1', 'delta', { text: 'invalid future' }, 3);
  p.records[0].events.push({ id: 1, event: 'delta', data: { text: 'valid first ' } },
    { id: 2, event: 'delta', data: { text: 'valid second' } });
  await waitFor(() => p.calls.some(call => call.url.endsWith('/events?after=2')));
  await waitFor(() => p.streams.size === 1);
  p.complete(); await waitFor(() => p.d.querySelector('.answer-copy'));
  assert.equal(p.d.querySelector('.message:last-child .answer-markdown').textContent.trim(), 'valid first valid second');
  assert.equal(p.calls.filter(call => call.url === '/api/tasks').length, 1);
});

test('failed task-list restoration blocks send until GET recovery confirms no active task', async t => {
  let fail = true;
  const p = await page(t, { conversationId: 'synthetic-history', intercept: url => {
    if (url.startsWith('/api/tasks?') && fail) throw new TypeError('synthetic offline');
  } });
  await waitFor(() => !p.d.querySelector('.task-reconnect').hidden);
  assert.equal(p.d.querySelector('#sendButton').disabled, true);
  p.submit(); await tick();
  assert.equal(p.calls.some(call => call.method === 'POST'), false);
  fail = false;
  p.d.querySelector('.task-reconnect').click();
  await waitFor(() => !p.d.querySelector('#sendButton').disabled);
  assert.equal(p.calls.some(call => call.method === 'POST'), false);
});

test('process text is escaped, remains outside answer copy and is removed at completion', async t => {
  const p = await page(t);
  p.submit(); await waitFor(() => p.streams.size === 1);
  p.emit('synthetic-task-1', 'process', { text: '<img src=x onerror=alert(1)> synthetic process' });
  p.emit('synthetic-task-1', 'delta', { text: 'only answer' });
  await waitFor(() => p.d.querySelector('.task-process'));
  assert.equal(p.d.querySelector('.task-process img'), null);
  assert.match(p.d.querySelector('.task-process').textContent, /<img/);
  p.complete(); await waitFor(() => p.d.querySelector('.answer-copy'));
  assert.equal(p.d.querySelector('.task-process'), null);
  p.d.querySelector('.answer-copy').click(); await tick();
  assert.deepEqual(p.copied, ['only answer']);
});

test('non-IMA local RAG intentionally retains legacy ask without durable capability', async t => {
  const p = await page(t, { capability: false, provider: 'local-rag-mimo', intercept: url => {
    if (url === '/api/ask') return new Response('event: delta\ndata: {"text":"legacy"}\n\nevent: done\ndata: {}\n\n');
  } });
  p.submit();
  await waitFor(() => p.d.querySelector('.answer-copy'));
  assert.equal(p.calls.filter(call => call.url === '/api/ask').length, 1);
  assert.equal(p.calls.some(call => call.url === '/api/tasks'), false);
});
