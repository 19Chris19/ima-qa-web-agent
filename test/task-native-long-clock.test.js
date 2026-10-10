const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createAskQueue } = require('../src/ask-queue');
const { IMAWebAgentClient } = require('../src/ima-web-agent-client');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { taskTransportFetch } = require('../src/task-transport');

test('real-clock task route -> fair queue -> pool -> native HTTP survives 365 seconds of upstream silence', {
  skip: process.env.TASK_NATIVE_LONG_CLOCK !== '1', timeout: 410_000,
}, async t => {
  const coreRoot = path.resolve(process.env.PROVIDER_TASK_CORE_ROOT || path.join(__dirname, '..'));
  const { createApp } = require(path.join(coreRoot, 'src/app'));
  const { ConversationStore } = require(path.join(coreRoot, 'src/conversation-store'));
  const coreHashes = Object.fromEntries(['app.js', 'durable-qa-tasks.js', 'durable-qa-store.js', 'durable-qa-routes.js']
    .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(coreRoot, 'src', file))).digest('hex')]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-native-long-clock-'));
  const historyPath = path.join(root, 'history.json');
  const conversations = new ConversationStore({ storePath: historyPath });
  const owner = 'synthetic-long-clock-owner';
  const conversationId = conversations.create(owner, { mode: 'knowledge_agent' }).conversationId;
  let qaPosts = 0;
  let qaStarted;
  let completionTimer;
  const upstream = http.createServer((req, res) => {
    req.resume();
    if (req.url.endsWith('/init_session')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ session_id: 'synthetic-long-session' }));
      return;
    }
    assert.ok(req.url.endsWith('/assistant/qa'));
    qaPosts++;
    qaStarted = Date.now();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    // No body bytes at all for >6 real minutes, crossing fetch's usual 300s edge.
    completionTimer = setTimeout(() => res.end(
      'event: MESSAGE\ndata: {"Text":"Synthetic long-clock answer\\n"}\n\n'
      + 'event: COMPLETED\ndata: {"Code":0}\n\n'), 365_000);
    res.on('close', () => clearTimeout(completionTimer));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const pool = new IMAWebAgentPool({ accounts: [{ id: 'synthetic', knowledgeBaseId: 'synthetic-kb',
    modelId: 'official_3', modelType: 3,
    headers: { 'x-ima-cookie': 'IMA-TOKEN=synthetic-unused', 'x-ima-bkn': '123' } }] }, {
    clientFactory: account => new IMAWebAgentClient({ ...account,
      taskFetchImpl: (url, options) => {
        assert.deepEqual(options.transportTimeouts, { headersMs: 60_000, idleMs: 600_000 });
        return taskTransportFetch(upstreamBase + new URL(url).pathname, options);
      },
    }, () => assert.fail('long-clock chain must use native task transport')),
  });
  const app = createApp({
    config: { qaProvider: 'ima-web-agent', mimo: {}, webAgent: { sharedKnowledgeBaseId: 'synthetic-kb' },
      conversations: { storePath: historyPath }, security: { apiToken: 'synthetic-api' },
      concurrency: { maxConcurrentAsk: 1, queueLimit: 4, requestTimeoutMs: 180_000 },
      limits: { maxQuestionLength: 2000 }, rateLimit: { windowMs: 0, max: 0 } },
    conversationStore: conversations, imaWebAgentClient: pool,
    webReadiness: { mode: 'knowledge_agent', snapshot: () => ({ mode: 'knowledge_agent' }) },
  });
  // Compose separate owners' work without modifying either checkout's core files.
  Object.assign(app.locals.imaQaAskQueue, createAskQueue({ maxConcurrent: 1, queueLimit: 4 }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    app.locals.durableQATasks?.close();
    clearTimeout(completionTimer);
    server.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api/tasks`;
  const headers = { authorization: 'Bearer synthetic-api', 'content-type': 'application/json',
    'x-ima-client-id': owner, 'Idempotency-Key': 'synthetic-native-long-clock' };
  const started = Date.now();
  t.diagnostic(JSON.stringify({ startedAt: new Date(started).toISOString(), coreHashes }));
  const posted = await fetch(base, { method: 'POST', headers,
    body: JSON.stringify({ conversationId, question: 'Synthetic long-clock question' }) });
  assert.equal(posted.status, 202);
  const { task } = await posted.json();
  const first = await fetch(`${base}/${task.id}/events`, { headers });
  await first.body.cancel();
  const replay = await fetch(`${base}/${task.id}/events`, { headers });
  const rotated = await replay.text();
  assert.match(rotated, /: heartbeat/, JSON.stringify(pool.stats({ includeDetails: true })));
  assert.doesNotMatch(rotated, /event: done/);
  assert.ok(Date.now() - started >= 240_000);
  const running = await (await fetch(`${base}/${task.id}`, { headers })).json();
  assert.equal(running.task.status, 'running');
  assert.equal(qaPosts, 1);
  assert.equal(pool.stats().activeRequests, 1);
  assert.equal(pool.stats().totalSlots, 1);
  t.diagnostic(JSON.stringify({ rotationElapsedMs: Date.now() - started, qaPosts }));
  const completed = await (await fetch(`${base}/${task.id}/events?after=${running.task.lastEventId}`, { headers })).text();
  assert.match(completed, /event: done/);
  assert.ok(Date.now() - qaStarted >= 365_000);
  const final = await (await fetch(`${base}/${task.id}`, { headers })).json();
  assert.equal(final.task.status, 'succeeded');
  assert.equal(final.snapshot.events.filter(event => event.event === 'done').length, 1);
  assert.equal(qaPosts, 1);
  assert.equal(conversations.getHistory(conversationId, owner).length, 2);
  assert.equal(pool.stats().activeRequests, 0);
  assert.equal(app.locals.imaQaAskQueue.stats().activeRequests, 0);
  t.diagnostic(JSON.stringify({ elapsedMs: Date.now() - started, upstreamSilentMs: Date.now() - qaStarted,
    qaPosts, terminal: final.task.status, historyMessages: conversations.getHistory(conversationId, owner).length }));
});
