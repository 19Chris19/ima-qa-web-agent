const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const { knowledgeScopeDigest } = require('./classic-knowledge-contract-proof');
const { IMAWebAgentClient } = require('./ima-web-agent-client');
const { knowledgeAgentContractDigest } = require('../ima-knowledge-agent-contract');
const {
  qualificationAccountSetDigest,
  runtimeQualificationState,
  validPrincipalFingerprint,
} = require('./knowledge-agent-qualification');

const SCENARIOS = Object.freeze([
  'knowledge_default',
  'explicit_web',
  'explicit_mixed',
  'explicit_no_web',
  'sequential_web',
  'post_web_ordinary',
]);
const REQUESTS_PER_TARGET = 1 + SCENARIOS.length;
const MAX_ACCOUNTS = 64;
const DEFAULT_REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_REPORT_LIMIT = 30;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_SPACING_MS = 1_000;
const SAFE_WARNINGS = new Set(['pool_sync_failed', 'capacity_sync_failed', 'report_persistence_failed']);
const SAFE_FAILURE_CATEGORIES = new Set([
  'knowledge_agent_qualification_batch_invalid',
  'network_failure',
  'process_interrupted',
  'protocol_failure',
  'qualification_binding_changed',
  'qualification_failed',
  'qualification_cancelled',
  'qualification_start_callback_failed',
  'qualification_report_persistence_failed',
  'provider_maintenance_conflict',
  'provider_requests_not_drained',
  'source_contract_unsatisfied',
  'upstream_auth',
  'upstream_failure',
  'upstream_quota',
  'upstream_timeout',
]);
const KNOWLEDGE_AGENT_SHORT_SUFFIX = [
  '请忠实执行本条用户问题，检索方式只依据本条问题，不继承上一轮：未明确要求联网时优先依据当前知识库；',
  '明确要求联网、只联网或结合知识库时，按原问题执行。请用自然的微信群聊天口吻在260字内直接回答，',
  '保留最关键结论；只输出可直接发送的正文，简单问题用一段，分点最多4行，不用标题、Markdown、表格、代码块或长链接。',
].join('');

class KnowledgeAgentQualificationError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = 'KnowledgeAgentQualificationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

class KnowledgeAgentQualificationReportStore {
  constructor(options = {}) {
    this.storePath = path.resolve(options.storePath || path.resolve(
      __dirname, '..', '..', 'runtime', 'ima-qa-qualification-reports.json',
    ));
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_REPORT_TTL_MS);
    this.maxCount = positiveInteger(options.maxCount, DEFAULT_REPORT_LIMIT);
    this.persist = options.persist !== false;
    this.now = options.now || Date.now;
    this.reports = null;
  }

  list() {
    this._load();
    this._prune();
    return this.reports.map(publicReportSummary);
  }

  get(id) {
    this._load();
    this._prune();
    const report = this.reports.find((item) => item.id === String(id || ''));
    return report ? clone(report) : null;
  }

  save(report) {
    this._load();
    const value = sanitizeReport(report, this.now(), this.ttlMs);
    const index = this.reports.findIndex((item) => item.id === value.id);
    if (index >= 0) this.reports[index] = value;
    else this.reports.unshift(value);
    this._prune();
    this.reports = this.reports.slice(0, this.maxCount);
    this._write();
    return clone(value);
  }

  _load() {
    if (this.reports) return;
    if (!this.persist || !fs.existsSync(this.storePath)) {
      this.reports = [];
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      this.reports = Array.isArray(parsed?.reports)
        ? parsed.reports.map((item) => sanitizeReport(item, this.now(), this.ttlMs))
        : [];
    } catch {
      this.reports = [];
    }
    let changed = false;
    for (const report of this.reports) {
      if (report.status === 'running') {
        report.status = 'interrupted';
        report.failureCategory = 'process_interrupted';
        report.finishedAt = this.now();
        changed = true;
      }
    }
    if (changed) this._write();
  }

  _prune() {
    const now = this.now();
    this.reports = this.reports
      .filter((item) => Number(item.expiresAt || 0) > now)
      .sort((left, right) => Number(right.startedAt) - Number(left.startedAt));
  }

  _write() {
    if (!this.persist) return;
    const directory = path.dirname(this.storePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(
      directory,
      `.${path.basename(this.storePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, reports: this.reports }, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.storePath);
    fs.chmodSync(this.storePath, 0o600);
  }
}

class KnowledgeAgentQualificationManager {
  constructor(options = {}) {
    this.accountDirectory = options.accountDirectory;
    this.pool = options.pool;
    this.askQueue = options.askQueue;
    this.onAccountsSynced = options.onAccountsSynced || (() => {});
    this.conflictManagers = Array.isArray(options.conflictManagers)
      ? options.conflictManagers.filter(Boolean) : [];
    this.reportStore = options.reportStore || new KnowledgeAgentQualificationReportStore(
      options.reportStoreOptions,
    );
    this.runner = options.runner || runAccountQualification;
    this.basicRunner = options.basicRunner || runBasicAccountQualification;
    this.questionBank = options.questionBank || loadQuestionBank();
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.now = options.now || Date.now;
    this.active = null;
    this.preflightAccountId = null;
    this.completions = new Map();
    this.terminalResults = new Map();
  }

  getBootstrap() {
    const snapshot = this._candidateSnapshot();
    const policyCapacity = this.pool?.policyCapacitySnapshot?.() || {};
    const pool = this.pool?.stats?.() || {};
    return {
      targetAccountCount: snapshot.targets.length,
      authorizedRequestCount: snapshot.targets.length * REQUESTS_PER_TARGET,
      requestsPerTarget: REQUESTS_PER_TARGET,
      candidateSetDigest: snapshot.candidateSetDigest,
      knowledgeAgentAvailable: Number(policyCapacity.knowledge_agent || 0),
      generalAutoAvailable: Number(pool.availableAccounts || 0),
      totalAccounts: snapshot.accounts.length,
      active: this.getActive(),
    };
  }

  getActive() {
    if (!this.active) return null;
    return publicActive(this.active);
  }

  getBootstrapForAccount(accountId) {
    if (typeof accountId !== 'string' || !accountId.trim()) {
      throw new KnowledgeAgentQualificationError('qualification_account_invalid', 400);
    }
    const snapshot = this._candidateSnapshot(accountId);
    return {
      targetAccountCount: 1,
      requestsPerTarget: REQUESTS_PER_TARGET,
      authorizedRequestCount: REQUESTS_PER_TARGET,
      candidateSetDigest: snapshot.candidateSetDigest,
      active: this.getActive(),
    };
  }

  async startForAccount(accountId, input = {}) {
    if (typeof accountId !== 'string' || !accountId.trim()) {
      throw new KnowledgeAgentQualificationError('qualification_account_invalid', 400);
    }
    return this._start(input, accountId);
  }

  cancel(id) {
    if (!this.active || this.active.id !== id) {
      throw new KnowledgeAgentQualificationError('qualification_run_not_found', 404);
    }
    if (!this.active.commitApplied) this.active.controller.abort();
    return this.getActive();
  }

  isMaintenanceActive() {
    return Boolean(this.active || this.preflightAccountId);
  }

  listReports() {
    this._pruneTerminalResults();
    const reports = new Map(this.reportStore.list().map((report) => [report.id,
      report.status === 'running' && this.active?.id !== report.id
        ? { ...report, status: 'interrupted', failureCategory: 'process_interrupted' } : report]));
    for (const [id, report] of this.terminalResults) reports.set(id, publicReportSummary(report));
    if (this.active) reports.set(this.active.id, publicReportSummary(this.active));
    return [...reports.values()].sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, DEFAULT_REPORT_LIMIT);
  }

  getReport(id) {
    id = String(id || '');
    this._pruneTerminalResults();
    if (this.terminalResults.has(id)) return clone(this.terminalResults.get(id));
    if (this.active?.id === id) return sanitizeReport(this.active, this.now(), DEFAULT_REPORT_TTL_MS);
    const report = this.reportStore.get(id);
    if (!report) throw new KnowledgeAgentQualificationError('qualification_report_not_found', 404);
    if (report.status === 'running') {
      return { ...report, status: 'interrupted', failureCategory: 'process_interrupted' };
    }
    return report;
  }

  _pruneTerminalResults() {
    for (const [id, report] of this.terminalResults) {
      if (report.expiresAt <= this.now()) this.terminalResults.delete(id);
    }
    while (this.terminalResults.size > DEFAULT_REPORT_LIMIT) {
      this.terminalResults.delete(this.terminalResults.keys().next().value);
    }
  }

  _saveProgress(run) {
    try {
      this.reportStore.save(run);
    } catch {
      throw new KnowledgeAgentQualificationError('qualification_report_persistence_failed', 500);
    }
  }

  _finalizeRun(run) {
    run.finishedAt = this.now();
    run.phase = 'completed';
    run.reportPersisted = this.reportStore.persist === true;
    try {
      this.reportStore.save(run);
    } catch {
      run.reportPersisted = false;
      run.warnings.push('report_persistence_failed');
    }
    this.terminalResults.set(run.id, sanitizeReport(run, this.now(), DEFAULT_REPORT_TTL_MS));
    this._pruneTerminalResults();
    if (this.active?.id === run.id) this.active = null;
  }

  async start(input = {}) {
    return this._start(input);
  }

  _assertIdleDependencies() {
    if (this.conflictManagers.some((manager) => manager?.isMaintenanceActive?.())) {
      throw new KnowledgeAgentQualificationError('provider_maintenance_conflict', 409);
    }
    const queue = this.askQueue?.stats?.() || {};
    if (Number(queue.activeRequests || 0) || Number(queue.queuedRequests || 0)) {
      throw new KnowledgeAgentQualificationError('provider_requests_not_drained', 409);
    }
  }

  async _start(input, accountId) {
    if (this.isMaintenanceActive()) {
      throw new KnowledgeAgentQualificationError('qualification_already_running', 409);
    }
    this._assertIdleDependencies();
    let snapshot = this._candidateSnapshot(accountId);
    if (!snapshot.targets.length) {
      throw new KnowledgeAgentQualificationError('qualification_no_candidates', 409);
    }
    if (input.mode === 'basic' && accountId === undefined) {
      throw new KnowledgeAgentQualificationError('qualification_account_invalid', 400);
    }
    const mode = input.mode === 'basic' ? 'basic' : 'advanced';
    if (mode === 'basic' && snapshot.targets[0].knowledgeAgentQualification?.requests === 6
        && ['qualified', 'expiring'].includes(runtimeQualificationState(
          snapshot.targets[0].knowledgeAgentQualification, snapshot.targets[0],
          snapshot.capabilityDigest, this.now(),
        ))) {
      throw new KnowledgeAgentQualificationError('qualification_no_candidates', 409);
    }
    const expectedRequests = snapshot.targets.length * (mode === 'basic' ? 1 : REQUESTS_PER_TARGET);
    if (input.confirm !== true
        || Number(input.authorizedRequestCount) !== expectedRequests
        || ((accountId === undefined || input.candidateSetDigest !== undefined)
          && String(input.candidateSetDigest || '') !== snapshot.candidateSetDigest)) {
      throw new KnowledgeAgentQualificationError('qualification_authorization_invalid', 409);
    }
    const activateEnrollment = input.activateEnrollment === true;
    if (activateEnrollment && (accountId === undefined || snapshot.targets[0].disabled !== true
        || !(snapshot.targets[0].disabledReason === 'pending_enrollment_qualification'
          || (mode === 'basic'
            && snapshot.targets[0].disabledReason === 'migration_verification_required')))) {
      throw new KnowledgeAgentQualificationError('qualification_activation_invalid', 409);
    }
    if (accountId !== undefined) {
      const stored = this.accountDirectory.getAccount(accountId);
      const accessExpiry = Number(stored?.runtime?.tokenExpiresAt || 0);
      if (stored?.runtime?.disabledReason === 'migration_verification_required'
          && accessExpiry > 0 && accessExpiry <= this.now() + 60_000) {
        this.preflightAccountId = accountId;
        try {
          await this._renewMigratedAccount(accountId, stored);
        } finally {
          this.preflightAccountId = null;
        }
        this._assertIdleDependencies();
        const renewed = this._candidateSnapshot(accountId);
        if (renewed.candidateSetDigest !== snapshot.candidateSetDigest) {
          throw new KnowledgeAgentQualificationError('qualification_binding_changed', 409);
        }
        snapshot = renewed;
      }
    }
    let accountBinding;
    if (accountId !== undefined) {
      const account = this.accountDirectory.getAccount(accountId);
      if (!account || account.id !== accountId) {
        throw new KnowledgeAgentQualificationError('qualification_binding_changed', 409);
      }
      accountBinding = { accountId, account, events: account.events,
        activateEnrollment,
        disabled: snapshot.targets[0].disabled === true,
        digest: crypto.createHash('sha256').update(JSON.stringify(account)).digest('hex') };
    }
    const startedAt = this.now();
    const run = {
      id: crypto.randomUUID(),
      mode,
      status: 'running',
      phase: 'smoke',
      startedAt,
      finishedAt: 0,
      authorizedRequests: expectedRequests,
      usedRequests: 0,
      completedModes: 0,
      targetCount: snapshot.targets.length,
      passedTargets: 0,
      failedTargets: 0,
      failureCategory: '',
      commitApplied: false,
      reportPersisted: false,
      warnings: [],
      candidateSetDigest: snapshot.candidateSetDigest,
      accountSetDigest: snapshot.accountSetDigest,
      capabilityDigest: snapshot.capabilityDigest,
      knowledgeScopeRef: snapshot.knowledgeScopeRef,
      targetIds: snapshot.targets.map((item) => item.id),
      results: [],
      accountId,
      accountBinding,
      controller: new AbortController(),
    };
    this.active = run;
    try {
      this._saveProgress(run);
    } catch (error) {
      run.status = 'failed';
      run.failureCategory = 'qualification_report_persistence_failed';
      this._finalizeRun(run);
      throw error;
    }
    if (accountId !== undefined && input.onStarted !== undefined) {
      try {
        input.onStarted(Object.freeze({ id: run.id, ...publicActive(run) }));
      } catch {
        run.status = 'failed';
        run.phase = 'completed';
        run.failureCategory = 'qualification_start_callback_failed';
        this._finalizeRun(run);
        throw new KnowledgeAgentQualificationError('qualification_start_callback_failed', 500);
      }
    }
    const completion = this._execute(run, snapshot.targets);
    this.completions.set(run.id, completion);
    completion.finally(() => this.completions.delete(run.id)).catch(() => {});
    return publicActive(run);
  }

  async _renewMigratedAccount(accountId, expected) {
    if (!this.pool?.renewQuarantinedCredentials) {
      throw new KnowledgeAgentQualificationError('qualification_auth_preflight_unavailable', 409);
    }
    let locked = null;
    await this.pool.renewQuarantinedCredentials(accountId, {
      signal: AbortSignal.timeout(15_000),
      onLocked: () => {
        const current = this.accountDirectory.getAccount(accountId);
        if (current !== expected || current.runtime.disabled !== true
            || current.runtime.disabledReason !== 'migration_verification_required') {
          throw new KnowledgeAgentQualificationError('qualification_binding_changed', 409);
        }
        locked = { account: current, events: current.events,
          digest: crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex') };
      },
      persist: (snapshot) => {
        const current = this.accountDirectory.getAccount(accountId);
        if (!locked || current !== locked.account || current?.events !== locked.events
            || crypto.createHash('sha256').update(JSON.stringify(current)).digest('hex') !== locked.digest
            || current.runtime.disabled !== true
            || current.runtime.disabledReason !== 'migration_verification_required') {
          throw new KnowledgeAgentQualificationError('qualification_binding_changed', 409);
        }
        this.accountDirectory.updateCredentialsFromClient(accountId, {
          ...snapshot,
          runtimeEnvPath: current.runtimeEnvPath,
        });
      },
    });
    this.pool.syncAccounts?.(this.accountDirectory.getPoolAccounts());
  }

  async waitFor(id) {
    const completion = this.completions.get(String(id || ''));
    if (completion) await completion;
    return this.getReport(id);
  }

  async _execute(run, targets) {
    try {
      for (const [index, account] of targets.entries()) {
        const beforeRequest = () => {
          throwIfCancelled(run.controller.signal);
          this._assertIdleDependencies();
          if (run.accountBinding) {
            const account = this.accountDirectory.getAccount(run.accountId);
            if (account !== run.accountBinding.account || account?.events !== run.accountBinding.events
                || crypto.createHash('sha256').update(JSON.stringify(account)).digest('hex')
                  !== run.accountBinding.digest) {
              throw new KnowledgeAgentQualificationError('qualification_binding_changed', 409);
            }
          }
          if (this._candidateSnapshot(run.accountId).candidateSetDigest !== run.candidateSetDigest) {
            throw new KnowledgeAgentQualificationError('qualification_binding_changed', 409);
          }
        };
        beforeRequest();
        let countsDispatches = false;
        const result = await (run.mode === 'basic' ? this.basicRunner : this.runner)({
          account,
          questions: this.questionBank,
          requestTimeoutMs: this.requestTimeoutMs,
          signal: run.controller.signal,
          beforeRequest,
          onRequest: () => {
            throwIfCancelled(run.controller.signal);
            countsDispatches = true;
            run.usedRequests += 1;
            this._saveProgress(run);
          },
          onObservation: (observation) => {
            throwIfCancelled(run.controller.signal);
            run.phase = observation.phase;
            if (!countsDispatches) run.usedRequests += 1;
            if (observation.phase === 'matrix' && observation.passed) run.completedModes += 1;
            this._saveProgress(run);
          },
        });
        throwIfCancelled(run.controller.signal);
        if (run.mode === 'basic' && !(result.passed === true && result.requests === 1
            && result.terminals === 1 && result.knowledgeSources > 0
            && result.webSources === 0 && result.unknownSources === 0)) {
          result.passed = false;
          result.failureCategory = result.failureCategory || 'source_contract_unsatisfied';
        }
        run.results.push(sanitizeTargetResult(result, index + 1));
        if (!result.passed) {
          run.failedTargets += 1;
          run.failureCategory = result.failureCategory || 'qualification_failed';
          throw new KnowledgeAgentQualificationError(run.failureCategory, 409);
        }
        run.passedTargets += 1;
      }
      run.phase = 'applying';
      throwIfCancelled(run.controller.signal);
      this._assertIdleDependencies();
      const current = this._candidateSnapshot(run.accountId);
      if (current.candidateSetDigest !== run.candidateSetDigest
          || current.accountSetDigest !== run.accountSetDigest
          || current.capabilityDigest !== run.capabilityDigest
          || current.knowledgeScopeRef !== run.knowledgeScopeRef
          || JSON.stringify(current.targets.map((item) => item.id)) !== JSON.stringify(run.targetIds)) {
        throw new KnowledgeAgentQualificationError('qualification_binding_changed', 409);
      }
      const verifiedAt = new Date(this.now()).toISOString();
      const entries = current.targets.map((account) => ({
        accountId: account.id,
        proof: run.mode === 'basic' ? {
          level: 'basic',
          capabilityDigest: current.capabilityDigest,
          requests: 1,
          terminalCount: 1,
          passedModes: 1,
          knowledgeSourceCount: run.results[0].knowledgeSources,
          unknownSourceCount: 0,
          verifiedAt,
          knowledgeScopeRef: current.knowledgeScopeRef,
          principalFingerprint: account.principalFingerprint,
        } : {
          capabilityDigest: current.capabilityDigest,
          requests: 6,
          terminalCount: 6,
          passedModes: 6,
          unknownSourceCount: 0,
          verifiedAt,
          knowledgeScopeRef: current.knowledgeScopeRef,
          principalFingerprint: account.principalFingerprint,
        },
      }));
      if (run.accountBinding) {
        this.accountDirectory.applyKnowledgeAgentQualification(
          entries[0].accountId, entries[0].proof, run.accountBinding,
        );
      } else {
        this.accountDirectory.recordKnowledgeAgentQualifications(entries);
      }
      // The directory write is the commit point; downstream failures cannot undo it.
      run.commitApplied = true;
      run.status = 'succeeded';
      run.phase = 'completed';
      let poolSynced = true;
      try {
        await this.pool?.syncAccounts?.(this.accountDirectory.getPoolAccounts());
      } catch {
        poolSynced = false;
        run.warnings.push('pool_sync_failed');
      }
      if (poolSynced) {
        try {
          await this.onAccountsSynced(this.pool?.stats?.());
        } catch {
          run.warnings.push('capacity_sync_failed');
        }
      }
    } catch (error) {
      if (!run.commitApplied) {
        run.status = run.controller.signal.aborted ? 'cancelled' : 'failed';
        run.failureCategory = run.controller.signal.aborted
          ? 'qualification_cancelled' : run.failureCategory || fixedFailure(error);
      }
    } finally {
      this._finalizeRun(run);
    }
  }

  _candidateSnapshot(accountId) {
    const accounts = this.accountDirectory?.getPoolAccounts?.() || [];
    const single = accountId !== undefined;
    if (single && (typeof accountId !== 'string' || !accountId.trim()
        || accounts.filter((account) => account.id === accountId).length !== 1)) {
      throw new KnowledgeAgentQualificationError('qualification_account_invalid', 404);
    }
    const capabilityDigest = knowledgeAgentContractDigest();
    if (accounts.length > MAX_ACCOUNTS) {
      throw new KnowledgeAgentQualificationError('qualification_account_count_invalid', 409);
    }
    if (!accounts.length) {
      const accountSetDigest = qualificationAccountSetDigest([]);
      return {
        accounts: [],
        targets: [],
        accountSetDigest,
        capabilityDigest,
        knowledgeScopeRef: '',
        candidateSetDigest: crypto.createHash('sha256').update(JSON.stringify({
          accountSetDigest,
          capabilityDigest,
          knowledgeScopeRef: '',
          targets: [],
        })).digest('hex'),
      };
    }
    const health = new Map((single ? [] : this.accountDirectory.listAccounts?.() || []).map(
      (account) => [account.id, account.health?.status],
    ));
    const scopes = [...new Set(accounts.map((account) => String(account.knowledgeBaseId || '').trim()))];
    if (scopes.length !== 1 || !scopes[0]) {
      throw new KnowledgeAgentQualificationError('qualification_scope_mismatch', 409);
    }
    const targets = single ? accounts.filter((account) => account.id === accountId) : accounts
      .filter((account) => account.disabled !== true)
      .filter((account) => !['qualified', 'expiring'].includes(runtimeQualificationState(
        account.knowledgeAgentQualification,
        account,
        capabilityDigest,
        this.now(),
      )))
      .filter((account) => health.get(account.id) === 'ready')
      .sort((left, right) => stableAccountOrder(left).localeCompare(stableAccountOrder(right)));
    if (targets.some((account) => !validPrincipalFingerprint(account.principalFingerprint))) {
      throw new KnowledgeAgentQualificationError('qualification_identity_unverified', 409);
    }
    const accountSetDigest = qualificationAccountSetDigest(accounts);
    const knowledgeScopeRef = knowledgeScopeDigest(scopes[0]);
    const candidateSetDigest = crypto.createHash('sha256').update(JSON.stringify({
      accountSetDigest,
      capabilityDigest,
      knowledgeScopeRef,
      targets: targets.map((account) => [account.id, account.principalFingerprint]),
    })).digest('hex');
    return { accounts, targets, accountSetDigest, capabilityDigest, knowledgeScopeRef,
      candidateSetDigest };
  }
}

async function runAccountQualification({
  account,
  questions,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  requestSpacingMs = DEFAULT_REQUEST_SPACING_MS,
  onObservation = () => {},
  signal,
  beforeRequest = () => {},
  onRequest = () => {},
  clientFactory = (config) => new IMAWebAgentClient({ ...config, runtimeEnvPath: '' }),
} = {}) {
  throwIfCancelled(signal);
  const client = clientFactory({ ...account, allowAuthRefresh: false });
  const rows = [];
  const smoke = await runScenario({
    client,
    scenario: 'knowledge_default',
    question: questionForScenario(questions, 'knowledge_default'),
    phase: 'smoke',
    requestTimeoutMs,
    signal,
    beforeRequest,
    onRequest,
  });
  rows.push(smoke);
  onObservation(smoke);
  if (!smoke.passed) return summarizeTarget(rows);
  if (requestSpacingMs > 0) await wait(requestSpacingMs, signal);
  let sessionId = '';
  for (const [index, scenario] of SCENARIOS.entries()) {
    const row = await runScenario({
      client,
      scenario,
      question: questionForScenario(questions, scenario),
      phase: 'matrix',
      requestTimeoutMs,
      signal,
      beforeRequest,
      onRequest,
      sessionId: scenario === 'post_web_ordinary' ? sessionId : '',
      onSession(value) {
        if (scenario === 'sequential_web') sessionId = String(value || '');
      },
    });
    rows.push(row);
    onObservation(row);
    if (!row.passed) break;
    if (requestSpacingMs > 0 && index < SCENARIOS.length - 1) await wait(requestSpacingMs, signal);
  }
  return summarizeTarget(rows);
}

async function runBasicAccountQualification({
  account, questions, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  onObservation = () => {}, signal, beforeRequest = () => {}, onRequest = () => {},
  clientFactory = (config) => new IMAWebAgentClient({ ...config, runtimeEnvPath: '' }),
} = {}) {
  throwIfCancelled(signal);
  const client = clientFactory({ ...account, allowAuthRefresh: false });
  const row = await runScenario({
    client, scenario: 'knowledge_default',
    question: questionForScenario(questions, 'knowledge_default'),
    phase: 'smoke', requestTimeoutMs, signal, beforeRequest, onRequest,
  });
  onObservation(row);
  return { passed: row.passed, requests: 1, terminals: row.terminalCount,
    passedModes: row.passed ? 1 : 0, knowledgeSources: row.knowledgeSources,
    webSources: row.webSources, unknownSources: row.unknownSources,
    totalMs: row.totalMs, failureCategory: row.failureCategory };
}

async function runScenario({
  client, scenario, question, phase, requestTimeoutMs, sessionId = '', onSession = () => {},
  signal, beforeRequest, onRequest,
}) {
  throwIfCancelled(signal);
  beforeRequest();
  const startedAt = Date.now();
  let answerPresent = false;
  let terminalCount = 0;
  let knowledge = 0;
  let web = 0;
  let unknown = 0;
  let failureCategory = '';
  onRequest();
  try {
    for await (const event of client.streamAsk({
      allowAuthRefresh: false,
      question: `${question}\n\n${KNOWLEDGE_AGENT_SHORT_SUFFIX}`,
      retrievalPolicy: 'knowledge_agent',
      sessionId: sessionId || undefined,
      onSession,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
        : AbortSignal.timeout(requestTimeoutMs),
    })) {
      throwIfCancelled(signal);
      if (event.type === 'delta' && String(event.text || '').trim()) answerPresent = true;
      if (event.type === 'done') terminalCount += 1;
      if (event.type === 'sources') {
        for (const kind of event.sourceKinds || []) {
          if (kind === 'knowledge') knowledge += 1;
          else if (kind === 'web') web += 1;
          else unknown += 1;
        }
      }
    }
  } catch (error) {
    throwIfCancelled(signal);
    failureCategory = fixedFailure(error);
  }
  throwIfCancelled(signal);
  const passed = !failureCategory && classifyScenario(scenario, {
    answerPresent, terminalCount, knowledge, web, unknown,
  });
  return {
    phase,
    scenario,
    passed,
    knowledgeSources: knowledge,
    webSources: web,
    unknownSources: unknown,
    terminalCount,
    totalMs: Math.max(0, Date.now() - startedAt),
    failureCategory: passed ? '' : failureCategory || 'source_contract_unsatisfied',
  };
}

function classifyScenario(scenario, row) {
  const base = row.answerPresent && row.terminalCount === 1 && row.unknown === 0;
  if (!base) return false;
  if (['knowledge_default', 'explicit_no_web', 'post_web_ordinary'].includes(scenario)) {
    return row.knowledge > 0 && row.web === 0;
  }
  if (scenario === 'explicit_mixed') return row.knowledge > 0 && row.web > 0;
  return ['explicit_web', 'sequential_web'].includes(scenario) && row.web > 0;
}

function summarizeTarget(rows) {
  const matrix = rows.filter((row) => row.phase === 'matrix');
  const passed = rows.length === REQUESTS_PER_TARGET
    && rows.every((row) => row.passed)
    && matrix.length === SCENARIOS.length;
  return {
    passed,
    requests: rows.length,
    terminals: rows.reduce((total, row) => total + Number(row.terminalCount || 0), 0),
    passedModes: matrix.filter((row) => row.passed).length,
    unknownSources: rows.reduce((total, row) => total + Number(row.unknownSources || 0), 0),
    knowledgeSources: rows.reduce((total, row) => total + Number(row.knowledgeSources || 0), 0),
    webSources: rows.reduce((total, row) => total + Number(row.webSources || 0), 0),
    totalMs: rows.reduce((total, row) => total + Number(row.totalMs || 0), 0),
    failureCategory: rows.find((row) => !row.passed)?.failureCategory || '',
  };
}

function loadQuestionBank() {
  const file = path.resolve(__dirname, '..', '..', 'eval', 'questions.jsonl');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  if (rows.length < 6 || rows.slice(0, 6).some((row) => !row?.question)) {
    throw new KnowledgeAgentQualificationError('qualification_question_bank_invalid', 500);
  }
  return {
    knowledge: String(rows[0].question),
    web: `请联网核对截至2026年9月的公开资料后回答：${String(rows[1].question)}`,
    mixed: `请结合当前知识库和联网公开资料回答：${String(rows[2].question)}`,
    noWeb: `请不要联网，只根据当前知识库回答：${String(rows[3].question)}`,
    sessionWeb: `请联网核对截至2026年9月的公开资料后回答：${String(rows[4].question)}`,
    sessionNormal: String(rows[5].question),
  };
}

function questionForScenario(questions, scenario) {
  const key = {
    knowledge_default: 'knowledge',
    explicit_web: 'web',
    explicit_mixed: 'mixed',
    explicit_no_web: 'noWeb',
    sequential_web: 'sessionWeb',
    post_web_ordinary: 'sessionNormal',
  }[scenario];
  const question = String(questions?.[key] || '').trim();
  if (!question) throw new KnowledgeAgentQualificationError('qualification_question_bank_invalid', 500);
  return question;
}

function sanitizeTargetResult(value, slot) {
  return {
    slot,
    passed: value?.passed === true,
    requests: Number(value?.requests || 0),
    terminals: Number(value?.terminals || 0),
    passedModes: Number(value?.passedModes || 0),
    unknownSources: Number(value?.unknownSources || 0),
    knowledgeSources: Number(value?.knowledgeSources || 0),
    webSources: Number(value?.webSources || 0),
    totalMs: Number(value?.totalMs || 0),
    failureCategory: fixedCategory(value?.failureCategory),
  };
}

function sanitizeReport(report, now, ttlMs) {
  const startedAt = Number(report?.startedAt || now);
  return {
    id: String(report?.id || crypto.randomUUID()),
    mode: report?.mode === 'basic' ? 'basic' : 'advanced',
    status: ['running', 'succeeded', 'failed', 'interrupted', 'cancelled'].includes(report?.status)
      ? report.status : 'failed',
    phase: ['smoke', 'matrix', 'applying', 'completed'].includes(report?.phase)
      ? report.phase : 'completed',
    startedAt,
    finishedAt: Number(report?.finishedAt || 0),
    expiresAt: Number(report?.expiresAt || startedAt + ttlMs),
    authorizedRequests: Number(report?.authorizedRequests || 0),
    usedRequests: Number(report?.usedRequests || 0),
    completedModes: Number(report?.completedModes || 0),
    targetCount: Number(report?.targetCount || 0),
    passedTargets: Number(report?.passedTargets || 0),
    failedTargets: Number(report?.failedTargets || 0),
    failureCategory: fixedCategory(report?.failureCategory),
    ...publicOutcome(report),
    candidateSetDigest: validDigest(report?.candidateSetDigest),
    results: Array.isArray(report?.results)
      ? report.results.map((item, index) => sanitizeTargetResult(item, index + 1)) : [],
  };
}

function publicActive(run) {
  return {
    runId: run.id,
    mode: run.mode === 'basic' ? 'basic' : 'advanced',
    status: run.status,
    phase: run.phase,
    startedAt: run.startedAt,
    authorizedRequests: run.authorizedRequests,
    usedRequests: run.usedRequests,
    completedModes: run.completedModes,
    targetCount: run.targetCount,
    passedTargets: run.passedTargets,
    failedTargets: run.failedTargets,
    failureCategory: fixedCategory(run.failureCategory),
    ...publicOutcome(run),
  };
}

function publicReportSummary(report) {
  return {
    id: report.id,
    mode: report.mode === 'basic' ? 'basic' : 'advanced',
    status: report.status,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    authorizedRequests: report.authorizedRequests,
    usedRequests: report.usedRequests,
    targetCount: report.targetCount,
    passedTargets: report.passedTargets,
    failedTargets: report.failedTargets,
    failureCategory: report.failureCategory,
    ...publicOutcome(report),
  };
}

function publicOutcome(run) {
  return {
    ...(typeof run?.commitApplied === 'boolean' ? { commitApplied: run.commitApplied } : {}),
    ...(typeof run?.reportPersisted === 'boolean' ? { reportPersisted: run.reportPersisted } : {}),
    warnings: Array.isArray(run?.warnings)
      ? [...new Set(run.warnings.filter((warning) => SAFE_WARNINGS.has(warning)))] : [],
  };
}

function fixedFailure(error) {
  const value = String(error?.code || error?.reason || error?.message || '');
  if (/auth|401|403|login/u.test(value)) return 'upstream_auth';
  if (/429|quota|limit/u.test(value)) return 'upstream_quota';
  if (/timeout|abort/u.test(value)) return 'upstream_timeout';
  if (/protocol|source|terminal|basis/u.test(value)) return 'protocol_failure';
  if (/network|fetch|socket/u.test(value)) return 'network_failure';
  return fixedCategory(value) || 'upstream_failure';
}

function fixedCategory(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return SAFE_FAILURE_CATEGORIES.has(text) ? text : '';
}

function stableAccountOrder(account) {
  return crypto.createHash('sha256').update(String(account?.id || '')).digest('hex');
}

function validDigest(value) {
  return /^[a-f0-9]{64}$/u.test(String(value || '')) ? String(value) : '';
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw new KnowledgeAgentQualificationError('qualification_cancelled', 409);
}

async function wait(milliseconds, signal) {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    throwIfCancelled(signal);
    throw error;
  }
}

module.exports = {
  KnowledgeAgentQualificationError,
  KnowledgeAgentQualificationManager,
  KnowledgeAgentQualificationReportStore,
  REQUESTS_PER_TARGET,
  SCENARIOS,
  classifyScenario,
  runAccountQualification,
  runBasicAccountQualification,
};
