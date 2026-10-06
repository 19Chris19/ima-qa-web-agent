const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
const { WebReadiness } = require('../src/web-readiness');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { buildRuntimeEnvText } = require('../src/ima-web-agent-client');
const express = require('express');
const { registerAdminRoutes } = require('../src/admin-routes');

const PENDING = 'pending_enrollment_qualification';
const capture = (extra = {}) => ({ id: 'synthetic', name: 'synthetic', knowledgeBaseId: 'synthetic-kb',
  headers: { 'x-ima-cookie': 'IMA-UID=synthetic-user; IMA-TOKEN=synthetic-token' },
  requireQualification: true, ...extra });
async function* success(options) {
  assert.equal(options.allowAuthRefresh, false);
  options.onDispatch();
  yield { type: 'sources', sources: [{ title: 'Synthetic evidence' }], sourceKinds: ['knowledge'] };
  yield { type: 'delta', text: 'Synthetic answer' };
  yield { type: 'done' };
}
function fixture(t, streamAsk = success) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-activation-'));
  const directory = new WebAgentAccountDirectory({ storePath: path.join(root, 'accounts.json'),
    keyPath: path.join(root, 'key'), keyMaterial: 'synthetic-activation-key' });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  directory.upsertCapturedAccount(capture());
  const pool = new IMAWebAgentPool({ accounts: directory.getPoolAccounts() }, {
    clientFactory: () => ({ applyConfig() {}, stopAutoRefresh() {} }),
    onAccountStateChange: row => directory.recordRuntimeState(row),
  });
  const readiness = new WebReadiness({ directory, pool, mode: 'classic_knowledge', timeoutMs: 1000,
    clientFactory: () => ({ streamAsk }) });
  return { directory, pool, readiness };
}
function assertPending(f) {
  const account = f.directory.reload().accounts[0];
  assert.equal(account.runtime.disabled, true);
  assert.equal(account.runtime.enrollmentQualificationRequired, true);
  assert.equal(account.runtime.webQualification, null);
  assert.equal(f.readiness.snapshot().capacity, 0);
  assert.match(f.directory.getPoolAccounts()[0].headers['x-ima-cookie'], /synthetic-token/);
}

test('capture persists disabled on first write; classic cannot dispatch or bypass with enable', async t => {
  const f = fixture(t);
  assertPending(f);
  assert.equal(f.directory.getAccount('synthetic').runtime.disabledReason, PENDING);
  assert.throws(() => f.directory.setDisabled('synthetic', false), { code: 'enrollment_qualification_required' });
  const stream = f.pool.streamAsk({ question: 'Synthetic', mode: 'classic_knowledge' });
  await assert.rejects(stream.next());
  f.directory.recordRuntimeState({ id: 'synthetic', disabled: false });
  f.readiness.sync();
  assertPending(f);
});

test('single successful probe commits proof and activation in one write, retaining ciphertext', async t => {
  const f = fixture(t);
  const secret = JSON.stringify(f.directory.getAccount('synthetic').secret);
  const writes = [];
  const write = f.directory._writeStore.bind(f.directory);
  f.directory._writeStore = () => {
    const runtime = f.directory.getAccount('synthetic').runtime;
    writes.push({ disabled: runtime.disabled, proof: Boolean(runtime.webQualification) });
    write();
  };
  const result = await f.readiness.verify('synthetic');
  assert.equal(result.success, true);
  assert.equal(result.capacity, 1);
  assert.ok(writes.some(row => !row.disabled && row.proof));
  assert.equal(writes.some(row => !row.disabled && !row.proof), false);
  assert.equal(JSON.stringify(f.directory.reload().accounts[0].secret), secret);
  assert.equal(f.directory.getAccount('synthetic').runtime.enrollmentQualificationRequired, false);
});

for (const code of ['auth_expired', 'auth_rejected', 'account_not_checked']) {
  test(`one successful bound answer replaces stale ${code} health and is schedulable`, async t => {
    const f = fixture(t);
    f.directory.recordAccountHealth('synthetic', { code, sessionValid: false,
      knowledgeReady: false, webReady: false });
    f.readiness.setMode('knowledge_agent');
    const result = await f.readiness.verify('synthetic');
    assert.equal(result.success, true);
    assert.equal(result.capacity, 1);
    assert.equal(result.schedulable, 1);
    assert.equal(result.basicHealthy, 1);
    assert.equal(f.pool.webReadiness(f.pool.accounts[0]), true);
    const health = f.directory.listAccounts()[0].health;
    assert.equal(health.last_check_code, 'ok');
    assert.equal(health.last_check_at, f.directory.getAccount('synthetic').runtime.webQualification.verifiedAt);
    f.pool.accounts[0].activeRequests = 1;
    assert.equal(f.readiness.snapshot().capacity, 1);
    assert.equal(f.readiness.snapshot().schedulable, 0);
    f.pool.accounts[0].activeRequests = 0;
    f.pool.accounts[0].client.streamAsk = async function* () { yield { type: 'done' }; };
    for await (const event of f.pool.streamAsk({ mode: 'knowledge_agent', question: 'Synthetic' })) {
      assert.ok(['route', 'done'].includes(event.type));
    }
    assert.equal(f.pool.accounts[0].activeRequests, 0);
  });
}

test('failed probe does not replace failed health with success', async t => {
  const f = fixture(t, async function* (options) { options.onDispatch(); yield { type: 'done' }; });
  f.directory.recordAccountHealth('synthetic', { code: 'auth_expired', sessionValid: false });
  const result = await f.readiness.verify('synthetic');
  assert.equal(result.success, false);
  assert.equal(result.basicHealthy, 0);
  assert.equal(f.directory.listAccounts()[0].health.last_check_code, 'auth_expired');
  assertPending(f);
});

for (const outcome of ['failure', 'cancel', 'timeout']) {
  test(`${outcome} retains disabled credentials and retry needs no capture`, async t => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = fixture(t, async function* (options) {
      options.onDispatch();
      if (outcome !== 'failure') await gate;
      yield { type: 'delta', text: 'Synthetic without knowledge sources' };
      yield { type: 'done' };
    });
    if (outcome === 'timeout') f.readiness.timeoutMs = 10;
    const pending = f.readiness.verify('synthetic');
    if (outcome === 'cancel') f.readiness.cancel('synthetic');
    const result = await pending;
    release();
    assert.equal(result.success, false);
    assertPending(f);
    f.readiness.clientFactory = () => ({ streamAsk: success });
    assert.equal((await f.readiness.verify('synthetic')).success, true);
  });
}

for (const drift of ['manual-disable', 'credentials', 'scope', 'identity', 'delete-recreate']) {
  test(`late probe cannot activate after ${drift}`, async t => {
    const f = fixture(t);
    f.readiness.clientFactory = () => ({ async *streamAsk(options) {
      const other = new WebAgentAccountDirectory({ storePath: f.directory.storePath,
        keyPath: f.directory.keyPath, keyMaterial: 'synthetic-activation-key' });
      if (drift === 'manual-disable') other.setDisabled('synthetic', true);
      else if (drift === 'delete-recreate') {
        other.deleteAccount('synthetic'); other.upsertCapturedAccount(capture());
      } else if (drift === 'credentials') other.replaceCapturedAccount('synthetic', capture({
        headers: { 'x-ima-cookie': 'IMA-UID=synthetic-user; IMA-TOKEN=synthetic-token-rotated' },
      }));
      else {
        const account = other.getAccount('synthetic');
        if (drift === 'scope') account.knowledgeBaseId = 'synthetic-other-kb';
        else account.principalFingerprint = 'synthetic-other-principal';
        other._writeStore();
      }
      yield* success(options);
    } });
    const result = await f.readiness.verify('synthetic');
    assert.equal(result.success, false);
    assert.equal(result.code, 'account_store_generation_conflict');
    assertPending(f);
    if (drift === 'manual-disable') assert.equal(f.directory.getAccount('synthetic').runtime.disabledReason, 'disabled_by_admin');
  });
}

for (const reason of ['disabled_by_admin', 'migration_verification_required', 'synthetic-owner-stop']) {
  test(`reauth and proof retain ${reason} and saved login`, async t => {
    const f = fixture(t);
    f.directory.setDisabled('synthetic', true, reason);
    f.directory.replaceCapturedAccount('synthetic', capture());
    f.readiness.sync();
    assert.equal(f.directory.getAccount('synthetic').runtime.disabledReason, reason);
    const result = await f.readiness.verify('synthetic');
    assert.equal(result.success, true);
    assert.equal(result.capacity, 0);
    const account = f.directory.reload().accounts[0];
    assert.equal(account.runtime.disabled, true);
    assert.equal(account.runtime.disabledReason, reason);
    assert.ok(account.runtime.webQualification);
    assert.match(f.directory.getPoolAccounts()[0].headers['x-ima-cookie'], /synthetic-token/);
    f.directory.setDisabled('synthetic', false);
    assert.equal(f.directory.getAccount('synthetic').runtime.disabled, false);
  });
}

for (const reason of ['auth_failed', 'knowledge_base_unavailable']) {
  test(`same-identity recovery from ${reason} enters pending before activation`, async t => {
    const f = fixture(t);
    f.directory.setDisabled('synthetic', true, reason);
    f.directory.replaceCapturedAccount('synthetic', capture());
    f.readiness.sync();
    assert.equal(f.directory.getAccount('synthetic').runtime.disabledReason, PENDING);
    assert.equal((await f.readiness.verify('synthetic')).success, true);
    assert.equal(f.directory.getAccount('synthetic').runtime.disabled, false);
  });
}

test('failed revalidation of a previously enabled classic account leaves it disabled', async t => {
  const f = fixture(t);
  assert.equal((await f.readiness.verify('synthetic')).success, true);
  f.readiness.clientFactory = () => ({ async *streamAsk(options) { options.onDispatch(); yield { type: 'done' }; } });
  assert.equal((await f.readiness.verify('synthetic')).success, false);
  assertPending(f);
});

test('activation write failure never enables disk or pool and preserves credentials', async t => {
  const f = fixture(t);
  const write = f.directory._writeStore.bind(f.directory);
  f.directory._writeStore = () => {
    if (f.directory.getAccount('synthetic').runtime.webQualification) throw new Error('synthetic-write-failure');
    write();
  };
  assert.equal((await f.readiness.verify('synthetic')).success, false);
  assertPending(f);
  assert.equal(f.directory.listAccounts()[0].health.last_check_code, 'account_not_checked');
  assert.equal(f.directory.listAccounts()[0].health.session_valid, null);
});

test('runtime import cannot bypass a captured admission gate or manual pause', t => {
  const f = fixture(t);
  f.directory.setDisabled('synthetic', true, 'disabled_by_admin');
  const runtimeEnvText = buildRuntimeEnvText({ accountId: 'synthetic', accountName: 'synthetic',
    knowledgeBaseId: 'synthetic-kb', headers: capture().headers });
  f.directory.upsertFromRuntimeEnv({ runtimeEnvText, replace: true });
  f.readiness.sync();
  assertPending(f);
  assert.equal(f.directory.getAccount('synthetic').runtime.disabledReason, 'disabled_by_admin');
});

test('first capture is never persisted enabled before pending state', t => {
  const f = fixture(t);
  const writes = [];
  const write = f.directory._writeStore.bind(f.directory);
  f.directory._writeStore = () => {
    const account = f.directory.getAccount('synthetic-new');
    writes.push({ disabled: account.runtime.disabled, reason: account.runtime.disabledReason });
    write();
  };
  f.directory.upsertCapturedAccount(capture({ id: 'synthetic-new', name: 'synthetic-new',
    headers: { 'x-ima-cookie': 'IMA-UID=synthetic-new; IMA-TOKEN=synthetic-token' } }));
  assert.deepEqual(writes, [{ disabled: true, reason: PENDING }]);
});

test('late cancellation reports already committed success instead of pretending to undo activation', async t => {
  const f = fixture(t);
  assert.equal((await f.readiness.verify('synthetic')).success, true);
  assert.equal(f.readiness.cancel('synthetic').completed, true);
  assert.equal(f.directory.reload().accounts[0].runtime.disabled, false);
  f.directory.replaceCapturedAccount('synthetic', capture());
  assert.equal(f.readiness.cancel('synthetic').completed, false);
});

test('protected capture and retry APIs use stored credentials and never probe on GET or failed auth', async t => {
  const f = fixture(t);
  let probes = 0;
  f.readiness.clientFactory = () => ({ async *streamAsk(options) { probes++; yield* success(options); } });
  const app = express(); app.use(express.json());
  registerAdminRoutes(app, { accountDirectory: f.directory, imaWebAgentClient: f.pool, webReadiness: f.readiness,
    config: { security: { adminToken: 'synthetic-admin' }, webAgent: { sharedKnowledgeBaseId: 'synthetic-kb' } } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer synthetic-admin', 'content-type': 'application/json' };
  const route = '/api/admin/accounts/synthetic/verify';
  assert.equal((await fetch(base + route, { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/api/admin/accounts', { headers })).status, 200);
  assert.equal(probes, 0);
  assert.equal((await fetch(base + '/api/admin/accounts/synthetic/enable', { method: 'POST', headers })).status, 409);
  const result = await (await fetch(base + route, { method: 'POST', headers, body: JSON.stringify({ question: 'Synthetic' }) })).json();
  assert.equal(result.success, true);
  assert.equal(result.activated, true);
  assert.equal(probes, 1);
  const captured = await (await fetch(base + '/api/admin/accounts', { method: 'POST', headers,
    body: JSON.stringify(capture({ id: 'synthetic-new', name: 'synthetic-new', requireQualification: false,
      headers: { 'x-ima-cookie': 'IMA-UID=synthetic-new; IMA-TOKEN=synthetic-token' } })) })).json();
  assert.equal(captured.success, true);
  assert.equal(captured.account.status, 'disabled');
  assert.equal(probes, 1);
  const runtimeEnvText = buildRuntimeEnvText({ accountId: 'synthetic-import', accountName: 'synthetic-import',
    knowledgeBaseId: 'synthetic-kb', headers: { 'x-ima-cookie': 'IMA-UID=synthetic-import; IMA-TOKEN=synthetic-token' } });
  const imported = await (await fetch(base + '/api/admin/accounts/import-runtime', { method: 'POST', headers,
    body: JSON.stringify({ runtimeEnvText, requireQualification: false }) })).json();
  assert.equal(imported.success, true);
  assert.equal(imported.account.status, 'disabled');
  assert.equal(probes, 1);
});

test('verify route preserves committed receipt when its capacity callback fails', async t => {
  const f = fixture(t);
  let callbacks = 0;
  const app = express(); app.use(express.json());
  registerAdminRoutes(app, { accountDirectory: f.directory, imaWebAgentClient: f.pool, webReadiness: f.readiness,
    onAccountsSynced: () => { if (++callbacks > 1) throw new Error('synthetic-private-callback'); },
    config: { security: { adminToken: 'synthetic-admin' } } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/accounts/synthetic/verify`, {
    method: 'POST', headers: { authorization: 'Bearer synthetic-admin', 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'Synthetic' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.commitApplied, true);
  assert.equal(result.success, true);
  assert.equal(result.warning, 'post_commit_update_failed');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  assert.equal(f.directory.getAccount('synthetic').runtime.disabled, false);
});

test('deletion during a probe rejects proof and never resurrects the account', async t => {
  const f = fixture(t);
  f.readiness.clientFactory = () => ({ async *streamAsk(options) {
    f.directory.deleteAccount('synthetic');
    yield* success(options);
  } });
  const result = await f.readiness.verify('synthetic');
  assert.equal(result.code, 'account_store_generation_conflict');
  assert.equal(f.directory.reload().accounts.length, 0);
  assert.equal(f.pool.accounts.length, 0);
});

test('duplicate verification is rejected without a second dispatch', async t => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async function* (options) { calls++; await gate; yield* success(options); });
  const pending = f.readiness.verify('synthetic');
  await assert.rejects(f.readiness.verify('synthetic'), { statusCode: 409 });
  release();
  assert.equal((await pending).success, true);
  assert.equal(calls, 1);
});

test('local CLI capture explicitly requests the same durable qualification gate', () => {
  const script = fs.readFileSync(path.join(__dirname, '../scripts/enroll-web-agent-account.mjs'), 'utf8');
  const input = script.slice(script.indexOf('const accountInput = {'), script.indexOf('const account = serverUrl'));
  assert.match(input, /requireQualification:\s*true/);
});

for (const invalid of ['duplicate-dispatch', 'duplicate-terminal', 'missing-source']) {
  test(`${invalid} never releases the pending gate`, async t => {
    const f = fixture(t, async function* (options) {
      options.onDispatch();
      if (invalid === 'duplicate-dispatch') options.onDispatch();
      if (invalid !== 'missing-source') yield { type: 'sources', sources: [{}], sourceKinds: ['knowledge'] };
      yield { type: 'delta', text: 'Synthetic answer' };
      yield { type: 'done' };
      if (invalid === 'duplicate-terminal') yield { type: 'done' };
    });
    assert.equal((await f.readiness.verify('synthetic')).success, false);
    assertPending(f);
  });
}

test('post-commit pool sync failure retains local quarantine and reports committed proof honestly', async t => {
  const f = fixture(t);
  const sync = f.pool.syncAccounts.bind(f.pool);
  f.pool.syncAccounts = rows => {
    sync(rows);
    if (rows.some(row => row.webQualification)) throw new Error('synthetic-sync-failure');
  };
  const result = await f.readiness.verify('synthetic');
  assert.equal(result.success, false);
  assert.equal(result.code, 'pool_sync_failed');
  assert.equal(result.capacity, 0);
  assert.equal(f.pool.accounts[0].maintenanceOperation, 'qualification');
  assert.ok(f.directory.reload().accounts[0].runtime.webQualification);
});

for (const phase of ['quarantine', 'commit']) {
  for (const fault of ['before', 'after', 'replacement']) {
    for (const mode of ['classic_knowledge', 'knowledge_agent']) {
      test(`${phase} sync fault ${fault} in ${mode} closes admission and preserves commit outcome`, async t => {
        const f = fixture(t);
        assert.equal((await f.readiness.verify('synthetic')).success, true);
        f.readiness.setMode(mode);
        let probes = 0, syncs = 0;
        f.readiness.clientFactory = () => ({ async *streamAsk(options) { probes++; yield* success(options); } });
        const sync = f.pool.syncAccounts.bind(f.pool);
        f.pool.syncAccounts = rows => {
          if (++syncs !== (phase === 'quarantine' ? 1 : 2)) return sync(rows);
          if (fault !== 'before') sync(rows);
          if (fault === 'replacement') f.pool.accounts = f.pool.accounts.map(row => ({ ...row, maintenanceOperation: '' }));
          throw new Error('synthetic-sync-fault');
        };
        const result = await f.readiness.verify('synthetic');
        assert.equal(result.code, 'pool_sync_failed');
        assert.equal(result.success, false);
        assert.equal(result.capacity, 0);
        assert.equal(result.knowledgeAgentCapacity, 0);
        assert.equal(result.schedulable, 0);
        assert.equal(f.pool._leaseAccount(), null);
        assert.equal(result.commitApplied, phase === 'commit');
        assert.equal(result.warning, 'pool_sync_failed');
        assert.equal(result.activated, phase === 'commit');
        assert.equal(probes, phase === 'commit' ? 1 : 0);
        const account = f.directory.reload().accounts[0];
        assert.equal(account.runtime.disabled, phase !== 'commit');
        assert.equal(Boolean(account.runtime.webQualification), phase === 'commit');
        const cancelled = f.readiness.cancel('synthetic');
        assert.equal(cancelled.completed, phase === 'commit');
        assert.equal(cancelled.commitApplied, phase === 'commit');
        assert.equal(cancelled.warning, 'pool_sync_failed');
        assert.equal(f.readiness.snapshot().capacity, 0);
      });
    }
  }
}
