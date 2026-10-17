import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImaClient, project, markdown } from '../src/client.mjs';
import { connectLocal } from '../src/connect.mjs';
import { atomic, loadConfig } from '../src/config.mjs';

async function directory(t) { const d = await mkdtemp(join(tmpdir(), 'ima-protocol-')); t.after(() => rm(d, { recursive: true, force: true })); return d; }
const task = { id: 'fixture-task', conversationId: 'fixture-conversation', status: 'succeeded', sourceIntent: 'web' };
const entry = { type: 'web', displayNumbers: ['7'], sources: [{ url: 'https://example.org/fixture', title: 'Scrubbed page' }] };
test('late metadata, explicit zero and contradictory web evidence retain the successful answer', () => {
  for (const [done, expected] of [[{ source_count: 1, web_source_count: 1 }, 'verified'],
    [{ source_count: 0, web_source_count: 0 }, 'not_observed'], [{}, 'unverified'],
    [{ source_count: 0, web_source_count: 2 }, 'unverified']]) {
    const value = project({ task, snapshot: { events: [{ event: 'delta', data: { text: 'Scrubbed answer' } }, { event: 'done', data: done }] } });
    assert.equal(value.webEvidenceStatus, expected);
    assert.equal(value.status, 'succeeded'); assert.equal(value.answer, 'Scrubbed answer');
    assert.match(markdown(value), /webEvidenceStatus/);
  }
  const value = project({ task, snapshot: { events: [
    { event: 'sources', data: { citationMap: { 'context:42': { type: 'unknown', displayNumbers: [] } } } },
    { event: 'done', data: { citationMap: { 'context:42': entry } } },
  ] } });
  assert.equal(value.webEvidenceStatus, 'verified');
  assert.deepEqual(value.citationMap['context:42'].displayNumbers, ['7']);
});
test('incoming conflict flags cannot be dropped by the unknown merge branch', () => {
  const diagnostics = [];
  const value = project({ task, snapshot: { events: [
    { event: 'sources', data: { citationMap: { 'context:42': entry } } },
    { event: 'done', data: { citationMap: { 'context:42': { type: 'unknown', conflicted: true, displayNumbers: ['7'] } } } },
  ] } }, { onCitationDiagnostic: d => diagnostics.push(d) });
  assert.equal(value.citationMap['context:42'].conflicted, true);
  assert.equal(value.webEvidenceStatus, 'unverified');
  assert.ok(diagnostics.some(d => d.category === 'conflicted'));
  assert.doesNotMatch(JSON.stringify(diagnostics), /https:|Scrubbed page|context:42/);
});
test('optional diagnostics tolerate discarded malformed citation entries and observer errors', () => {
  const snapshot = { task, snapshot: { events: [
    { event: 'sources', data: { citationMap: { 'context:discarded': null, 'context:42': entry } } },
    { event: 'delta', data: { text: 'Scrubbed answer' } },
    { event: 'done', data: { web_source_count: 1 } },
  ] } };
  assert.deepEqual(project(snapshot, { onCitationDiagnostic: () => { throw Error('observer failure'); } }).citationMap,
    project(snapshot).citationMap);
  assert.equal(project(snapshot, { onCitationDiagnostic: () => {} }).answer, 'Scrubbed answer');
});
test('reading an old cache is offline and immutable; new export uses a new content identity', async t => {
  const d = await directory(t), result = { taskId: task.id, conversationId: task.conversationId, status: 'succeeded',
    complete: true, answer: 'Scrubbed answer', answerBasis: 'unknown', sourceCount: 1, knowledgeSourceCount: null,
    webSourceCount: null, citationMap: { 'context:42': entry }, sources: [], process: [], suggestions: [] };
  await mkdir(join(d, 'results')); await mkdir(join(d, 'exports'));
  const file = join(d, 'results', `${task.id}.json`), oldExport = join(d, 'exports', 'old.json');
  const bytes = JSON.stringify(result); await writeFile(file, bytes, { mode: 0o600 }); await writeFile(oldExport, bytes, { mode: 0o600 });
  const client = new ImaClient({ stateDir: d }, { fetchImpl: () => { throw Error('must stay offline'); } });
  const value = await client.task(task.id);
  assert.deepEqual(value, result);
  assert.equal(value.webEvidenceStatus, undefined, 'old caches do not gain evidence claims');
  assert.equal(await readFile(file, 'utf8'), bytes);
  const exported = await client.export(task.id, { format: 'json' });
  assert.notEqual(exported.output, oldExport);
  assert.equal(await readFile(oldExport, 'utf8'), bytes);
  assert.equal(JSON.parse(await readFile(exported.output)).webEvidenceStatus, undefined);
  assert.doesNotMatch(markdown(value), /webEvidenceStatus/, 'legacy evidence remains unannotated');
});
test('installer-recorded application wins over a multi-app ambiguity, never over an existing legacy profile', async t => {
  const d = await directory(t), providerEnv = join(d, 'provider.json'), file = join(d, 'client.json');
  const env = { IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID: 'SCRUBBED_KB', IMA_QA_AGENT_APPLICATION_ID: 'ima-agent',
    IMA_QA_API_TOKEN: 'synthetic-legacy', IMA_QA_INTERNAL_SERVICE_TOKEN: 'synthetic-legacy-internal', IMA_QA_APPLICATIONS_JSON: JSON.stringify([
      { id: 'other', apiTokens: ['synthetic-other'], internalServiceTokens: ['synthetic-other-internal'] },
      { id: 'ima-agent', apiTokens: ['synthetic-api'], internalServiceTokens: ['synthetic-internal'] },
    ]) };
  await atomic(providerEnv, env);
  class Client { constructor(config) { this.config = config; } async status() { return { identityPairing: this.config.applicationId === 'legacy' ? 'legacy_shared' : 'verified' }; } }
  const options = { providerEnv, baseUrl: 'http://localhost', config: file };
  await connectLocal(options, { Client }); assert.equal((await loadConfig(file)).applicationId, 'ima-agent');
  const old = join(d, 'legacy.json'); await connectLocal({ ...options, config: old, applicationId: 'legacy' }, { Client });
  const before = await readFile(old, 'utf8');
  assert.equal((await connectLocal({ ...options, config: old }, { Client })).reused, true);
  assert.equal(await readFile(old, 'utf8'), before);
  await assert.rejects(connectLocal({ ...options, applicationId: 'absent' }, { Client }), { code: 'application_not_found' });
});
test('isolation is proved by both server identities, independently of readiness', async () => {
  const config = { applicationId: 'ima-agent', baseUrl: 'http://localhost', apiToken: 'synthetic-api', internalServiceToken: 'synthetic-internal' };
  let ordinaryId = 'ima-agent', internalId = 'ima-agent';
  const client = new ImaClient(config, { fetchImpl: async url => Response.json(url.includes('/api/capabilities')
    ? { applicationId: ordinaryId, features: { durable_qa_tasks_v1: true } }
    : { applicationId: internalId, available: 0, policies: { knowledge_agent: { max_concurrent: 1 } },
      features: { durable_qa_tasks_v1: true, knowledge_agent_keyed_sse_v1: true } }) });
  assert.equal((await client.status()).isolationVerified, true);
  ordinaryId = 'other'; assert.equal((await client.status()).isolationVerified, false);
  ordinaryId = null; internalId = null; client.config.applicationId = 'legacy';
  const legacy = await client.status(); assert.equal(legacy.ready, true); assert.equal(legacy.isolationVerified, false);
  ordinaryId = 'legacy'; internalId = 'legacy';
  assert.equal((await client.status()).isolationVerified, false, 'a legacy namespace is not an independent named identity');
});
