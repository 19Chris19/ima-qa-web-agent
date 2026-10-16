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
  const frames = new Map(), paints = [];
  let nextFrame = 0;
  if (options.manualFrames) {
    w.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
    w.cancelAnimationFrame = id => frames.delete(id);
  }
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
    const parsed = new URL(url, w.location.href); parsed.searchParams.delete('presentation');
    url = parsed.pathname + (parsed.searchParams.size ? '?' + parsed.searchParams : '');
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
        id: `synthetic-task-${records.length + 1}`, conversationId: payload.conversationId, status: options.taskStatus || 'running',
        question: payload.question, sourceIntent: payload.sourceIntent || 'knowledge',
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
  for (const file of ['vendor/marked.umd.js', 'vendor/purify.min.js', ...(options.presentation ? ['chat-presentation.js'] : []), 'answer-renderer.js', 'qa-experience.js', 'chat-controls.js', 'qa-tasks.js', 'client.js']) {
    w.eval(fs.readFileSync(path.join(publicRoot, file), 'utf8'));
    if (file === 'answer-renderer.js') {
      const render = w.ImaAnswerRenderer.updateAnswerElement;
      w.ImaAnswerRenderer.updateAnswerElement = (target, markdown, settings) => {
        paints.push({ markdown, settings });
        return render(target, markdown, settings);
      };
    }
  }
  t.after(() => { w.dispatchEvent(new w.Event('pagehide')); w.close(); });
  await waitFor(() => calls.some(call => call.url.startsWith('/api/conversations?')));
  await tick();
  return { w, d, calls, copied, delays, records, streams, histories, emit, paints, frames,
    paintFrame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
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

const deferred = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};

for (const mode of ['index', 'embed']) for (const entrance of ['icon', 'message menu']) test(`${mode} ${entrance}: confirmed failure retries once, preserves draft and original record, and keeps web intent`, async t => {
  const check = deferred(); let hold = false;
  const p = await page(t, { mode, intercept: async url => {
    if (hold && url === '/api/tasks/synthetic-task-1') { hold = false; await check.promise; }
  } });
  p.submit('original synthetic question'); await waitFor(() => p.streams.size === 1);
  p.records[0].task.question = 'original synthetic question'; p.records[0].task.sourceIntent = 'web';
  p.complete('synthetic-task-1', 'failed');
  await waitFor(() => p.d.querySelector('.answer-retry') && !p.d.querySelector('.answer-retry').disabled);
  const original = JSON.stringify(p.records[0]);
  const input = p.d.querySelector('#questionInput'); input.value = 'unsent draft'; input.dispatchEvent(new p.w.Event('input'));
  const retry = p.d.querySelector('.answer-retry'); hold = true;
  if (entrance === 'message menu') {
    p.d.querySelector('.message.user .message-actions-trigger').click();
    assert.equal(p.d.querySelector('.message-action-item[data-action="retry"] span').textContent, '重试');
    p.d.querySelector('.message-action-item[data-action="retry"]').click();
  } else retry.click();
  retry.click(); assert.equal(retry.disabled, true); assert.equal(p.records.length, 1);
  check.release(); await waitFor(() => p.records.length === 2);
  const posts = p.calls.filter(call => call.url === '/api/tasks' && call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(posts[1].body), { question: 'original synthetic question', conversationId: 'synthetic-conversation-1', sourceIntent: 'web' });
  assert.equal(input.value, 'unsent draft'); assert.equal(JSON.stringify(p.records[0]), original);
  assert.equal(p.d.querySelectorAll('.message.user').length, 2); assert.ok(p.d.querySelector('.answer-failure'));
  await waitFor(() => p.streams.has('synthetic-task-2')); p.complete('synthetic-task-2');
});

test('retry verification failure and indeterminate recovery never dispatch a new question', async t => {
  let rejectRead = false;
  const p = await page(t, { intercept: async url => rejectRead && url === '/api/tasks/synthetic-task-1'
    ? Response.json({ error: 'synthetic denial' }, { status: 403 }) : null });
  p.submit(); await waitFor(() => p.streams.size === 1); p.complete('synthetic-task-1', 'failed');
  await waitFor(() => p.d.querySelector('.answer-retry') && !p.d.querySelector('.answer-retry').disabled);
  rejectRead = true; p.d.querySelector('.answer-retry').click();
  await waitFor(() => p.d.querySelector('.retry-status').textContent.includes('没有重新发送'));
  assert.equal(p.records.length, 1);
  rejectRead = false; p.records[0].task.status = 'indeterminate';
  p.d.querySelector('.answer-retry').click();
  await waitFor(() => p.d.querySelector('.answer-retry')?.textContent === '检查原任务');
  p.d.querySelector('.message.user .message-actions-trigger').click();
  assert.equal(p.d.querySelector('.message-action-item[data-action="retry"] span').textContent, '检查原任务');
  p.d.querySelector('.message-action-item[data-action="retry"]').click();
  await waitFor(() => p.d.querySelector('.answer-retry')?.textContent === '检查原任务');
  assert.equal(p.records.length, 1); assert.equal(p.d.querySelector('#sendButton').disabled, true);
});

for (const mode of ['index', 'embed']) {
  test(`${mode}: burst paints once per frame and terminal flush preserves exact Markdown`, async t => {
    const p = await page(t, { mode, manualFrames: true });
    p.submit(); await waitFor(() => p.streams.size === 1);
    const first = '\r\n# Synthetic burst\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 你好 | 👩‍💻 |\r\n' + ' body '.repeat(80);
    for (const text of Array.from(first)) p.emit('synthetic-task-1', 'delta', { text });
    await waitFor(() => p.d.querySelector('#statusPill').textContent === '生成中');
    await tick();
    assert.equal(p.frames.size, 1);
    assert.equal(p.paints.filter(row => row.settings?.streaming).length, 0);
    p.paintFrame();
    const streaming = p.paints.filter(row => row.settings?.streaming);
    assert.equal(streaming.length, 1);
    assert.equal(streaming[0].markdown, first);
    const final = first + '\r\n```js\r\n  const n = 1;\r\n```\r\n';
    p.emit('synthetic-task-1', 'delta', { text: final.slice(first.length) });
    await tick();
    assert.equal(p.frames.size, 1);
    p.complete(); await waitFor(() => p.d.querySelector('.answer-copy'));
    assert.equal(p.frames.size, 0, 'terminal flush must not wait for another animation frame');
    p.d.querySelector('.answer-copy').click(); await tick();
    assert.deepEqual(p.copied, [final]);
    assert.equal(p.d.querySelectorAll('.message.user').length, 1);
    assert.equal(p.calls.filter(call => call.url === '/api/tasks' && call.method === 'POST').length, 1);
  });

  test(`${mode}: click feedback precedes network and definite rejection restores the exact draft`, async t => {
    const create = deferred(), post = deferred();
    t.after(() => { create.release(); post.release(); });
    const p = await page(t, { mode, intercept: async (url, init) => {
      if (url === '/api/conversations') { await create.promise; return Response.json({ conversation: { conversationId: 'synthetic-conversation-1' } }); }
      if (url === '/api/tasks' && init.method === 'POST') { await post.promise; return Response.json({ error: 'synthetic rejected' }, { status: 429 }); }
    } });
    const original = '  Synthetic retained draft\n';
    p.submit(original);
    const primary = p.d.querySelector('#sendButton');
    assert.equal(primary.classList.contains('is-submitting'), true);
    assert.equal(primary.getAttribute('aria-busy'), 'true');
    assert.equal(primary.disabled, true);
    assert.match(p.d.querySelector('#composerNotice').textContent, /准备会话/);
    assert.equal(p.d.querySelectorAll('.message.user').length, 1);
    p.d.querySelector('#askForm').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    assert.equal(p.calls.filter(call => call.url === '/api/conversations' && call.method === 'POST').length, 1);
    create.release(); await waitFor(() => p.calls.some(call => call.url === '/api/tasks'));
    assert.match(p.d.querySelector('#composerNotice').textContent, /发送问题/);
    post.release(); await waitFor(() => primary.getAttribute('aria-label') === '发送');
    assert.equal(p.d.querySelector('#questionInput').value, original);
    assert.match(p.d.querySelector('#composerNotice').textContent, /草稿已恢复/);
    assert.equal(primary.getAttribute('aria-busy'), 'false');
    assert.equal(p.w.localStorage.getItem('ima-qa-task-reference'), null);
    assert.equal(p.calls.filter(call => call.url === '/api/tasks' && call.method === 'POST').length, 1);
  });
}

for (const newerDraft of ['Synthetic next draft', '']) {
  test(`definite rejection never overwrites an edited draft (${newerDraft ? 'text' : 'deleted'})`, async t => {
    const post = deferred(); t.after(() => post.release());
    const p = await page(t, { intercept: async (url, init) => {
      if (url === '/api/tasks' && init.method === 'POST') { await post.promise; return Response.json({}, { status: 409 }); }
    } });
    p.submit('Synthetic original'); await waitFor(() => p.calls.some(call => call.url === '/api/tasks'));
    const input = p.d.querySelector('#questionInput');
    input.value = 'edited'; input.dispatchEvent(new p.w.Event('input'));
    input.value = newerDraft; input.dispatchEvent(new p.w.Event('input'));
    post.release(); await waitFor(() => p.d.querySelector('#sendButton').getAttribute('aria-label') === '发送');
    assert.equal(input.value, newerDraft);
    assert.doesNotMatch(p.d.querySelector('#composerNotice').textContent, /草稿已恢复/);
  });
}

test('failed conversation creation restores draft without dispatching a task', async t => {
  const p = await page(t, { intercept: url => url === '/api/conversations' ? Response.json({}, { status: 503 }) : undefined });
  p.submit('Synthetic retained question');
  await waitFor(() => p.d.querySelector('#sendButton').getAttribute('aria-label') === '发送');
  assert.equal(p.d.querySelector('#questionInput').value, 'Synthetic retained question');
  assert.equal(p.calls.some(call => call.url === '/api/tasks'), false);
});

test('HTTP 408 remains ambiguous: query the original identity, keep sends blocked and never restore/resubmit', async t => {
  const p = await page(t, { intercept: (url, init) => url === '/api/tasks' && init.method === 'POST'
    ? Response.json({}, { status: 408 }) : undefined });
  p.submit('Synthetic uncertain question');
  await waitFor(() => !p.d.querySelector('.task-reconnect').hidden);
  assert.equal(p.d.querySelector('#questionInput').value, '');
  assert.ok(p.w.localStorage.getItem('ima-qa-task-reference'));
  assert.ok(p.calls.some(call => call.url.includes('requestKey=')));
  assert.equal(p.d.querySelector('#sendButton').disabled, true);
  p.submit('Do not dispatch'); await tick();
  assert.equal(p.calls.filter(call => call.url === '/api/tasks' && call.method === 'POST').length, 1);
  assert.equal(p.calls.some(call => call.method === 'DELETE'), false);
});

test('queued, waiting, generating and reconnecting reflect real task/transport evidence', async t => {
  let snapshots = 0;
  const recovery = deferred(); t.after(() => recovery.release());
  const p = await page(t, { taskStatus: 'queued', intercept: async url => {
    if (url === '/api/tasks/synthetic-task-1' && ++snapshots > 1) await recovery.promise;
  } });
  p.submit(); await waitFor(() => p.streams.size === 1);
  assert.equal(p.d.querySelector('#statusPill').textContent, '排队中');
  p.records[0].task.status = 'running';
  p.emit('synthetic-task-1', 'task.status', { status: 'running' });
  await waitFor(() => p.d.querySelector('#statusPill').textContent === '等待回答');
  p.emit('synthetic-task-1', 'process', { text: 'Synthetic upstream message' });
  await tick(); assert.equal(p.d.querySelector('#statusPill').textContent, '等待回答');
  p.emit('synthetic-task-1', 'delta', { text: 'Synthetic received text' });
  await waitFor(() => p.d.querySelector('#statusPill').textContent === '生成中');
  p.streams.get('synthetic-task-1').close(); p.streams.delete('synthetic-task-1');
  await waitFor(() => p.d.querySelector('#statusPill').textContent === '重新连接中');
  assert.match(p.d.querySelector('#composerNotice').textContent, /同一任务/);
  assert.match(p.d.querySelector('.message:last-child .answer-markdown').textContent, /Synthetic received text/);
  recovery.release(); await waitFor(() => p.streams.size === 1);
  assert.equal(p.d.querySelector('#statusPill').textContent, '生成中');
  p.complete(); await waitFor(() => p.d.querySelector('.answer-copy'));
});

test('switching conversation discards an unpainted frame without cancelling the old task', async t => {
  const p = await page(t, { manualFrames: true });
  p.submit(); await waitFor(() => p.streams.size === 1);
  p.emit('synthetic-task-1', 'delta', { text: 'Synthetic stale frame' });
  await waitFor(() => p.frames.size === 1);
  p.d.querySelector('#newConversationButton').click();
  await waitFor(() => p.w.localStorage.getItem('ima-qa-conversation-id') === 'synthetic-conversation-2');
  assert.equal(p.frames.size, 0);
  p.paintFrame();
  assert.doesNotMatch(p.d.querySelector('#chatLog').textContent, /stale frame/);
  assert.equal(p.records[0].task.status, 'running');
  assert.equal(p.calls.some(call => call.method === 'DELETE'), false);
});

test('BFCache return discards old paint and restores the same task with GET before allowing sends', async t => {
  const p = await page(t, { manualFrames: true });
  p.submit(); await waitFor(() => p.streams.size === 1);
  p.emit('synthetic-task-1', 'delta', { text: 'Synthetic resumed answer' });
  await waitFor(() => p.frames.size === 1);
  p.w.dispatchEvent(new p.w.Event('pagehide'));
  await waitFor(() => p.streams.size === 0);
  assert.equal(p.frames.size, 0);
  p.w.dispatchEvent(new p.w.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(p.d.querySelector('#sendButton').disabled, true, 'restoration gates new submissions synchronously');
  await waitFor(() => p.streams.size === 1);
  p.paintFrame();
  assert.match(p.d.querySelector('.message:last-child .answer-markdown').textContent, /Synthetic resumed answer/);
  assert.equal(p.calls.filter(call => call.url === '/api/tasks' && call.method === 'POST').length, 1);
  assert.equal(p.calls.some(call => call.method === 'DELETE'), false);
  p.histories['synthetic-conversation-1'] = [{ role: 'user', content: 'synthetic question' },
    { role: 'assistant', content: 'Synthetic resumed answer' }];
  p.complete(); await waitFor(() => p.d.querySelector('.answer-copy'));
});

for (const status of ['failed', 'cancelled', 'indeterminate']) {
  test(`${status} flushes an unpainted partial answer and cancels the pending frame`, async t => {
    const p = await page(t, { manualFrames: true });
    p.submit(); await waitFor(() => p.streams.size === 1);
    p.emit('synthetic-task-1', 'delta', { text: '**Synthetic exact partial**\n' });
    await waitFor(() => p.frames.size === 1);
    p.complete('synthetic-task-1', status);
    await waitFor(() => p.d.querySelector('.answer-copy'));
    assert.equal(p.frames.size, 0);
    assert.match(p.d.querySelector('.answer-failure').textContent, status === 'cancelled' ? /已停止/ : status === 'indeterminate' ? /尚无法确认/ : /未完成/);
    assert.equal(p.d.querySelector('.answer-failure').dataset.outcome, status);
    p.d.querySelector('.answer-copy').click(); await tick();
    assert.deepEqual(p.copied, ['**Synthetic exact partial**\n']);
  });
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
  await waitFor(() => p.calls.some(call => call.url.endsWith('/events?after=1&presentation=chat_v1')));
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
  assert.ok(p.calls.some(call => call.url.endsWith('/events?after=1&presentation=chat_v1')));
  // Transport subscription can precede requestAnimationFrame painting on a busy runner.
  await waitFor(() => p.d.querySelector('.message:last-child .answer-markdown')?.textContent.includes('partial'));
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
  assert.match(p.d.querySelector('.answer-failure').textContent, /未完成.*已保留/);
  assert.doesNotMatch(p.d.querySelector('.answer-failure').textContent, /synthetic failure/);
  assert.equal(p.calls.some(call => call.method === 'POST'), false);
});

test('sequence gap reconnects through full snapshot and does not commit an out-of-order delta', async t => {
  const p = await page(t);
  p.submit(); await waitFor(() => p.streams.size === 1);
  p.emit('synthetic-task-1', 'delta', { text: 'invalid future' }, 3);
  p.records[0].events.push({ id: 1, event: 'delta', data: { text: 'valid first ' } },
    { id: 2, event: 'delta', data: { text: 'valid second' } });
  await waitFor(() => p.calls.some(call => call.url.endsWith('/events?after=2&presentation=chat_v1')));
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


for (const mode of ['index', 'embed']) test(`${mode}: chat_v1 metadata reaches the actual composer and native page`, async t => {
  const p = await page(t, { mode, presentation: true });
  p.submit(); await waitFor(() => p.streams.size === 1);
  const id = p.records[0].task.id;
  p.emit(id, 'sources', { citationMap: { 'index:42': { type: 'web', sources: [{ url: 'https://example.org/one', title: 'Web', snippet: 'excerpt' }] },
    'index:5': { type: 'knowledge', title: 'PRIVATE KB' } } });
  p.emit(id, 'process', { phase: 'web', status: 'completed', text: 'PRIVATE PROCESS' });
  p.emit(id, 'delta', { text: 'Answer[7](@index-ref?id=42)[2](@index-ref?id=5)' });
  p.emit(id, 'suggestions', { suggestions: ['one', 'two', 'three'] });
  p.complete(id);
  await waitFor(() => p.d.querySelector('.chat-suggestions button') && !p.d.querySelector('#sendButton').classList.contains('is-busy'));
  assert.equal(p.d.querySelector('[data-citation-key="index:42"]').textContent, '7');
  assert.equal(p.d.querySelectorAll('.chat-citation-static').length, 1);
  assert.doesNotMatch(p.d.querySelector('#chatLog').textContent, /PRIVATE/);
  assert.ok(p.calls.some(call => /tasks\/[^/]+\?presentation=chat_v1$/u.test(call.url)));
  p.d.querySelector('.chat-suggestions button').click();
  assert.equal(p.d.querySelector('#questionInput').value, 'one');
  assert.ok([...p.d.querySelectorAll('.chat-suggestions button')].every(control => control.disabled));
  assert.equal(p.calls.filter(call => call.method === 'POST' && call.url === '/api/tasks').length, 1);
});
