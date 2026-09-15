const assert = require('node:assert/strict');
const test = require('node:test');
const {
  IMAWebAgentPool,
  NoAvailableWebAgentAccountError,
  isAuthError,
  isCooldownError,
} = require('../src/ima-web-agent-pool');

function makeAccount(name) {
  return {
    name,
    knowledgeBaseId: 'web-kb-id',
    headers: { 'x-ima-cookie': `${name}-cookie`, 'x-ima-bkn': '123' },
    modelId: 'official_3',
    modelType: 3,
  };
}

async function collectText(stream) {
  let text = '';
  for await (const event of stream) {
    if (event.type === 'delta') {
      text += event.text;
    }
  }
  return text;
}

test('IMAWebAgentPool leases least-recently-used accounts, waits for any busy account, and keeps one active ask per account', async () => {
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const activeByAccount = new Map();
  const maxActiveByAccount = new Map();
  const usedAccounts = [];
  const pool = new IMAWebAgentPool(
    {
      accounts: [makeAccount('account-a'), makeAccount('account-b')],
      accountCooldownMs: 120000,
      accountMaxConsecutiveErrors: 2,
    },
    {
      clientFactory(account) {
        return {
          async *streamAsk() {
            usedAccounts.push(account.name);
            const nextActive = (activeByAccount.get(account.name) || 0) + 1;
            activeByAccount.set(account.name, nextActive);
            maxActiveByAccount.set(
              account.name,
              Math.max(maxActiveByAccount.get(account.name) || 0, nextActive),
            );
            await blocker;
            yield { type: 'delta', text: account.name };
            yield { type: 'done' };
            activeByAccount.set(account.name, activeByAccount.get(account.name) - 1);
          },
        };
      },
    },
  );

  const first = collectText(pool.streamAsk({ question: '问题1' }));
  const second = collectText(pool.streamAsk({ question: '问题2' }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const third = collectText(pool.streamAsk({ question: '问题3' }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(pool.stats().busyAccounts, 2);

  release();
  const answers = await Promise.all([first, second, third]);
  assert.deepEqual(answers.slice(0, 2).sort(), ['account-a', 'account-b']);
  assert.match(answers[2], /^account-[ab]$/);
  assert.deepEqual(usedAccounts.slice(0, 2).sort(), ['account-a', 'account-b']);
  assert.equal(usedAccounts.length, 3);
  assert.equal(maxActiveByAccount.get('account-a'), 1);
  assert.equal(maxActiveByAccount.get('account-b'), 1);
});

test('IMAWebAgentPool cools down a rate-limited account without disabling the pool', async () => {
  let now = 1000;
  const calls = [];
  const pool = new IMAWebAgentPool(
    {
      accounts: [makeAccount('account-a'), makeAccount('account-b')],
      accountCooldownMs: 5000,
      accountMaxConsecutiveErrors: 2,
    },
    {
      now: () => now,
      clientFactory(account) {
        return {
          async *streamAsk() {
            calls.push(account.name);
            if (account.name === 'account-a' && calls.length === 1) {
              throw new Error('提问太快啦，晚点再来问问ima吧');
            }
            yield { type: 'delta', text: account.name };
            yield { type: 'done' };
          },
        };
      },
    },
  );

  await assert.rejects(
    () => collectText(pool.streamAsk({ question: '问题1' })),
    /提问太快/,
  );
  assert.equal(pool.stats().coolingDownAccounts, 1);

  assert.equal(await collectText(pool.streamAsk({ question: '问题2' })), 'account-b');
  now += 5001;
  assert.equal(await collectText(pool.streamAsk({ question: '问题3' })), 'account-a');
});

test('IMAWebAgentPool marks auth-failed accounts unavailable', async () => {
  const pool = new IMAWebAgentPool(
    {
      accounts: [makeAccount('account-a'), makeAccount('account-b')],
      accountCooldownMs: 5000,
      accountMaxConsecutiveErrors: 2,
    },
    {
      clientFactory(account) {
        return {
          async *streamAsk() {
            if (account.name === 'account-a') {
              throw new Error('登录失败，请重新登录');
            }
            yield { type: 'delta', text: account.name };
            yield { type: 'done' };
          },
        };
      },
    },
  );

  await assert.rejects(() => collectText(pool.streamAsk({ question: '问题1' })), /登录失败/);
  assert.equal(pool.stats().unavailableAccounts, 1);
  assert.equal(await collectText(pool.streamAsk({ question: '问题2' })), 'account-b');
});

test('IMAWebAgentPool does not penalize accounts for client-aborted requests', async () => {
  const controller = new AbortController();
  const pool = new IMAWebAgentPool(
    {
      accounts: [makeAccount('account-a')],
      accountCooldownMs: 5000,
      accountMaxConsecutiveErrors: 1,
    },
    {
      clientFactory() {
        return {
          async *streamAsk({ signal }) {
            signal.addEventListener('abort', () => {}, { once: true });
            throw new Error('aborted');
          },
        };
      },
    },
  );

  controller.abort();
  await assert.rejects(
    () => collectText(pool.streamAsk({ question: '问题', signal: controller.signal })),
    /aborted/,
  );
  const stats = pool.stats();
  assert.equal(stats.availableAccounts, 1);
  assert.equal(stats.coolingDownAccounts, 0);
  assert.equal(stats.unavailableAccounts, 0);
});

test('IMAWebAgentPool exposes detailed health only when requested', () => {
  const pool = new IMAWebAgentPool(
    {
      accounts: [makeAccount('account-a')],
      accountCooldownMs: 5000,
      accountMaxConsecutiveErrors: 2,
    },
    {
      clientFactory() {
        return {
          getAuthStatus() {
            return { tokenSecondsRemaining: 3000 };
          },
          async *streamAsk() {
            yield { type: 'done' };
          },
        };
      },
    },
  );

  assert.equal(Object.prototype.hasOwnProperty.call(pool.stats(), 'accounts'), false);
  const detailed = pool.stats({ includeDetails: true });
  assert.equal(detailed.accounts[0].auth.tokenSecondsRemaining, 3000);
});

test('IMAWebAgentPool can sync accounts after empty control-plane startup', async () => {
  const stateChanges = [];
  const pool = new IMAWebAgentPool(
    {
      accounts: [],
      accountCooldownMs: 5000,
      accountMaxConsecutiveErrors: 2,
    },
    {
      onAccountStateChange(snapshot) {
        stateChanges.push(snapshot);
      },
      clientFactory(account) {
        return {
          applyConfig(config) {
            this.latestConfig = config;
          },
          async *streamAsk() {
            yield { type: 'delta', text: account.name };
            yield { type: 'done' };
          },
        };
      },
    },
  );

  await assert.rejects(
    () => pool.streamAsk({ question: '问题' }).next(),
    NoAvailableWebAgentAccountError,
  );

  pool.syncAccounts([makeAccount('account-a')]);
  assert.equal(await collectText(pool.streamAsk({ question: '问题' })), 'account-a');

  pool.setAccountDisabled('account-a', true, 'maintenance');
  await assert.rejects(
    () => pool.streamAsk({ question: '问题' }).next(),
    NoAvailableWebAgentAccountError,
  );
  assert.ok(stateChanges.some((snapshot) => snapshot.id === 'account-a'));
});

test('IMAWebAgentPool starts periodic refresh for accounts enrolled after startup', () => {
  let refreshStarts = 0;
  const pool = new IMAWebAgentPool(
    { accounts: [] },
    {
      clientFactory() {
        return {
          startAutoRefresh() {
            refreshStarts += 1;
          },
          async *streamAsk() {
            yield { type: 'done' };
          },
        };
      },
    },
  );

  pool.startAutoRefresh();
  pool.syncAccounts([makeAccount('account-a')]);

  assert.equal(refreshStarts, 1);
});

test('IMAWebAgentPool refreshAccount notifies credential persistence callback', async () => {
  const credentialChanges = [];
  const checkCalls = [];
  const pool = new IMAWebAgentPool(
    {
      accounts: [makeAccount('account-a')],
      accountCooldownMs: 5000,
      accountMaxConsecutiveErrors: 2,
    },
    {
      onAccountCredentialsChange(accountId, snapshot) {
        credentialChanges.push({ accountId, snapshot });
      },
      clientFactory(account) {
        return {
          async refreshAuth() {},
          createFirstPartyClientContext() {
            return { type: 'synthetic-first-party-context' };
          },
          async initSession(options) {
            checkCalls.push(options);
            assert.equal(options.clientContext.type, 'synthetic-first-party-context');
            assert.equal(options.signal instanceof AbortSignal, true);
            return 'synthetic-session';
          },
          persistRuntimeEnv() {
            return true;
          },
          getConfigSnapshot() {
            return {
              id: account.name,
              name: account.name,
              knowledgeBaseId: account.knowledgeBaseId,
              headers: account.headers,
              modelId: account.modelId,
              modelType: account.modelType,
            };
          },
          async *streamAsk() {
            yield { type: 'done' };
          },
        };
      },
    },
  );

  const accountState = await pool.refreshAccount('account-a');

  assert.equal(accountState.status, 'available');
  assert.equal(credentialChanges.length, 1);
  assert.equal(credentialChanges[0].accountId, 'account-a');
  assert.equal(credentialChanges[0].snapshot.knowledgeBaseId, 'web-kb-id');
  assert.equal(checkCalls.length, 1);
});

test('IMAWebAgentPool health check forwards a service-owned first-party context without asking a question', async () => {
  const calls = [];
  const pool = new IMAWebAgentPool(
    { accounts: [makeAccount('account-a')], healthCheckTimeoutMs: 100 },
    {
      clientFactory() {
        return {
          createFirstPartyClientContext() {
            return { type: 'synthetic-first-party-context', source: 'service' };
          },
          async initSession(options) {
            calls.push(options);
            return 'session-for-health-only';
          },
          async *streamAsk() {
            throw new Error('health check must not call streamAsk');
          },
        };
      },
    },
  );

  const result = await pool.checkAccount('account-a');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].clientContext, { type: 'synthetic-first-party-context', source: 'service' });
  assert.equal(calls[0].allowAuthRefresh, false);
  assert.equal(calls[0].question, undefined);
  assert.equal(result.healthCheck.sessionValid, true);
  assert.equal(result.healthCheck.knowledgeReady, true);
  assert.equal(result.healthCheck.webReady, true);
});

test('IMAWebAgentPool fails closed when a health-check client has no first-party context', async () => {
  const pool = new IMAWebAgentPool(
    { accounts: [makeAccount('account-a')] },
    {
      clientFactory() {
        return {
          async initSession() {
            throw new Error('should not run without a client context');
          },
        };
      },
    },
  );

  await assert.rejects(
    () => pool.checkAccount('account-a'),
    (error) => error.code === 'web_context_missing' && /会话上下文/.test(error.message),
  );
});

test('IMAWebAgentPool classifies expired refresh credentials and transient health failures', async () => {
  const refreshPool = new IMAWebAgentPool(
    { accounts: [makeAccount('account-a')] },
    {
      clientFactory() {
        return {
          async refreshAuth() {
            throw new Error('IMA Web login expired and refresh credentials are unavailable');
          },
        };
      },
    },
  );
  await assert.rejects(
    () => refreshPool.refreshAccount('account-a'),
    (error) => error.code === 'auth_expired',
  );

  const checkPool = new IMAWebAgentPool(
    { accounts: [makeAccount('account-b')] },
    {
      clientFactory() {
        return {
          createFirstPartyClientContext() {
            return { type: 'synthetic-first-party-context' };
          },
          async initSession() {
            throw new Error('fetch failed');
          },
        };
      },
    },
  );
  await assert.rejects(
    () => checkPool.checkAccount('account-b'),
    (error) => error.code === 'upstream_temporary',
  );
});

test('IMAWebAgentPool bounds a stuck health check and prevents a duplicate maintenance operation', async () => {
  let firstSignal;
  const pool = new IMAWebAgentPool(
    { accounts: [makeAccount('account-a')], healthCheckTimeoutMs: 15 },
    {
      clientFactory() {
        return {
          createFirstPartyClientContext() {
            return { type: 'synthetic-first-party-context' };
          },
          async initSession({ signal }) {
            firstSignal = signal;
            return new Promise(() => {});
          },
        };
      },
    },
  );

  const first = pool.checkAccount('account-a');
  await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(
    () => pool.checkAccount('account-a'),
    (error) => error.code === 'account_operation_in_progress',
  );
  await assert.rejects(
    () => first,
    (error) => error.code === 'upstream_temporary',
  );
  assert.equal(firstSignal.aborted, true);
});

test('IMAWebAgentPool proxies refresh, persistence, and auto-refresh to accounts', async () => {
  let ensureCalls = 0;
  let persistCalls = 0;
  let startCalls = 0;
  let stopCalls = 0;
  const pool = new IMAWebAgentPool(
    {
      accounts: [makeAccount('account-a'), makeAccount('account-b')],
      accountCooldownMs: 5000,
      accountMaxConsecutiveErrors: 2,
    },
    {
      clientFactory() {
        return {
          async ensureFreshAuth() {
            ensureCalls += 1;
            return ensureCalls === 1;
          },
          persistRuntimeEnv() {
            persistCalls += 1;
            return true;
          },
          startAutoRefresh() {
            startCalls += 1;
          },
          stopAutoRefresh() {
            stopCalls += 1;
          },
          async *streamAsk() {
            yield { type: 'done' };
          },
        };
      },
    },
  );

  assert.equal(await pool.ensureFreshAuth(), true);
  assert.equal(pool.persistRuntimeEnv(), true);
  pool.startAutoRefresh();
  pool.stopAutoRefresh();
  assert.equal(ensureCalls, 2);
  assert.equal(persistCalls, 4);
  assert.equal(startCalls, 2);
  assert.equal(stopCalls, 2);
});

test('IMAWebAgentPool error classifiers catch rate-limit and auth failures', () => {
  assert.equal(isCooldownError(new Error('HTTP 429')), true);
  assert.equal(isCooldownError(new Error('提问太快啦')), true);
  assert.equal(isAuthError(new Error('登录过期')), true);
  assert.equal(isAuthError(new Error('HTTP 403 forbidden')), true);
});

test('IMAWebAgentPool keeps a conversation on its requested account and session', async () => {
  const calls = [];
  const pool = new IMAWebAgentPool(
    {
      accounts: [makeAccount('account-a'), makeAccount('account-b')],
    },
    {
      clientFactory(account) {
        return {
          async *streamAsk({ question, sessionId, onSession }) {
            calls.push({ account: account.name, question, sessionId });
            onSession?.(sessionId || `${account.name}-new-session`);
            yield { type: 'delta', text: account.name };
            yield { type: 'done' };
          },
        };
      },
    },
  );

  const events = [];
  for await (const event of pool.streamAsk({
    question: '追问',
    accountId: 'account-b',
    sessionId: 'account-b-session-1',
  })) {
    events.push(event);
  }

  assert.deepEqual(calls, [{ account: 'account-b', question: '追问', sessionId: 'account-b-session-1' }]);
  assert.deepEqual(events, [
    { type: 'route', accountId: 'account-b' },
    { type: 'session', sessionId: 'account-b-session-1' },
    { type: 'delta', text: 'account-b' },
    { type: 'done' },
  ]);
});

test('IMAWebAgentPool fails a sticky conversation fast while its account is cooling down', async () => {
  const pool = new IMAWebAgentPool(
    {
      accounts: [makeAccount('account-a')],
      accountCooldownMs: 60_000,
      accountMaxConsecutiveErrors: 2,
    },
    {
      clientFactory() {
        return {
          async *streamAsk() {
            throw new Error('提问太快啦');
          },
        };
      },
    },
  );

  await assert.rejects(() => collectText(pool.streamAsk({ question: '第一问' })), /提问太快/);
  await assert.rejects(
    () => pool.streamAsk({ question: '追问', accountId: 'account-a', sessionId: 'session-a' }).next(),
    /正在冷却/,
  );
});
