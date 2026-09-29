const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');

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
    if (url.endsWith('/internal/provider-a/capacity')) return new Response(JSON.stringify({ policies: { knowledge_agent: { max_concurrent: 2 } }, features: { source_intent_web_requested_v1: true } }), { status: 200 });
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

test('web BFF rejects cross-origin posting before dispatch', async () => {
  await withExample({}, async base => {
    const response = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' });
    assert.equal(response.status, 403);
  });
});
