const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../src/app');
const { ConversationStore } = require('../src/conversation-store');

async function withExample(options, fn) {
  const { createWebBff } = await import('../examples/web-bff/server.mjs');
  const server = createWebBff(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('synthetic web BFF supports a first question, follow-up and owned history without credentials', async () => {
  await withExample({}, async base => {
    const initial = await fetch(base);
    assert.equal(initial.status, 200);
    assert.doesNotMatch(await initial.text(), /Bearer /u);
    const cookie = initial.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    const send = (question, conversationId = '') => fetch(`${base}/api/ask`, {
      method: 'POST', headers, body: JSON.stringify({ question, conversationId, requestId: randomUUID() }),
    });
    const first = await send('Synthetic first question');
    const firstEvents = await first.text();
    assert.equal(first.status, 200);
    assert.match(firstEvents, /event: done/u);
    const id = /"conversationId":"([^"]+)"/u.exec(firstEvents)[1];
    const second = await send('Synthetic follow-up', id);
    assert.match(await second.text(), /合成追问回答/u);
    const history = await fetch(`${base}/api/conversations/${id}`, { headers: { Cookie: cookie } });
    assert.equal((await history.json()).messages.length, 4);
    assert.equal((await fetch(`${base}/api/conversations/${id}`)).status, 404);
  });
});

test('real web BFF uses separate server-side credentials and only forwards protected native fields', async () => {
  const calls = [];
  const scope = createHash('sha256').update('synthetic-kb').digest('hex');
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/internal/provider-a/capacity')) return new Response(JSON.stringify({ schemaVersion: 1, policies: { knowledge_agent: { max_concurrent: 2 } }, features: { knowledge_agent_keyed_sse_v1: true, source_intent_web_requested_v1: true } }), { status: 200 });
    if (url.includes('/api/conversations?')) return new Response('{}', { status: 200 });
    if (url.endsWith('/internal/provider-a/deep-ask')) return new Response('event: conversation\ndata: {"conversationId":"synthetic"}\n\nevent: delta\ndata: {"text":"Answer"}\n\nevent: done\ndata: {"source_count":0}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    throw new Error('unexpected request');
  };
  await withExample({ mode: 'real', providerUrl: 'http://127.0.0.1:3117', apiToken: 'synthetic-ordinary-token',
    serviceToken: 'synthetic-service-token', scopeRef: scope, fetchImpl: fakeFetch }, async base => {
    const home = await fetch(base);
    const cookie = home.headers.get('set-cookie').split(';')[0];
    const html = await home.text();
    assert.doesNotMatch(html, /synthetic-(ordinary|service)-token/u);
    const state = await (await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).json();
    assert.equal(state.ready, true);
    assert.equal(state.contractSupported, true);
    const response = await fetch(`${base}/api/ask`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Synthetic question', requestId: randomUUID(), sourceIntent: 'web' }) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: done/u);
    const ask = calls.find(call => call.url.endsWith('/internal/provider-a/deep-ask'));
    const body = JSON.parse(ask.options.body);
    assert.equal(ask.options.headers.Authorization, 'Bearer synthetic-service-token');
    assert.match(ask.options.headers['Idempotency-Key'], /^[a-f0-9]{64}$/u);
    assert.equal(body.retrieval_policy, 'knowledge_agent');
    assert.equal(body.knowledge_scope_ref, scope);
    assert.equal(body.source_intent, 'web_requested');
    assert.equal(calls.find(call => call.url.includes('/api/conversations?')).options.headers.Authorization, 'Bearer synthetic-ordinary-token');
  });
});

test('real web BFF does not mark an older capacity contract ready', async () => {
  const fakeFetch = async (url) => {
    if (url.endsWith('/internal/provider-a/capacity')) return new Response(JSON.stringify({ schemaVersion: 1,
      policies: { knowledge_agent: { max_concurrent: 2 } } }), { status: 200 });
    if (url.includes('/api/conversations?')) return new Response('{}', { status: 200 });
    throw new Error('unexpected request');
  };
  await withExample({ mode: 'real', providerUrl: 'http://127.0.0.1:3117', apiToken: 'synthetic-ordinary-token',
    serviceToken: 'synthetic-service-token', scopeRef: createHash('sha256').update('synthetic-kb').digest('hex'), fetchImpl: fakeFetch }, async base => {
    const home = await fetch(base);
    const cookie = home.headers.get('set-cookie').split(';')[0];
    const state = await (await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).json();
    assert.equal(state.authenticated, true);
    assert.equal(state.contractSupported, false);
    assert.equal(state.ready, false);
  });
});

test('web BFF rejects cross-origin posting before dispatch', async () => {
  await withExample({}, async base => {
    const response = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' });
    assert.equal(response.status, 403);
  });
});

test('real BFF and Provider A contract complete two isolated native turns without IMA credentials', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ima-web-bff-integration-'));
  const storePath = path.join(root, 'conversations.json');
  const sessions = [];
  const config = {
    qaProvider: 'ima-web-agent', mimo: { model: 'synthetic' }, webAgent: { sharedKnowledgeBaseId: 'synthetic-kb' },
    security: { apiToken: 'synthetic-api-token', internalServiceToken: 'synthetic-service-token', allowedOrigins: [] },
    limits: { maxQuestionLength: 2000 }, concurrency: { maxConcurrentAsk: 1, queueLimit: 2, requestTimeoutMs: 2000 },
    rateLimit: { windowMs: 0, max: 0 }, conversations: { storePath },
  };
  const app = createApp({ config, conversationStore: new ConversationStore({ storePath }),
    webReadiness: { mode: 'knowledge_agent', snapshot: () => ({ mode: 'knowledge_agent', generation: 1, capacity: 1, knowledgeAgentCapacity: 1, schedulable: 1 }) },
    imaWebAgentClient: { async *streamAsk(options) {
      sessions.push({ mode: options.mode, sessionId: options.sessionId, question: options.question });
      yield { type: 'route', accountId: 'synthetic-account' };
      yield { type: 'session', sessionId: options.sessionId || 'synthetic-upstream-session' };
      yield { type: 'sources', sources: [{ index: 1, title: 'Synthetic KB', snippet: 'Safe evidence' }], sourceKinds: ['knowledge'] };
      yield { type: 'delta', text: options.sessionId ? 'Synthetic follow-up' : 'Synthetic first answer' };
      yield { type: 'done' };
    } },
  });
  const provider = http.createServer(app);
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const scopeRef = createHash('sha256').update('synthetic-kb').digest('hex');
  try {
    await withExample({ mode: 'real', providerUrl, apiToken: 'synthetic-api-token', serviceToken: 'synthetic-service-token', scopeRef }, async base => {
      const home = await fetch(base);
      const cookie = home.headers.get('set-cookie').split(';')[0];
      const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
      const status = await (await fetch(`${base}/api/status`, { headers: { Cookie: cookie } })).json();
      assert.equal(status.ready, true);
      const send = async (question, conversationId = '') => {
        const response = await fetch(`${base}/api/ask`, { method: 'POST', headers,
          body: JSON.stringify({ question, conversationId, requestId: randomUUID() }) });
        assert.equal(response.status, 200);
        return response.text();
      };
      const first = await send('Synthetic original question');
      assert.match(first, /event: done/u);
      const id = /"conversationId":"([^"]+)"/u.exec(first)[1];
      const second = await send('Synthetic follow-up question', id);
      assert.match(second, /Synthetic follow-up/u);
      assert.equal(sessions.length, 2);
      assert.equal(sessions[0].mode, 'knowledge_agent');
      assert.equal(sessions[1].sessionId, 'synthetic-upstream-session');
      const detail = await (await fetch(`${base}/api/conversations/${id}`, { headers: { Cookie: cookie } })).json();
      assert.equal(detail.messages[0].content, 'Synthetic original question');
      assert.equal(detail.messages[1].knowledge_source_count, 1);
      assert.equal(detail.messages[3].content, 'Synthetic follow-up');
    });
  } finally {
    await new Promise(resolve => provider.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
