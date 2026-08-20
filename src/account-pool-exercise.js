const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_REPORT_LIMIT = 30;
const MAX_CLIENTS = 30;
const MAX_SOURCES = 10;

class AccountPoolExerciseError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'AccountPoolExerciseError';
    this.statusCode = statusCode;
  }
}

class AccountPoolExerciseReportStore {
  constructor(options = {}) {
    this.storePath = path.resolve(
      options.storePath || path.resolve(__dirname, '..', '..', '..', 'runtime', 'ima-qa-account-pool-exercises.json'),
    );
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_REPORT_TTL_MS);
    this.maxCount = positiveInteger(options.maxCount, DEFAULT_REPORT_LIMIT);
    this.persist = options.persist !== false;
    this.now = options.now || Date.now;
    this.reports = null;
  }

  list() {
    this._load();
    this._removeExpired();
    return this.reports
      .slice()
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(publicReportSummary);
  }

  get(reportId) {
    this._load();
    this._removeExpired();
    const report = this.reports.find((candidate) => candidate.id === String(reportId || ''));
    return report ? clone(report) : null;
  }

  save(report) {
    this._load();
    this._removeExpired();
    const sanitized = sanitizeReport(report, this.now());
    const index = this.reports.findIndex((candidate) => candidate.id === sanitized.id);
    if (index >= 0) {
      this.reports[index] = sanitized;
    } else {
      this.reports.push(sanitized);
    }
    this._trim();
    this._write();
    return clone(sanitized);
  }

  delete(reportId) {
    this._load();
    const index = this.reports.findIndex((candidate) => candidate.id === String(reportId || ''));
    if (index < 0) {
      return false;
    }
    this.reports.splice(index, 1);
    this._write();
    return true;
  }

  _load() {
    if (this.reports) {
      return;
    }
    if (!this.persist || !fs.existsSync(this.storePath)) {
      this.reports = [];
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      this.reports = Array.isArray(parsed?.reports)
        ? parsed.reports.map((report) => sanitizeReport(report, this.now())).filter(Boolean)
        : [];
    } catch {
      this.reports = [];
    }
  }

  _removeExpired() {
    const now = this.now();
    const before = this.reports.length;
    this.reports = this.reports.filter((report) => report.expiresAt > now);
    if (before !== this.reports.length) {
      this._write();
    }
  }

  _trim() {
    this.reports.sort((left, right) => right.startedAt - left.startedAt);
    this.reports = this.reports.slice(0, this.maxCount);
  }

  _write() {
    if (!this.persist) {
      return;
    }
    const directory = path.dirname(this.storePath);
    const tempPath = path.join(directory, `.${path.basename(this.storePath)}.${process.pid}.${Date.now()}.tmp`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempPath, `${JSON.stringify({ version: 1, reports: this.reports }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, this.storePath);
    try {
      fs.chmodSync(this.storePath, 0o600);
    } catch {
      // The write mode is the primary permission boundary on normal filesystems.
    }
  }
}

class AccountPoolExerciseManager {
  constructor(options = {}) {
    this.askQueue = options.askQueue;
    this.accountDirectory = options.accountDirectory;
    this.pool = options.pool;
    this.reportStore = options.reportStore || new AccountPoolExerciseReportStore(options.reportStoreOptions);
    this.questionBank = Array.isArray(options.questionBank) ? options.questionBank : loadDefaultQuestionBank();
    this.requestTimeoutMs = positiveInteger(options.requestTimeoutMs, 180000);
    this.now = options.now || Date.now;
    this.active = null;
    this.completions = new Map();
  }

  getBootstrap() {
    const availableAccounts = this._availableAccounts();
    const questionBankCount = this._questionBank().length;
    return {
      availableAccountCount: availableAccounts.length,
      maxClients: MAX_CLIENTS,
      questionBankCount,
      profiles: {
        baseline: availableAccounts.length,
        queue: Math.min(MAX_CLIENTS, availableAccounts.length * 2),
      },
      reportRetentionDays: Math.round(this.reportStore.ttlMs / (24 * 60 * 60 * 1000)),
      active: this.getActive(),
    };
  }

  getTemplates(count) {
    const target = boundedInteger(count, 1, MAX_CLIENTS, this._availableAccounts().length || 1);
    const bank = this._questionBank();
    return Array.from({ length: target }, (_value, index) => {
      const item = bank[index];
      return {
        label: `模拟用户 ${index + 1}`,
        question: cleanText(item?.question, 2000),
        followUp: '请继续上一问，只补充一个最关键的实操注意事项，并保持和前文一致。',
        category: cleanText(item?.category, 80),
        requiresManualQuestion: !item,
      };
    });
  }

  _questionBank() {
    return this.questionBank.length ? this.questionBank : defaultQuestionBank();
  }

  getActive() {
    if (!this.active) {
      return null;
    }
    return publicActiveRun(this.active, this._queueSnapshot(), this._poolSnapshot());
  }

  isMaintenanceActive() {
    return Boolean(this.active && ['running', 'cancelling'].includes(this.active.status));
  }

  listReports() {
    return this.reportStore.list();
  }

  getReport(reportId) {
    const report = this.reportStore.get(reportId);
    if (!report) {
      throw new AccountPoolExerciseError('演练报告不存在或已过期', 404);
    }
    return report;
  }

  deleteReport(reportId) {
    if (!this.reportStore.delete(reportId)) {
      throw new AccountPoolExerciseError('演练报告不存在或已过期', 404);
    }
  }

  score(reportId, clientIndex, review) {
    const report = this.getReport(reportId);
    const index = Number(clientIndex);
    if (!Number.isInteger(index) || index < 0 || index >= report.clients.length) {
      throw new AccountPoolExerciseError('模拟客户编号无效', 404);
    }
    report.clients[index].review = normalizeReview(review);
    report.reviewSummary = buildReviewSummary(report.clients);
    this.reportStore.save(report);
    return this.getReport(reportId);
  }

  async start(input = {}) {
    if (this.isMaintenanceActive()) {
      throw new AccountPoolExerciseError('已有账号池演练正在运行，请先等待结束或取消', 409);
    }
    const queue = this._queueSnapshot();
    if (queue.activeRequests || queue.queuedRequests) {
      throw new AccountPoolExerciseError('当前仍有普通问答在处理或排队，请等待队列清空后再开始演练', 409);
    }
    if (input.confirm !== true) {
      throw new AccountPoolExerciseError('真实演练会调用 IMA 共享知识库，请确认后再启动', 400);
    }

    const availableAccounts = this._availableAccounts();
    if (!availableAccounts.length) {
      throw new AccountPoolExerciseError('当前没有可用的独立 IMA 账号，无法启动演练', 409);
    }
    const profile = normalizeProfile(input.profile);
    const clients = normalizeClients(input.clients);
    validateClientCount(profile, clients.length, availableAccounts.length);

    const startedAt = this.now();
    const controller = new AbortController();
    const run = {
      id: crypto.randomUUID(),
      status: 'running',
      phase: 'initial',
      profile,
      startedAt,
      finishedAt: 0,
      controller,
      availableAccountNames: availableAccounts.map((account) => account.name),
      accountNamesById: new Map(availableAccounts.map((account) => [account.id, account.name])),
      peakActiveRequests: 0,
      peakQueuedRequests: 0,
      clients: clients.map((client, index) => createRunClient(client, index)),
    };
    this.active = run;
    const completion = this._execute(run);
    this.completions.set(run.id, completion);
    completion
      .finally(() => {
        this.completions.delete(run.id);
      })
      .catch(() => {});
    return this.getActive();
  }

  async waitFor(runId) {
    const completion = this.completions.get(String(runId || ''));
    if (completion) {
      await completion;
    }
    return this.getReport(runId);
  }

  cancel(runId) {
    if (!this.active || this.active.id !== String(runId || '')) {
      throw new AccountPoolExerciseError('没有可取消的进行中演练', 404);
    }
    if (this.active.status === 'running') {
      this.active.status = 'cancelling';
      this.active.controller.abort();
    }
    return this.getActive();
  }

  async _execute(run) {
    try {
      await Promise.all(run.clients.map((client) => this._runTurn(run, client, 'initial')));
      if (!run.controller.signal.aborted) {
        run.phase = 'follow_up';
        await Promise.all(
          run.clients
            .filter((client) => client.initial.ok && client.followUp.question)
            .map((client) => this._runTurn(run, client, 'followUp')),
        );
      }
    } finally {
      run.finishedAt = this.now();
      const report = buildReport(run, this.reportStore.ttlMs);
      try {
        this.reportStore.save(report);
      } finally {
        if (this.active?.id === run.id) {
          this.active = null;
        }
      }
    }
  }

  async _runTurn(run, client, phase) {
    const turn = client[phase];
    if (run.controller.signal.aborted) {
      markCancelled(turn, this.now());
      return;
    }
    turn.submittedAt = this.now();
    const abort = createTurnAbort(run.controller.signal, this.requestTimeoutMs);
    try {
      const execution = this.askQueue.run(
        async () => {
          turn.startedAt = this.now();
          run.peakActiveRequests = Math.max(run.peakActiveRequests, Number(this._queueSnapshot().activeRequests || 0));
          await this._streamTurn(run, client, turn, abort.signal);
        },
        { signal: abort.signal },
      );
      const queue = this._queueSnapshot();
      run.peakActiveRequests = Math.max(run.peakActiveRequests, Number(queue.activeRequests || 0));
      run.peakQueuedRequests = Math.max(run.peakQueuedRequests, Number(queue.queuedRequests || 0));
      await execution;
      turn.ok = true;
      turn.status = 'succeeded';
    } catch (error) {
      turn.ok = false;
      turn.status = run.controller.signal.aborted ? 'cancelled' : 'failed';
      turn.failureReason = classifyFailure(error, run.controller.signal.aborted, abort.timedOut());
      turn.error = safeError(error, [
        ...run.accountNamesById.keys(),
        client.upstream.accountId,
        client.upstream.sessionId,
        turn.sessionId,
      ]);
    } finally {
      abort.cleanup();
      turn.completedAt = this.now();
      turn.queueMs = duration(turn.submittedAt, turn.startedAt || turn.completedAt);
      turn.firstResponseMs = turn.firstResponseAt ? duration(turn.startedAt || turn.submittedAt, turn.firstResponseAt) : null;
      turn.totalMs = duration(turn.submittedAt, turn.completedAt);
    }
  }

  async _streamTurn(run, client, turn, signal) {
    const upstream = client.upstream;
    for await (const event of this.pool.streamAsk({
      question: turn.question,
      accountId: upstream.accountId,
      sessionId: upstream.sessionId,
      signal,
      onSession(sessionId) {
        upstream.sessionId = String(sessionId || '');
      },
    })) {
      if (event.type === 'route') {
        upstream.accountId = String(event.accountId || '');
        // Keep the internal value only for integrity checks; public reports expose the display name instead.
        turn.accountId = upstream.accountId;
        turn.accountName = run.accountNamesById.get(upstream.accountId) || '已分配账号';
        continue;
      }
      if (event.type === 'session') {
        upstream.sessionId = String(event.sessionId || upstream.sessionId || '');
        turn.sessionObserved = Boolean(upstream.sessionId);
        turn.sessionId = upstream.sessionId;
        continue;
      }
      if (event.type === 'sources') {
        turn.sources = normalizeSources([...(turn.sources || []), ...(event.sources || [])]);
        turn.searchSummary = cleanText(event.searchSummary, 240) || turn.searchSummary;
        continue;
      }
      if (event.type === 'delta') {
        turn.firstResponseAt ||= this.now();
        turn.answer = cleanAnswer(`${turn.answer}${event.text || ''}`, 8000);
      }
    }
  }

  _availableAccounts() {
    const accounts = Array.isArray(this.accountDirectory?.listAccounts?.())
      ? this.accountDirectory.listAccounts()
      : [];
    return accounts
      .filter((account) => account?.status === 'available')
      .filter((account) => !account?.identityDuplicate)
      .map((account) => ({ id: String(account.id || ''), name: cleanText(account.name || account.id, 80) || '已配置账号' }))
      .filter((account) => account.id);
  }

  _queueSnapshot() {
    return this.askQueue?.stats?.() || { activeRequests: 0, queuedRequests: 0, maxConcurrent: 1, queueLimit: 0 };
  }

  _poolSnapshot() {
    const stats = this.pool?.stats?.() || {};
    return {
      totalAccounts: Number(stats.totalAccounts || 0),
      availableAccounts: Number(stats.availableAccounts || 0),
      busyAccounts: Number(stats.busyAccounts || 0),
      coolingDownAccounts: Number(stats.coolingDownAccounts || 0),
      unavailableAccounts: Number(stats.unavailableAccounts || 0),
    };
  }
}

function createRunClient(client, index) {
  return {
    index,
    label: client.label,
    upstream: { accountId: '', sessionId: '' },
    initial: createTurn(client.question),
    followUp: createTurn(client.followUp),
  };
}

function createTurn(question) {
  return {
    question,
    answer: '',
    sources: [],
    searchSummary: '',
    status: question ? 'pending' : 'skipped',
    ok: false,
    accountId: '',
    accountName: '',
    sessionObserved: false,
    sessionId: '',
    submittedAt: 0,
    startedAt: 0,
    firstResponseAt: 0,
    completedAt: 0,
    queueMs: null,
    firstResponseMs: null,
    totalMs: null,
    failureReason: '',
    error: '',
  };
}

function buildReport(run, ttlMs) {
  const now = run.finishedAt || Date.now();
  const clients = run.clients.map((client) => ({
    index: client.index,
    label: client.label,
    initial: publicTurn(client.initial),
    followUp: publicTurn(client.followUp),
    review: emptyReview(),
    checks: {
      initialSessionCreated: Boolean(client.initial.sessionObserved),
      followUpSameAccount: client.followUp.question
        ? Boolean(
          client.initial.accountId
          && client.followUp.accountId
          && client.initial.accountId === client.followUp.accountId,
        )
        : null,
      followUpSameSession: client.followUp.question
        ? Boolean(
          client.initial.sessionObserved
          && client.followUp.sessionObserved
          && client.initial.sessionId
          && client.initial.sessionId === client.followUp.sessionId,
        )
        : null,
    },
  }));
  // Use only the private run state for integrity conclusions. The public clients above
  // intentionally omit account IDs and IMA session IDs.
  const initial = run.clients.map((client) => client.initial);
  const followUp = run.clients.filter((client) => client.followUp.question).map((client) => client.followUp);
  const successfulInitial = initial.filter((turn) => turn.ok);
  const initialSessions = run.clients
    .filter((client) => client.initial.ok && client.initial.sessionId)
    .map((client) => client.initial.sessionId);
  const followUpClients = run.clients.filter((client) => client.followUp.question && client.initial.ok);
  const accountIds = unique(successfulInitial.map((turn) => turn.accountId).filter(Boolean));
  const accountNames = unique(successfulInitial.map((turn) => turn.accountName).filter(Boolean));
  const initialOk = successfulInitial.length;
  const initialFailed = initial.length - initialOk;
  const followUpOk = followUp.filter((turn) => turn.ok).length;
  const sessionIsolationPassed = initialOk > 0
    && initialSessions.length === initialOk
    && new Set(initialSessions).size === initialSessions.length;
  const followUpContinuityPassed = followUpClients.every((client) =>
    client.followUp.ok
    && client.initial.accountId
    && client.initial.accountId === client.followUp.accountId
    && client.initial.sessionId
    && client.initial.sessionId === client.followUp.sessionId,
  );
  const expectedAccountIds = unique(run.accountNamesById.keys());
  const coveragePassed = expectedAccountIds.every((accountId) => accountIds.includes(accountId));
  const queueObserved = run.peakQueuedRequests > 0 || initial.some((turn) => Number(turn.queueMs || 0) > 0);
  const initialSucceeded = initialOk === initial.length;
  const followUpSucceeded = followUpOk === followUp.length;
  const baselinePassed = coveragePassed
    && initialSucceeded
    && followUpSucceeded
    && sessionIsolationPassed
    && followUpContinuityPassed
    && run.peakActiveRequests >= expectedAccountIds.length;
  const queuePassed = queueObserved
    && initialSucceeded
    && followUpSucceeded
    && sessionIsolationPassed
    && followUpContinuityPassed;
  return {
    version: 1,
    id: run.id,
    status: run.controller.signal.aborted ? 'cancelled' : 'completed',
    profile: run.profile,
    startedAt: run.startedAt,
    finishedAt: now,
    expiresAt: now + ttlMs,
    clients,
    summary: {
      requestedClients: clients.length,
      initial: { total: initial.length, ok: initialOk, failed: initialFailed },
      followUp: { total: followUp.length, ok: followUpOk, failed: followUp.length - followUpOk },
      peakActiveRequests: run.peakActiveRequests,
      peakQueuedRequests: run.peakQueuedRequests,
      queueObserved,
      accountCoverage: {
        expectedAccountCount: expectedAccountIds.length,
        usedAccountCount: accountIds.length,
        usedAccountNames: accountNames,
        passed: coveragePassed,
      },
      isolation: {
        sessionIsolationPassed,
        followUpContinuityPassed,
      },
      scenario: {
        type: run.profile,
        passed: run.profile === 'baseline' ? baselinePassed : run.profile === 'queue' ? queuePassed : null,
        targetConcurrent: run.profile === 'baseline' ? expectedAccountIds.length : null,
        expectedQueue: run.profile === 'queue',
      },
    },
    reviewSummary: buildReviewSummary(clients),
  };
}

function publicActiveRun(run, queue, pool) {
  const turns = run.clients.flatMap((client) => [client.initial, client.followUp]);
  return {
    runId: run.id,
    status: run.status,
    profile: run.profile,
    phase: run.phase,
    startedAt: run.startedAt,
    requestedClients: run.clients.length,
    progress: {
      submitted: turns.filter((turn) => turn.submittedAt).length,
      queued: turns.filter((turn) => turn.submittedAt && !turn.startedAt && !turn.completedAt).length,
      processing: turns.filter((turn) => turn.startedAt && !turn.completedAt).length,
      completed: turns.filter((turn) => turn.status === 'succeeded').length,
      failed: turns.filter((turn) => ['failed', 'cancelled'].includes(turn.status)).length,
    },
    queue,
    pool,
  };
}

function publicReportSummary(report) {
  return {
    id: report.id,
    status: report.status,
    profile: report.profile,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    expiresAt: report.expiresAt,
    requestedClients: report.summary?.requestedClients || 0,
    initial: report.summary?.initial || { total: 0, ok: 0, failed: 0 },
    followUp: report.summary?.followUp || { total: 0, ok: 0, failed: 0 },
    reviewSummary: report.reviewSummary || buildReviewSummary([]),
  };
}

function publicTurn(turn) {
  return {
    question: cleanText(turn.question, 2000),
    answer: cleanAnswer(turn.answer, 8000),
    sources: normalizeSources(turn.sources),
    searchSummary: cleanText(turn.searchSummary, 240),
    status: cleanText(turn.status, 32),
    ok: Boolean(turn.ok),
    accountName: cleanText(turn.accountName, 80),
    sessionObserved: Boolean(turn.sessionObserved),
    submittedAt: numberOrZero(turn.submittedAt),
    startedAt: numberOrZero(turn.startedAt),
    firstResponseAt: numberOrZero(turn.firstResponseAt),
    completedAt: numberOrZero(turn.completedAt),
    queueMs: nullableInteger(turn.queueMs),
    firstResponseMs: nullableInteger(turn.firstResponseMs),
    totalMs: nullableInteger(turn.totalMs),
    failureReason: cleanText(turn.failureReason, 80),
    error: cleanText(turn.error, 240),
  };
}

function sanitizeReport(value, now) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const startedAt = numberOrZero(value.startedAt) || now;
  const finishedAt = numberOrZero(value.finishedAt) || startedAt;
  const clients = Array.isArray(value.clients)
    ? value.clients.slice(0, MAX_CLIENTS).map((client, index) => ({
      index,
      label: cleanText(client?.label, 80) || `模拟用户 ${index + 1}`,
      initial: publicTurn(client?.initial || {}),
      followUp: publicTurn(client?.followUp || {}),
      review: normalizeReview(client?.review),
      checks: {
        initialSessionCreated: Boolean(client?.checks?.initialSessionCreated),
        followUpSameAccount: client?.checks?.followUpSameAccount == null ? null : Boolean(client.checks.followUpSameAccount),
        followUpSameSession: client?.checks?.followUpSameSession == null ? null : Boolean(client.checks.followUpSameSession),
      },
    }))
    : [];
  const summary = value.summary && typeof value.summary === 'object' ? value.summary : {};
  return {
    version: 1,
    id: normalizeReportId(value.id),
    status: ['completed', 'cancelled'].includes(value.status) ? value.status : 'completed',
    profile: normalizeProfile(value.profile, 'custom'),
    startedAt,
    finishedAt,
    expiresAt: numberOrZero(value.expiresAt) || now + DEFAULT_REPORT_TTL_MS,
    clients,
    summary: {
      requestedClients: boundedInteger(summary.requestedClients, 0, MAX_CLIENTS, clients.length),
      initial: normalizePhaseSummary(summary.initial, clients.map((client) => client.initial)),
      followUp: normalizePhaseSummary(summary.followUp, clients.map((client) => client.followUp).filter((turn) => turn.question)),
      peakActiveRequests: boundedInteger(summary.peakActiveRequests, 0, MAX_CLIENTS, 0),
      peakQueuedRequests: boundedInteger(summary.peakQueuedRequests, 0, MAX_CLIENTS, 0),
      queueObserved: Boolean(summary.queueObserved),
      accountCoverage: {
        expectedAccountCount: boundedInteger(summary.accountCoverage?.expectedAccountCount, 0, MAX_CLIENTS, 0),
        usedAccountCount: boundedInteger(summary.accountCoverage?.usedAccountCount, 0, MAX_CLIENTS, 0),
        usedAccountNames: unique((summary.accountCoverage?.usedAccountNames || []).map((name) => cleanText(name, 80)).filter(Boolean)),
        passed: Boolean(summary.accountCoverage?.passed),
      },
      isolation: {
        sessionIsolationPassed: Boolean(summary.isolation?.sessionIsolationPassed),
        followUpContinuityPassed: Boolean(summary.isolation?.followUpContinuityPassed),
      },
      scenario: {
        type: normalizeProfile(summary.scenario?.type, 'custom'),
        passed: summary.scenario?.passed == null ? null : Boolean(summary.scenario.passed),
        targetConcurrent: summary.scenario?.targetConcurrent == null
          ? null
          : boundedInteger(summary.scenario.targetConcurrent, 0, MAX_CLIENTS, 0),
        expectedQueue: Boolean(summary.scenario?.expectedQueue),
      },
    },
    reviewSummary: buildReviewSummary(clients),
  };
}

function normalizePhaseSummary(value, turns) {
  const total = boundedInteger(value?.total, 0, MAX_CLIENTS, turns.length);
  const ok = boundedInteger(value?.ok, 0, total, turns.filter((turn) => turn.ok).length);
  return { total, ok, failed: Math.max(0, total - ok) };
}

function normalizeClients(value) {
  if (!Array.isArray(value) || !value.length) {
    throw new AccountPoolExerciseError('请至少配置一位模拟客户', 400);
  }
  if (value.length > MAX_CLIENTS) {
    throw new AccountPoolExerciseError(`单次演练最多支持 ${MAX_CLIENTS} 位模拟客户`, 400);
  }
  return value.map((client, index) => {
    const question = cleanText(client?.question, 2000);
    if (!question) {
      throw new AccountPoolExerciseError(`模拟用户 ${index + 1} 的首问不能为空`, 400);
    }
    return {
      label: cleanText(client?.label, 80) || `模拟用户 ${index + 1}`,
      question,
      followUp: cleanText(client?.followUp, 2000),
    };
  });
}

function validateClientCount(profile, count, accountCount) {
  if (profile === 'baseline' && count !== accountCount) {
    throw new AccountPoolExerciseError(`基线并发必须配置 ${accountCount} 位模拟客户`, 400);
  }
  const expectedQueueCount = Math.min(MAX_CLIENTS, accountCount * 2);
  if (profile === 'queue' && count !== expectedQueueCount) {
    throw new AccountPoolExerciseError(`排队压力必须配置 ${expectedQueueCount} 位模拟客户`, 400);
  }
}

function normalizeProfile(value, fallback = 'baseline') {
  return ['baseline', 'queue', 'custom'].includes(value) ? value : fallback;
}

function normalizeSources(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const sources = [];
  for (const source of value) {
    const title = cleanText(source?.title, 160);
    const snippet = cleanText(source?.snippet, 900);
    if (!title && !snippet) {
      continue;
    }
    const key = `${title}\n${snippet}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    sources.push({
      index: boundedInteger(source?.index, 1, 9999, sources.length + 1),
      title: title || '知识库资料',
      snippet,
    });
    if (sources.length >= MAX_SOURCES) {
      break;
    }
  }
  return sources;
}

function emptyReview() {
  return { relevance: null, completeness: null, sourceTrust: null, followUpContinuity: null, note: '' };
}

function normalizeReview(value) {
  const review = value && typeof value === 'object' ? value : {};
  return {
    relevance: scoreValue(review.relevance),
    completeness: scoreValue(review.completeness),
    sourceTrust: scoreValue(review.sourceTrust),
    followUpContinuity: scoreValue(review.followUpContinuity),
    note: cleanText(review.note, 2000),
  };
}

function scoreValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return [0, 1, 2].includes(Number(value)) ? Number(value) : null;
}

function buildReviewSummary(clients) {
  const reviews = clients.map((client) => normalizeReview(client.review));
  const complete = reviews.filter((review) => [review.relevance, review.completeness, review.sourceTrust, review.followUpContinuity].every((value) => value != null));
  const totalScore = reviews.reduce((sum, review) => sum + [review.relevance, review.completeness, review.sourceTrust, review.followUpContinuity].reduce((score, value) => score + (value || 0), 0), 0);
  return {
    reviewedClients: complete.length,
    pendingClients: Math.max(0, clients.length - complete.length),
    totalScore,
    maxScore: clients.length * 8,
  };
}

function classifyFailure(error, cancelled, timedOut = false) {
  if (cancelled) return 'cancelled';
  if (timedOut) return 'timeout';
  if (Number(error?.statusCode) === 401 || Number(error?.statusCode) === 403) return 'auth_failure';
  if (Number(error?.statusCode) === 429) return 'rate_limited';
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'timeout';
  if (/timeout|超时/i.test(String(error?.message || ''))) return 'timeout';
  if (/network|fetch failed|ECONN|ENOTFOUND/i.test(String(error?.message || ''))) return 'network_failure';
  if (/账号.*不可用|账号.*冷却|NoAvailableWebAgentAccount/i.test(String(error?.message || ''))) return 'account_unavailable';
  if (Number(error?.statusCode) >= 500) return 'upstream_failure';
  return 'upstream_failure';
}

function markCancelled(turn, now) {
  turn.status = 'cancelled';
  turn.failureReason = 'cancelled';
  turn.completedAt = now;
}

function safeError(error, privateValues = []) {
  let value = String(error?.message || '演练请求失败')
    .replace(/IMA-[A-Z-]+=[^;\s]+/g, 'IMA-SECRET=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/((?:session|account)[_ -]?id\s*[=:]\s*)[^,;\s]+/gi, '$1[redacted]');
  for (const privateValue of privateValues) {
    const text = String(privateValue || '').trim();
    if (text) {
      value = value.replace(new RegExp(escapeRegExp(text), 'g'), '[redacted]');
    }
  }
  return cleanText(value, 240);
}

function defaultQuestionBank() {
  return [
    { category: 'basic_principles', question: '开始学习 3DGS，需要准备哪些基本硬件设备和软件？' },
    { category: 'capture_devices', question: '使用无人机进行航拍采集时，如何规划飞行路径和重叠率？' },
    { category: 'training_workflow', question: '训练过程中显存不足，可以优先采取哪些优化措施？' },
    { category: 'advanced_troubleshooting', question: '训练时出现 Loss 发散或 NaN，应该如何排查？' },
    { category: 'rendering_application', question: '大范围 3DGS 场景如何做分块训练和流式加载？' },
  ];
}

function loadDefaultQuestionBank(filePath = path.resolve(__dirname, '..', 'eval', 'questions.jsonl')) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    const bank = lines
      .map((line) => JSON.parse(line))
      .map((item) => ({
        category: cleanText(item?.category, 80),
        question: cleanText(item?.question, 2000),
      }))
      .filter((item) => item.question);
    return bank.length ? bank : defaultQuestionBank();
  } catch {
    return defaultQuestionBank();
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function unique(values) {
  return [...new Set(values)];
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanAnswer(value, maxLength) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .trimEnd()
    .slice(0, maxLength);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeReportId(value) {
  const id = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : crypto.randomUUID();
}

function composeAbortSignal(...signals) {
  const controller = new AbortController();
  const listeners = [];
  const abort = (signal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal?.reason);
    }
  };
  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) {
      abort(signal);
      continue;
    }
    const listener = () => abort(signal);
    signal.addEventListener('abort', listener, { once: true });
    listeners.push([signal, listener]);
  }
  const cleanup = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener('abort', listener);
    }
  };
  return { signal: controller.signal, cleanup };
}

function createTurnAbort(runSignal, timeoutMs) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error('演练请求超时')), timeoutMs);
  timer.unref?.();
  const composed = composeAbortSignal(runSignal, timeoutController.signal);
  return {
    signal: composed.signal,
    cleanup() {
      clearTimeout(timer);
      composed.cleanup();
    },
    timedOut() {
      return timeoutController.signal.aborted && !runSignal?.aborted;
    },
  };
}

function numberOrZero(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function nullableInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    return fallback;
  }
  return number;
}

function duration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  return Math.max(0, Number(finishedAt) - Number(startedAt));
}

module.exports = {
  AccountPoolExerciseError,
  AccountPoolExerciseManager,
  AccountPoolExerciseReportStore,
  buildReviewSummary,
  defaultQuestionBank,
  loadDefaultQuestionBank,
  normalizeClients,
  normalizeReview,
  sanitizeReport,
};
