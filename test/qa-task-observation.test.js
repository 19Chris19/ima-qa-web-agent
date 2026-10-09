'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(t, fetch) {
  const dom = new JSDOM('', { url: 'https://example.test/', runScripts: 'outside-only' });
  const w = dom.window, timers = new Map(), calls = [];
  let now = 0, nextId = 0;
  w.TextDecoder = TextDecoder;
  w.fetch = (url, options) => { calls.push({ url, ...options }); return fetch(url, options, calls.length); };
  w.setTimeout = (callback, ms) => { timers.set(++nextId, { callback, due: now + ms }); return nextId; };
  w.clearTimeout = id => timers.delete(id);
  w.eval(fs.readFileSync(path.resolve(__dirname, '../public/qa-tasks.js'), 'utf8'));
  t.after(() => w.close());
  return { calls, timers, tasks: w.ProviderQaTasks.create(options => options),
    async advance(ms) {
      await flush();
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) { timers.delete(id); timer.callback(); }
      }
      await flush();
    },
  };
}

const running = () => Response.json({ task: { id: 'synthetic-task', status: 'running' }, snapshot: { events: [] } });
const finished = () => Response.json({ task: { id: 'synthetic-task', status: 'succeeded' }, snapshot: {
  events: [{ id: 1, event: 'task.status', data: { status: 'succeeded' } }],
} });
function follow(p, controller = new AbortController()) {
  return p.tasks.follow('synthetic-task', { signal: controller.signal, onEvent() {}, onStatus() {}, onReconnect() {} });
}

for (const stage of ['headers', 'body']) {
  test(`POST ${stage} blackhole has a bounded unknown outcome and never automatically retries/cancels`, async t => {
    const p = fixture(t, () => stage === 'headers' ? new Promise(() => {})
      : Promise.resolve({ ok: true, json: () => new Promise(() => {}) }));
    const result = p.tasks.submit('synthetic question', 'synthetic-conversation', 'synthetic-key');
    const rejected = assert.rejects(result, error => error.name === 'TimeoutError');
    await p.advance(14999);
    assert.equal(p.calls[0].signal.aborted, false);
    await p.advance(1);
    await rejected;
    assert.equal(p.calls[0].signal.aborted, true);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].headers['Idempotency-Key'], 'synthetic-key');
    assert.equal(p.timers.size, 0);
  });
}

test('half-open SSE headers time out and recover by GET without aborting the task view', async t => {
  let snapshots = 0;
  const p = fixture(t, url => url.includes('/events?') ? new Promise(() => {})
    : Promise.resolve(++snapshots === 1 ? running() : finished()));
  const controller = new AbortController();
  const result = follow(p, controller);
  await flush();
  await p.advance(15000);
  assert.equal(p.calls[1].signal.aborted, true);
  assert.equal(controller.signal.aborted, false);
  await p.advance(1000);
  assert.equal((await result).task.status, 'succeeded');
  assert.equal(p.calls.length, 3);
  assert.equal(p.calls.every(call => !call.method || call.method === 'GET'), true);
});

test('SSE byte/heartbeat activity resets the 45s observer deadline; silent reads then reconnect', async t => {
  let snapshots = 0, stream, cancelled = 0;
  const p = fixture(t, url => Promise.resolve(url.includes('/events?') ? new Response(new ReadableStream({
    start(value) { stream = value; }, cancel() { cancelled++; },
  })) : ++snapshots === 1 ? running() : finished()));
  const controller = new AbortController();
  const result = follow(p, controller);
  await flush();
  for (let i = 0; i < 3; i++) {
    await p.advance(30000);
    stream.enqueue(new TextEncoder().encode(i === 1 ? ': partial heartbeat' : ': heartbeat\n\n'));
    await flush();
    assert.equal(p.calls[1].signal.aborted, false);
  }
  await p.advance(44999);
  assert.equal(p.calls[1].signal.aborted, false);
  await p.advance(1);
  assert.equal(p.calls[1].signal.aborted, true);
  assert.equal(cancelled, 1);
  assert.equal(controller.signal.aborted, false);
  await p.advance(1000);
  assert.equal((await result).task.status, 'succeeded');
  assert.equal(p.calls.length, 3);
  assert.equal(p.calls.every(call => !call.method || call.method === 'GET'), true);
});

test('blackholed status bodies exhaust finite GET retries instead of waiting indefinitely', async t => {
  const p = fixture(t, () => Promise.resolve({ ok: true, json: () => new Promise(() => {}) }));
  const controller = new AbortController();
  const result = follow(p, controller);
  const rejected = assert.rejects(result, /任务状态尚未确认/);
  for (const backoff of [1000, 2000, 4000, 8000, 8000]) {
    await p.advance(15000);
    await p.advance(backoff);
  }
  await p.advance(15000);
  await rejected;
  assert.equal(p.calls.length, 6);
  assert.equal(p.calls.every(call => call.signal.aborted && call.url === '/api/tasks/synthetic-task'), true);
  assert.equal(controller.signal.aborted, false);
  assert.equal(p.timers.size, 0);
});

test('navigation abort releases pending reads/timers without DELETE or another subscription', async t => {
  let cancelled = 0;
  const p = fixture(t, url => Promise.resolve(url.includes('/events?') ? new Response(new ReadableStream({
    cancel() { cancelled++; },
  })) : running()));
  const controller = new AbortController();
  const result = follow(p, controller);
  await flush();
  controller.abort();
  assert.equal(await result, null);
  await flush();
  assert.equal(cancelled, 1);
  assert.equal(p.calls.length, 2);
  assert.equal(p.timers.size, 0);
});
