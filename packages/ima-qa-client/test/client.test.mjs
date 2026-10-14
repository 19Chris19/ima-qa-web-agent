import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImaClient, project, markdown } from '../src/client.mjs';
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
  const config = { baseUrl: 'http://localhost', apiToken: 'ordinary', internalServiceToken: 'internal', clientId: 'client', stateDir: dir, knowledgeScopeRef: 'a'.repeat(64) };
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
