const test = require('node:test');
const assert = require('node:assert/strict');
const chat = require('../src/chat-presentation');
const { parseIMAWebAgentStream, normalizeIMAWebAgentEvent } = require('../src/ima-upstream-protocol');

const reference = (key, item) => ({ eventName: 'STRUCTURED_BLOCK', data: {
  Id: 'synthetic', Type: 'referenceIndexes', Data: { reference_indexes: { indexes: { [key]: item } } },
} });
const web = (url, content = '') => ({ type: 1, jumpUrl: url, title: 'Synthetic web', content });
const packet = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
async function parse(input) {
  const events = [];
  for await (const event of parseIMAWebAgentStream(new Response(input))) events.push(event);
  return events;
}

test('upstream keys survive reordered, repeated URLs and late metadata; displayed number is independent', () => {
  const seen = new Set(); let map = {};
  for (const event of [reference('42', web('https://example.org/a')), reference('9', web('https://example.org/b')),
    reference('17', web('https://example.org/a', 'same URL, another relationship')),
    reference('42', web('https://example.org/a', 'late excerpt'))]) {
    const value = normalizeIMAWebAgentEvent(event, seen);
    map = chat.mergeCitations(map, value.citationMap);
  }
  map = chat.withDisplayNumbers(map, '依据[7](@index-ref?id=42)和[2](@index-ref?id=17)。');
  assert.equal(map['index:42'].sources[0].snippet, 'late excerpt');
  assert.equal(map['index:17'].sources[0].snippet, 'same URL, another relationship');
  assert.deepEqual(map['index:42'].displayNumbers, ['7']);
  assert.deepEqual(map['index:17'].displayNumbers, ['2']);
  assert.equal(map['index:9'].sources[0].url, 'https://example.org/b');
  assert.equal(seen.size, 2, 'legacy dedup is independent of exact citation relationships');
});

test('same reference key retains multiple web relationships and cannot override contradictory provenance', () => {
  let map = chat.mergeCitations({}, { 'index:1': { type: 'web', sources: [webSource('a')] } });
  map = chat.mergeCitations(map, { 'index:1': { type: 'web', sources: [webSource('b')] } });
  assert.equal(map['index:1'].sources.length, 2);
  const conflict = chat.mergeCitations(map, { 'index:1': { type: 'knowledge' } });
  assert.equal(conflict['index:1'].type, 'unknown');
  assert.equal(chat.mergeCitations(conflict, map)['index:1'].type, 'unknown');
});
function webSource(path) { return { url: `https://example.org/${path}`, title: path, snippet: '' }; }

test('public view drops private knowledge metadata and arbitrary process fields without dropping cursors', () => {
  const input = { task: { id: 'task' }, snapshot: { events: [
    { id: 1, event: 'sources', data: { sources: [{ title: 'PRIVATE KB', snippet: 'PRIVATE FILE' }], searchSummary: 'PRIVATE IMA',
      citationMap: { 'index:5': { type: 'knowledge', sources: [webSource('secret')], kbName: 'PRIVATE' },
        'index:2': { type: 'web', sources: [webSource('public')] } } } },
    { id: 2, event: 'process', data: { phase: 'knowledge', status: 'completed', kbName: 'PRIVATE', text: 'PRIVATE IMA' } },
    { id: 3, event: 'process', data: { text: 'PRIVATE UNKNOWN' } },
  ] } };
  const projected = chat.projectSnapshot(input);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
  assert.deepEqual(projected.snapshot.events.map(event => event.id), [1, 2, 3]);
  assert.deepEqual(projected.snapshot.events[0].data.citationMap['index:5'], { type: 'knowledge' });
  assert.equal(input.snapshot.events[0].data.sources.length, 1, 'raw contract remains untouched');
});

test('suggestions after upstream completion are consumed before local completion; invalid auxiliary data is ignored', async () => {
  const input = packet('MESSAGE', { Text: 'answer' }) + packet('COMPLETED', { Code: 0 })
    + packet('SUGGEST_QUESTION', [{ Text: 'one', KnowledgeBaseId: 'private', ToolChainName: 'run' },
      { text: 'two' }, { text: 'three' }, { text: 'four' }, { text: 'x'.repeat(2001) }]);
  const events = await parse(input);
  assert.deepEqual(events.at(-1), { type: 'suggestions', suggestions: ['one', 'two', 'three'] });
  assert.equal(events.filter(event => event.type === 'done').length, 1);
  assert.deepEqual((await parse(packet('SUGGEST_QUESTION', { text: 'invalid envelope' })
    + packet('MESSAGE', { Text: 'answer' }) + packet('COMPLETED', { Code: 0 }))).map(event => event.type), ['delta', 'done']);
  await assert.rejects(parse(input + packet('MESSAGE', { Text: 'late semantic text' })), /upstream_event_after_terminal/);
  await assert.rejects(parse(input + packet('UNKNOWN_AGENT_TOOL', { action: 'run' })), /protocol_variant_unrecognized/);
  await assert.rejects(parse(input + packet('COMPLETED', { Code: 0 })), /upstream_terminal_duplicate/);
});

test('legacy records never acquire a guessed mapping, excerpts never come from publisher, unsafe URLs stay static', () => {
  assert.deepEqual(chat.projectHistory({ messages: [{ role: 'assistant', content: 'old [1]', sources: [webSource('old')] }] })
    .messages[0].citationMap, undefined);
  const event = normalizeIMAWebAgentEvent(reference('8', { ...web('https://example.org'), publisher: 'Publisher, not excerpt' }));
  assert.equal(event.citationMap['index:8'].sources[0].snippet, '');
  for (const url of ['https://example.org/?access_token=private', 'javascript:alert(1)', 'https://user:pass@example.org', 'https://ima.qq.com/knowledge/private']) {
    assert.equal(chat.webUrl(url), '');
  }
});

test('stored display numbers ignore code and formulas as well as ordinary numbers', () => {
  const map = { 'index:42': { type: 'knowledge' } };
  const answer = 'Real[7](@index-ref?id=42) `Code[8](@index-ref?id=42)` $[9](@index-ref?id=42)$\n\n```md\n[10](@index-ref?id=42)\n```';
  assert.deepEqual(chat.withDisplayNumbers(map, answer)['index:42'].displayNumbers, ['7']);
});

// Redacted shapes from a successful first-party browser answer on 2026-10-14.
test('current web reference content type preserves exact keys and real excerpts without relaxing unknown fields', () => {
  const event = reference('37', { type: 1, title: 'Public paper', jump_url: 'https://example.org/paper',
    content: 'Actual upstream excerpt', logo_url: '', source: 'Publisher', reference_content_type: 2 });
  const result = normalizeIMAWebAgentEvent(event);
  assert.equal(result.citationMap['index:37'].sources[0].snippet, 'Actual upstream excerpt');
  assert.equal(result.citationMap['index:37'].type, 'web');
  assert.throws(() => normalizeIMAWebAgentEvent(reference('37', { ...event.data.Data.reference_indexes.indexes['37'],
    new_agent_instruction: 'run' })), /protocol_variant_unrecognized/);
  assert.equal(normalizeIMAWebAgentEvent(reference('37', { ...event.data.Data.reference_indexes.indexes['37'],
    reference_content_type: '2' })).type, 'control');
});

test('expanded file progress/cards are bounded; unproved file cards never become knowledge evidence or citation associations', () => {
  const list = files => ({ eventName: 'STRUCTURED_BLOCK', data: { Id: 'synthetic-list', Type: 'fileList', UpdateType: 'create',
    Data: { file_list: { tool_id: 'synthetic-tool', description: 'Retrieval', status: files ? 2 : 1, ...(files ? { files } : {}) } } } });
  const card = { type: 2, title: 'Web card', subtitle: '', introduction: '', logo: '', cover: '',
    jumpUrl: 'https://example.org/card', timestamp: 123, index: 1 };
  const kb = { ...card, type: 1, id: 'synthetic-file', sourceType: 1, knowledgeBaseInfo: {
    id: 'synthetic-kb', name: 'PRIVATE KB', introduction: '', description: '', creatorName: '', permissionType: 2 } };
  assert.equal(normalizeIMAWebAgentEvent(list()).type, 'control');
  const result = normalizeIMAWebAgentEvent(list([card, kb, { ...kb, id: 'synthetic-file-2', type: 6 }]));
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sourceKinds, ['knowledge', 'knowledge']);
  assert.equal(result.citationMap, undefined);
  assert.doesNotMatch(JSON.stringify(chat.projectData('sources', result)), /PRIVATE KB|synthetic-file/);
  for (const bad of [{ ...card, extra_content: 'unproved' }, { ...card, timestamp: '123' },
    { ...kb, knowledgeBaseInfo: { ...kb.knowledgeBaseInfo, access_token: 'secret' } }]) {
    assert.throws(() => normalizeIMAWebAgentEvent(list([bad])), /protocol_variant_unrecognized/);
  }
  assert.throws(() => normalizeIMAWebAgentEvent({ ...list(), data: { ...list().data,
    Data: { file_list: { ...list().data.Data.file_list, status: 2 } } } }), /protocol_variant_unrecognized/);
});
