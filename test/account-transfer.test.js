const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
const { readSnapshot, buildTransfer, prepareTransfer, decryptAccount, exportHistory } = require('../src/account-transfer');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-transfer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = name => {
    const storePath = path.join(root, `${name}.json`), keyPath = path.join(root, `${name}.key`);
    const keyMaterial = `synthetic-${name}-store-key`;
    fs.writeFileSync(keyPath, keyMaterial, { mode: 0o600 });
    const directory = new WebAgentAccountDirectory({ storePath, keyPath, keyMaterial });
    directory.load();
    // Force private key creation even for an initially empty pool.
    directory._key();
    return { storePath, keyPath, directory };
  };
  const source = make('source'), target = make('target');
  const add = (pool, id, uid) => pool.directory.upsertCapturedAccount({ id, name: id,
    knowledgeBaseId: '999000111', modelId: 'official_3', modelType: 3,
    headers: { 'x-ima-cookie': `IMA-UID=${uid}; IMA-TOKEN=synthetic-access; IMA-REFRESH-TOKEN=synthetic-refresh` } });
  const read = () => ({ source: readSnapshot(source.storePath, source.keyPath),
    target: readSnapshot(target.storePath, target.keyPath), knowledgeBaseId: '999000111' });
  return { root, source, target, add, read };
}

test('cross-key transfer re-encrypts and preserves target records without enabling imported accounts', t => {
  const f = fixture(t); f.add(f.source, 'same-id', 'synthetic-source'); f.add(f.target, 'same-id', 'synthetic-target');
  const input = f.read(); const result = buildTransfer(input);
  assert.equal(result.report.newIdentities, 1);
  assert.equal(result.report.resultingIdentities, 2);
  assert.deepEqual(result.candidate.accounts[0], input.target.store.accounts[0]);
  const added = result.candidate.accounts[1];
  assert.notEqual(added.id, 'same-id'); assert.equal(added.runtime.disabled, true);
  assert.equal(added.runtime.webQualification, null); assert.equal(added.runtimeEnvPath, '');
  assert.equal(decryptAccount(added, input.target.key).principal, 'synthetic-source');
  assert.throws(() => decryptAccount(added, input.source.key), /transfer_identity_unverified/);
  assert.equal(fs.readFileSync(f.target.storePath, 'utf8'), input.target.raw);
  assert.doesNotMatch(JSON.stringify(result.report), /synthetic-source|synthetic-access|ciphertext/);
});

test('identities deduplicate across installation HMAC keys without replacing existing credentials', t => {
  const f = fixture(t); f.add(f.source, 'source', 'synthetic-same'); f.add(f.target, 'target', 'synthetic-same');
  const input = f.read();
  assert.notEqual(input.source.store.accounts[0].principalFingerprint, input.target.store.accounts[0].principalFingerprint);
  const result = buildTransfer(input);
  assert.equal(result.report.duplicateIdentities, 1); assert.equal(result.report.newIdentities, 0);
  assert.deepEqual(result.candidate.accounts, input.target.store.accounts);
});

test('corrupt credentials, knowledge scope mismatches and duplicate targets fail closed', t => {
  const f = fixture(t); f.add(f.source, 'source', 'synthetic-source'); f.add(f.target, 'target', 'synthetic-target');
  let input = f.read(); input.source.store.accounts[0].secret.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => buildTransfer(input), /transfer_identity_unverified/);
  input = f.read(); input.knowledgeBaseId = '888'; assert.throws(() => buildTransfer(input), /transfer_target_conflict/);
  input = f.read(); input.target.store.accounts.push({ ...input.target.store.accounts[0], id: 'other-id' });
  assert.throws(() => buildTransfer(input), /transfer_(target_duplicate_identity|account_namespace_conflict)/);
});

test('transfer reserves account IDs and names together, including repeated fallback labels', t => {
  const f = fixture(t);
  f.target.directory.upsertCapturedAccount({ id: 'a', name: 'b', knowledgeBaseId: '999000111',
    headers: { 'x-ima-cookie': 'IMA-UID=synthetic-target; IMA-TOKEN=synthetic-token' } });
  f.source.directory.upsertCapturedAccount({ id: 'b', name: 'a', knowledgeBaseId: '999000111',
    headers: { 'x-ima-cookie': 'IMA-UID=synthetic-first; IMA-TOKEN=synthetic-token' } });
  f.add(f.source, 'a-migrated-1', 'synthetic-second');
  const { candidate } = buildTransfer(f.read());
  const target = candidate.accounts[0];
  for (const added of candidate.accounts.slice(1)) {
    assert.equal(candidate.accounts.find(row => row.id === added.id || row.name === added.id), added);
    assert.equal(candidate.accounts.find(row => row.id === added.name || row.name === added.name), added);
  }
  assert.equal(target.id, 'a'); assert.equal(target.name, 'b');
});

test('private output cannot enter a Git worktree through a symlinked ancestor', t => {
  const f = fixture(t);
  const repo = path.join(f.root, 'synthetic-repo');
  fs.mkdirSync(path.join(repo, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git'), 'synthetic-worktree-marker');
  const alias = path.join(f.root, 'outside-alias');
  fs.symlinkSync(path.join(repo, 'subdir'), alias, 'dir');
  assert.throws(() => prepareTransfer({ sourceStore: f.source.storePath, sourceKey: f.source.keyPath,
    targetStore: f.target.storePath, targetKey: f.target.keyPath, knowledgeBaseId: '999000111',
    output: path.join(alias, 'bundle') }), /transfer_output_must_be_private/);
  assert.equal(fs.existsSync(path.join(repo, 'subdir', 'bundle')), false);
});

test('private preparation is repeat-safe and cannot overwrite existing bundles or live stores', t => {
  const f = fixture(t); f.add(f.source, 'source', 'synthetic-source');
  const before = f.read(); const output = path.join(f.root, 'bundle');
  const options = { sourceStore: f.source.storePath, sourceKey: f.source.keyPath,
    targetStore: f.target.storePath, targetKey: f.target.keyPath, knowledgeBaseId: '999000111', output };
  const result = prepareTransfer(options);
  assert.equal(result.state, 'prepared_not_applied');
  assert.equal(fs.statSync(output).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(output, 'candidate.accounts.json')).mode & 0o777, 0o600);
  assert.throws(() => prepareTransfer(options), /EEXIST/);
  assert.equal(fs.readFileSync(f.source.storePath, 'utf8'), before.source.raw);
  assert.equal(fs.readFileSync(f.target.storePath, 'utf8'), before.target.raw);
  fs.mkdirSync(path.join(f.root, '.git'));
  assert.throws(() => prepareTransfer({ ...options, output: path.join(f.root, 'unsafe') }), /transfer_output_must_be_private/);
});

test('archive retains owner and Markdown but excludes upstream bindings and private metadata', () => {
  const answer = '| a | b |\n|---|---|\n| 1 | 2 |';
  const archive = exportHistory({ conversations: [{ id: 'synthetic-history', ownerKey: 'demo:owner-a',
    upstream: { accountId: 'private-id', sessionId: 'private-session' }, title: 'synthetic',
    turns: [{ question: 'synthetic', answer, createdAt: 1, cookie: 'private-cookie',
      sources: [{ index: 1, title: 'synthetic source', snippet: 'synthetic', cookie: 'private-cookie' }],
      evidence: { source_count: 1, answer_basis: 'knowledge', credential: 'private-value' } }] }] });
  assert.equal(archive.conversations[0].ownerKey, 'demo:owner-a');
  assert.equal(archive.conversations[0].turns[0].answer, answer);
  assert.equal(archive.conversations[0].turns[0].evidence.source_count, 1);
  assert.doesNotMatch(JSON.stringify(archive), /private-|upstream|credential|cookie/);
  assert.throws(() => exportHistory({ conversations: [{ id: 'missing-owner', turns: [] }] }), /archive_ownership_invalid/);
});

test('archive source/evidence keys match consumer schema v1 at 6237d8a', () => {
  const archive = exportHistory({ conversations: [{ id: 'synthetic-history',
    ownerKey: 'demo:11111111-1111-4111-8111-111111111111', createdAt: 1, updatedAt: 2, expiresAt: 3,
    turns: [{ question: 'synthetic', answer: 'synthetic answer', createdAt: 2,
      sources: [{ index: 1, title: 'synthetic web', sourceType: 0 },
        { index: 2, title: 'synthetic knowledge', sourceType: 1 },
        { index: 3, title: 'synthetic media', sourceType: 2 },
        { index: 4, title: 'synthetic custom', type: 'document', sourceType: 1 }],
      evidence: { sourceIntent: 'web_requested', source_count: 4 } }] }] });
  const turn = archive.conversations[0].turns[0];
  assert.deepEqual(turn.sources.map(source => source.type), ['web', 'knowledge', 'knowledge', 'document']);
  for (const source of turn.sources) {
    assert.ok(Object.keys(source).every(key => ['index', 'title', 'url', 'snippet', 'type'].includes(key)));
  }
  assert.deepEqual(turn.evidence, { source_count: 4, source_intent: 'web_requested' });
  assert.doesNotMatch(JSON.stringify(archive), /sourceType|sourceIntent/);
});
