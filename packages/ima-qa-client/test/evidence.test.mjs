import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ImaClient, project, summary } from '../src/client.mjs';
import { atomic, digest } from '../src/config.mjs';
import { projectEvidence, readArchive } from '../src/evidence.mjs';
import { createServer } from '../src/mcp.mjs';

const scope = digest('synthetic-kb'), sourceRef = digest(JSON.stringify([scope, 'ima_web_media', 'synthetic-material']));
const evidence = { schemaVersion: 1, scopeRef: scope,
  materials: { [sourceRef]: { materialId: 'synthetic-material', idNamespace: 'ima_web_media', title: 'Synthetic title' } },
  citations: { 'index:42': { type: 'knowledge', sourceRefs: [sourceRef], displayNumbers: ['7'] } } };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ima-client-evidence-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { baseUrl: 'http://localhost', applicationId: 'agent', apiToken: 'synthetic-api', internalServiceToken: 'synthetic-internal',
    clientId: 'client', stateDir: dir, knowledgeScopeRef: scope };
  let reads = 0, asks = 0, mapping = true, readError = false;
  const readId = randomUUID(), content = 'Original 原文\n'.repeat(1200), readAt = '2026-10-16T00:00:00.000Z';
  const data = { task: { id: 'task-1', conversationId: 'conv-1', status: 'succeeded', question: 'Q', lastEventId: 4 },
    knowledgeEvidence: evidence, snapshot: { events: [
      { event: 'sources', data: { citationMap: { 'index:42': { type: 'knowledge', displayNumbers: [] } } } },
      { event: 'delta', data: { text: 'Answer[7](@index-ref?id=42)' } }, { event: 'done', data: { complete: true } },
    ] } };
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/api/capabilities') return Response.json({ applicationId: 'agent', features: { durable_qa_tasks_v1: true } });
    if (path === '/internal/provider-a/capacity') return Response.json({ applicationId: 'agent', available: 1, policies: { knowledge_agent: { max_concurrent: 1 } },
      features: { durable_qa_tasks_v1: true, knowledge_agent_keyed_sse_v1: true, knowledge_material_map_v1: mapping, knowledge_source_read_v1: mapping } });
    if (path === '/internal/provider-a/tasks') { asks++; throw new Error('must not ask'); }
    if (path.endsWith('/task-1')) return Response.json(data);
    if (path === '/internal/provider-a/source-evidence') return Response.json({ scopeRef: scope, mappingStatus: 'mapped', taskId: 'task-1', citationKey: 'index:42',
      displayNumbers: ['7'], materials: [{ sourceRef, ...evidence.materials[sourceRef] }], trustedInstructions: false });
    if (path === '/internal/provider-a/source-evidence/read') {
      reads++;
      if (readError) return Response.json({ error: 'source_read_unavailable' }, { status: 503 });
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(), ['citationKey', 'conversationId', 'sourceRef', 'taskId', ...(body.cursor ? ['cursor'] : [])].sort());
      const offset = body.cursor ? 8000 : 0, end = Math.min(offset + 8000, content.length);
      return Response.json({ schemaVersion: 1, scopeRef: scope, taskId: 'task-1', citationKey: 'index:42', sourceRef, readId, readAt, format: 'note',
        materialId: 'synthetic-material', idNamespace: 'ima_web_media', content: content.slice(offset, end), offset,
        nextCursor: end === content.length ? null : 'syntheticCursor', extractedCharacters: content.length,
        contentComplete: true, extractionTruncated: false, sha256: digest(content), trustedInstructions: false,
        ignoredCredential: 'PRIVATE-READER-CREDENTIAL' });
    }
    throw Error('unexpected synthetic route');
  };
  return { config, fetchImpl, data, stats: () => ({ reads, asks }), setMapping: value => { mapping = value; }, setReadError: value => { readError = value; } };
}

test('private material mappings project into exact knowledge keys; summary remains small and unknown stays unknown', () => {
  const full = project({ task: { id: 't', status: 'succeeded' }, knowledgeEvidence: evidence, snapshot: { events: [
    { event: 'sources', data: { citationMap: { 'index:42': { type: 'knowledge' }, 'index:9': { type: 'unknown' } } } },
    { event: 'done', data: { complete: true } },
  ] } });
  assert.deepEqual(full.citationMap['index:42'].materialRefs, [sourceRef]);
  assert.deepEqual(full.citationMap['index:42'].displayNumbers, ['7']);
  assert.equal(full.citationMap['index:9'].type, 'unknown');
  assert.equal(Object.hasOwn(summary(full), 'knowledgeEvidence'), false);
  assert.deepEqual(projectEvidence({ ...evidence, materials: { forged: evidence.materials[sourceRef] } }).materials, {});
});

test('on-demand read pages archive privately; full digest verifies only after all pages, with no new asks', async t => {
  const f = await fixture(t), client = new ImaClient(f.config, { fetchImpl: f.fetchImpl });
  assert.equal((await client.status()).sourceEvidence.mappingSupported, true);
  const task = await client.task('task-1'); assert.deepEqual(task.citationMap['index:42'].materialRefs, [sourceRef]);
  const source = await client.source({ taskId: 'task-1', citationKey: 'index:42' }); assert.equal(source.mappingStatus, 'mapped');
  const first = await client.readSource({ taskId: 'task-1', citationKey: 'index:42', sourceRef });
  assert.equal(first.complete, false); assert.ok(first.nextCursor);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE-READER-CREDENTIAL/);
  assert.equal((await stat(first.artifact.output)).mode & 0o777, 0o600);
  assert.equal((await readArchive(f.config.stateDir, 'task-1'))[0].allPages, false);
  const second = await client.readSource({ taskId: 'task-1', citationKey: 'index:42', sourceRef, cursor: first.nextCursor });
  assert.equal(second.complete, true); assert.equal(second.readId, first.readId);
  const archive = await readArchive(f.config.stateDir, 'task-1'); assert.equal(archive[0].verifiedDigest, true); assert.equal(archive[0].complete, true);
  const exported = await client.export('task-1', { format: 'json', includeReadEvidence: true });
  assert.equal(JSON.parse(await readFile(exported.output, 'utf8')).readEvidence[0].verifiedDigest, true);
  assert.deepEqual(f.stats(), { reads: 2, asks: 0 });
});

test('old terminal cache and exports remain byte-identical; read evidence creates a separate export', async t => {
  const f = await fixture(t), old = { taskId: 'task-1', conversationId: 'conv-1', status: 'succeeded', answer: 'Old answer', complete: true,
    sources: [], citationMap: { 'index:42': { type: 'unknown', displayNumbers: [] } }, observedAt: '2026-10-15T00:00:00Z' };
  const cache = join(f.config.stateDir, 'results/task-1.json'); await atomic(cache, old); const cachedBytes = await readFile(cache);
  const client = new ImaClient(f.config, { fetchImpl: f.fetchImpl });
  const before = await client.export('task-1', { format: 'json' }), beforeBytes = await readFile(before.output);
  await client.source({ taskId: 'task-1', citationKey: 'index:42' });
  await client.readSource({ taskId: 'task-1', citationKey: 'index:42', sourceRef });
  assert.deepEqual(await readFile(cache), cachedBytes);
  const unchanged = await client.export('task-1', { format: 'json' }); assert.equal(unchanged.output, before.output);
  assert.deepEqual(await readFile(before.output), beforeBytes);
  const annotated = await client.export('task-1', { format: 'json', includeReadEvidence: true }); assert.notEqual(annotated.output, before.output);
  const value = JSON.parse(await readFile(annotated.output, 'utf8')); assert.deepEqual(value.citationMap, old.citationMap);
  assert.equal(value.readEvidence[0].complete, false);
});

test('unsupported providers and failed reads never retry, change identity, or resubmit a question', async t => {
  const f = await fixture(t), client = new ImaClient(f.config, { fetchImpl: f.fetchImpl });
  f.setMapping(false); await assert.rejects(client.source({ taskId: 'task-1', citationKey: 'index:42' }), { code: 'source_evidence_unavailable' });
  assert.equal(f.stats().reads, 0);
  f.setMapping(true); f.setReadError(true);
  await assert.rejects(client.readSource({ taskId: 'task-1', citationKey: 'index:42', sourceRef }), { code: 'source_read_unavailable' });
  assert.deepEqual(f.stats(), { reads: 1, asks: 0 });
  await assert.rejects(client.readSource({ taskId: '../outside', citationKey: 'index:42', sourceRef }), { code: 'invalid_id' });
});

test('modified private evidence is preserved and rejected rather than overwritten', async t => {
  const f = await fixture(t), client = new ImaClient(f.config, { fetchImpl: f.fetchImpl });
  const first = await client.readSource({ taskId: 'task-1', citationKey: 'index:42', sourceRef });
  await writeFile(first.artifact.output, 'modified local evidence');
  await assert.rejects(client.readSource({ taskId: 'task-1', citationKey: 'index:42', sourceRef }), { code: 'modified_evidence_conflict' });
  assert.equal(await readFile(first.artifact.output, 'utf8'), 'modified local evidence');
});

test('MCP tools inspect, read and export evidence through the actual SDK without implicit questions', async t => {
  const f = await fixture(t), service = createServer(new ImaClient(f.config, { fetchImpl: f.fetchImpl }));
  const client = new Client({ name: 'evidence-test', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  await service.connect(a); await client.connect(b);
  try {
    const source = await client.callTool({ name: 'ima_qa_get_source', arguments: { taskId: 'task-1', citationKey: 'index:42' } });
    assert.equal(source.structuredContent.materials[0].sourceRef, sourceRef);
    const invalid = await client.callTool({ name: 'ima_qa_read_source', arguments: { taskId: 'task-1', citationKey: 'index:42', sourceRef: 'https://example.org' } });
    assert.equal(invalid.isError, true); assert.equal(f.stats().reads, 0);
    const first = await client.callTool({ name: 'ima_qa_read_source', arguments: { taskId: 'task-1', citationKey: 'index:42', sourceRef } });
    assert.equal(first.structuredContent.trustedInstructions, false);
    const exported = await client.callTool({ name: 'ima_qa_export', arguments: { taskId: 'task-1', format: 'json', includeReadEvidence: true } });
    assert.equal(JSON.parse(await readFile(exported.structuredContent.output, 'utf8')).readEvidence.length, 1);
    assert.equal(f.stats().asks, 0);
  } finally { await client.close(); await service.close(); }
});
