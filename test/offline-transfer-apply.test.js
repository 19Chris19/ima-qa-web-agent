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

test('persistent retirement blocks startup and old apply replay after explicit rollback', async t => {
  const f = await fixture(t); f.prepare();
  await applyPreparedTransfer(f.input);
  await assert.rejects(acquireAccountStoreFence(f.input.sourceStore), { code: 'account_store_retired' });
  assert.equal(parse(`${f.input.sourceStore}.retirement.json`).state, 'retired');
  await applyPreparedTransfer({ ...f.input, rollback: true });
  const release = await acquireAccountStoreFence(f.input.sourceStore); await release();
  await assert.rejects(applyPreparedTransfer(f.input), { code: 'transfer_retirement_replay' });
});

test('rollback before apply refuses without writes', async t => {
  const f = await fixture(t); f.prepare();
  await assert.rejects(applyPreparedTransfer({ ...f.input, rollback: true }), { code: 'transfer_retirement_missing' });
});

for (const stage of ['before-target', 'after-target']) {
  test(`apply crash ${stage} retains retirement and retries without duplication`, async t => {
    const f = await fixture(t); f.prepare();
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === f.input.targetStore) {
        assert.equal(parse(`${f.input.sourceStore}.retirement.json`).state, 'retired');
        if (stage === 'after-target') rename(from, to);
        throw new Error('synthetic crash');
      }
      return rename(from, to);
    });
    await assert.rejects(applyPreparedTransfer(f.input), /synthetic crash/);
    mock.mock.restore();
    await assert.rejects(acquireAccountStoreFence(f.input.sourceStore), { code: 'account_store_retired' });
    await applyPreparedTransfer(f.input);
    assert.equal(parse(f.input.targetStore).accounts.length, 2);
    assert.equal(fs.statSync(`${f.input.sourceStore}.retirement.json`).mode & 0o777, 0o600);
  });
  test(`rollback crash ${stage} is journaled and retry preserves data`, async t => {
    const f = await fixture(t); f.prepare(); await applyPreparedTransfer(f.input);
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === f.input.targetStore) {
        if (stage === 'after-target') rename(from, to);
        throw new Error('synthetic crash');
      }
      return rename(from, to);
    });
    await assert.rejects(applyPreparedTransfer({ ...f.input, rollback: true }), /synthetic crash/);
    mock.mock.restore();
    await assert.rejects(acquireAccountStoreFence(f.input.sourceStore), { code: 'account_store_retired' });
    await assert.rejects(applyPreparedTransfer(f.input), { code: 'transfer_rollback_pending' });
    await applyPreparedTransfer({ ...f.input, rollback: true });
    assert.equal(parse(f.input.targetStore).accounts.length, 1);
  });
}

test('missing import and duplicate source identity prevent source release', async t => {
  const f = await fixture(t); f.prepare(); await applyPreparedTransfer(f.input);
  const current = parse(f.input.targetStore);
  write(f.input.targetStore, { ...current, accounts: current.accounts.slice(0, 1) });
  await assert.rejects(applyPreparedTransfer({ ...f.input, rollback: true }), { code: 'transfer_rollback_account_changed' });
  current.accounts.push({ ...structuredClone(current.accounts[1]), id: 'duplicate', name: 'duplicate' });
  write(f.input.targetStore, current);
  await assert.rejects(applyPreparedTransfer({ ...f.input, rollback: true }), { code: 'transfer_retirement_target_identity_present' });
  await assert.rejects(acquireAccountStoreFence(f.input.sourceStore), { code: 'account_store_retired' });
});

for (const field of ['sourceKey', 'targetKey', 'sourceStore']) {
  test(`post-seal ${field} changes fail closed`, async t => {
    const f = await fixture(t); f.prepare(); await applyPreparedTransfer(f.input);
    fs.appendFileSync(f.input[field], '\nsynthetic-change');
    await assert.rejects(applyPreparedTransfer({ ...f.input, rollback: true }), { code: field === 'sourceStore' ? 'transfer_source_changed' : 'transfer_key_changed' });
    await assert.rejects(acquireAccountStoreFence(f.input.sourceStore), { code: 'account_store_retired' });
  });
}

test('invalid marker fails closed and rejected startup releases the mutex', async t => {
  const f = await fixture(t);
  write(`${f.input.sourceStore}.retirement.json`, { state: 'released' });
  for (let i = 0; i < 2; i++) await assert.rejects(acquireAccountStoreFence(f.input.sourceStore), { code: 'transfer_retirement_invalid' });
});

test('different transaction rollback cannot release source', async t => {
  const f = await fixture(t); f.prepare(); await applyPreparedTransfer(f.input);
  const file = `${f.input.sourceStore}.retirement.json`, marker = parse(file);
  write(file, { ...marker, transaction: 'a'.repeat(64) });
  await assert.rejects(applyPreparedTransfer({ ...f.input, rollback: true }), { code: 'transfer_retirement_conflict' });
});

test('failure to seal leaves target unchanged; corrupted backup cannot seal', async t => {
  const f = await fixture(t); f.prepare();
  const before = read(f.input.targetStore), rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to.endsWith('.retirement.json')) throw new Error('synthetic seal failure');
    return rename(from, to);
  });
  await assert.rejects(applyPreparedTransfer(f.input), /synthetic seal failure/);
  mock.mock.restore();
  assert.equal(read(f.input.targetStore), before);
  const release = await acquireAccountStoreFence(f.input.sourceStore); await release();
  fs.appendFileSync(path.join(f.input.bundle, 'source.accounts.json'), ' ');
  await assert.rejects(applyPreparedTransfer(f.input), { code: 'transfer_bundle_changed' });
  assert.equal(fs.existsSync(`${f.input.sourceStore}.retirement.json`), false);
});

test('rollback recovery refuses newer target data instead of overwriting it', async t => {
  const f = await fixture(t); f.prepare(); await applyPreparedTransfer(f.input);
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (to === f.input.targetStore) throw new Error('synthetic crash');
  });
  await assert.rejects(applyPreparedTransfer({ ...f.input, rollback: true }), /synthetic crash/);
  mock.mock.restore();
  const newer = parse(f.input.targetStore); newer.settings = { newData: true }; write(f.input.targetStore, newer);
  const before = read(f.input.targetStore);
  await assert.rejects(applyPreparedTransfer({ ...f.input, rollback: true }), { code: 'transfer_rollback_target_changed' });
  assert.equal(read(f.input.targetStore), before);
  await assert.rejects(acquireAccountStoreFence(f.input.sourceStore), { code: 'account_store_retired' });
});

test('fresh process refuses retired source even after runtime flags change', async t => {
  const f = await fixture(t); f.prepare(); await applyPreparedTransfer(f.input);
  const source = parse(f.input.sourceStore); source.accounts[0].runtime.disabled = false;
  write(f.input.sourceStore, source);
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e',
    'require(process.argv[1]).acquireAccountStoreFence(process.argv[2]).then(r=>r()).catch(e=>{console.log(e.code);process.exitCode=7})',
    require.resolve('../src/account-store-fence'), f.input.sourceStore], { encoding: 'utf8' });
  assert.equal(result.status, 7);
  assert.equal(result.stdout.trim(), 'account_store_retired');
});

test('deduplicated existing target identity cannot release source on rollback', async t => {
  const f = await fixture(t); f.add(f.target, 'existing-source', 'imported'); f.prepare();
  await applyPreparedTransfer(f.input);
  await assert.rejects(applyPreparedTransfer({ ...f.input, rollback: true }), { code: 'transfer_retirement_target_identity_present' });
});

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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-offline-transfer-')));
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
