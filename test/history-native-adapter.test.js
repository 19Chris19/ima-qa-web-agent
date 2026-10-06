const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ConversationStore } = require('../src/conversation-store');
const { exportHistory, exportHistoryWithReport, auditHistoryInput } = require('../src/account-transfer');

function native(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-public-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'synthetic.json');
  let now = 1000;
  const store = new ConversationStore({ storePath, now: () => now });
  const owner = 'demo:11111111-1111-4111-8111-111111111111';
  store.create(owner, { id: 'synthetic-native' });
  now = 2000;
  store.appendTurn('synthetic-native', 'synthetic question', 'synthetic **answer** [1]', {
    sources: [{ index: 1, title: 'synthetic source', snippet: 'synthetic source body' }],
    searchSummary: 'synthetic summary', answer_basis: 'mixed', source_count: 7,
    knowledge_source_count: 5, web_source_count: 2, source_intent: 'web_requested',
  }, owner);
  return JSON.parse(fs.readFileSync(storePath, 'utf8'));
}

test('actual public serialized store preserves nested evidence, text, times and owner', t => {
  const raw = native(t), before = structuredClone(raw);
  const { archive, report } = exportHistoryWithReport(raw);
  const original = raw.conversations[0], exported = archive.conversations[0];
  for (const key of ['id', 'ownerKey', 'title', 'createdAt', 'updatedAt', 'expiresAt', 'turns']) {
    assert.deepEqual(exported[key], original[key]);
  }
  assert.equal(report.mappedEvidenceFields, 0);
  assert.equal(report.excludedUpstreamFields, 1);
  assert.equal(report.excludedL0Fields, 0);
  assert.doesNotMatch(JSON.stringify(report), /synthetic|11111111|demo:/);
  assert.doesNotMatch(JSON.stringify(archive), /upstream|turnRef|activeRequest/);
  assert.deepEqual(raw, before);
  assert.deepEqual(exportHistory(raw), archive);
});

test('synthetic flat legacy evidence maps exactly with counted exclusions and conflict rejection', t => {
  const raw = native(t), row = raw.conversations[0], turn = row.turns[0];
  const expected = structuredClone(turn.evidence);
  delete turn.evidence;
  Object.assign(turn, { answerBasis: 'mixed', sourceCount: 7, knowledgeSourceCount: 5,
    webSourceCount: 2, sourceIntent: 'web_requested', l0ContextCount: 2,
    l0SourceCount: 3, l0SnapshotCount: 1, l0OmittedCount: 4, l0TruncationReason: 'prompt_budget' });
  row.activeRequest = false;
  const result = exportHistoryWithReport(raw);
  assert.deepEqual(result.archive.conversations[0].turns[0].evidence, expected);
  assert.equal(result.report.mappedEvidenceFields, 5);
  assert.equal(result.report.excludedL0Fields, 5);
  assert.doesNotMatch(JSON.stringify(result.archive), /l0|upstream|activeRequest/);
  for (const mutate of [
    r => { r.activeRequest = true; }, r => { r.activeRequest = 0; },
    r => { r.turns[0].sourceCount = '7'; },
    r => { r.turns[0].evidence = { source_count: 6 }; },
    r => { r.turns[0].evidence = { sourceIntent: '' }; },
    r => { r.turns[0].l0TruncationReason = 'unknown'; },
    r => { r.turns[0].l0ContextCount = -1; },
    r => { r.turns[0].unexpected = 'synthetic-private'; },
  ]) {
    const input = structuredClone(raw); mutate(input.conversations[0]);
    assert.throws(() => exportHistoryWithReport(input, { excludeEmptyShells: true, omitSourceUrls: true }),
      { code: 'archive_preflight_failed' });
  }
});

test('explicit options remove URLs and valid shells only, with no mutation or silent source loss', t => {
  const raw = native(t);
  const shell = { ...structuredClone(raw.conversations[0]), id: 'synthetic-shell', turns: [] };
  raw.conversations.push(shell);
  raw.conversations[0].turns[0].sources[0].url = 'https://example.invalid/kb?id=synthetic#section';
  const before = structuredClone(raw);
  assert.throws(() => exportHistory(raw), { code: 'archive_preflight_failed' });
  const options = { excludeEmptyShells: true, omitSourceUrls: true };
  const result = exportHistoryWithReport(raw, options);
  assert.equal(result.report.excludedEmptyShells, 1);
  assert.equal(result.report.removedSourceUrls, 1);
  assert.deepEqual(result.report, auditHistoryInput(raw, options));
  assert.equal(result.archive.conversations.length, 1);
  assert.deepEqual(raw, before);
  assert.doesNotMatch(JSON.stringify(result), /example.invalid/);
  for (const invalid of [null, { omitSourceUrls: 'true' }, { excludeEmptyShells: 1 }, { omitUrls: true }]) {
    assert.throws(() => exportHistoryWithReport(raw, invalid), error => error.report.reasons.options_invalid === 1);
  }
  shell.ownerKey = '';
  assert.throws(() => exportHistoryWithReport(raw, options));
  raw.conversations.pop();
  raw.conversations[0].turns[0].sources = [{ url: 'https://example.invalid/' }];
  assert.throws(() => exportHistoryWithReport(raw, options), error => error.report.reasons.source_invalid === 1);
});

test('actual public serialized store passes unchanged website parser', {
  skip: !process.env.PROVIDER_A_ARCHIVE_PARSER_TEST_MODULE,
}, async t => {
  const { parseHistoryArchive } = await import(pathToFileURL(process.env.PROVIDER_A_ARCHIVE_PARSER_TEST_MODULE));
  const raw = native(t);
  const result = exportHistoryWithReport(raw);
  const parsed = parseHistoryArchive(JSON.parse(JSON.stringify(result.archive)));
  assert.deepEqual(parsed.get('archive:synthetic-native').turns, raw.conversations[0].turns);
});
