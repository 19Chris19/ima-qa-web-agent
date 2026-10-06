const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { auditHistoryInput, exportHistory } = require('../src/account-transfer');

function row(extra = {}) {
  return { id: 'synthetic-history', ownerKey: 'demo:11111111-1111-4111-8111-111111111111',
    createdAt: 0, updatedAt: 10, expiresAt: 20, title: 'synthetic title',
    turns: [{ question: 'synthetic question', answer: 'synthetic answer', createdAt: 5 }], ...extra };
}
const store = value => ({ conversations: [value] });

test('pure repeatable audit separates valid empty shells and never silently excludes them', () => {
  const input = { conversations: [row(), row({ id: 'synthetic-shell', turns: [] })] };
  const before = structuredClone(input);
  const report = auditHistoryInput(input);
  assert.equal(report.emptyShells, 1);
  assert.equal(report.validConversations, 1);
  assert.equal(report.invalidConversations, 0);
  assert.equal(report.ready, false);
  assert.deepEqual(auditHistoryInput(input), report);
  assert.deepEqual(input, before);
  assert.throws(() => exportHistory(input), error => error.code === 'archive_preflight_failed'
    && error.report.emptyShells === 1);
  assert.equal(auditHistoryInput(store(row({ turns: [], ownerKey: '' }))).emptyShells, 0);
  assert.deepEqual(exportHistory({ conversations: [] }), { schemaVersion: 1, conversations: [] });
});

test('invalid text, ownership, dates, incomplete evidence and aliases fail closed before projection', () => {
  const invalid = [
    r => { r.ownerKey = 'demo:unknown'; }, r => { delete r.ownerKey; },
    r => { r.id = 'bad:id'; }, r => { r.updatedAt = -1; },
    r => { r.createdAt = '2026-02-30T00:00:00Z'; },
    r => { r.expiresAt = '20'; }, r => { r.turns[0].createdAt = NaN; },
    r => { r.turns[0].answer = ' '; }, r => { delete r.turns[0].question; },
    r => { r.turns[0].evidence = { complete: false }; },
    r => { r.turns[0].evidence = { interrupted: true }; },
    r => { r.turns[0].evidence = { sourceIntent: 'unknown' }; },
    r => { r.turns[0].evidence = { sourceIntent: 'web_requested', source_intent: '' }; },
    r => { r.turns[0].sourceIntent = 'unknown'; },
    r => { r.turns[0].evidence = { unexpected: 'synthetic-private' }; },
    r => { r.turns[0].sources = [{ sourceType: 99 }]; },
    r => { r.turns[0].sources = [{ url: 'https://example.invalid/?token=synthetic-private' }]; },
  ];
  for (const mutate of invalid) {
    const value = row(); mutate(value);
    const report = auditHistoryInput(store(value));
    assert.equal(report.ready, false);
    assert.equal(report.invalidConversations, 1);
    assert.doesNotMatch(JSON.stringify(report), /synthetic|11111111|demo:|example/);
    assert.throws(() => exportHistory(store(value)), { code: 'archive_preflight_failed' });
  }
});

test('duplicate identities, turn chronology and consumer size limits block export', () => {
  for (const input of [null, {}, { conversations: [row(), row()] },
    store(row({ turns: [{ question: 'q', answer: 'a', createdAt: 11 }] })),
    store(row({ turns: Array.from({ length: 1001 }, () => ({ question: 'q', answer: 'a', createdAt: 5 })) })),
    store(row({ title: 'a'.repeat(501) }))]) {
    assert.equal(auditHistoryInput(input).ready, false);
    assert.throws(() => exportHistory(input), { code: 'archive_preflight_failed' });
  }
});

test('supported evidence survives export and intentional private redactions are counted', () => {
  const value = row();
  value.upstream = { accountId: 'synthetic-private' };
  value.turns[0].evidence = { sourceIntent: 'web_requested', complete: true, interrupted: false,
    timing: { elapsed_ms: 2 }, process: [{ kind: 'synthetic', text: 'synthetic process' }] };
  const report = auditHistoryInput(store(value));
  assert.equal(report.ready, true);
  assert.equal(report.redactedFields, 1);
  const exported = exportHistory(store(value));
  assert.equal(exported.conversations[0].turns[0].evidence.complete, true);
  assert.deepEqual(exported.conversations[0].turns[0].evidence.process, value.turns[0].evidence.process);
  assert.doesNotMatch(JSON.stringify(exported), /synthetic-private|upstream/);
});

test('consumer metadata, chronological order and all quota boundaries are enforced', () => {
  for (const mutate of [
    r => { r.turns[0].evidence = { source_count: 101 }; },
    r => { r.turns[0].evidence = { answer_basis: 'unknown' }; },
    r => { r.turns[0].evidence = { timing: { elapsed_ms: Infinity } }; },
    r => { r.turns[0].evidence = { process: [{ kind: 'step' }] }; },
    r => { r.turns[0].sources = [{ url: 'https://user:pass@example.invalid' }]; },
    r => { r.turns[0].sources = [{ type: 1.5 }]; },
    r => { r.turns[0].sources = [{}]; },
    r => { r.turns[0].sources = null; },
    r => { r.turns[0].searchSummary = {}; },
    r => { r.turns.push({ question: 'q', answer: 'a', createdAt: 4 }); },
    r => { r.turns[0].createdAt = undefined; },
    r => { r.createdAt = 0.5; },
    r => { r.createdAt = '2026-01-01T00:00:00+00:00'; },
    r => { r.mode = ''; },
  ]) {
    const value = row(); mutate(value);
    assert.equal(auditHistoryInput(store(value)).ready, false);
  }
  assert.equal(auditHistoryInput({ conversations: Array.from({ length: 5001 }, () => row()) }).ready, false);
  const many = { conversations: Array.from({ length: 51 }, (_, i) => row({ id: `synthetic-${i}`,
    turns: Array.from({ length: 1000 }, () => ({ question: 'q', answer: 'a', createdAt: 5 })) })) };
  assert.equal(auditHistoryInput(many).reasons.turn_limit, 1);
  const large = row(); large.upstream = { synthetic: 'x'.repeat(16 * 1024 * 1024) };
  assert.equal(auditHistoryInput(store(large)).reasons.size_limit, 1);
});

test('actual website parser accepts audited synthetic exports', {
  skip: !process.env.PROVIDER_A_ARCHIVE_PARSER_TEST_MODULE,
}, async () => {
  const { parseHistoryArchive } = await import(pathToFileURL(process.env.PROVIDER_A_ARCHIVE_PARSER_TEST_MODULE));
  for (const iso of [false, true]) {
    const value = row();
    value.turns[0].sources = [{ sourceType: 0, title: 'synthetic', url: 'https://example.invalid/' }];
    value.turns[0].evidence = { sourceIntent: 'web_requested', source_intent: 'web_requested',
      source_count: 1, complete: true, interrupted: false, timing: { elapsed_ms: 1 },
      process: [{ kind: 'synthetic', text: 'synthetic process' }] };
    if (iso) {
      for (const key of ['createdAt', 'updatedAt', 'expiresAt']) value[key] = new Date(value[key]).toISOString();
      value.turns[0].createdAt = new Date(5).toISOString();
    }
    const wire = JSON.parse(JSON.stringify(exportHistory(store(value))));
    assert.equal(parseHistoryArchive(wire).size, 1);
  }
});
