const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { taskTransportFetch } = require('../src/task-transport');
const { IMAWebAgentClient } = require('../src/ima-web-agent-client');

async function localServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const consume = async stream => { for await (const event of stream) void event; };

test('transport rejects timer overflow instead of silently reducing a deadline to 1ms', () => {
  assert.throws(() => taskTransportFetch('http://127.0.0.1', {
    transportTimeouts: { idleMs: 2_147_483_648 },
  }), /Invalid transport timeout/);
});

test('headers timeout covers dispatch to response headers and never retries the POST', async t => {
  let requests = 0;
  const url = await localServer(t, () => { requests++; });
  await assert.rejects(taskTransportFetch(url, {
    method: 'POST', body: 'synthetic', transportTimeouts: { headersMs: 1500, idleMs: 500 },
  }), { code: 'upstream_headers_timeout' });
  assert.equal(requests, 1);
});

test('upstream raw heartbeat bytes keep an otherwise silent response alive beyond header deadline', async t => {
  const url = await localServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    let count = 0;
    const timer = setInterval(() => {
      // Even an incomplete SSE comment counts as upstream byte activity.
      res.write(':');
      if (++count === 20) { clearInterval(timer); res.end('\n\n'); }
    }, 100);
    res.on('close', () => clearInterval(timer));
  });
  const response = await taskTransportFetch(url, { transportTimeouts: { headersMs: 1500, idleMs: 750 } });
  assert.equal(await response.text(), ':'.repeat(20) + '\n\n');
});

test('byte monitoring continues while downstream consumption is paused', async t => {
  const url = await localServer(t, (_req, res) => {
    res.writeHead(200);
    let count = 0;
    const timer = setInterval(() => {
      res.write('x');
      if (++count === 10) { clearInterval(timer); res.end(); }
    }, 25);
    res.on('close', () => clearInterval(timer));
  });
  const response = await taskTransportFetch(url, { transportTimeouts: { headersMs: 2000, idleMs: 750 } });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await response.text(), 'xxxxxxxxxx');
});

test('downstream heartbeat work cannot reset upstream idle timeout', async t => {
  const url = await localServer(t, (_req, res) => { res.writeHead(200); res.flushHeaders(); });
  let browserHeartbeats = 0;
  const heartbeat = setInterval(() => browserHeartbeats++, 10);
  t.after(() => clearInterval(heartbeat));
  const response = await taskTransportFetch(url, { transportTimeouts: { headersMs: 2000, idleMs: 100 } });
  await assert.rejects(response.text(), { code: 'upstream_idle_timeout' });
  assert.ok(browserHeartbeats > 0);
});

test('explicit cancellation propagates before headers and after bytes; pre-abort sends nothing', async t => {
  let requests = 0;
  const url = await localServer(t, (req, res) => {
    requests++;
    if (req.url === '/body') { res.writeHead(200); res.write('x'); }
  });
  const pre = new AbortController();
  pre.abort(new Error('synthetic pre-abort'));
  assert.throws(() => taskTransportFetch(url, { signal: pre.signal }), /synthetic pre-abort/);
  const header = new AbortController();
  const beforeHeaders = taskTransportFetch(url, { signal: header.signal });
  const headerError = assert.rejects(beforeHeaders, /synthetic header abort/);
  header.abort(new Error('synthetic header abort'));
  await headerError;
  const body = new AbortController();
  const response = await taskTransportFetch(`${url}/body`, { signal: body.signal });
  const result = assert.rejects(response.text(), /synthetic body abort/);
  body.abort(new Error('synthetic body abort'));
  await result;
  assert.equal(requests, 1);
});

test('transport does not follow redirects or replay broken native POSTs', async t => {
  let requests = 0;
  const url = await localServer(t, (req, res) => {
    requests++;
    if (req.url === '/redirect') { res.writeHead(307, { location: '/replayed' }); res.end(); }
    else req.socket.destroy();
  });
  const redirect = await taskTransportFetch(`${url}/redirect`);
  assert.equal(redirect.status, 307);
  await redirect.text();
  await assert.rejects(taskTransportFetch(`${url}/broken`));
  assert.equal(requests, 2);
});

test('client opt-in applies timeouts to session init and QA, while legacy uses injected fetch', async () => {
  const taskCalls = [];
  const legacyCalls = [];
  const fake = async (url, options) => {
    if (url.endsWith('init_session')) return Response.json({ session_id: 'synthetic-session' });
    return new Response('event: MESSAGE\ndata: {"Text":"synthetic"}\n\nevent: COMPLETED\ndata: {"Code":0}\n\n');
  };
  const client = new IMAWebAgentClient({ knowledgeBaseId: 'synthetic', headers: {},
    taskFetchImpl: (url, options) => { taskCalls.push({ url, options }); return fake(url, options); },
  }, (url, options) => { legacyCalls.push({ url, options }); return fake(url, options); });
  const controller = new AbortController();
  const transportTimeouts = { headersMs: 60_000, idleMs: 600_000 };
  let dispatched = 0;
  await consume(client.streamAsk({ question: 'synthetic', signal: controller.signal,
    transportTimeouts, onDispatch: () => dispatched++ }));
  assert.equal(dispatched, 1);
  assert.equal(taskCalls.length, 2);
  for (const { options } of taskCalls) {
    assert.deepEqual(options.transportTimeouts, transportTimeouts);
    assert.equal(options.signal, controller.signal);
  }
  await consume(client.streamAsk({ question: 'synthetic', sessionId: 'synthetic-session' }));
  assert.equal(legacyCalls.length, 1);
  assert.equal('transportTimeouts' in legacyCalls[0].options, false);
  controller.signal.transportTimeouts = transportTimeouts;
  await consume(client.streamAsk({ question: 'synthetic', sessionId: 'synthetic-session', signal: controller.signal }));
  assert.equal(taskCalls.length, 3);
});

test('client preserves timeout errors despite parser wrapping and dispatches only once', async t => {
  let requests = 0;
  const url = await localServer(t, (_req, res) => { requests++; res.writeHead(200); res.flushHeaders(); });
  const client = new IMAWebAgentClient({ headers: {},
    taskFetchImpl: (_url, options) => taskTransportFetch(url, options),
  }, () => assert.fail('legacy fetch must not run'));
  let dispatches = 0;
  await assert.rejects(consume(client.streamAsk({ question: 'synthetic', sessionId: 'synthetic',
    transportTimeouts: { headersMs: 2000, idleMs: 100 }, onDispatch: () => dispatches++,
  })), { code: 'upstream_idle_timeout' });
  assert.equal(requests, 1);
  assert.equal(dispatches, 1);
});
