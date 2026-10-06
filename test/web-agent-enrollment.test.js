const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const {
  WebAgentEnrollmentManager,
  captureAuthFromContext,
  captureLoginScreenshot,
  classifyImaLoginMode,
  classifyImaScanState,
  isQrLoginActionText,
  publicEnrollmentError,
  readDevToolsDebuggerUrl,
} = require('../src/web-agent-enrollment');

function makeTempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ima-enrollment-'));
}

function makeFakeBrowser() {
  const page = {
    async goto() {},
    async evaluate() {
      return { x: 10, y: 20, width: 240, height: 240 };
    },
    async screenshot() {
      return Buffer.from('synthetic-qr-image');
    },
  };
  const context = {
    closed: false,
    pages() {
      return [page];
    },
    async newPage() {
      return page;
    },
    async close() {
      this.closed = true;
    },
  };
  return { context, page };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for enrollment state');
}

function makeManager(overrides = {}) {
  const tempDir = makeTempDirectory();
  const accountDirectory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });
  const fakeBrowser = makeFakeBrowser();
  const poolCalls = [];
  const pool = {
    syncAccounts(accounts) {
      poolCalls.push(accounts);
    },
  };
  const state = { auth: null, wake: null, initCalls: 0 };
  const manager = new WebAgentEnrollmentManager({
    accountDirectory,
    pool,
    config: {
      webAgent: {
        sharedKnowledgeBaseId: 'web-kb-id',
        browserPath: process.execPath,
        enrollmentTimeoutMs: 30000,
        enrollmentScreenshotIntervalMs: 1000,
      },
    },
    browserLauncher: async () => fakeBrowser.context,
    captureAuth: async () => state.auth,
    clientFactory: () => ({
      async initSession() {
        state.initCalls += 1;
        if (overrides.initError) {
          throw overrides.initError;
        }
      },
    }),
    sleep: () => new Promise((resolve) => {
      state.wake = resolve;
    }),
    ...overrides,
  });
  return { tempDir, accountDirectory, fakeBrowser, manager, poolCalls, state };
}

function syntheticAuth(uid = 'synthetic-distinct') {
  return { headers: { 'x-ima-cookie': `IMA-UID=${uid}; IMA-TOKEN=synthetic-new-token; IMA-REFRESH-TOKEN=synthetic-refresh`, 'x-ima-bkn': '123' } };
}

async function conflictSetup(overrides = {}) {
  const setup = makeManager(overrides);
  const { manager, state, accountDirectory } = setup;
  accountDirectory.upsertCapturedAccount({ id: 'original', name: 'original', knowledgeBaseId: 'web-kb-id',
    headers: syntheticAuth('synthetic-original').headers });
  setup.original = JSON.stringify(accountDirectory.getAccount('original'));
  setup.storeBytes = fs.readFileSync(accountDirectory.storePath);
  const started = await manager.start({ reauthAccountId: 'original' });
  setup.id = started.taskId;
  await waitFor(() => Boolean(state.wake));
  state.auth = syntheticAuth(); state.wake();
  await waitFor(() => manager.get(setup.id).state === 'identity_conflict');
  return setup;
}

test('identity conflict is private, preserves store, adds once and runs the declared hook once', async () => {
  let hooks = 0;
  const setup = await conflictSetup({ onEnrolled: async () => { hooks++; return { success: true }; } });
  const { manager, id, accountDirectory, storeBytes, original, state } = setup;
  try {
    assert.deepEqual(fs.readFileSync(accountDirectory.storePath), storeBytes);
    assert.equal(state.initCalls, 0);
    for (const snapshot of [manager.get(id), manager.getActive()]) {
      assert.deepEqual(snapshot.identityConflict, { actions: ['add', 'cancel'] });
      assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-distinct|synthetic-new-token|synthetic-refresh|principalFingerprint|x-ima/);
    }
    assert.equal(hooks, 0);
    manager.captureAuth = async () => { throw new Error('must not rescan'); };
    await Promise.all([manager.resolveIdentityConflict(id, { action: 'add', name: 'new-account' }),
      manager.resolveIdentityConflict(id, { action: 'add', name: 'second-account' })]);
    assert.equal(manager.get(id).state, 'completed');
    assert.equal(accountDirectory.listAccounts().length, 2);
    assert.deepEqual(accountDirectory.getAccount('original'), JSON.parse(original));
    assert.equal(hooks, 1);
    assert.equal(state.initCalls, 1);
    assert.equal(manager.jobs.get(id).pendingAuth, null);
    await assert.rejects(manager.resolveIdentityConflict(id, { action: 'add', name: 'again' }), { statusCode: 409 });
  } finally { await manager.shutdown(); }
});

test('conflict addition keeps the original pool client and session', async () => {
  const { manager, id, accountDirectory } = await conflictSetup();
  const pool = new IMAWebAgentPool({ accounts: accountDirectory.getPoolAccounts() }, {
    clientFactory: config => ({ headers: config.headers, sessionId: 'synthetic-session',
      applyConfig(next) { this.headers = next.headers; } }),
  });
  manager.pool = pool;
  const originalClient = pool.accounts[0].client;
  const originalHeaders = { ...originalClient.headers };
  try {
    await manager.resolveIdentityConflict(id, { action: 'add', name: 'new' });
    assert.equal(pool.accounts.length, 2);
    assert.equal(pool.accounts[0].client, originalClient);
    assert.equal(originalClient.sessionId, 'synthetic-session');
    assert.deepEqual(originalClient.headers, originalHeaders);
  } finally { await manager.shutdown(); }
});

test('conflict cancellation does not cancel unrelated verification on original account', async () => {
  const cancelled = [];
  const { manager, id } = await conflictSetup({ onCancelVerification: id => cancelled.push(id) });
  await manager.cancel(id);
  assert.deepEqual(cancelled, []);
  await manager.shutdown();
});

test('conflict expires without an add request and clears all task resources', async () => {
  let now = Date.now();
  const { manager, id, fakeBrowser, accountDirectory, storeBytes } = await conflictSetup({ now: () => now });
  try {
    const job = manager.jobs.get(id);
    clearTimeout(job.expiryTimer);
    now = job.expiresAt;
    manager._scheduleExpiry(job);
    await waitFor(() => job.state === 'failed' && job.context === null);
    assert.equal(job.pendingAuth, null);
    assert.equal(fakeBrowser.context.closed, true);
    assert.deepEqual(fs.readFileSync(accountDirectory.storePath), storeBytes);
  } finally { await manager.shutdown(); }
});

test('invalid conflict decisions retain the pending login and do not change the store', async () => {
  const { manager, id, accountDirectory, storeBytes } = await conflictSetup();
  try {
    await assert.rejects(manager.resolveIdentityConflict(id, { action: 'replace', name: 'new' }), { statusCode: 400 });
    await assert.rejects(manager.resolveIdentityConflict(id, { action: 'add', name: '' }), { statusCode: 400 });
    assert.equal(manager.get(id).state, 'identity_conflict');
    assert.ok(manager.jobs.get(id).pendingAuth);
    assert.deepEqual(fs.readFileSync(accountDirectory.storePath), storeBytes);
  } finally { await manager.shutdown(); }
});

test('conflict add waits for membership and concurrent continue uses captured auth once', async () => {
  let membership = 'not_joined'; let hooks = 0;
  const { manager, id, accountDirectory, state } = await conflictSetup({
    membershipVerifier: async () => ({ membership }),
    onEnrolled: async () => { hooks++; return { success: true }; },
  });
  try {
    manager.jobs.get(id).shareUrl = 'https://ima.qq.com/wiki/?shareId=' + 'a'.repeat(64);
    manager.captureAuth = async () => { throw new Error('must not rescan'); };
    await manager.resolveIdentityConflict(id, { action: 'add', name: 'member' });
    assert.equal(manager.get(id).state, 'waiting_for_membership');
    assert.equal(accountDirectory.listAccounts().length, 1);
    membership = 'joined';
    await Promise.all([manager.continueVerification(id), manager.continueVerification(id)]);
    assert.equal(manager.get(id).state, 'completed');
    assert.equal(accountDirectory.listAccounts().length, 2);
    assert.equal(state.initCalls, 1);
    assert.equal(hooks, 1);
  } finally { await manager.shutdown(); }
});

test('conflict duplicate identity fails without replacing credentials or duplicating capacity', async () => {
  const { manager, id, accountDirectory, original } = await conflictSetup();
  try {
    accountDirectory.upsertCapturedAccount({ id: 'existing', name: 'existing', knowledgeBaseId: 'web-kb-id',
      headers: syntheticAuth().headers });
    const before = fs.readFileSync(accountDirectory.storePath);
    await manager.resolveIdentityConflict(id, { action: 'add', name: 'duplicate' });
    assert.equal(manager.get(id).state, 'failed');
    assert.equal(manager.get(id).diagnostics.lastFailure.code, 'duplicate_ima_identity');
    assert.deepEqual(fs.readFileSync(accountDirectory.storePath), before);
    assert.deepEqual(accountDirectory.getAccount('original'), JSON.parse(original));
    assert.equal(accountDirectory.listAccounts().length, 2);
    assert.equal(manager.jobs.get(id).pendingAuth, null);
  } finally { await manager.shutdown(); }
});

for (const action of ['cancel', 'expiry', 'failure']) {
  test(`pending conflict ${action} clears private auth and browser without changing store`, async () => {
    let now = Date.now();
    const { manager, id, accountDirectory, storeBytes, fakeBrowser } = await conflictSetup({ now: () => now });
    try {
      if (action === 'cancel') await manager.cancel(id);
      else {
        if (action === 'expiry') now += 60000;
        else manager.clientFactory = () => ({ initSession: async () => { throw new Error('synthetic failure'); } });
        await manager.resolveIdentityConflict(id, { action: 'add', name: 'new' });
      }
      assert.equal(manager.get(id).state, action === 'cancel' ? 'cancelled' : 'failed');
      assert.equal(manager.jobs.get(id).pendingAuth, null);
      assert.equal(fakeBrowser.context.closed, true);
      assert.deepEqual(fs.readFileSync(accountDirectory.storePath), storeBytes);
    } finally { await manager.shutdown(); }
  });
}

for (const interruption of ['cancel', 'expiry']) {
  test(`conflict ${interruption} during session verification prevents late persistence`, async () => {
    let now = Date.now(); let release; let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const setup = await conflictSetup({ now: () => now });
    const { manager, id, accountDirectory, storeBytes } = setup;
    manager.clientFactory = () => ({ initSession: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
    try {
      const adding = manager.resolveIdentityConflict(id, { action: 'add', name: 'late' });
      await ready;
      if (interruption === 'cancel') await manager.cancel(id);
      else now += 60000;
      release(); await adding;
      assert.deepEqual(fs.readFileSync(accountDirectory.storePath), storeBytes);
      assert.equal(manager.jobs.get(id).pendingAuth, null);
      assert.equal(manager.get(id).state, interruption === 'cancel' ? 'cancelled' : 'failed');
    } finally { await manager.shutdown(); }
  });
}

test('unknown scanned identity fails closed and preserves original credentials', async () => {
  const setup = makeManager();
  const { manager, state, accountDirectory } = setup;
  accountDirectory.upsertCapturedAccount({ id: 'original', name: 'original', knowledgeBaseId: 'web-kb-id', headers: syntheticAuth('original').headers });
  const before = fs.readFileSync(accountDirectory.storePath);
  try {
    const { taskId } = await manager.start({ reauthAccountId: 'original' });
    await waitFor(() => Boolean(state.wake));
    state.auth = { headers: { 'x-ima-cookie': 'IMA-TOKEN=synthetic-no-uid', 'x-ima-bkn': '123' } }; state.wake();
    await waitFor(() => manager.get(taskId).state === 'failed');
    assert.equal(manager.get(taskId).diagnostics.lastFailure.code, 'ima_identity_unverified');
    assert.deepEqual(fs.readFileSync(accountDirectory.storePath), before);
    assert.equal(state.initCalls, 0);
  } finally { await manager.shutdown(); }
});

test('share authorization waits in memory and resumes in the same window after joining', async () => {
  let permission = 'not_joined';
  const setup = makeManager({ membershipVerifier: async () => ({ membership: permission }) });
  const { manager, state, accountDirectory, fakeBrowser, poolCalls } = setup;
  manager.config.webAgent.sharedKnowledgeBaseShareUrl = 'https://ima.qq.com/wiki/?shareId=' + 'a'.repeat(64);
  const started = await manager.start({ name: 'synthetic-member' });
  await waitFor(() => Boolean(state.wake));
  state.auth = { headers: { 'x-ima-cookie': 'IMA-UID=synthetic; IMA-TOKEN=synthetic', 'x-ima-bkn': '123' } };
  state.wake();
  await waitFor(() => manager.get(started.taskId).state === 'waiting_for_membership');
  assert.equal(accountDirectory.listAccounts().length, 0);
  assert.equal(poolCalls.length, 0);
  assert.equal(fakeBrowser.context.closed, false);
  assert.equal(state.initCalls, 0);
  permission = 'joined';
  await manager.continueVerification(started.taskId);
  assert.equal(manager.get(started.taskId).state, 'completed');
  assert.equal(accountDirectory.listAccounts().length, 1);
  assert.equal(fakeBrowser.context.closed, true);
  await assert.rejects(manager.continueVerification(started.taskId), /不在等待/);
  await manager.shutdown();
});

test('permission network failures do not assert non-membership; cancelling never stores auth', async () => {
  const { manager, state, accountDirectory, fakeBrowser } = makeManager({ membershipVerifier: async () => { throw new Error('synthetic network failure'); } });
  manager.config.webAgent.sharedKnowledgeBaseShareUrl = 'https://ima.qq.com/wiki/?shareId=' + 'a'.repeat(64);
  const started = await manager.start({ name: 'synthetic-unknown' });
  await waitFor(() => Boolean(state.wake));
  state.auth = { headers: { 'x-ima-cookie': 'IMA-UID=synthetic; IMA-TOKEN=synthetic', 'x-ima-bkn': '123' } }; state.wake();
  await waitFor(() => manager.get(started.taskId).state === 'access_unverified');
  assert.equal(manager.get(started.taskId).authorizationStatus, 'unknown');
  await manager.cancel(started.taskId);
  assert.equal(accountDirectory.listAccounts().length, 0);
  assert.equal(fakeBrowser.context.closed, true);
  await manager.shutdown();
});

test('QR enrollment keeps screenshot in memory and stores credentials only after session verification', async () => {
  const { accountDirectory, fakeBrowser, manager, poolCalls, state } = makeManager();
  const started = await manager.start({ name: 'account-c' });
  await waitFor(() => manager.get(started.taskId).state === 'waiting_for_scan');
  assert.equal(manager.getQr(started.taskId).toString(), 'synthetic-qr-image');

  await waitFor(() => Boolean(state.wake));
  state.auth = {
    headers: {
      'x-ima-cookie': 'IMA-UID=user-c; IMA-TOKEN=access-c; IMA-REFRESH-TOKEN=refresh-c',
      'x-ima-bkn': '123',
    },
    tokenExpiresAt: 1785257551943,
    refreshTokenExpiresAt: 1787842056525,
  };
  state.wake();

  await waitFor(() => manager.get(started.taskId).state === 'completed');
  const completed = manager.get(started.taskId);
  assert.equal(completed.account.name, 'account-c');
  assert.equal(JSON.stringify(completed).includes('access-c'), false);
  assert.equal(accountDirectory.listAccounts().length, 1);
  assert.equal(JSON.stringify(accountDirectory.listAccounts()).includes('refresh-c'), false);
  assert.equal(state.initCalls, 1);
  assert.equal(poolCalls.length, 1);
  assert.equal(fakeBrowser.context.closed, true);
  assert.throws(() => manager.getQr(started.taskId), /没有可展示/);
});

test('enrollment closes browser before one automatic probe and retains account when probe fails', async () => {
  let calls = 0;
  const setup = makeManager({ onEnrolled: async (id, question) => {
    calls++;
    assert.equal(setup.fakeBrowser.context.closed, true);
    assert.equal(question, 'Synthetic test question');
    assert.ok(setup.accountDirectory.getAccount(id));
    return { success: false, code: 'probe_evidence_insufficient' };
  } });
  const { manager, state, accountDirectory } = setup;
  const started = await manager.start({ name: 'synthetic-enrollment', testQuestion: 'Synthetic test question' });
  await waitFor(() => Boolean(state.wake));
  state.auth = { headers: { 'x-ima-cookie': 'IMA-UID=synthetic-user; IMA-TOKEN=synthetic-token', 'x-ima-bkn': '123' } };
  state.wake();
  await waitFor(() => manager.get(started.taskId).state === 'failed');
  assert.equal(calls, 1);
  assert.equal(accountDirectory.listAccounts().length, 1);
  assert.equal(accountDirectory.listAccounts()[0].status, 'disabled');
  assert.match(manager.get(started.taskId).detail, /验证未通过/);
  assert.equal(JSON.stringify(manager.get(started.taskId)).includes('Synthetic test question'), false);
  await manager.shutdown();
});

test('QR re-login is bound to the existing slot and preserves it on identity mismatch', async () => {
  const { accountDirectory, manager, state } = makeManager();
  accountDirectory.upsertCapturedAccount({
    id: 'account-c',
    name: 'Account C',
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=user-c; IMA-TOKEN=old-token; IMA-REFRESH-TOKEN=old-refresh',
      'x-ima-bkn': '123',
    },
  });

  const started = await manager.start({
    reauthAccountId: 'account-c',
    name: 'attacker-name',
  });
  assert.equal(started.name, 'Account C');
  await waitFor(() => manager.get(started.taskId).state === 'waiting_for_scan');
  await waitFor(() => Boolean(state.wake));
  state.auth = {
    headers: {
      'x-ima-cookie': 'IMA-UID=different-user; IMA-TOKEN=new-token; IMA-REFRESH-TOKEN=new-refresh',
      'x-ima-bkn': '456',
    },
  };
  state.wake();

  await waitFor(() => manager.get(started.taskId).state === 'identity_conflict');
  assert.equal(manager.get(started.taskId).error, null);
  assert.equal(accountDirectory.listAccounts().length, 1);
  assert.equal(accountDirectory.listAccounts()[0].name, 'Account C');
  await manager.cancel(started.taskId);
});

test('QR re-login replaces the original slot only after the same IMA identity verifies', async () => {
  const { accountDirectory, manager, poolCalls, state } = makeManager();
  accountDirectory.upsertCapturedAccount({
    id: 'account-c',
    name: 'Account C',
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=user-c; IMA-TOKEN=old-token; IMA-REFRESH-TOKEN=old-refresh',
      'x-ima-bkn': '123',
    },
  });

  const started = await manager.start({ reauthAccountId: 'account-c' });
  await waitFor(() => manager.get(started.taskId).state === 'waiting_for_scan');
  await waitFor(() => Boolean(state.wake));
  state.auth = {
    headers: {
      'x-ima-cookie': 'IMA-UID=user-c; IMA-TOKEN=new-token; IMA-REFRESH-TOKEN=new-refresh',
      'x-ima-bkn': '456',
    },
  };
  state.wake();

  await waitFor(() => manager.get(started.taskId).state === 'completed');
  assert.equal(manager.get(started.taskId).mode, 'reauth');
  assert.equal(accountDirectory.listAccounts().length, 1);
  assert.equal(accountDirectory.listAccounts()[0].name, 'Account C');
  assert.equal(state.initCalls, 1);
  assert.equal(poolCalls.length, 1);
});

test('captureAuthFromContext recognizes a compatible IMA account record outside the legacy storage key', async () => {
  const context = {
    async cookies() {
      return [];
    },
    pages() {
      return [{
        async evaluate() {
          return [{
            key: 'ima-auth-session-v2',
            value: {
              data: {
                accessToken: 'access-c',
                refresh_token: 'refresh-c',
                user_id: 'user-c',
                tokenType: 0,
                idType: 1,
              },
            },
          }];
        },
      }];
    },
  };

  const auth = await captureAuthFromContext(context);

  assert.equal(auth.headers['x-ima-cookie'].includes('IMA-UID=user-c'), true);
  assert.equal(auth.headers['x-ima-cookie'].includes('IMA-TOKEN=access-c'), true);
  assert.equal(auth.headers['x-ima-cookie'].includes('IMA-REFRESH-TOKEN=refresh-c'), true);
  assert.equal(auth.headers['x-ima-bkn'].length > 0, true);
});

test('captureAuthFromContext accepts a compatible IMA account record from session storage', async () => {
  const context = {
    async cookies() {
      return [];
    },
    pages() {
      return [{
        async evaluate() {
          return [{
            scope: 'session',
            key: 'ima-login-session',
            value: {
              accountInfo: {
                token: 'access-session',
                refreshToken: 'refresh-session',
                uid: 'user-session',
              },
            },
          }];
        },
      }];
    },
  };

  const auth = await captureAuthFromContext(context);

  assert.equal(auth.headers['x-ima-cookie'].includes('IMA-UID=user-session'), true);
  assert.equal(auth.headers['x-ima-cookie'].includes('IMA-TOKEN=access-session'), true);
  assert.equal(auth.headers['x-ima-cookie'].includes('IMA-REFRESH-TOKEN=refresh-session'), true);
});

test('classifyImaScanState distinguishes a confirmed scan from the initial QR prompt', () => {
  assert.equal(classifyImaScanState('请使用微信扫码登录'), 'waiting');
  assert.equal(classifyImaScanState('扫码成功，请在手机上确认登录'), 'scan_confirmed');
});

test('QR enrollment returns a live task before a slow IMA navigation completes', async () => {
  let releaseBrowser;
  const browserReady = new Promise((resolve) => {
    releaseBrowser = resolve;
  });
  const { fakeBrowser, manager } = makeManager({
    browserLauncher: async () => browserReady,
  });

  const startPromise = manager.start({ name: 'account-slow' });
  const result = await Promise.race([
    startPromise.then(() => 'returned'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 25)),
  ]);
  assert.equal(result, 'returned');

  const started = await startPromise;
  assert.equal(started.state, 'launching_browser');
  releaseBrowser(fakeBrowser.context);
  await manager.cancel(started.taskId);
});

test('QR enrollment honors an explicit background mode and keeps the visible window as fallback', async () => {
  let launchOptions;
  const { manager, fakeBrowser, state } = makeManager({
    browserLauncher: async (_profile, options, hooks) => {
      launchOptions = options;
      hooks.onWindowOpened({ visible: false });
      return fakeBrowser.context;
    },
  });
  const started = await manager.start({ name: 'account-background' });
  await waitFor(() => manager.get(started.taskId).state === 'waiting_for_scan');
  assert.equal(launchOptions.headless, true);
  assert.equal(manager.get(started.taskId).diagnostics.browserWindowAvailable, false);
  state.wake?.();
  await manager.cancel(started.taskId);
});

test('browser launch timeout exposes a safe diagnostic instead of leaving the enrollment spinner active', async () => {
  const { manager, accountDirectory } = makeManager({
    config: {
      webAgent: {
        sharedKnowledgeBaseId: 'web-kb-id',
        browserPath: process.execPath,
        enrollmentTimeoutMs: 30000,
        enrollmentScreenshotIntervalMs: 1000,
        enrollmentBrowserLaunchTimeoutMs: 250,
      },
    },
    browserLauncher: async () => new Promise(() => {}),
  });

  const started = await manager.start({ name: 'account-launch-timeout' });
  await waitFor(() => manager.get(started.taskId).state === 'failed');
  const failed = manager.get(started.taskId);
  assert.equal(failed.diagnostics.lastFailure.code, 'browser_launch_timeout');
  assert.equal(failed.diagnostics.lastFailure.stage, 'launching_browser');
  assert.match(failed.error, /受控浏览器启动超时/);
  assert.equal(failed.error.includes('Cookie'), false);
  assert.equal(accountDirectory.listAccounts().length, 0);
});

test('browser connection timeout preserves an already visible controlled window as a login fallback', async () => {
  let focusCalls = 0;
  let closeCalls = 0;
  const { manager } = makeManager({
    config: {
      webAgent: {
        sharedKnowledgeBaseId: 'web-kb-id',
        browserPath: process.execPath,
        enrollmentTimeoutMs: 30000,
        enrollmentScreenshotIntervalMs: 1000,
        enrollmentBrowserLaunchTimeoutMs: 250,
      },
    },
    browserLauncher: async (_profile, _options, hooks) => {
      hooks.onWindowOpened({
        async focus() {
          focusCalls += 1;
        },
        async close() {
          closeCalls += 1;
        },
      });
      return new Promise(() => {});
    },
  });

  const started = await manager.start({ name: 'account-window-fallback' });
  await waitFor(() => manager.get(started.taskId).state === 'browser_fallback');
  const fallback = manager.get(started.taskId);
  assert.equal(fallback.diagnostics.lastFailure.code, 'browser_connection_timeout');
  assert.equal(fallback.diagnostics.browserFallbackAvailable, true);

  await manager.focusWindow(started.taskId);
  assert.equal(focusCalls, 1);
  await manager.cancel(started.taskId);
  assert.equal(closeCalls, 1);
});

test('a recovered QR clears a recoverable browser diagnostic and returns to scan state', async () => {
  const { manager, state } = makeManager();
  let qrReady = false;
  const page = {
    async goto() {
      throw new Error('page.goto: Timeout 15000ms exceeded');
    },
    async evaluate() {
      return qrReady ? { x: 10, y: 20, width: 240, height: 240 } : null;
    },
    async screenshot() {
      return Buffer.from('recovered-qr-image');
    },
  };
  const context = {
    closed: false,
    pages() {
      return [page];
    },
    async close() {
      this.closed = true;
    },
  };
  manager.browserLauncher = async () => context;

  const started = await manager.start({ name: 'account-qr-recovery' });
  await waitFor(() => manager.get(started.taskId).state === 'browser_fallback');
  assert.equal(manager.get(started.taskId).diagnostics.lastFailure.code, 'ima_navigation_timeout');

  qrReady = true;
  state.wake?.();
  await waitFor(() => manager.get(started.taskId).state === 'waiting_for_scan');
  const recovered = manager.get(started.taskId);
  assert.equal(recovered.qrAvailable, true);
  assert.equal(recovered.diagnostics.lastFailure, null);
  assert.equal(recovered.diagnostics.browserFallbackAvailable, false);
  await manager.cancel(started.taskId);
});

test('DevTools discovery uses Chrome auto-assigned port without exposing its browser path', () => {
  const tempDir = makeTempDirectory();
  fs.writeFileSync(
    path.join(tempDir, 'DevToolsActivePort'),
    '49152\n/devtools/browser/ef4ff10e-0000-4000-8000-123456789abc\n',
  );
  assert.equal(readDevToolsDebuggerUrl(tempDir), 'http://127.0.0.1:49152');
  fs.writeFileSync(path.join(tempDir, 'DevToolsActivePort'), '49152\nnot-a-browser-path\n');
  assert.equal(readDevToolsDebuggerUrl(tempDir), '');
});

test('QR-only enrollment prefers a visible QR option and never treats quick login as a safe action', () => {
  assert.equal(classifyImaLoginMode('微信扫码登录 快捷登录'), 'qr');
  assert.equal(classifyImaLoginMode('请在微信中确认快捷登录'), 'quick');
  assert.equal(isQrLoginActionText('扫码登录'), true);
  assert.equal(isQrLoginActionText('使用二维码登录'), true);
  assert.equal(isQrLoginActionText('快捷登录'), false);
});

test('cancelling a task remains responsive when Playwright does not close a temporary browser promptly', async () => {
  const { manager } = makeManager({ browserCloseTimeoutMs: 250 });
  const page = {
    async goto() {},
    async evaluate() {
      return { x: 10, y: 20, width: 240, height: 240 };
    },
    async screenshot() {
      return Buffer.from('synthetic-qr-image');
    },
  };
  const context = {
    pages() {
      return [page];
    },
    async close() {
      return new Promise(() => {});
    },
  };
  manager.browserLauncher = async () => context;

  const started = await manager.start({ name: 'account-close-timeout' });
  await waitFor(() => manager.get(started.taskId).state === 'waiting_for_scan');
  const startedAt = Date.now();
  const cancelled = await manager.cancel(started.taskId);
  assert.equal(cancelled.state, 'cancelled');
  assert.ok(Date.now() - startedAt < 1000);
});

test('navigation fallback never saves an unconfirmed login state', async () => {
  const { manager, state, accountDirectory } = makeManager();
  let focusCalls = 0;
  const page = {
    async goto() {
      throw new Error('page.goto: Timeout 15000ms exceeded');
    },
    async bringToFront() {
      focusCalls += 1;
    },
  };
  const context = {
    closed: false,
    pages() {
      return [page];
    },
    async close() {
      this.closed = true;
    },
  };
  manager.browserLauncher = async () => context;

  const started = await manager.start({ name: 'account-fallback' });
  await waitFor(() => manager.get(started.taskId).state === 'browser_fallback');
  const fallback = manager.get(started.taskId);
  assert.equal(fallback.diagnostics.lastFailure.code, 'ima_navigation_timeout');
  assert.equal(fallback.diagnostics.browserFallbackAvailable, true);
  assert.equal(fallback.diagnostics.lastFailure.fallbackAvailable, true);
  assert.equal(fallback.error, null);

  await manager.focusWindow(started.taskId);
  assert.ok(focusCalls >= 2);

  await waitFor(() => Boolean(state.wake));
  state.auth = {
    headers: {
      'x-ima-cookie': 'IMA-UID=user-fallback; IMA-TOKEN=access-fallback; IMA-REFRESH-TOKEN=refresh-fallback',
      'x-ima-bkn': '123',
    },
  };
  state.wake();
  await waitFor(() => manager.get(started.taskId).state === 'failed');
  const failed = manager.get(started.taskId);
  assert.equal(failed.diagnostics.lastFailure.code, 'quick_login_blocked');
  assert.match(failed.error, /不会保存该账号/);
  assert.equal(accountDirectory.listAccounts().length, 0);
  assert.equal(context.closed, true);
});

test('a login state is rejected when a confirmed QR screen changes to quick login', async () => {
  const { manager, state, accountDirectory } = makeManager();
  const page = {
    mode: 'qr',
    async goto() {},
    frames() {
      return [this];
    },
    async evaluate() {
      if (this.mode === 'qr') {
        return '微信扫码登录 ima 快捷登录';
      }
      return '请在微信中确认快捷登录';
    },
    async screenshot() {
      return Buffer.from('synthetic-qr-image');
    },
  };
  const context = {
    closed: false,
    pages() {
      return [page];
    },
    async close() {
      this.closed = true;
    },
  };
  manager.browserLauncher = async () => context;

  const started = await manager.start({ name: 'account-quick-login' });
  await waitFor(() => manager.get(started.taskId).state === 'waiting_for_scan');
  assert.equal(manager.get(started.taskId).diagnostics.qrModeConfirmed, true);
  page.mode = 'quick';
  await waitFor(() => Boolean(state.wake));
  state.auth = {
    headers: {
      'x-ima-cookie': 'IMA-UID=user-quick; IMA-TOKEN=access-quick; IMA-REFRESH-TOKEN=refresh-quick',
      'x-ima-bkn': '789',
    },
  };
  state.wake();

  await waitFor(() => manager.get(started.taskId).state === 'failed');
  const failed = manager.get(started.taskId);
  assert.equal(failed.diagnostics.lastFailure.code, 'quick_login_blocked');
  assert.equal(JSON.stringify(failed).includes('access-quick'), false);
  assert.equal(accountDirectory.listAccounts().length, 0);
  assert.equal(context.closed, true);
});

test('QR enrollment cancel and validation failure never add an account', async () => {
  const cancelled = makeManager();
  const started = await cancelled.manager.start({ name: 'account-d' });
  const result = await cancelled.manager.cancel(started.taskId);
  assert.equal(result.state, 'cancelled');
  assert.equal(cancelled.accountDirectory.listAccounts().length, 0);
  assert.equal(cancelled.fakeBrowser.context.closed, true);

  const failed = makeManager({ initError: new Error('knowledge session check rejected') });
  const failedStart = await failed.manager.start({ name: 'account-e' });
  await waitFor(() => Boolean(failed.state.wake));
  failed.state.auth = {
    headers: {
      'x-ima-cookie': 'IMA-UID=user-e; IMA-TOKEN=access-e; IMA-REFRESH-TOKEN=refresh-e',
      'x-ima-bkn': '456',
    },
  };
  failed.state.wake();
  await waitFor(() => failed.manager.get(failedStart.taskId).state === 'failed');
  assert.equal(failed.accountDirectory.listAccounts().length, 0);
  assert.equal(JSON.stringify(failed.manager.get(failedStart.taskId)).includes('access-e'), false);
  assert.equal(failed.manager.get(failedStart.taskId).diagnostics.lastFailure.code, 'knowledge_base_verification_failed');
});

test('QR enrollment refuses a previously enrolled IMA identity instead of creating a third slot', async () => {
  const setup = makeManager();
  setup.accountDirectory.upsertCapturedAccount({
    id: 'account-primary',
    name: 'account-primary',
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=same-ima-user; IMA-TOKEN=old-token; IMA-REFRESH-TOKEN=old-refresh',
      'x-ima-bkn': '123',
    },
  });
  const started = await setup.manager.start({ name: 'account-new-name' });
  await waitFor(() => Boolean(setup.state.wake));
  setup.state.auth = {
    headers: {
      'x-ima-cookie': 'IMA-UID=same-ima-user; IMA-TOKEN=new-token; IMA-REFRESH-TOKEN=new-refresh',
      'x-ima-bkn': '456',
    },
  };
  setup.state.wake();
  await waitFor(() => setup.manager.get(started.taskId).state === 'failed');
  const failed = setup.manager.get(started.taskId);
  assert.equal(failed.diagnostics.lastFailure.code, 'duplicate_ima_identity');
  assert.match(failed.error, /已作为“account-primary”/);
  assert.equal(setup.accountDirectory.listAccounts().length, 1);
});

test('QR enrollment rejects duplicate account names before opening a browser', async () => {
  const { accountDirectory, manager } = makeManager();
  accountDirectory.upsertCapturedAccount({
    id: 'account-f',
    name: 'account-f',
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=user-f; IMA-TOKEN=access-f; IMA-REFRESH-TOKEN=refresh-f',
      'x-ima-bkn': '789',
    },
  });
  await assert.rejects(() => manager.start({ name: 'ACCOUNT-F' }), {
    message: /已存在/,
    statusCode: 409,
  });
});

test('QR enrollment exposes only the active job and crops a detected QR screenshot', async () => {
  const { manager } = makeManager();
  const started = await manager.start({ name: 'account-g' });
  assert.equal(manager.getActive().taskId, started.taskId);
  await manager.cancel(started.taskId);
  assert.equal(manager.getActive(), null);

  let screenshotOptions;
  const screenshot = await captureLoginScreenshot({
    async evaluate() {
      return { x: 10, y: 20, width: 250, height: 250 };
    },
    async screenshot(options) {
      screenshotOptions = options;
      return Buffer.from('cropped-qr');
    },
  });
  assert.equal(screenshot.toString(), 'cropped-qr');
  assert.deepEqual(screenshotOptions, {
    type: 'png',
    clip: { x: 10, y: 20, width: 250, height: 250 },
  });

  const missing = await captureLoginScreenshot({
    async evaluate() {
      return null;
    },
    async screenshot() {
      throw new Error('whole-page screenshots must not be used');
    },
  });
  assert.equal(missing, null);
});

test('QR screenshot captures the visible nested login iframe when the QR is not in the top document', async () => {
  let evaluations = 0;
  let screenshotOptions;
  const screenshot = await captureLoginScreenshot({
    async evaluate() {
      evaluations += 1;
      return evaluations === 1 ? null : { x: 120, y: 180, width: 280, height: 260 };
    },
    async screenshot(options) {
      screenshotOptions = options;
      return Buffer.from('nested-login-qr');
    },
  });

  assert.equal(screenshot.toString(), 'nested-login-qr');
  assert.deepEqual(screenshotOptions, {
    type: 'png',
    clip: { x: 120, y: 180, width: 280, height: 260 },
  });
});

test('QR screenshot capture downloads the original WeChat QR image instead of cropping a nested iframe', async () => {
  let requestedUrl = '';
  const screenshot = await captureLoginScreenshot({
    frames() {
      return [{
        url() {
          return 'https://open.weixin.qq.com/connect/qrconnect?appid=example';
        },
        async evaluate() {
          return 'https://open.weixin.qq.com/connect/qrcode/qr-token';
        },
      }];
    },
    async screenshot(options) {
      throw new Error(`nested iframe should not be cropped: ${JSON.stringify(options)}`);
    },
  }, {
    fetch: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        headers: { get: () => 'image/jpeg' },
        async arrayBuffer() {
          return Uint8Array.from([0xff, 0xd8, 0xff, 0x00]).buffer;
        },
      };
    },
  });

  assert.equal(requestedUrl, 'https://open.weixin.qq.com/connect/qrcode/qr-token');
  assert.deepEqual(screenshot, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
});

test('enrollment errors translate upstream browser details into actionable Chinese status', () => {
  const message = publicEnrollmentError("locator.click: Timeout 15000ms exceeded. waiting for getByText('登录')");
  assert.match(message, /IMA 登录页/);
  assert.equal(message.includes('locator.click'), false);
});
