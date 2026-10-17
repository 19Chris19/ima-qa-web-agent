'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const knowledge = require('../src/knowledge-evidence');
const chat = require('../src/chat-presentation');
const { ConversationStore } = require('../src/conversation-store');
const { DurableQATaskStore, readTaskRecord } = require('../src/durable-qa-store');
const { getConfig } = require('../src/config');
const { fixture, reference, normalize, scope } = require('../scripts/test-fixtures/source-evidence-app.cjs');

test('knowledge IDs remain explicitly keyed, unordered, deduplicated and late-updatable', () => {
  let result = knowledge.empty(scope);
  for (const [key, id, title] of [['42', 'a', 'first'], ['9', 'b', 'second'], ['17', 'a', 'same material'], ['42', 'a', 'late']])
    result = knowledge.merge(result, normalize(reference(key, { type: 2, media_id: id, title })).knowledgeEvidence);
  result = knowledge.withDisplayNumbers(result, 'Actual[7](@index-ref?id=42) [2](@index-ref?id=17) `Code[8](@index-ref?id=42)`');
  const a = knowledge.sourceRef(scope, 'ima_web_media', 'a'), b = knowledge.sourceRef(scope, 'ima_web_media', 'b');
  assert.equal(Object.keys(result.materials).length, 2);
  assert.equal(result.materials[a].title, 'late');
  assert.deepEqual(result.citations['index:42'].sourceRefs, [a]);
  assert.deepEqual(result.citations['index:17'].sourceRefs, [a]);
  assert.deepEqual(result.citations['index:9'].sourceRefs, [b]);
  assert.deepEqual(result.citations['index:42'].displayNumbers, ['7']);
});

test('one key may identify several materials; unknown or contradictory provenance never proves knowledge', () => {
  const context = items => ({ eventName: 'CONTEXT_REFERENCES', data: { 0: items } });
  let result = normalize(context([{ sourceType: 1, media_id: 'a' }, { sourceType: 1, media_id: 'b' }])).knowledgeEvidence;
  assert.equal(result.citations['context:0'].sourceRefs.length, 2);
  const unknown = normalize(context([{ media_id: 'a' }])).knowledgeEvidence;
  assert.equal(unknown.citations['context:0'].type, 'unknown');
  assert.equal(Object.hasOwn(unknown.citations['context:0'], 'conflicted'), false);
  result = knowledge.merge(result, normalize(context([{ sourceType: 0, url: 'https://example.org' }])).knowledgeEvidence);
  assert.equal(result.citations['context:0'].conflicted, true);
  assert.equal(knowledge.merge(result, unknown).citations['context:0'].conflicted, true);
  const noId = normalize(reference('2', { type: 2, title: 'No ID', source: 'not-a-material-id' })).knowledgeEvidence;
  assert.deepEqual(noId.citations['index:2'].sourceRefs, []);
});

test('delta persistence does not repeat the material catalog for later display numbers', () => {
  const first = normalize(reference('42', { type: 2, media_id: 'a', title: 'a'.repeat(512), positions: [{ page: 3 }] })).knowledgeEvidence;
  const next = knowledge.withDisplayNumbers(first, '[7](@index-ref?id=42)');
  const change = knowledge.delta(first, next);
  assert.deepEqual(change.materials, {});
  assert.deepEqual(knowledge.merge(first, change), next);
  assert.deepEqual(next.citations['index:42'].upstreamPositions, [{ page: 3 }]);
  assert.equal(next.citations['index:42'].positionFormat, 'upstream_opaque');
  assert.equal(knowledge.hasData(knowledge.delta(next, next)), false);
  assert.deepEqual(knowledge.merge(first, { ...first, scopeRef: knowledge.hash('other-kb') }), first);
});

test('public projections remove internal evidence, and limits reject forged catalog identities', () => {
  const evidence = normalize(reference('42', { type: 2, media_id: 'PRIVATE-MATERIAL-ID', title: 'PRIVATE-TITLE' })).knowledgeEvidence;
  const event = { id: 2, event: knowledge.EVENT, data: { knowledgeEvidence: evidence } };
  const projected = chat.projectSnapshot({ snapshot: { events: [{ id: 1, event: 'delta', data: { text: 'answer' } }, event] } });
  assert.deepEqual(projected.snapshot.events.map(x => x.id), [1]);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
  assert.doesNotMatch(JSON.stringify(chat.projectHistory({ messages: [{ role: 'assistant', content: 'answer', knowledgeEvidence: evidence }] })), /PRIVATE/);
  assert.deepEqual(knowledge.normalize({ ...evidence, materials: { forged: Object.values(evidence.materials)[0] } }).materials, {});
});

test('real task routes persist private JSONL evidence, isolate applications, and retain legacy/chat contracts', async t => {
  const f = await fixture(t), taskId = await f.submit(), route = '/internal/provider-a/tasks/' + taskId;
  const original = await (await f.request(route)).json();
  const chatView = await (await f.request(route + '?presentation=chat_v1')).json();
  for (const response of [original, chatView]) assert.doesNotMatch(JSON.stringify(response), /synthetic-media|knowledgeEvidence|knowledge_evidence/);
  const agent = await (await f.request(route + '?presentation=agent_evidence_v1')).json();
  assert.deepEqual(agent.knowledgeEvidence.citations['index:42'].displayNumbers, ['7']);
  assert.equal(Object.keys(agent.knowledgeEvidence.materials).length, 2);
  assert.equal((await f.request(route + '?presentation=agent_evidence_v1', {}, 'synthetic-b-service')).status, 404);
  assert.equal((await f.request(route + '?presentation=agent_evidence_v1', {}, 'synthetic-legacy-service')).status, 403);
  assert.equal((await f.request('/api/tasks/' + taskId + '?presentation=agent_evidence_v1', {}, 'synthetic-a')).status, 403);
  const ordinary = await (await f.request('/api/conversations/' + f.conversationId, {}, 'synthetic-a')).json();
  assert.doesNotMatch(JSON.stringify(ordinary), /synthetic-media|knowledgeEvidence/);
  const replay = await (await f.request(route + '/events')).text();
  assert.doesNotMatch(replay, /knowledge_evidence|synthetic-media/);
  const privateReplay = await (await f.request(route + '/events?presentation=agent_evidence_v1')).text();
  assert.match(privateReplay, /event: knowledge_evidence/);
  assert.equal((privateReplay.match(/event: done/g) || []).length, 1);
  assert.equal(await f.submit(), taskId); assert.equal(f.calls(), 1);
  const tasks = f.app.locals.durableQATasks, task = tasks.store.tasks.get(taskId);
  const file = path.join(tasks.store.directory, taskId + '.json');
  const persisted = readTaskRecord(file);
  assert.deepEqual(knowledge.fromEvents(persisted.events, scope), agent.knowledgeEvidence);
  const owner = task.ownerKey;
  const restoredHistory = new ConversationStore({ storePath: f.conversations.storePath });
  assert.deepEqual(restoredHistory.getKnowledgeEvidence(f.conversationId, taskId, owner), agent.knowledgeEvidence);
  assert.equal(fs.statSync(f.conversations.storePath).mode & 0o777, 0o600);
  tasks.close();
  const restoredTasks = new DurableQATaskStore({ directory: tasks.store.directory });
  assert.deepEqual(knowledge.fromEvents(restoredTasks.tasks.get(taskId).events, scope), agent.knowledgeEvidence);
  restoredTasks.close();
});

test('expired task events use only same-owner, same-task retained history; old records stay unresolved', async t => {
  const f = await fixture(t), taskId = await f.submit();
  const store = f.app.locals.durableQATasks.store, task = store.tasks.get(taskId);
  store.now = () => task.expiresAt + 1; store.prune();
  const result = await (await f.request('/internal/provider-a/tasks/' + taskId + '?presentation=agent_evidence_v1')).json();
  assert.deepEqual(result.knowledgeEvidence.citations['index:42'].displayNumbers, ['7']);
  assert.equal(result.snapshot.eventsExpired, true);
  assert.throws(() => f.conversations.getKnowledgeEvidence(f.conversationId, taskId, 'other-owner'));
  assert.deepEqual(f.conversations.getKnowledgeEvidence(f.conversationId, 'old-task-without-evidence', task.ownerKey).materials, {});
});

test('configuration keeps evidence access opt-in and does not echo invalid configuration', () => {
  const env = { IMA_QA_PROVIDER: 'ima-web-agent', IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID: '123456' };
  assert.deepEqual(getConfig(env).sourceEvidence.applications, []);
  assert.deepEqual(getConfig({ ...env, IMA_QA_SOURCE_EVIDENCE_APPLICATIONS_JSON: '["agent-a"]' }).sourceEvidence.applications, ['agent-a']);
  for (const value of ['["agent-a","agent-a"]', '{"secret":"PRIVATE"}', '["PRIVATE TOKEN"]'])
    assert.throws(() => getConfig({ ...env, IMA_QA_SOURCE_EVIDENCE_APPLICATIONS_JSON: value }), error => !error.message.includes('PRIVATE'));
});

test('file cards enrich an exact ID without manufacturing a citation from title or file index', () => {
  const card = id => ({ type: 1, id, sourceType: 1, title: 'Same title', subtitle: '', introduction: '', logo: '', cover: '',
    jumpUrl: '', timestamp: 1, index: 7, knowledgeBaseInfo: { id: 'synthetic-kb', name: 'Synthetic KB', introduction: '',
      description: '', creatorName: '', permissionType: 2 } });
  const files = normalize({ eventName: 'STRUCTURED_BLOCK', data: { Id: 'list', Type: 'fileList', UpdateType: 'create',
    Data: { file_list: { tool_id: 'tool', description: '', status: 2, files: [card('a'), card('b')] } } } }).knowledgeEvidence;
  assert.deepEqual(files.citations, {});
  const result = knowledge.merge(files, normalize(reference('18', { type: 2, media_id: 'b' })).knowledgeEvidence);
  const ref = result.citations['index:18'].sourceRefs[0];
  assert.equal(result.materials[ref].materialId, 'b');
  assert.equal(result.materials[ref].knowledgeBaseId, 'synthetic-kb');
  assert.equal(Object.keys(result.materials).length, 2);
});

test('repeated source events persist only changed private evidence and never download material', async t => {
  const f = await fixture(t, { stream: async function* () {
    for (let n = 0; n < 120; n++) yield normalize(reference('42', { type: 2, media_id: 'a', title: 'same'.repeat(100) }));
    yield { type: 'delta', text: 'Answer[7](@index-ref?id=42)' }; yield { type: 'done' };
  } });
  const taskId = await f.submit(), task = f.app.locals.durableQATasks.store.tasks.get(taskId);
  const events = task.events.filter(event => event.event === knowledge.EVENT);
  assert.equal(events.length, 2, 'one identity update and one final number update');
  assert.equal(Object.keys(events[1].data.knowledgeEvidence.materials).length, 0);
  assert.equal(task.events.filter(event => event.event === 'done').length, 1);
  assert.equal(f.calls(), 1);
});
