const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const lockfile = require('proper-lockfile');
const { EventEmitter } = require('node:events');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
const { prepareTransfer } = require('../src/account-transfer');
const { applyPreparedTransfer } = require('../src/offline-transfer-apply');
const { acquireAccountStoreFence } = require('../src/account-store-fence');

const read = file => fs.readFileSync(file, 'utf8');
const parse = file => JSON.parse(read(file));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function listen(host = '::', port = 0) {
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port, ipv6Only: host === '::1' }, resolve);
  });
  return server;
}
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-offline-transfer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = name => {
    const storePath = path.join(root, `${name}.json`), keyPath = path.join(root, `${name}.key`);
    const keyMaterial = `synthetic-${name}-key`;
    fs.writeFileSync(keyPath, keyMaterial, { mode: 0o600 });
    const directory = new WebAgentAccountDirectory({ storePath, keyPath, keyMaterial });
    directory.load();
    return { storePath, keyPath, directory };
  };
  const source = make('source'), target = make('target');
  const add = (pool, id, uid = id) => pool.directory.upsertCapturedAccount({ id, name: id,
    knowledgeBaseId: '999000111', headers: { 'x-ima-cookie': `IMA-UID=synthetic-${uid}; IMA-TOKEN=synthetic-token; IMA-REFRESH-TOKEN=synthetic-refresh` } });
  add(source, 'imported'); add(target, 'original');
  const first = await listen(), second = await listen();
  const input = { bundle: path.join(root, 'bundle'), sourceStore: source.storePath, sourceKey: source.keyPath,
    targetStore: target.storePath, targetKey: target.keyPath,
    sourcePort: first.address().port, targetPort: second.address().port };
  await close(first); await close(second);
  const prepare = () => prepareTransfer({ ...input, output: input.bundle, knowledgeBaseId: '999000111' });
  return { root, source, target, input, add, prepare };
}

test('offline apply and rollback are idempotent, preserve originals, and never touch history/source', async t => {
  const f = await fixture(t); f.prepare();
  const sourceBefore = read(f.input.sourceStore), original = parse(f.input.targetStore).accounts[0];
  const history = path.join(f.root, 'synthetic-history.json');
  write(history, { conversations: [{ id: 'synthetic-new-conversation' }] });
  const historyBefore = read(history);
  const result = await applyPreparedTransfer(f.input);
  assert.equal(result.state, 'applied_disabled');
  assert.equal(result.sourceOwnershipTransferred, false);
  assert.equal(result.sourceMustRemainStopped, true);
  const applied = read(f.input.targetStore);
  assert.equal((await applyPreparedTransfer(f.input)).state, 'already_applied');
  assert.equal(read(f.input.targetStore), applied);
  const current = parse(f.input.targetStore);
  assert.deepEqual(current.accounts[0], original);
  assert.equal(current.accounts[1].runtime.disabled, true);
  assert.equal(fs.statSync(f.input.targetStore).mode & 0o777, 0o600);
  assert.equal((await applyPreparedTransfer({ ...f.input, rollback: true })).state, 'rolled_back_unused_import');
  const rolledBack = read(f.input.targetStore);
  assert.equal((await applyPreparedTransfer({ ...f.input, rollback: true })).state, 'already_rolled_back');
  assert.equal(read(f.input.targetStore), rolledBack);
  assert.deepEqual(parse(f.input.targetStore).accounts, [original]);
  assert.equal(read(f.input.sourceStore), sourceBefore);
  assert.equal(read(history), historyBefore);
});

test('rollback preserves newer unrelated records/settings but refuses changed imports', async t => {
  const f = await fixture(t); f.prepare(); await applyPreparedTransfer(f.input);
  const current = parse(f.input.targetStore);
  current.settings = { syntheticNewSetting: true };
  current.accounts[0].runtime.totalRequests = 17;
  current.accounts.push({ ...structuredClone(current.accounts[0]), id: 'newer', name: 'newer' });
  current.generation++;
  write(f.input.targetStore, current);
  const expected = current.accounts.filter(row => row.id !== 'imported');
  await applyPreparedTransfer({ ...f.input, rollback: true });
  assert.deepEqual(parse(f.input.targetStore).accounts, expected);
  assert.deepEqual(parse(f.input.targetStore).settings, current.settings);
});

for (const change of ['used', 'enabled', 'credentials', 'proof']) {
  test(`rollback refuses ${change} imported accounts without writing`, async t => {
    const f = await fixture(t); f.prepare(); await applyPreparedTransfer(f.input);
    const current = parse(f.input.targetStore), imported = current.accounts.find(row => row.id === 'imported');
    if (change === 'used') imported.runtime.totalRequests = 1;
    if (change === 'enabled') imported.runtime.disabled = false;
    if (change === 'credentials') imported.secret.ciphertext = 'synthetic-changed';
    if (change === 'proof') imported.runtime.webQualification = { synthetic: true };
    write(f.input.targetStore, current);
    const before = read(f.input.targetStore);
    await assert.rejects(applyPreparedTransfer({ ...f.input, rollback: true }), { code: 'transfer_rollback_account_changed' });
    assert.equal(read(f.input.targetStore), before);
  });
}

for (const host of ['127.0.0.1', '::1']) {
  for (const side of ['sourcePort', 'targetPort']) {
    test(`offline apply refuses a running ${side} listener on ${host}`, async t => {
      const f = await fixture(t); f.prepare();
      const server = await listen(host);
      t.after(() => close(server));
      const before = read(f.input.targetStore);
      await assert.rejects(applyPreparedTransfer({ ...f.input, [side]: server.address().port }), { code: 'transfer_service_still_running' });
      assert.equal(read(f.input.targetStore), before);
    });
  }
}

test('shared startup fence blocks apply before listening and blocks a second startup owner', async t => {
  const f = await fixture(t); f.prepare();
  for (const file of [f.input.sourceStore, f.input.targetStore]) {
    const release = await acquireAccountStoreFence(file);
    try {
      await assert.rejects(applyPreparedTransfer(f.input), { code: 'account_store_in_use' });
      await assert.rejects(acquireAccountStoreFence(file), { code: 'account_store_in_use' });
    } finally { await release(); }
  }
  assert.equal((await applyPreparedTransfer(f.input)).state, 'applied_disabled');
});

test('migration fences both stores before port probes, preventing startup throughout apply', async t => {
  const f = await fixture(t); f.prepare();
  const connect = net.createConnection;
  let notifyProbe, releaseProbe, first = true;
  const reachedProbe = new Promise(resolve => { notifyProbe = resolve; });
  const mock = t.mock.method(net, 'createConnection', (...args) => {
    if (!first) return connect(...args);
    first = false;
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.setTimeout = () => {};
    releaseProbe = () => socket.emit('error', Object.assign(new Error('synthetic refusal'), { code: 'ECONNREFUSED' }));
    notifyProbe();
    return socket;
  });
  const applying = applyPreparedTransfer(f.input);
  try {
    await reachedProbe;
    for (const file of [f.input.sourceStore, f.input.targetStore]) {
      await assert.rejects(acquireAccountStoreFence(file), { code: 'account_store_in_use' });
    }
  } finally { releaseProbe(); mock.mock.restore(); }
  assert.equal((await applying).state, 'applied_disabled');
});

test('both Provider entrypoints acquire the lifecycle fence before constructing the account directory', () => {
  for (const file of ['provider-a-server.js', 'server.js']) {
    const source = read(path.join(__dirname, '..', file));
    const fence = source.indexOf('await acquireAccountStoreFence(config.webAgent.accountStorePath)');
    assert.ok(fence > 0);
    assert.ok(fence < source.indexOf('new WebAgentAccountDirectory('));
  }
});

test('offline apply respects both ordinary store locks and releases partial acquisitions', async t => {
  const f = await fixture(t); f.prepare();
  for (const file of [f.input.sourceStore, f.input.targetStore]) {
    const release = await lockfile.lock(file, { stale: 10000, update: 2000 });
    try { await assert.rejects(applyPreparedTransfer(f.input), { code: 'transfer_store_locked' }); }
    finally { await release(); }
    const releaseFence = await acquireAccountStoreFence(f.input.sourceStore); await releaseFence();
    const releaseTarget = await acquireAccountStoreFence(f.input.targetStore); await releaseTarget();
  }
  assert.equal((await applyPreparedTransfer(f.input)).state, 'applied_disabled');
});

test('concurrent applies cannot insert twice', async t => {
  const f = await fixture(t); f.prepare();
  const results = await Promise.allSettled([applyPreparedTransfer(f.input), applyPreparedTransfer(f.input)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'account_store_in_use');
  assert.equal(parse(f.input.targetStore).accounts.length, 2);
});

for (const side of ['sourceStore', 'targetStore']) {
  test(`whole-hash comparison rejects changed ${side} even with unchanged generation`, async t => {
    const f = await fixture(t); f.prepare();
    const changed = parse(f.input[side]); changed.settings = { changed: true }; write(f.input[side], changed);
    const before = read(f.input.targetStore);
    await assert.rejects(applyPreparedTransfer(f.input), { code: side === 'sourceStore' ? 'transfer_source_changed' : 'transfer_target_changed' });
    assert.equal(read(f.input.targetStore), before);
  });
}

test('duplicate source identity is skipped without overwriting target credentials', async t => {
  const f = await fixture(t); f.add(f.source, 'same-original', 'original'); f.prepare();
  const original = parse(f.input.targetStore).accounts[0];
  await applyPreparedTransfer(f.input);
  assert.equal(parse(f.input.targetStore).accounts.length, 2);
  assert.deepEqual(parse(f.input.targetStore).accounts[0], original);
});

test('apply rejects duplicate candidate identities even if bundle hash was recomputed', async t => {
  const f = await fixture(t); f.prepare();
  const file = path.join(f.input.bundle, 'candidate.accounts.json'), candidate = parse(file);
  candidate.accounts.push({ ...structuredClone(candidate.accounts[1]), id: 'duplicate', name: 'duplicate' });
  write(file, candidate);
  const manifestFile = path.join(f.input.bundle, 'manifest.json'), manifest = parse(manifestFile);
  manifest.candidateHash = hash(read(file)); write(manifestFile, manifest);
  const before = read(f.input.targetStore);
  await assert.rejects(applyPreparedTransfer(f.input), { code: 'transfer_candidate_duplicate_identity' });
  assert.equal(read(f.input.targetStore), before);
});

for (const mutation of ['enabled', 'original', 'namespace', 'hash', 'key']) {
  test(`apply refuses ${mutation} tampering without modifying target`, async t => {
    const f = await fixture(t); f.prepare();
    const candidateFile = path.join(f.input.bundle, 'candidate.accounts.json'), candidate = parse(candidateFile);
    if (mutation === 'enabled') candidate.accounts[1].runtime.disabled = false;
    if (mutation === 'original') candidate.accounts[0].runtime.totalRequests++;
    if (mutation === 'namespace') candidate.accounts[1].name = candidate.accounts[0].id;
    if (mutation === 'key') fs.writeFileSync(f.input.targetKey, 'synthetic-replaced-key');
    if (mutation === 'hash') candidate.updatedAt = 'synthetic-modified';
    write(candidateFile, candidate);
    if (mutation !== 'hash') {
      const manifestFile = path.join(f.input.bundle, 'manifest.json'), manifest = parse(manifestFile);
      manifest.candidateHash = hash(read(candidateFile)); write(manifestFile, manifest);
    }
    const before = read(f.input.targetStore);
    const codes = { enabled: 'transfer_candidate_must_be_disabled', original: 'transfer_original_records_changed',
      namespace: 'transfer_account_namespace_conflict', hash: 'transfer_bundle_changed', key: 'transfer_key_changed' };
    await assert.rejects(applyPreparedTransfer(f.input), { code: codes[mutation] });
    assert.equal(read(f.input.targetStore), before);
  });
}
