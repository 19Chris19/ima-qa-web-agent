const assert = require('node:assert/strict');
const test = require('node:test');

const { knowledgeScopeDigest } = require('../src/air/classic-knowledge-contract-proof');
const { knowledgeAgentContractDigest } = require('../src/ima-knowledge-agent-contract');
const {
  KnowledgeAgentQualificationManager,
  KnowledgeAgentQualificationReportStore,
  REQUESTS_PER_TARGET,
  runAccountQualification,
} = require('../src/air/knowledge-agent-qualification-job');

const KNOWLEDGE_BASE_ID = 'synthetic-3dgs-knowledge';

test('qualification bootstrap derives candidates and quota from a dynamic account pool', () => {
  for (const count of [0, 1, 3, 7]) {
    const fixture = createFixture({ accountCount: count, qualifiedCount: Math.min(1, count) });
    const bootstrap = fixture.manager.getBootstrap();
    const expectedTargets = Math.max(0, count - 1);
    assert.equal(bootstrap.totalAccounts, count);
    assert.equal(bootstrap.targetAccountCount, expectedTargets);
    assert.equal(bootstrap.authorizedRequestCount, expectedTargets * REQUESTS_PER_TARGET);
    assert.match(bootstrap.candidateSetDigest, /^[a-f0-9]{64}$/);
  }
});

test('an empty pool keeps the admin bootstrap usable but cannot start qualification', async () => {
  const fixture = createFixture({ accountCount: 0, qualifiedCount: 0 });
  const bootstrap = fixture.manager.getBootstrap();
  assert.equal(bootstrap.totalAccounts, 0);
  assert.equal(bootstrap.targetAccountCount, 0);
  assert.equal(bootstrap.authorizedRequestCount, 0);
  await assert.rejects(fixture.manager.start({
    confirm: true,
    candidateSetDigest: bootstrap.candidateSetDigest,
    authorizedRequestCount: 0,
  }), { code: 'qualification_no_candidates' });
});

test('qualification requires the exact current candidate digest and real request quota', async () => {
  const fixture = createFixture({ accountCount: 4, qualifiedCount: 2 });
  const bootstrap = fixture.manager.getBootstrap();
  await assert.rejects(
    fixture.manager.start({
      confirm: true,
      candidateSetDigest: bootstrap.candidateSetDigest,
      authorizedRequestCount: bootstrap.authorizedRequestCount - 1,
    }),
    { code: 'qualification_authorization_invalid' },
  );
  await assert.rejects(
    fixture.manager.start({
      confirm: true,
      candidateSetDigest: '0'.repeat(64),
      authorizedRequestCount: bootstrap.authorizedRequestCount,
    }),
    { code: 'qualification_authorization_invalid' },
  );
  assert.equal(fixture.directory.applied.length, 0);
});

test('a passing batch atomically qualifies every target and updates knowledge-agent capacity', async () => {
  const fixture = createFixture({ accountCount: 4, qualifiedCount: 2 });
  const bootstrap = fixture.manager.getBootstrap();
  const run = await fixture.manager.start({
    confirm: true,
    candidateSetDigest: bootstrap.candidateSetDigest,
    authorizedRequestCount: bootstrap.authorizedRequestCount,
  });
  const report = await fixture.manager.waitFor(run.runId);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.authorizedRequests, 14);
  assert.equal(report.usedRequests, 14);
  assert.equal(report.passedTargets, 2);
  assert.equal(fixture.directory.applied.length, 2);
  assert.equal(fixture.pool.policyCapacitySnapshot().knowledge_agent, 4);
  assert.equal(fixture.syncCount(), 1);
});

test('one failed target leaves the whole account directory unchanged', async () => {
  let target = 0;
  const fixture = createFixture({
    accountCount: 4,
    qualifiedCount: 2,
    runner: async ({ onObservation }) => {
      target += 1;
      const passed = target === 1;
      const calls = passed ? 7 : 2;
      for (let index = 0; index < calls; index += 1) {
        onObservation({ phase: index === 0 ? 'smoke' : 'matrix', passed: passed || index === 0 });
      }
      return {
        passed,
        requests: calls,
        terminals: calls,
        passedModes: passed ? 6 : 0,
        unknownSources: 0,
        knowledgeSources: calls,
        webSources: 0,
        totalMs: calls * 10,
        failureCategory: passed ? '' : 'source_contract_unsatisfied',
      };
    },
  });
  const bootstrap = fixture.manager.getBootstrap();
  const run = await fixture.manager.start({
    confirm: true,
    candidateSetDigest: bootstrap.candidateSetDigest,
    authorizedRequestCount: bootstrap.authorizedRequestCount,
  });
  const report = await fixture.manager.waitFor(run.runId);
  assert.equal(report.status, 'failed');
  assert.equal(report.failureCategory, 'source_contract_unsatisfied');
  assert.equal(fixture.directory.applied.length, 0);
  assert.equal(fixture.pool.policyCapacitySnapshot().knowledge_agent, 2);
});

test('qualification reports retain only anonymous counters and fixed categories', async () => {
  const fixture = createFixture({ accountCount: 2, qualifiedCount: 1 });
  const bootstrap = fixture.manager.getBootstrap();
  const run = await fixture.manager.start({
    confirm: true,
    candidateSetDigest: bootstrap.candidateSetDigest,
    authorizedRequestCount: bootstrap.authorizedRequestCount,
  });
  const report = await fixture.manager.waitFor(run.runId);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /question|answer|knowledgeBaseId|account-2|token|cookie/i);
  assert.equal(report.results[0].slot, 1);
  assert.equal(report.results[0].requests, 7);
});

test('resident qualification runner executes one smoke plus six modes and reuses only the final pair session', async () => {
  const seenSessions = [];
  let call = 0;
  const sourceKinds = [
    ['knowledge'],
    ['knowledge'],
    ['web'],
    ['knowledge', 'web'],
    ['knowledge'],
    ['web'],
    ['knowledge'],
  ];
  const result = await runAccountQualification({
    account: { id: 'synthetic', knowledgeBaseId: KNOWLEDGE_BASE_ID },
    questions: syntheticQuestions(),
    requestTimeoutMs: 1000,
    requestSpacingMs: 0,
    clientFactory: () => ({
      async *streamAsk(options) {
        seenSessions.push(options.sessionId || '');
        const session = `session-${call + 1}`;
        options.onSession?.(session);
        yield { type: 'sources', sourceKinds: sourceKinds[call] };
        yield { type: 'delta', text: 'synthetic answer' };
        yield { type: 'done' };
        call += 1;
      },
    }),
  });
  assert.equal(result.passed, true);
  assert.equal(result.requests, 7);
  assert.deepEqual(seenSessions.slice(0, 6), ['', '', '', '', '', '']);
  assert.equal(seenSessions[6], 'session-6');
});

function createFixture({ accountCount, qualifiedCount, runner = passingRunner } = {}) {
  const now = Date.now();
  const accounts = Array.from({ length: accountCount }, (_value, index) => ({
    id: `account-${index + 1}`,
    name: `Synthetic Account ${index + 1}`,
    knowledgeBaseId: KNOWLEDGE_BASE_ID,
    principalFingerprint: String(index + 1).padStart(64, '0'),
    disabled: false,
    knowledgeAgentQualification: index < qualifiedCount
      ? validProof(index, now) : null,
  }));
  const directory = {
    applied: [],
    getPoolAccounts() {
      return accounts.map((account) => ({ ...account }));
    },
    listAccounts() {
      return accounts.map((account) => ({ id: account.id, health: { status: 'ready' } }));
    },
    recordKnowledgeAgentQualifications(entries) {
      this.applied.push(...entries.map((entry) => entry.accountId));
      for (const entry of entries) {
        accounts.find((account) => account.id === entry.accountId).knowledgeAgentQualification = {
          ...entry.proof,
        };
      }
      return { qualified: entries.length };
    },
  };
  const pool = {
    accounts,
    syncAccounts(next) {
      this.accounts = next;
    },
    policyCapacitySnapshot() {
      return {
        knowledge_agent: this.accounts.filter((account) => account.knowledgeAgentQualification).length,
      };
    },
    stats() {
      return { availableAccounts: qualifiedCount, totalAccounts: accountCount };
    },
  };
  let syncCalls = 0;
  const manager = new KnowledgeAgentQualificationManager({
    accountDirectory: directory,
    pool,
    askQueue: { stats: () => ({ activeRequests: 0, queuedRequests: 0 }) },
    runner,
    questionBank: syntheticQuestions(),
    reportStore: new KnowledgeAgentQualificationReportStore({ persist: false }),
    onAccountsSynced() { syncCalls += 1; },
    now: () => now,
  });
  return { directory, pool, manager, syncCount: () => syncCalls };
}

async function passingRunner({ onObservation }) {
  for (let index = 0; index < 7; index += 1) {
    onObservation({ phase: index === 0 ? 'smoke' : 'matrix', passed: true });
  }
  return {
    passed: true,
    requests: 7,
    terminals: 7,
    passedModes: 6,
    unknownSources: 0,
    knowledgeSources: 8,
    webSources: 4,
    totalMs: 70,
    failureCategory: '',
  };
}

function validProof(index, now) {
  return {
    capabilityDigest: knowledgeAgentContractDigest(),
    requests: 6,
    terminalCount: 6,
    passedModes: 6,
    unknownSourceCount: 0,
    verifiedAt: new Date(now - index * 1000).toISOString(),
    knowledgeScopeRef: knowledgeScopeDigest(KNOWLEDGE_BASE_ID),
    principalFingerprint: String(index + 1).padStart(64, '0'),
  };
}

function syntheticQuestions() {
  return {
    knowledge: 'synthetic knowledge question',
    web: 'synthetic web question',
    mixed: 'synthetic mixed question',
    noWeb: 'synthetic no web question',
    sessionWeb: 'synthetic session web question',
    sessionNormal: 'synthetic session normal question',
  };
}

test('qualification cancellation preserves no proof and releases maintenance without another request', async () => {
  const fixture = createFixture({ accountCount: 1, qualifiedCount: 0,
    runner: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
  const bootstrap = fixture.manager.getBootstrap();
  const run = await fixture.manager.start({ confirm: true, candidateSetDigest: bootstrap.candidateSetDigest,
    authorizedRequestCount: bootstrap.authorizedRequestCount });
  assert.equal(fixture.manager.isMaintenanceActive(), true);
  fixture.manager.cancel(run.runId);
  assert.equal((await fixture.manager.waitFor(run.runId)).status, 'cancelled');
  assert.equal(fixture.manager.isMaintenanceActive(), false);
  assert.equal(fixture.directory.applied.length, 0);
});

test('qualification rejects non-drained queue before invoking any runner', async () => {
  let calls = 0;
  const fixture = createFixture({ accountCount: 1, qualifiedCount: 0, runner: () => { calls++; } });
  fixture.manager.askQueue = { stats: () => ({ activeRequests: 1, queuedRequests: 0 }) };
  const bootstrap = fixture.manager.getBootstrap();
  await assert.rejects(fixture.manager.start({ confirm: true, candidateSetDigest: bootstrap.candidateSetDigest,
    authorizedRequestCount: bootstrap.authorizedRequestCount }), { code: 'provider_requests_not_drained' });
  assert.equal(calls, 0);
});
