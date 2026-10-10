'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecentContextConsumer, validatePayload, buildRecentContextQuestionPlan } = require('../src/bot-recent-context');
const ref = `ctx_${'b'.repeat(64)}`;
const binding = { account_id: 'synthetic-account', group_id: 'synthetic-group', route_ref: 'synthetic-route', route_generation: 0, feature_generation: 1 };
const messages = [{ observed_at: '2026-01-01T00:00:00Z', sender_display_name: 'Synthetic', text: 'Synthetic\uff1a context', message_type: 'text' }];
const payload = (version = 2, rows = messages) => ({ schema_version: `wechat.qa.recent-context.payload.v${version}`,
  messages: rows, byte_count: Buffer.byteLength(JSON.stringify(rows)), watermark_category: 'watermark_known', truncated: false,
  ...(version === 1 ? { message_count: rows.length } : { source_message_count: rows.length, selected_message_count: rows.length,
    omitted_message_count: 0, truncation_reason: 'none' }) });
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const consumer = fetchImpl => new RecentContextConsumer({ baseUrl: 'http://127.0.0.1:9999', token: 'synthetic-token', fetchImpl });

test('v1/v2 validate original byte counts before normalization and expose only bounded context', () => {
  for (const version of [1, 2]) {
    const value = validatePayload(payload(version));
    assert.equal(value.messages[0].text, 'Synthetic: context');
    assert.equal(value.selectedMessageCount, 1);
    assert.equal(Object.isFrozen(value.messages), true);
  }
  for (const update of [
    { byte_count: 0 }, { source_message_count: 0, omitted_message_count: -1 },
    { omitted_message_count: 1 }, { truncated: true }, { schema_version: 'wechat.qa.recent-context.payload.v3' },
    { private: 'extra' },
  ]) assert.throws(() => validatePayload({ ...payload(), ...update }), { code: 'recent_context_unavailable' });
});

test('single-use consume sends the exact bound body once with no redirects or retry', async () => {
  let calls = 0;
  const client = consumer(async (url, options) => {
    calls++;
    assert.equal(url, `http://127.0.0.1:9999/internal/weflow-bridge/recent-context/${ref}/consume`);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), binding);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    return json(payload());
  });
  assert.equal((await client.consume(ref, { binding })).messageCount, 1);
  assert.equal(calls, 1);
  await assert.rejects(client.consume(ref, { binding, signal: AbortSignal.abort() }), { code: 'recent_context_unavailable' });
  await assert.rejects(client.consume(ref, { binding: {} }), { code: 'recent_context_unavailable' });
  assert.equal(calls, 1);
});

test('context errors never leak upstream text, follow redirects, or retry consumed snapshots', async () => {
  for (const response of [new Response('private-upstream', { status: 302, headers: { Location: 'https://example.invalid' } }),
    new Response('private-upstream', { status: 503 }), json({ private: 'private-upstream' }),
    new Response('x'.repeat(131073), { headers: { 'Content-Type': 'application/json' } })]) {
    let calls = 0;
    await assert.rejects(consumer(async () => { calls++; return response; }).consume(ref, { binding }), error => {
      assert.equal(error.message, 'recent_context_unavailable'); return true;
    });
    assert.equal(calls, 1);
  }
});

test('only literal loopback origins without userinfo, paths, query or fragment are accepted', () => {
  for (const baseUrl of ['http://localhost:9999', 'https://example.invalid', 'http://user@127.0.0.1:9999',
    'http://127.0.0.1:9999/path', 'http://127.0.0.1:9999/?secret=no', 'http://127.0.0.1:9999/#fragment', 'file:///tmp/synthetic']) {
    assert.throws(() => new RecentContextConsumer({ baseUrl, token: 'synthetic-token' }), /recent_context_config_invalid/);
  }
  assert.doesNotThrow(() => new RecentContextConsumer({ baseUrl: 'http://[::1]:9999', token: 'synthetic-token' }));
});

test('cancellation reaches the injected transport and a failed consume is never retried', async () => {
  const controller = new AbortController();
  let calls = 0, aborted = false;
  const client = consumer(async (_, options) => {
    calls++;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted = true; reject(Error('synthetic-private-error')); }, { once: true });
      queueMicrotask(() => controller.abort());
    });
  });
  await assert.rejects(client.consume(ref, { binding, signal: controller.signal }), { code: 'recent_context_unavailable' });
  assert.equal(calls, 1);
  assert.equal(aborted, true);
});

test('context is chronological after newest-first budgeting and original question is preserved', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ ...messages[0], text: `Synthetic-${index} ` + 'x'.repeat(3000) }));
  const context = validatePayload(payload(2, rows));
  const plan = buildRecentContextQuestionPlan('Synthetic original?', context, 'group_knowledge');
  assert.ok(Array.from(plan.question).length <= 18000);
  assert.ok(plan.question.endsWith('Synthetic original?'));
  assert.match(plan.question, /Synthetic-11 /);
  assert.doesNotMatch(plan.question, /Synthetic-0 /);
  assert.equal(plan.omittedMessageCount, 12 - plan.injectedMessageCount);
  assert.equal(plan.truncationReason, 'prompt_budget');
  assert.ok(plan.question.indexOf('Synthetic-10 ') < plan.question.indexOf('Synthetic-11 '));
  assert.equal(buildRecentContextQuestionPlan('Synthetic original?', null).question, 'Synthetic original?');
});
