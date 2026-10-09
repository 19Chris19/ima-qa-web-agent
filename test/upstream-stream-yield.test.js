const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { once } = require('node:events');
const { parseIMAWebAgentStream } = require('../src/ima-upstream-protocol');

for (const controls of [false, true]) {
  test(`dense ${controls ? 'control' : 'semantic'} frames allow an HTTP observer before completion`, async () => {
    let completed = false;
    const observed = [];
    const server = http.createServer((_req, res) => {
      observed.push(completed);
      res.end('healthy');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let request;
    const reply = new Promise((resolve, reject) => {
      request = http.get(`http://127.0.0.1:${server.address().port}`, res => {
        res.resume(); res.on('end', resolve);
      });
      request.on('error', reject);
    });
    const texts = Array.from({ length: 1024 }, (_, i) => ` item ${i}\n`);
    const frames = texts.map(text => controls ? 'event: HEARTBEAT\ndata: {}'
      : `event: MESSAGE\ndata: ${JSON.stringify({ Text: text })}`);
    frames.push('event: COMPLETED\ndata: {"Code":0}');
    const response = new Response(frames.join('\n\n') + '\n\n');
    const events = [];
    try {
      for await (const event of parseIMAWebAgentStream(response)) events.push(event);
      completed = true;
      await reply;
      assert.deepEqual(observed, [false]);
      assert.equal(events.filter(e => e.type === 'done').length, 1);
      assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), controls ? '' : texts.join(''));
    } finally {
      request.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('native dense task stays observable while persisting every delta exactly once', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createApp } = require('../src/app');
  const { ConversationStore } = require('../src/conversation-store');
  const { IMAWebAgentClient } = require('../src/ima-web-agent-client');
  const { taskTransportFetch } = require('../src/task-transport');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-dense-task-'));
  const storePath = path.join(root, 'history.json');
  const conversations = new ConversationStore({ storePath });
  const owner = 'synthetic-observer';
  const conversationId = conversations.create(owner, { mode: 'knowledge_agent' }).conversationId;
  const texts = Array.from({ length: 512 }, (_, i) => ` synthetic ${i}\n`);
  let posts = 0;
  const upstream = http.createServer((req, res) => {
    req.resume();
    if (req.url.endsWith('/init_session')) {
      res.end(JSON.stringify({ session_id: 'synthetic-session' })); return;
    }
    posts += 1;
    res.setHeader('content-type', 'text/event-stream');
    res.end(texts.map(text => `event: MESSAGE\ndata: ${JSON.stringify({ Text: text })}\n\n`).join('')
      + 'event: COMPLETED\ndata: {"Code":0}\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const client = new IMAWebAgentClient({ knowledgeBaseId: 'synthetic-kb', modelId: 'official_3', modelType: 3,
    headers: { 'x-ima-cookie': 'IMA-TOKEN=synthetic-unused', 'x-ima-bkn': '123' },
    taskFetchImpl: (url, options) => taskTransportFetch(`http://127.0.0.1:${upstream.address().port}${new URL(url).pathname}`, options),
  }, () => assert.fail('must use native transport'));
  const app = createApp({
    config: { qaProvider: 'ima-web-agent', mimo: {}, webAgent: {}, conversations: { storePath },
      security: { apiToken: 'synthetic-api' }, concurrency: { maxConcurrentAsk: 1, queueLimit: 4 },
      limits: { maxQuestionLength: 2000 }, rateLimit: { windowMs: 0, max: 0 } },
    conversationStore: conversations, imaWebAgentClient: client,
    webReadiness: { mode: 'knowledge_agent', snapshot: () => ({ mode: 'knowledge_agent' }) },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    app.locals.durableQATasks.close();
    server.closeAllConnections(); upstream.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer synthetic-api', 'content-type': 'application/json',
    'x-ima-client-id': owner, 'Idempotency-Key': 'synthetic-dense-task' };
  const store = app.locals.durableQATasks.store;
  const append = store.append.bind(store);
  let health;
  store.append = (id, event, data) => {
    const result = append(id, event, data);
    if (event === 'delta' && !health) {
      health = fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) }).then(async response => {
        await response.text();
        return { status: response.status, duringStream: store.tasks.get(id).status === 'running' };
      });
    }
    return result;
  };
  const accepted = await fetch(`${base}/api/tasks`, { method: 'POST', headers,
    body: JSON.stringify({ conversationId, question: 'Synthetic dense answer' }) });
  assert.equal(accepted.status, 202);
  const { task } = await accepted.json();
  const replay = await (await fetch(`${base}/api/tasks/${task.id}/events`, { headers })).text();
  assert.match(replay, /event: done/);
  assert.deepEqual(await health, { status: 200, duringStream: true });
  const final = await (await fetch(`${base}/api/tasks/${task.id}`, { headers })).json();
  assert.equal(final.task.status, 'succeeded');
  assert.equal(final.snapshot.events.filter(e => e.event === 'done').length, 1);
  assert.equal(final.snapshot.events.filter(e => e.event === 'delta').map(e => e.data.text).join(''), texts.join(''));
  assert.equal(conversations.getHistory(conversationId, owner).at(-1).content, texts.join(''));
  assert.equal(posts, 1);
});
