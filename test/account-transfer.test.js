const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
const { readSnapshot, buildTransfer, prepareTransfer, decryptAccount, exportHistory } = require('../src/account-transfer');
const { WebReadiness } = require('../src/web-readiness');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');

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

for (const mode of ['classic_knowledge', 'knowledge_agent']) {
  test(`imported ${mode} account needs QA proof and remains migration-stopped after proof`, async t => {
    const f = fixture(t); f.add(f.source, 'source', 'synthetic-source');
    const { candidate } = buildTransfer(f.read());
    candidate.settings = { ...candidate.settings, webMode: mode };
    fs.writeFileSync(f.target.storePath, JSON.stringify(candidate));
    const directory = f.target.directory;
    directory.reload();
    const id = candidate.accounts[0].id;
    const pool = new IMAWebAgentPool({ accounts: directory.getPoolAccounts() }, {
      clientFactory: () => ({ applyConfig() {}, stopAutoRefresh() {} }),
      onAccountStateChange: row => directory.recordRuntimeState(row),
    });
    let requests = 0;
    const readiness = new WebReadiness({ directory, pool, timeoutMs: 1000,
      clientFactory: () => ({ async *streamAsk(options) {
        requests++; options.onDispatch();
        yield { type: 'sources', sources: [{ title: 'Synthetic source' }], sourceKinds: ['knowledge'] };
        yield { type: 'delta', text: 'Synthetic answer' };
        yield { type: 'done' };
      } }),
    });
    assert.throws(() => directory.setDisabled(id, false), { code: 'enrollment_qualification_required' });
    directory.recordRuntimeState({ id, disabled: false });
    readiness.sync();
    assert.equal(readiness.snapshot().capacity, 0);
    assert.equal(directory.reload().accounts[0].runtime.enrollmentQualificationRequired, true);
    const result = await readiness.verify(id);
    assert.equal(requests, 1);
    assert.equal(result.success, true);
    assert.equal(result.activated, false);
    assert.equal(result.capacity, 0);
    const runtime = directory.reload().accounts[0].runtime;
    assert.equal(runtime.enrollmentQualificationRequired, false);
    assert.equal(runtime.disabled, true);
    assert.equal(runtime.disabledReason, 'migration_verification_required');
    directory.setDisabled(id, false);
    readiness.sync();
    assert.equal(readiness.snapshot().capacity, 1);
    assert.equal(readiness.snapshot().accounts[0].schedulable, true);
  });
}

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

test('archive preflight failure creates no transfer bundle and does not modify synthetic stores', t => {
  const f = fixture(t);
  const before = f.read();
  const historyStore = path.join(f.root, 'synthetic-history.json');
  fs.writeFileSync(historyStore, JSON.stringify({ conversations: [{ id: 'synthetic-orphan', turns: [] }] }));
  const output = path.join(f.root, 'blocked-bundle');
  assert.throws(() => prepareTransfer({ sourceStore: f.source.storePath, sourceKey: f.source.keyPath,
    targetStore: f.target.storePath, targetKey: f.target.keyPath, knowledgeBaseId: '999000111',
    historyStore, output }), { code: 'archive_preflight_failed' });
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readFileSync(f.source.storePath, 'utf8'), before.source.raw);
  assert.equal(fs.readFileSync(f.target.storePath, 'utf8'), before.target.raw);
});

test('archive retains owner and Markdown but excludes upstream bindings and private metadata', () => {
  const answer = '| a | b |\n|---|---|\n| 1 | 2 |';
  const archive = exportHistory({ conversations: [{ id: 'synthetic-history', ownerKey: 'demo:11111111-1111-4111-8111-111111111111',
    createdAt: 0, updatedAt: 1, expiresAt: 2,
    upstream: { accountId: 'private-id', sessionId: 'private-session' }, title: 'synthetic',
    turns: [{ question: 'synthetic', answer, createdAt: 1, cookie: 'private-cookie',
      sources: [{ index: 1, title: 'synthetic source', snippet: 'synthetic', cookie: 'private-cookie' }],
      evidence: { source_count: 1, answer_basis: 'knowledge', credential: 'private-value' } }] }] });
  assert.equal(archive.conversations[0].ownerKey, 'demo:11111111-1111-4111-8111-111111111111');
  assert.equal(archive.conversations[0].turns[0].answer, answer);
  assert.equal(archive.conversations[0].turns[0].evidence.source_count, 1);
  assert.doesNotMatch(JSON.stringify(archive), /private-|upstream|credential|cookie/);
  assert.throws(() => exportHistory({ conversations: [{ id: 'missing-owner', turns: [] }] }), /archive_preflight_failed/);
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
