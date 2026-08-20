const assert = require('node:assert/strict');
const test = require('node:test');

const { createAskQueue } = require('../src/ask-queue');
const {
  AccountPoolExerciseManager,
  AccountPoolExerciseReportStore,
  loadDefaultQuestionBank,
} = require('../src/account-pool-exercise');

test('default exercise templates load the tracked 3DGS evaluation set', () => {
  const bank = loadDefaultQuestionBank();

  assert.ok(bank.length >= 50);
  assert.ok(bank.some((item) => item.category === 'capture_devices'));
  assert.ok(bank.some((item) => item.category === 'advanced_troubleshooting'));
  assert.ok(bank.every((item) => item.question));
});

test('baseline exercise keeps each simulated customer isolated and stores a sanitized report', async () => {
  let nextAccount = 0;
  let nextSession = 0;
  const accounts = [
    { id: 'account-a', name: '账号 A', status: 'available' },
    { id: 'account-b', name: '账号 B', status: 'available' },
  ];
  const manager = new AccountPoolExerciseManager({
    askQueue: createAskQueue({ maxConcurrent: 2, queueLimit: 10 }),
    accountDirectory: { listAccounts: () => accounts },
    pool: {
      stats: () => ({ totalAccounts: 2, availableAccounts: 2, unavailableAccounts: 0 }),
      async *streamAsk(options) {
        const accountId = options.accountId || accounts[nextAccount++ % accounts.length].id;
        const sessionId = options.sessionId || `ima-session-${++nextSession}`;
        yield { type: 'route', accountId };
        yield { type: 'session', sessionId };
        yield { type: 'sources', sources: [{ title: '3DGS 群聊资料', snippet: '可追溯的公开摘录' }], searchSummary: '找到 1 篇资料' };
        yield { type: 'delta', text: `${options.question} 的回答` };
      },
    },
    reportStore: new AccountPoolExerciseReportStore({ persist: false }),
  });

  const run = await manager.start({
    profile: 'baseline',
    confirm: true,
    clients: [
      { label: '模拟用户 1', question: '3DGS 航拍重叠率如何设置？', followUp: '请补充一个采集注意事项。' },
      { label: '模拟用户 2', question: '显存不足时怎样排查？', followUp: '请补充一个软件设置建议。' },
    ],
  });
  await manager.waitFor(run.runId);

  const report = manager.getReport(run.runId);
  assert.equal(report.status, 'completed');
  assert.equal(report.summary.initial.ok, 2);
  assert.equal(report.summary.followUp.ok, 2);
  assert.equal(report.summary.isolation.sessionIsolationPassed, true);
  assert.equal(report.summary.isolation.followUpContinuityPassed, true);
  assert.equal(report.summary.scenario.passed, true);
  assert.deepEqual(report.summary.accountCoverage.usedAccountNames.sort(), ['账号 A', '账号 B']);
  assert.equal(report.clients[0].initial.answer.includes('航拍重叠率'), true);
  assert.equal(report.clients[0].followUp.answer.includes('采集注意事项'), true);
  assert.equal(JSON.stringify(report).includes('account-a'), false);
  assert.equal(JSON.stringify(report).includes('ima-session-'), false);

  const reviewed = manager.score(run.runId, 0, {
    relevance: 2,
    completeness: 1,
    sourceTrust: 2,
    followUpContinuity: 2,
    note: '首问和追问均可复核。',
  });
  assert.equal(reviewed.reviewSummary.reviewedClients, 1);
  assert.equal(reviewed.reviewSummary.pendingClients, 1);
  assert.equal(reviewed.reviewSummary.totalScore, 7);
});

test('exercise templates allow up to 30 custom simulated customers', () => {
  const manager = new AccountPoolExerciseManager({
    askQueue: createAskQueue({ maxConcurrent: 1, queueLimit: 30 }),
    accountDirectory: { listAccounts: () => [{ id: 'account-a', name: '账号 A', status: 'available' }] },
    pool: { stats: () => ({}) },
    questionBank: [{ category: 'capture_devices', question: '无人机航拍重叠率如何设置？' }],
    reportStore: new AccountPoolExerciseReportStore({ persist: false }),
  });

  const templates = manager.getTemplates(30);
  assert.equal(templates.length, 30);
  assert.equal(templates[29].label, '模拟用户 30');
});

test('exercise templates do not silently reuse a question when the bank is exhausted', () => {
  const manager = new AccountPoolExerciseManager({
    askQueue: createAskQueue({ maxConcurrent: 1, queueLimit: 4 }),
    accountDirectory: { listAccounts: () => [{ id: 'account-a', name: '账号 A', status: 'available' }] },
    pool: { stats: () => ({}) },
    questionBank: [
      { category: 'basic_principles', question: '题目一' },
      { category: 'capture_devices', question: '题目二' },
    ],
    reportStore: new AccountPoolExerciseReportStore({ persist: false }),
  });

  const bootstrap = manager.getBootstrap();
  const templates = manager.getTemplates(3);

  assert.equal(bootstrap.questionBankCount, 2);
  assert.equal(bootstrap.maxClients, 30);
  assert.deepEqual(templates.map((item) => item.question), ['题目一', '题目二', '']);
  assert.deepEqual(templates.map((item) => item.requiresManualQuestion), [false, false, true]);
});

test('exercise report detects a follow-up session switch without exposing either session id', async () => {
  let initialSession = 0;
  const manager = new AccountPoolExerciseManager({
    askQueue: createAskQueue({ maxConcurrent: 1, queueLimit: 2 }),
    accountDirectory: { listAccounts: () => [{ id: 'account-a', name: '账号 A', status: 'available' }] },
    pool: {
      stats: () => ({ totalAccounts: 1, availableAccounts: 1 }),
      async *streamAsk(options) {
        const sessionId = options.sessionId || `initial-session-${++initialSession}`;
        yield { type: 'route', accountId: 'account-a' };
        yield { type: 'session', sessionId: options.sessionId ? 'unexpected-session-switch' : sessionId };
        yield { type: 'delta', text: '| 项目 | 值 |\n| --- | --- |\n| 重叠率 | 80% |' };
      },
    },
    reportStore: new AccountPoolExerciseReportStore({ persist: false }),
  });

  const run = await manager.start({
    profile: 'baseline',
    confirm: true,
    clients: [{ label: '模拟用户 1', question: '航拍重叠率？', followUp: '继续说明。' }],
  });
  await manager.waitFor(run.runId);
  const report = manager.getReport(run.runId);

  assert.equal(report.clients[0].checks.initialSessionCreated, true);
  assert.equal(report.clients[0].checks.followUpSameSession, false);
  assert.equal(report.summary.isolation.followUpContinuityPassed, false);
  assert.match(report.clients[0].initial.answer, /\n/);
  assert.equal(JSON.stringify(report).includes('initial-session-'), false);
  assert.equal(JSON.stringify(report).includes('unexpected-session-switch'), false);
});

test('exercise detects an account switch even when two accounts share the same display name', async () => {
  const accounts = [
    { id: 'account-a', name: '共享显示名', status: 'available' },
    { id: 'account-b', name: '共享显示名', status: 'available' },
  ];
  let initialIndex = 0;
  const manager = new AccountPoolExerciseManager({
    askQueue: createAskQueue({ maxConcurrent: 2, queueLimit: 4 }),
    accountDirectory: { listAccounts: () => accounts },
    pool: {
      stats: () => ({ totalAccounts: 2, availableAccounts: 2 }),
      async *streamAsk(options) {
        const initial = !options.accountId;
        const accountId = initial
          ? accounts[initialIndex++].id
          : options.accountId === 'account-a' ? 'account-b' : 'account-a';
        yield { type: 'route', accountId };
        yield { type: 'session', sessionId: options.sessionId || `private-session-${initialIndex}` };
        yield { type: 'delta', text: '回答' };
      },
    },
    reportStore: new AccountPoolExerciseReportStore({ persist: false }),
  });

  const run = await manager.start({
    profile: 'baseline',
    confirm: true,
    clients: [
      { label: '模拟用户 1', question: '问题一', followUp: '追问一' },
      { label: '模拟用户 2', question: '问题二', followUp: '追问二' },
    ],
  });
  await manager.waitFor(run.runId);
  const report = manager.getReport(run.runId);

  assert.equal(report.summary.accountCoverage.passed, true);
  assert.equal(report.summary.accountCoverage.usedAccountCount, 2);
  assert.equal(report.clients[0].checks.followUpSameAccount, false);
  assert.equal(report.clients[1].checks.followUpSameAccount, false);
  assert.equal(report.summary.isolation.followUpContinuityPassed, false);
  assert.equal(report.summary.scenario.passed, false);
  assert.equal(JSON.stringify(report).includes('account-a'), false);
  assert.equal(JSON.stringify(report).includes('account-b'), false);
});

test('exercise cancellation aborts remaining work and writes a partial report', async () => {
  const manager = new AccountPoolExerciseManager({
    askQueue: createAskQueue({ maxConcurrent: 1, queueLimit: 4 }),
    accountDirectory: {
      listAccounts: () => [
        { id: 'account-a', name: '账号 A', status: 'available' },
        { id: 'account-b', name: '账号 B', status: 'available' },
      ],
    },
    pool: {
      stats: () => ({ totalAccounts: 2, availableAccounts: 2 }),
      async *streamAsk(options) {
        yield { type: 'route', accountId: 'account-a' };
        yield { type: 'session', sessionId: 'private-session' };
        if (options.signal.aborted) {
          throw Object.assign(new Error('请求已取消'), { name: 'AbortError' });
        }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('请求已取消'), { name: 'AbortError' }));
          }, { once: true });
        });
      },
    },
    reportStore: new AccountPoolExerciseReportStore({ persist: false }),
  });

  const run = await manager.start({
    profile: 'baseline',
    confirm: true,
    clients: [
      { label: '模拟用户 1', question: '问题一', followUp: '追问一' },
      { label: '模拟用户 2', question: '问题二', followUp: '追问二' },
    ],
  });
  manager.cancel(run.runId);
  await manager.waitFor(run.runId);

  const report = manager.getReport(run.runId);
  assert.equal(report.status, 'cancelled');
  assert.ok(report.clients.some((client) => client.initial.failureReason === 'cancelled'));
  assert.equal(manager.isMaintenanceActive(), false);
});

test('exercise marks a running IMA request as timed out without retrying it', async () => {
  let calls = 0;
  const manager = new AccountPoolExerciseManager({
    askQueue: createAskQueue({ maxConcurrent: 1, queueLimit: 1 }),
    accountDirectory: { listAccounts: () => [{ id: 'account-a', name: '账号 A', status: 'available' }] },
    pool: {
      stats: () => ({ totalAccounts: 1, availableAccounts: 1 }),
      async *streamAsk(options) {
        calls += 1;
        yield { type: 'route', accountId: 'account-a' };
        yield { type: 'session', sessionId: 'private-session' };
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('请求超时'), { name: 'TimeoutError' }));
          }, { once: true });
        });
      },
    },
    requestTimeoutMs: 15,
    reportStore: new AccountPoolExerciseReportStore({ persist: false }),
  });

  const run = await manager.start({
    profile: 'baseline',
    confirm: true,
    clients: [{ label: '模拟用户 1', question: '问题', followUp: '' }],
  });
  await manager.waitFor(run.runId);
  const report = manager.getReport(run.runId);

  assert.equal(calls, 1);
  assert.equal(report.clients[0].initial.failureReason, 'timeout');
  assert.equal(report.clients[0].initial.status, 'failed');
});

test('exercise timeout bounds waiting work in the shared queue', async () => {
  let calls = 0;
  const manager = new AccountPoolExerciseManager({
    askQueue: createAskQueue({ maxConcurrent: 1, queueLimit: 4 }),
    accountDirectory: { listAccounts: () => [{ id: 'account-a', name: '账号 A', status: 'available' }] },
    pool: {
      stats: () => ({ totalAccounts: 1, availableAccounts: 1 }),
      async *streamAsk(options) {
        calls += 1;
        yield { type: 'route', accountId: 'account-a' };
        yield { type: 'session', sessionId: `private-session-${calls}` };
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 1000);
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('请求超时'), { name: 'TimeoutError' }));
          }, { once: true });
        });
      },
    },
    requestTimeoutMs: 15,
    reportStore: new AccountPoolExerciseReportStore({ persist: false }),
  });

  const run = await manager.start({
    profile: 'custom',
    confirm: true,
    clients: [
      { label: '模拟用户 1', question: '问题一', followUp: '' },
      { label: '模拟用户 2', question: '问题二', followUp: '' },
    ],
  });
  await manager.waitFor(run.runId);
  const report = manager.getReport(run.runId);

  assert.ok(calls >= 1 && calls <= 2);
  assert.equal(report.clients[0].initial.failureReason, 'timeout');
  assert.equal(report.clients[1].initial.failureReason, 'timeout');
  assert.equal(report.summary.peakQueuedRequests, 1);
});

test('report store removes expired reports and keeps its persisted file private', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-exercise-report-'));
  const storePath = path.join(directory, 'reports.json');
  let current = 1_000;
  const store = new AccountPoolExerciseReportStore({
    storePath,
    ttlMs: 20,
    now: () => current,
  });

  store.save({
    id: 'a8e292b8-058a-44e2-86c7-bcf874af2b56',
    status: 'completed',
    profile: 'custom',
    startedAt: current,
    finishedAt: current,
    expiresAt: current + 10,
    clients: [],
    summary: {},
  });
  assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
  current += 11;
  assert.deepEqual(store.list(), []);
  fs.rmSync(directory, { recursive: true, force: true });
});
