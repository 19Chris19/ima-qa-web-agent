const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
const {
  WebAgentEnrollmentManager,
  captureLoginScreenshot,
  classifyImaLoginMode,
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

test('QR enrollment uses a background browser by default and keeps the visible window as fallback', async () => {
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
