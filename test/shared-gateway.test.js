'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createSharedGateway } = require('../src/shared-gateway');

const a = 'synthetic-site-a-token-000000';
const b = 'synthetic-site-b-token-000000';
const rotated = 'synthetic-site-a-rotated-0000';
const sites = [{ deploymentId: 'site-a', token: a }, { deploymentId: 'site-b', token: b }];
const stream = 'event: conversation\ndata: {"conversationId":"synthetic-id"}\n\nevent: delta\ndata: {"text":"synthetic"}\n\nevent: done\ndata: {}\n\n';

async function fixture(t, overrides = {}) {
  const calls = [], history = new Map(), keys = new Set();
  let mode = 'normal', cancelled;
  const cancellation = new Promise(resolve => { cancelled = resolve; });
  const provider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: req.url, headers: req.headers, body });
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Set-Cookie': 'private=synthetic' }); res.end(JSON.stringify(value)); };
    if (mode === 'redirect') { res.writeHead(302, { Location: '/private-target' }); return res.end(); }
    if (req.url.endsWith('/capacity')) {
      if (mode === 'unauthorized') return send(401, { secret: 'synthetic-private' });
      return send(200, { schemaVersion: 1, features: { knowledge_agent_keyed_sse_v1: true, source_intent_web_requested_v1: mode !== 'no-web' },
        policies: { knowledge_agent: { max_concurrent: 2 } }, active: 1, queued: 0, private: 'synthetic-private' });
    }
    const owner = req.headers['x-ima-client-id'];
    if (mode === 'bad-api') return send(401, { secret: 'synthetic-private' });
    if (req.url.endsWith('/deep-ask')) {
      const key = `${owner}:${req.headers['idempotency-key']}`;
      if (keys.has(key)) return send(409, { private: 'synthetic-private' });
      keys.add(key);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Set-Cookie': 'private=synthetic' });
      res.write(stream);
      if (mode === 'hold') { res.on('close', cancelled); return; }
      return res.end();
    }
    if (req.url === '/api/conversations' && req.method === 'POST') {
      const conversationId = randomUUID(); history.set(conversationId, owner);
      return send(201, { conversation: { conversationId, ownerKey: owner, upstream: { accountId: 'synthetic-private' } }, token: 'synthetic-private' });
    }
    if (req.url.startsWith('/api/conversations/')) {
      const id = req.url.split('/').at(-1);
      if (history.get(id) !== owner) return send(404, {});
      if (req.method === 'DELETE') history.delete(id);
      return send(200, { conversation: { conversationId: id, ownerKey: owner }, messages: [{ role: 'assistant', content: 'Synthetic', upstream: { private: true }, sources: [{ index: 1, title: 'Synthetic', snippet: 'Synthetic', ownerKey: owner }] }] });
    }
    return send(200, { conversations: [...history].filter(([, value]) => value === owner).map(([conversationId]) => ({ conversationId })) });
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const config = { providerUrl: `http://127.0.0.1:${provider.address().port}`, apiToken: 'synthetic-api-token',
    serviceToken: 'replace-me-synthetic-service-token', knowledgeScopeRef: 'a'.repeat(64), hmacKey: 'synthetic-hmac-key-for-tests-only-0000', sites, ...overrides };
  const gateway = createSharedGateway(config);
  gateway.listen(0); await once(gateway.server, 'listening');
  t.after(async () => {
    for (const server of [gateway.server, provider]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const send = (path, { token = a, visitor = 'visitor-1', body, headers = {}, ...options } = {}) => fetch(base + path, {
    ...options, headers: { Authorization: `Bearer ${token}`, 'X-IMA-Client-Id': visitor,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { send, calls, gateway, config, base, cancellation, mode(value) { mode = value; } };
}

test('sanitized readiness, authentication and feature gating', async t => {
  const f = await fixture(t);
  const response = await f.send('/v1/capabilities');
  assert.deepEqual(await response.json(), { schemaVersion: 1, features: { knowledge_agent_keyed_sse_v1: true },
    connected: true, configured: true, authenticated: true,
    contractSupported: true, ready: true, capacity: 2, active: 1, queued: 0, webIntentSupported: true });
  assert.equal(response.headers.get('set-cookie'), null);
  f.mode('bad-api');
  const badApi = await (await f.send('/v1/capabilities')).json();
  assert.equal(badApi.authenticated, false);
  assert.equal(badApi.ready, false);
  assert.equal(f.calls.at(-1).path, '/api/conversations?limit=1');
  assert.match(f.calls.at(-1).headers['x-ima-client-id'], /^sg:/);
  f.mode('unauthorized');
  assert.equal((await (await f.send('/v1/capabilities')).json()).ready, false);
  f.mode('no-web');
  assert.equal((await f.send('/v1/ask', { method: 'POST', body: { question: 'Synthetic', request_id: randomUUID(), sourceIntent: 'web' } })).status, 503);
  assert.equal(f.calls.filter(c => c.path.endsWith('/deep-ask')).length, 0);
});

test('two tenants and visitors isolate history; rotation preserves ownership and revocation denies access', async t => {
  const f = await fixture(t);
  const created = await (await f.send('/v1/conversations', { method: 'POST', body: {} })).json();
  assert.doesNotMatch(JSON.stringify(created), /ownerKey|upstream|token|synthetic-private/);
  const path = `/v1/conversations/${created.conversation.conversationId}`;
  const detail = await (await f.send(path)).json();
  assert.doesNotMatch(JSON.stringify(detail), /ownerKey|upstream|private/);
  assert.equal(detail.messages[0].sources[0].title, 'Synthetic');
  assert.equal((await f.send(path, { token: b })).status, 404);
  assert.equal((await f.send(path, { visitor: 'visitor-2' })).status, 404);
  assert.equal((await f.send(path, { token: b, method: 'DELETE' })).status, 404);
  assert.deepEqual(await (await f.send('/v1/conversations', { token: b })).json(), { conversations: [] });
  assert.equal((await f.send('/v1/conversations?limit=50')).status, 200);
  assert.equal(f.calls.at(-1).path, '/api/conversations?limit=50');
  assert.equal(f.calls.at(-1).headers.authorization, 'Bearer synthetic-api-token');
  f.gateway.replaceSites([{ deploymentId: 'site-a', token: rotated }, sites[1]]);
  assert.equal((await f.send(path)).status, 401);
  assert.equal((await f.send(path, { token: rotated })).status, 200);
  assert.equal((await f.send(path, { token: rotated, method: 'DELETE' })).status, 200);
  assert.equal((await f.send(path, { token: rotated })).status, 404);
});

test('fixed credentials, scope and namespaced keyed raw SSE without retries', async t => {
  const f = await fixture(t);
  const body = { question: 'Synthetic', request_id: randomUUID(), sourceIntent: 'web' };
  const ask = options => f.send('/v1/ask', { method: 'POST', body, ...options });
  const response = await ask({ headers: { 'Idempotency-Key': 'spoof', Cookie: 'spoof=1', 'X-Upstream-Url': 'http://invalid' } });
  assert.equal(await response.text(), stream);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await ask()).status, 409);
  assert.equal((await ask({ token: b })).status, 200);
  assert.equal((await ask({ visitor: 'visitor-2' })).status, 200);
  f.gateway.replaceSites([{ deploymentId: 'site-a', token: rotated }, sites[1]]);
  assert.equal((await ask({ token: rotated })).status, 409);
  const calls = f.calls.filter(c => c.path.endsWith('/deep-ask'));
  assert.equal(calls.length, 5);
  assert.equal(calls[0].headers.authorization, 'Bearer replace-me-synthetic-service-token');
  assert.equal(calls[0].headers.cookie, undefined);
  assert.match(calls[0].headers['x-ima-client-id'], /^sg:[a-f0-9]{64}$/);
  assert.notEqual(calls[0].headers['idempotency-key'], calls[2].headers['idempotency-key']);
  assert.deepEqual(calls[0].body, { question: 'Synthetic', retrieval_policy: 'knowledge_agent',
    knowledge_scope_ref: 'a'.repeat(64), source_intent: 'web_requested' });
});

test('strict fields, IDs, methods, path denial and body limit never dispatch', async t => {
  const f = await fixture(t);
  for (const path of ['/internal/provider-a/capacity', '/api/ask', '/v1/ask/', '/v1/conversations?url=http://evil', '/v1/conversations/%2e%2e%2fadmin']) {
    assert.equal((await f.send(path)).status, 404);
  }
  assert.equal((await f.send('/v1/capabilities', { method: 'HEAD' })).status, 405);
  assert.equal((await f.send('/v1/capabilities', { visitor: 'invalid visitor' })).status, 400);
  for (const field of ['owner', 'deploymentId', 'history', 'retrieval_policy', 'knowledge_scope_ref', 'source_intent', 'apiToken', 'url']) {
    assert.equal((await f.send('/v1/ask', { method: 'POST', body: { question: 'Synthetic', request_id: randomUUID(), [field]: 'spoof' } })).status, 400);
  }
  assert.equal((await f.send('/v1/ask', { method: 'POST', body: { question: 'Synthetic', request_id: 'invalid' } })).status, 400);
  assert.equal((await f.send('/v1/ask', { method: 'POST', body: { question: 'x'.repeat(17000), request_id: randomUUID() } })).status, 413);
  assert.equal(f.calls.length, 0);
});

test('redirects are never followed and error details are not exposed', async t => {
  const f = await fixture(t); f.mode('redirect');
  const response = await f.send('/v1/conversations');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'provider_request_failed' });
  assert.deepEqual(f.calls.map(c => c.path), ['/api/conversations']);
});

test('client disconnect cancels upstream streaming request', async t => {
  const f = await fixture(t); f.mode('hold');
  const controller = new AbortController();
  const response = await f.send('/v1/ask', { method: 'POST', signal: controller.signal,
    body: { question: 'Synthetic', request_id: randomUUID() } });
  const reader = response.body.getReader(); await reader.read();
  f.gateway.replaceSites([sites[1]]);
  assert.equal((await f.send('/v1/capabilities')).status, 401);
  controller.abort();
  await assert.rejects(reader.read());
  await Promise.race([f.cancellation, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('upstream not cancelled')), 2000); timer.unref();
  })]);
});

test('configuration rejects remote origins', () => {
  for (const providerUrl of ['https://example.com', 'http://localhost:80', 'http://127.0.0.1/private', 'http://user:pass@127.0.0.1']) {
    assert.throws(() => createSharedGateway({ providerUrl }), /loopback/);
  }
});

test('registry updates are atomic on invalid credentials', async t => {
  const f = await fixture(t);
  assert.throws(() => f.gateway.replaceSites([sites[0], sites[0]]), /invalid_sites/);
  assert.throws(() => f.gateway.replaceSites([{ deploymentId: 'site-a', token: 'short' }]), /invalid_sites/);
  assert.equal((await f.send('/v1/capabilities')).status, 200);
  f.gateway.replaceSites([]);
  assert.equal((await f.send('/v1/capabilities')).status, 401);
});

test('raw traversal targets and chunked oversized uploads are rejected', async t => {
  const f = await fixture(t);
  const raw = (path, chunks) => new Promise((resolve, reject) => {
    const req = http.request(f.base, { path, method: chunks ? 'POST' : 'GET', headers: {
      'Authorization': `Bearer ${a}`, 'X-IMA-Client-Id': 'visitor-1', 'Content-Type': 'application/json',
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    if (chunks) for (const chunk of chunks) req.write(chunk);
    req.end();
  });
  assert.equal(await raw('/v1/conversations/../capabilities'), 404);
  assert.equal(await raw('/v1/ask', ['{"question":"', 'x'.repeat(17000), '"}']), 413);
  assert.equal(f.calls.length, 0);
});

test('deadline closes stalled body and cancels stalled SSE', async t => {
  const f = await fixture(t, { timeoutMs: 500 });
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/v1/ask', { method: 'POST', headers: {
      'Authorization': `Bearer ${a}`, 'X-IMA-Client-Id': 'visitor-1', 'Content-Type': 'application/json',
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write('{');
  });
  assert.equal(status, 504);
  f.mode('hold');
  const response = await f.send('/v1/ask', { method: 'POST', body: { question: 'Synthetic', request_id: randomUUID() } });
  await assert.rejects(response.text());
  await f.cancellation;
});
