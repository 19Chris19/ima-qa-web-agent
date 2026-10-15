import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { project, ImaClient, markdown } from '../src/client.mjs';
import { digest } from '../src/config.mjs';
import { createServer } from '../src/mcp.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/context-citation-number-regression.json', import.meta.url), 'utf8'));
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function snapshot(events, id = 'synthetic-task') {
  return { task: { id, conversationId: 'synthetic-conversation', status: 'succeeded', question: 'Synthetic question' },
    snapshot: { events } };
}
function reportedSnapshot(round, arrival) {
  const keys = Object.keys(round.doneCitationMap);
  return freeze(snapshot([
    ...round.sourcesEventIds.map((id, position) => ({ id, event: 'sources', data: {
      citationMap: Object.fromEntries(keys.filter((key, index) => arrival[index] <= position)
        .map(key => [key, { ...round.firstEntry }])),
    } })),
    { id: round.doneEventId, event: 'done', data: { complete: true, citationMap: round.doneCitationMap } },
  ], `synthetic-${round.name}`));
}

for (const round of fixture.rounds) {
  test(`reported ${round.name} retains final citation numbers for every possible first appearance`, () => {
    const keys = Object.keys(round.doneCitationMap);
    const radix = round.sourcesEventIds.length;
    // The redacted report did not identify which sources event first contained
    // each key. Cover all 64 / 625 possibilities instead of inventing its order.
    for (let n = 0; n < radix ** keys.length; n++) {
      let remaining = n;
      const arrival = keys.map(() => { const position = remaining % radix; remaining = Math.floor(remaining / radix); return position; });
      const input = reportedSnapshot(round, arrival);
      const value = project(input);
      assert.deepEqual(value.citationMap, round.doneCitationMap);
      assert.equal(value.complete, true);
      assert.equal(value.webEvidence, false);
      for (const entry of Object.values(value.citationMap)) {
        assert.equal(Object.hasOwn(entry, 'conflicted'), false, 'absence must not become conflicted=false');
        assert.equal(Object.hasOwn(entry, 'sources'), false, 'numbers do not establish source provenance');
      }
    }
  });
}

test('repeated unknown updates union explicit display numbers without mutating input or guessing another key', () => {
  const input = freeze(snapshot([
    { event: 'sources', data: { citationMap: {
      'context:42': { type: 'unknown', displayNumbers: ['2'] },
      'context:7': { type: 'unknown', displayNumbers: ['42'] },
    } } },
    { event: 'sources', data: { citationMap: { 'context:42': { type: 'unknown', displayNumbers: ['7', '2'] } } } },
    { event: 'done', data: { citationMap: { 'context:42': { type: 'unknown', displayNumbers: ['22', '7'] } } } },
  ]));
  const value = project(input);
  assert.deepEqual(value.citationMap['context:42'], { type: 'unknown', displayNumbers: ['2', '7', '22'] });
  assert.deepEqual(value.citationMap['context:7'], { type: 'unknown', displayNumbers: ['42'] });
  assert.deepEqual(input.snapshot.events[0].data.citationMap['context:42'].displayNumbers, ['2']);
});

test('late unknown metadata adds numbers without downgrading proved provenance or replacing its sources', () => {
  for (const type of ['knowledge', 'web']) {
    const known = { type, displayNumbers: ['1'], ...(type === 'web'
      ? { sources: [{ url: 'https://example.org/proved', title: 'Proved source', snippet: 'Proved excerpt' }] } : {}) };
    const input = freeze(snapshot([
      { event: 'sources', data: { citationMap: { 'index:42': known } } },
      { event: 'done', data: { citationMap: { 'index:42': { type: 'unknown', displayNumbers: ['7'],
        sources: [{ url: 'https://example.org/unproved', title: 'Do not promote' }] } } } },
    ]));
    assert.deepEqual(project(input).citationMap['index:42'], { ...known, displayNumbers: ['1', '7'] });
  }
});

test('unknown numbering updates preserve absent and explicit false conflict fields', () => {
  for (const fields of [{}, { conflicted: false }]) {
    const value = project(freeze(snapshot([
      { event: 'sources', data: { citationMap: { 'context:0': { type: 'unknown', displayNumbers: [], ...fields } } } },
      { event: 'done', data: { citationMap: { 'context:0': { type: 'unknown', displayNumbers: ['22'] } } } },
    ])));
    assert.deepEqual(value.citationMap['context:0'], { type: 'unknown', displayNumbers: ['22'], ...fields });
  }
});

test('contradictory provenance stays conflicted and cannot regain a web card through late updates', () => {
  const value = project(freeze(snapshot([
    { event: 'sources', data: { citationMap: { 'index:42': { type: 'web', sources: [{ url: 'https://example.org/a' }] } } } },
    { event: 'sources', data: { citationMap: { 'index:42': { type: 'knowledge' } } } },
    { event: 'done', data: { citationMap: { 'index:42': { type: 'unknown', displayNumbers: ['7'] } } } },
  ])));
  assert.equal(value.citationMap['index:42'].type, 'unknown');
  assert.equal(value.citationMap['index:42'].conflicted, true);
  assert.equal(Object.hasOwn(value.citationMap['index:42'], 'sources'), false);
  assert.equal(value.webEvidence, false);
});

async function temporaryState(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'ima-citation-regression-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return stateDir;
}
for (const round of fixture.rounds) {
  test(`MCP full read, new cache and both exports retain ${round.name} numbers without submitting`, async t => {
    const stateDir = await temporaryState(t);
    const input = reportedSnapshot(round, Array(Object.keys(round.doneCitationMap).length).fill(0));
    let reads = 0;
    const client = new ImaClient({ stateDir, baseUrl: 'http://synthetic.invalid', clientId: 'synthetic-client', internalServiceToken: 'synthetic-service' },
      { fetchImpl: async (url, options) => {
        assert.equal(options.method, 'GET');
        assert.equal(new URL(url).pathname, `/internal/provider-a/tasks/${input.task.id}`);
        reads++; return Response.json(input);
      } });
    const server = createServer(client);
    const mcp = new McpClient({ name: 'citation-regression', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await mcp.connect(b);
    try {
      const full = await mcp.callTool({ name: 'ima_qa_get_task', arguments: { taskId: input.task.id, view: 'full' } });
      assert.equal(full.isError, undefined);
      assert.deepEqual(full.structuredContent.citationMap, round.doneCitationMap);
      const jsonExport = await mcp.callTool({ name: 'ima_qa_export', arguments: { taskId: input.task.id, format: 'json' } });
      assert.equal(jsonExport.isError, undefined);
      const saved = JSON.parse(await readFile(jsonExport.structuredContent.output, 'utf8'));
      assert.deepEqual(saved.citationMap, round.doneCitationMap);
      const mdExport = await mcp.callTool({ name: 'ima_qa_export', arguments: { taskId: input.task.id, format: 'markdown' } });
      assert.equal(mdExport.isError, undefined);
      assert.equal(await readFile(mdExport.structuredContent.output, 'utf8'), markdown(saved));
      assert.equal(reads, 1);
      const offline = new ImaClient({ stateDir }, { fetchImpl: () => { throw Error('No network permitted'); } });
      assert.deepEqual((await offline.task(input.task.id)).citationMap, round.doneCitationMap);
    } finally { await mcp.close(); await server.close(); }
  });
}

test('existing terminal caches and exports remain byte-identical; no automatic re-fetch or repair', async t => {
  const stateDir = await temporaryState(t);
  const taskId = 'synthetic-old-task';
  const old = { taskId, conversationId: 'synthetic-conversation', status: 'succeeded', complete: true, eventsExpired: false,
    observedAt: '2000-01-01T00:00:00.000Z', question: 'Synthetic question', answer: 'Synthetic answer',
    sources: [], citationMap: { 'context:0': { type: 'unknown', displayNumbers: [] } }, process: [], suggestions: [] };
  await mkdir(join(stateDir, 'results'), { mode: 0o700 });
  await mkdir(join(stateDir, 'exports'), { mode: 0o700 });
  const cache = join(stateDir, 'results', `${taskId}.json`);
  const jsonText = JSON.stringify(old, null, 2) + '\n';
  const mdText = markdown(old);
  const jsonPath = join(stateDir, 'exports', `${taskId}-${digest(jsonText).slice(0, 16)}.json`);
  const mdPath = join(stateDir, 'exports', `${taskId}-${digest(mdText).slice(0, 16)}.md`);
  for (const [file, text] of [[cache, jsonText], [jsonPath, jsonText], [mdPath, mdText]]) await writeFile(file, text, { mode: 0o600 });
  let requests = 0;
  const client = new ImaClient({ stateDir }, { fetchImpl: () => { requests++; throw Error('No network permitted'); } });
  assert.deepEqual(await client.task(taskId), old);
  assert.equal((await client.export(taskId, { format: 'json' })).output, jsonPath);
  assert.equal((await client.export(taskId, { format: 'markdown' })).output, mdPath);
  assert.equal(requests, 0);
  for (const [file, text] of [[cache, jsonText], [jsonPath, jsonText], [mdPath, mdText]]) assert.equal(await readFile(file, 'utf8'), text);
});
