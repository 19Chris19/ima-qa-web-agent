import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImaClient, project, markdown, summary } from '../src/client.mjs';
import { digest } from '../src/config.mjs';
import { page } from '../src/mcp.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ima-client-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let posts = 0, conversations = 0, drop = true, status = 'succeeded', deletes = 0;
  const bodies = [];
  const data = () => ({ task: { id: 'task-1', conversationId: 'conv-1', status, question: 'Q', lastEventId: 3 },
    snapshot: { events: [{ event: 'delta', data: { text: '答'.repeat(20000) } },
      { event: 'sources', data: { sources: Array.from({ length: 30 }, (_, n) => ({ title: `source ${n}`, snippet: 's'.repeat(1000) })) } },
      ...(status === 'succeeded' ? [{ event: 'done', data: { answer_basis: 'knowledge', complete: true } }] : [])] } });
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers['x-ima-client-id'], 'client');
    if (url.endsWith('/api/capabilities')) return Response.json({ applicationId: 'app', features: { durable_qa_tasks_v1: true } });
    if (url.endsWith('/internal/provider-a/capacity')) return Response.json({ applicationId: 'app', available: 1, policies: { knowledge_agent: { max_concurrent: 1 } },
      features: { durable_qa_tasks_v1: true, knowledge_agent_keyed_sse_v1: true, source_intent_web_requested_v1: true } });
    if (url.endsWith('/api/conversations')) {
      assert.equal(options.headers.authorization, 'Bearer ordinary'); conversations++;
      return Response.json({ conversation: { conversationId: 'conv-1' } });
    }
    assert.equal(options.headers.authorization, 'Bearer internal');
    if (options.method === 'DELETE') { deletes++; return Response.json({ task: { status: 'cancelled' } }); }
    if (options.method === 'POST') {
      posts++; bodies.push(options.body);
      const receipt = JSON.parse(await readFile(join(dir, 'requests', `${digest('key')}.json`)));
      assert.equal(receipt.conversationId, 'conv-1');
      if (drop) { drop = false; throw Error('lost response with secret'); }
      return Response.json({ task: { id: 'task-1' } });
    }
    return Response.json(data());
  };
  const config = { baseUrl: 'http://localhost', applicationId: 'app', apiToken: 'ordinary', internalServiceToken: 'internal', clientId: 'client', stateDir: dir, knowledgeScopeRef: 'a'.repeat(64) };
  return { config, fetchImpl, stats: () => ({ posts, conversations, deletes, bodies }), setStatus: s => { status = s; } };
}
test('lost submission response replays identical persisted input across client restart; full evidence archived', async t => {
  const f = await fixture(t);
  const first = new ImaClient(f.config, { fetchImpl: f.fetchImpl });
  await assert.rejects(first.ask({ question: 'Q', requestKey: 'key' }), e => e.code === 'provider_transport_error' && e.requestKey === 'key' && !e.message.includes('secret'));
  const second = new ImaClient(f.config, { fetchImpl: f.fetchImpl });
  const result = await second.ask({ question: 'Q', requestKey: 'key' });
  assert.equal(result.complete, true); assert.equal(result.answer.length, 20000); assert.equal(result.sources.length, 30);
  assert.equal(f.stats().conversations, 1); assert.equal(f.stats().posts, 2); assert.equal(f.stats().bodies[0], f.stats().bodies[1]);
  await second.ask({ question: 'Q', requestKey: 'key' }); assert.equal(f.stats().posts, 2);
  await assert.rejects(second.ask({ question: 'different', requestKey: 'key' }), { code: 'request_key_conflict' });
  const offline = new ImaClient(f.config, { fetchImpl: () => { throw Error('offline'); } });
  assert.equal((await offline.task(result.taskId)).answer, result.answer);
  assert.ok(markdown(result).includes('source 29'));
  let chunks = '', offset = 0;
  do { const p = page(result, offset); chunks += p.chunk; offset = p.nextOffset; } while (offset !== null);
  assert.deepEqual(JSON.parse(chunks), result);
});
test('running and indeterminate are observed without cancellation or redispatch', async t => {
  const f = await fixture(t); f.setStatus('running');
  const client = new ImaClient(f.config, { fetchImpl: f.fetchImpl, pollMs: 1 });
  assert.equal((await client.task('task-1', { waitSeconds: 0 })).status, 'running');
  assert.equal(f.stats().deletes, 0); assert.equal(f.stats().posts, 0);
  f.setStatus('indeterminate');
  assert.equal((await client.task('task-1')).complete, false);
  assert.equal(f.stats().posts, 0);
  await client.cancel('task-1'); assert.equal(f.stats().deletes, 1);
});
test('expired or missing terminal events cannot be reported complete', () => {
  const task = { id: 'x', status: 'succeeded', eventsExpired: true };
  assert.equal(project({ task, snapshot: { events: [] } }).complete, false);
  assert.equal(project({ task: { ...task, eventsExpired: false }, snapshot: { events: [] } }).complete, false);
});

test('status proves server-bound pairing, rejects mismatch before writes, distinguishes busy from absent qualified capacity', async t => {
  const f = await fixture(t);
  let ordinaryId = 'app', available = 0, max = 1;
  const client = new ImaClient(f.config, { fetchImpl: async url => Response.json(url.includes('/api/capabilities')
    ? { applicationId: ordinaryId, features: { durable_qa_tasks_v1: true } }
    : { applicationId: 'app', available, policies: { knowledge_agent: { max_concurrent: max } }, features: { durable_qa_tasks_v1: true, knowledge_agent_keyed_sse_v1: true } }) });
  assert.equal((await client.status()).ready, true);
  assert.equal((await client.status()).canSubmitNow, false);
  ordinaryId = 'another';
  assert.equal((await client.status()).identityPairing, 'mismatch');
  await assert.rejects(client.ask({ question: 'Q', requestKey: 'key' }), { code: 'application_pairing_unverified' });
  assert.equal(f.stats().posts, 0); assert.equal(f.stats().conversations, 0);
  ordinaryId = 'app'; max = 0;
  assert.equal((await client.status()).reason, 'no_eligible_capacity');
});

test('web intent is forwarded, accurate late citations, process and text-only suggestions survive archive and export', async t => {
  const f = await fixture(t);
  const client = new ImaClient(f.config, { fetchImpl: f.fetchImpl });
  await assert.rejects(client.ask({ question: 'Q', requestKey: 'key', sourceIntent: 'web' }));
  const full = await client.ask({ question: 'Q', requestKey: 'key', sourceIntent: 'web' });
  assert.equal(JSON.parse(f.stats().bodies[0]).source_intent, 'web_requested');
  assert.equal(JSON.parse(f.stats().bodies[0]).retrieval_policy, 'knowledge_agent');
  const value = project({ task: { id: 't', conversationId: 'c', status: 'succeeded', sourceIntent: 'web' }, snapshot: { events: [
    { event: 'sources', data: { citationMap: { 'index:55': { type: 'web', displayNumbers: ['1'], sources: [{ url: 'https://example.org/a', title: 'A' }] }, 'context:kb': { type: 'knowledge' } } } },
    { event: 'process', data: { phase: 'web', status: 'running' } },
    { event: 'sources', data: { citationMap: { 'index:55': { type: 'web', displayNumbers: ['7'], sources: [{ url: 'https://example.org/b', title: 'B' }, { url: 'https://example.org/a', snippet: 'late' }] } } } },
    { event: 'suggestions', data: { suggestions: ['follow up', { tool: 'do-not-run' }, 'follow up'] } },
    { event: 'done', data: { complete: true, process: [{ phase: 'web', status: 'completed' }] } },
  ] } });
  assert.deepEqual(value.citationMap['index:55'].displayNumbers, ['1', '7']);
  assert.equal(value.citationMap['index:55'].sources.length, 2);
  assert.equal(value.citationMap['index:55'].sources[0].title, 'A');
  assert.equal(value.citationMap['index:55'].sources[0].snippet, 'late');
  assert.deepEqual(value.suggestions, ['follow up']); assert.equal(value.process[0].status, 'completed');
  assert.equal(value.webEvidence, true); assert.equal(value.complete, true);
  assert.equal(summary({ ...full, status: 'running' }).answer.length, 0);
  assert.equal(summary(full).answerTruncated, true);
  assert.ok(JSON.stringify(summary(full)).length < JSON.stringify(full).length / 5);
  const exported = await client.export(full.taskId, { format: 'json' });
  assert.equal(JSON.parse(await readFile(exported.output)).answer, full.answer);
  assert.equal((await client.export(full.taskId, { format: 'json' })).output, exported.output);
});
