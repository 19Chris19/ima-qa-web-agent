const { createHash } = require('node:crypto');
const { normalizeElasticScheduling, ElasticAccountScheduler } = require('./elastic-account-scheduler');
const { accountDescriptor } = require('./elastic-validation');
const { IMAWebAgentClient } = require('./ima-web-agent-client');
const {
  classifyAccountHealthError,
  createAccountHealthError,
} = require('./account-health');

const DEFAULT_ACCOUNT_COOLDOWN_MS = 120 * 1000;
const DEFAULT_ACCOUNT_MAX_CONSECUTIVE_ERRORS = 2;
const DEFAULT_ACCOUNT_HEALTH_CHECK_TIMEOUT_MS = 15 * 1000;

class NoAvailableWebAgentAccountError extends Error {
  constructor(message = 'IMA 账号池暂时没有可用账号，请稍后再试') {
    super(message);
    this.name = 'NoAvailableWebAgentAccountError';
    this.statusCode = 503;
  }
}

class IMAWebAgentPool {
  constructor(config = {}, options = {}) {
    const accounts = Array.isArray(config.accounts) ? config.accounts : [];

    const clientFactory =
      options.clientFactory ||
      ((account) => new IMAWebAgentClient(account, options.fetchImpl || globalThis.fetch));
    this.clientFactory = clientFactory;
    this.onAccountStateChange = options.onAccountStateChange || null;
    this.onAccountCredentialsChange = options.onAccountCredentialsChange || null;
    this.managedPersistence = options.managedPersistence === true;
    this.persistenceReady = options.persistenceReady || (() => true);
    this.policyEligibility = options.policyEligibility || null;
    this.now = options.now || Date.now;
    const elasticConfig = normalizeElasticScheduling(config.elasticScheduling);
    this.defaultElasticMode = config.webMode || 'classic_knowledge';
    this.elastic = elasticConfig.enabled ? new ElasticAccountScheduler(elasticConfig, this.now) : null;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.availabilityTimer = null;
    this.availabilityTimerAt = 0;
    this.slotWaiters = 0;
    this.schedulingClosed = false;
    this.cancelSlotWaiters = new Set();
    this.activeSessions = new Set();
    this.waiters = new Set();
    this.availabilityListeners = new Set();
    this.availabilityObserverErrors = 0;
    this.taskLeases = new WeakMap();
    this.parallelPairs = new Map();
    this.maxParallelPairs = options.maxParallelPairs || 4096;
    if (!Number.isSafeInteger(this.maxParallelPairs) || this.maxParallelPairs < 1 || this.maxParallelPairs > 4096) {
      throw new TypeError('Invalid parallel pair capacity');
    }
    this.parallelPairRetentionMs = options.parallelPairRetentionMs || 5 * 60_000;
    this.cooldownMs = Number(config.accountCooldownMs || DEFAULT_ACCOUNT_COOLDOWN_MS);
    this.maxConsecutiveErrors = Number(
      config.accountMaxConsecutiveErrors || DEFAULT_ACCOUNT_MAX_CONSECUTIVE_ERRORS,
    );
    this.healthCheckTimeoutMs = Number(
      config.healthCheckTimeoutMs || DEFAULT_ACCOUNT_HEALTH_CHECK_TIMEOUT_MS,
    );
    this.autoRefreshStarted = false;
    this.accounts = [];
    this.syncAccounts(accounts);
  }

  syncAccounts(accounts = []) {
    if (this.elastic && new Set(accounts.map(accountId)).size !== accounts.length) throw new TypeError('Duplicate elastic account ID');
    const existingById = new Map(this.accounts.map((account) => [account.id, account]));
    const next = [];
    const added = [];
    const seen = new Set();

    accounts.forEach((config, index) => {
      const id = accountId(config, index);
      const existing = existingById.get(id);
      if (existing) {
        const wasDisabled = existing.disabled;
        const elasticBindingChanged = existing.principalFingerprint !== config.principalFingerprint
          || existing.modelId !== config.modelId || existing.modelType !== config.modelType;
        existing.name = config.name || existing.name || id;
        existing.modelId = config.modelId; existing.modelType = config.modelType;
        existing.maxConcurrent = normalizeAccountMaxConcurrent(config.maxConcurrent);
        existing.webQualification = config.webQualification || null;
        existing.principalFingerprint = config.principalFingerprint;
        existing.knowledgeBaseId = config.knowledgeBaseId;
        existing.client.applyConfig?.({ ...config, id, name: existing.name });
        if (elasticBindingChanged) this.elastic?.reset(existing);
        existing.disabled = Boolean(config.disabled);
        existing.disabledReason = config.disabledReason || '';
        if (existing.disabled) existing.client.stopAutoRefresh?.();
        else if (wasDisabled && this.autoRefreshStarted) {
          existing.client.startAutoRefresh?.((_snapshot, generation) => this._notifyCredentials(existing, generation));
        }
        next.push(existing);
        seen.add(id);
        this._notifyState(existing);
        return;
      }

      const account = {
        id,
        name: config.name || id,
        client: this.clientFactory({ ...config, id, name: config.name || id }),
        activeRequests: Number(config.activeRequests || 0),
        modelId: config.modelId, modelType: config.modelType,
        maxConcurrent: normalizeAccountMaxConcurrent(config.maxConcurrent),
        cooldownUntil: Number(config.cooldownUntil || 0),
        consecutiveErrors: Number(config.consecutiveErrors || 0),
        disabled: Boolean(config.disabled),
        disabledReason: config.disabledReason || '',
        lastError: config.lastError || '',
        lastUsedAt: Number(config.lastUsedAt || 0),
        totalRequests: Number(config.totalRequests || 0),
        maintenanceOperation: '',
        webQualification: config.webQualification || null,
        principalFingerprint: config.principalFingerprint,
        knowledgeBaseId: config.knowledgeBaseId,
      };
      account.client.runAutoMaintenance = fn => {
        if (account.disabled || account.activeRequests || account.maintenanceOperation) return false;
        return this._runMaintenanceOperation(account, 'auto_refresh', fn);
      };
      if (this.managedPersistence) {
        account.client.managedPersistence = true;
        account.client.onCredentialCommit = (_snapshot, generation) => this._notifyCredentials(account, generation);
      }
      next.push(account);
      added.push(account);
      seen.add(id);
      this._notifyState(account);
    });

    for (const account of this.accounts) {
      if (!seen.has(account.id)) account.client.stopAutoRefresh?.();
      if (!seen.has(account.id) && account.activeRequests > 0) {
        account.disabled = true;
        account.disabledReason = 'removed_while_active';
        next.push(account);
        this._notifyState(account);
      }
    }

    this.accounts = next;
    this.elastic?.sync(next);
    if (this.autoRefreshStarted) {
      for (const account of added) {
        if (!account.disabled) account.client.startAutoRefresh?.((_snapshot, generation) => this._notifyCredentials(account, generation));
      }
    }
    this._notifyAvailability();
  }

  withCredentialReplacement(accountId, writeAndSync) {
    const previous = this.accounts.find(account => account.id === accountId);
    if (!previous) return writeAndSync();
    this.elastic?.reset(previous);
    // Keep quarantine across asynchronous persistence and pool synchronization.
    previous.client.invalidateCredentials?.({ suspend: true });
    previous.client.stopAutoRefresh?.();
    previous.maintenanceOperation = 'credential_replacement';
    const failed = error => {
      for (const account of new Set([previous, ...this.accounts.filter(row => row.id === previous.id)])) {
        account.client.invalidateCredentials?.({ suspend: true });
        account.client.stopAutoRefresh?.();
        account.maintenanceOperation = 'qualification';
        account.webQualification = null;
      }
      throw error;
    };
    const completed = value => {
      if (previous.maintenanceOperation === 'credential_replacement') previous.maintenanceOperation = '';
      this._notifyAvailability(); return value;
    };
    try {
      const result = writeAndSync();
      return result && typeof result.then === 'function' ? result.then(completed, failed) : completed(result);
    } catch (error) {
      return failed(error);
    }
  }

  async ensureFreshAuth() {
    const results = await Promise.allSettled(
      this.accounts.map(async (account) => {
        if (account.disabled || account.activeRequests > 0 || account.maintenanceOperation
            || typeof account.client.ensureFreshAuth !== 'function') {
          return false;
        }
        let refreshed = false;
        await this._runMaintenanceOperation(account, 'refresh', async () => {
          refreshed = await account.client.ensureFreshAuth();
          account.client.persistRuntimeEnv?.();
          if (refreshed) await this._notifyCredentials(account);
        });
        return refreshed;
      }),
    );
    return results.some((result) => result.status === 'fulfilled' && result.value);
  }

  startAutoRefresh() {
    this.autoRefreshStarted = true;
    for (const account of this.accounts) {
      if (!account.disabled) account.client.startAutoRefresh?.((_snapshot, generation) => this._notifyCredentials(account, generation));
    }
  }

  persistRuntimeEnv() {
    let persisted = false;
    for (const account of this.accounts) {
      if (typeof account.client.persistRuntimeEnv === 'function') {
        persisted = account.client.persistRuntimeEnv() || persisted;
      }
    }
    return persisted;
  }

  stopAutoRefresh() {
    this.autoRefreshStarted = false;
    for (const account of this.accounts) {
      account.client.stopAutoRefresh?.();
    }
  }

  async *streamAsk(options = {}) {
    options.signal?.throwIfAborted();
    const pair = this._parallelPair(options);
    let ownPairLease;
    if ((pair || this.elastic) && !options.accountLease) {
      ownPairLease = await this._waitForPairSlot(options);
      options = { ...options, accountLease: ownPairLease.value };
    }
    try {
      yield* this._streamAsk(options);
    } finally {
      ownPairLease?.release();
    }
  }

  async *_streamAsk(options = {}) {
    let preferredAccountId = String(options.accountId || '').trim();
    if ((options.mode === 'knowledge_agent' && this.webReadiness) || (options.retrievalPolicy && this.policyEligibility)) {
      const eligible = this.accounts.filter(account => this._requestEligible(account, options));
      if (preferredAccountId && !eligible.some(account => [account.id, account.name].includes(preferredAccountId))) throw new NoAvailableWebAgentAccountError('会话账号需要重新验证');
      if (!eligible.length) throw new NoAvailableWebAgentAccountError('暂无通过问答验证的账号');
    }
    const account = options.accountLease ? this._consumeTaskLease(options.accountLease, options) : preferredAccountId
      ? await this._waitForPreferredAccount(preferredAccountId, options.signal)
      : await this._waitForAnyAccount(options.signal, account => this._requestEligible(account, options));
    let sessionId = '';
    const upstreamOnSession = options.onSession;
    const clientOptions = {
      ...options,
      sessionId: options.sessionId || '',
      onSession(nextSessionId, metadata) {
        sessionId = nextSessionId;
        upstreamOnSession?.(nextSessionId, metadata);
      },
    };
    delete clientOptions.accountId;
    delete clientOptions.parallelPairKey;
    try {
      options.signal?.throwIfAborted();
      yield { type: 'route', accountId: account.id };
      options.signal?.throwIfAborted();
      if (!this._requestEligible(account, options)) {
        throw new NoAvailableWebAgentAccountError('账号状态已变化，请稍后重试');
      }
      const stream = account.client.streamAsk(clientOptions);
      let reportedSession = false;
      for await (const event of stream) {
        if (!reportedSession && sessionId) {
          reportedSession = true;
          yield { type: 'session', sessionId };
        }
        yield event;
      }
      if (sessionId) {
        if (!reportedSession) {
          yield { type: 'session', sessionId };
        }
      }
      await this._markSuccess(account, options.accountLease && this.taskLeases.get(options.accountLease)?.elasticTicket);
    } catch (error) {
      if (!options.signal?.aborted && !(error instanceof NoAvailableWebAgentAccountError)) {
        await this._markFailure(account, error);
      }
      throw error;
    } finally {
      if (options.accountLease) this.taskLeases.get(options.accountLease).release();
      else this._releaseAccount(account);
    }
  }

  onAvailability(listener) {
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  _requestEligible(account, options) {
    return this.persistenceReady() && !account.client.pendingCredentialPersistence && !account.client.credentialWritesSuspended
      && !(options.mode === 'knowledge_agent' && this.webReadiness && !this.webReadiness(account))
      && !(options.retrievalPolicy && this.policyEligibility && !this.policyEligibility(account, options));
  }

  _runnableAccount(options = {}) {
    if (this.schedulingClosed) throw new NoAvailableWebAgentAccountError('服务正在停止');
    const pair = this._parallelPair(options);
    this._pruneParallelPairs();
    if (pair && !this.parallelPairs.has(pair.key) && this.parallelPairs.size >= this.maxParallelPairs) {
      throw new NoAvailableWebAgentAccountError('parallel_pair_capacity');
    }
    const preferred = options.accountId || '';
    const eligible = account => this._requestEligible(account, options) && this._pairEligible(account, pair, options);
    const sessionFree = account => !(this.elastic && options.sessionId && this.activeSessions.has(this._sessionKey(account, options)));
    if (preferred) {
      const account = this.accounts.find(item => item.id === preferred || item.name === preferred);
      if (!account || account.disabled) {
        throw new NoAvailableWebAgentAccountError('会话账号暂不可用');
      }
      if (account.maintenanceOperation) return null;
      if (this.elastic && account.cooldownUntil > this.now()) { this._scheduleAvailability(); return null; }
      if (!eligible(account) || account.cooldownUntil > this.now()) throw new NoAvailableWebAgentAccountError('会话账号暂不可用');
      const available = sessionFree(account) && this._slotAvailable(account, true, options);
      if (!available) this._scheduleAvailability();
      return available ? account : null;
    }
    const potential = this.elastic
      ? this.accounts.some(account => !account.disabled && (account.maintenanceOperation || account.cooldownUntil > this.now() || eligible(account)))
      : this._hasPotentialAvailability(account => account.maintenanceOperation || eligible(account));
    if (!potential) throw new NoAvailableWebAgentAccountError();
    const account = this._findAvailableAccount(account => eligible(account) && sessionFree(account), options);
    if (!account) this._scheduleAvailability();
    return account;
  }

  canAcquireSlot(options) { return Boolean(this._runnableAccount(options)); }

  tryAcquireSlot(options = {}) {
    options.signal?.throwIfAborted();
    const account = this._runnableAccount(options);
    if (!account) return null;
    const pairLease = this._recordParallelPairLease(this._parallelPair(options), account.id);
    let elasticTicket;
    const sessionKey = this.elastic && options.sessionId ? this._sessionKey(account, options) : null;
    try { this._reserveAccount(account, () => {
      elasticTicket = this.elastic?.reserve(account, accountDescriptor(account, options, this.defaultElasticMode));
      if (sessionKey) this.activeSessions.add(sessionKey);
    }); }
    catch (error) { if (sessionKey) this.activeSessions.delete(sessionKey); pairLease?.release(); throw error; }
    const value = {};
    const record = { account, pairLease, elasticTicket, sessionId: String(options.sessionId || ''), used: false, released: false, release: () => {
      if (record.released) return;
      record.released = true;
      if (sessionKey) this.activeSessions.delete(sessionKey);
      pairLease?.release();
      this._releaseAccount(account);
    } };
    this.taskLeases.set(value, record);
    return { value, release: record.release };
  }

  _consumeTaskLease(lease, options) {
    const record = this.taskLeases.get(lease);
    const account = record?.account;
    const pair = this._parallelPair(options);
    if (!record || record.used || record.released || !this.accounts.includes(account)
        || record.pairLease?.key !== pair?.key || record.pairLease?.leg !== pair?.leg
        || account.disabled || account.maintenanceOperation || account.cooldownUntil > this.now()
        || (this.elastic && record.sessionId !== String(options.sessionId || ''))
        || (options.accountId && ![account.id, account.name].includes(options.accountId))
        || !this._requestEligible(account, options)) {
      throw new Error('Invalid account lease');
    }
    record.used = true;
    record.pairLease?.markUsed();
    return account;
  }

  _parallelPair(options) {
    if (!options.parallelPairRef && !options.parallelLeg && !options.parallelPairKey) return null;
    if (!/^[a-f0-9]{64}$/u.test(options.parallelPairRef || '') ||
        !/^[a-f0-9]{64}$/u.test(options.parallelPairKey || '') ||
        !['knowledge', 'web'].includes(options.parallelLeg) ||
        options.retrievalPolicy !== (options.parallelLeg === 'knowledge' ? 'group_knowledge' : 'web')) {
      throw new NoAvailableWebAgentAccountError('parallel_contract_invalid');
    }
    return { key: options.parallelPairKey, leg: options.parallelLeg };
  }

  _pairEligible(account, pair, options) {
    if (!pair) return true;
    const entry = this.parallelPairs.get(pair.key);
    if (entry?.blocked) return false;
    const other = pair.leg === 'knowledge' ? 'web' : 'knowledge';
    if (entry?.legs[other]?.accountId === account.id) return false;
    if (entry?.legs[pair.leg] && entry.legs[pair.leg].accountId !== account.id) return false;
    if (entry?.legs[other]) return true;
    const counterpart = { ...options, accountId: undefined,
      retrievalPolicy: other === 'web' ? 'web' : 'group_knowledge' };
    return this.accounts.some(candidate => candidate.id !== account.id && !candidate.disabled &&
      !candidate.maintenanceOperation && candidate.cooldownUntil <= this.now() && this._requestEligible(candidate, counterpart));
  }

  _recordParallelPairLease(pair, accountId) {
    if (!pair) return null;
    let entry = this.parallelPairs.get(pair.key);
    if (!entry) {
      if (this.parallelPairs.size >= this.maxParallelPairs) throw new NoAvailableWebAgentAccountError('parallel_pair_capacity');
      entry = { legs: {}, expiresAt: Infinity };
      this.parallelPairs.set(pair.key, entry);
    }
    const other = pair.leg === 'knowledge' ? 'web' : 'knowledge';
    if (entry.legs[other]?.accountId === accountId ||
        (entry.legs[pair.leg] && entry.legs[pair.leg].accountId !== accountId)) {
      throw new NoAvailableWebAgentAccountError('parallel_pair_account_conflict');
    }
    const leg = entry.legs[pair.leg] ||= { accountId, active: 0, used: false };
    leg.active++;
    entry.expiresAt = Infinity;
    let released = false;
    return { ...pair, markUsed() { leg.used = true; }, release: () => {
      if (released) return;
      released = true;
      leg.active--;
      if (!leg.active && !leg.used) delete entry.legs[pair.leg];
      const legs = Object.values(entry.legs);
      if (!legs.length) this.parallelPairs.delete(pair.key);
      else if (!entry.blocked && legs.length === 2 && legs.every(item => !item.active)) entry.expiresAt = this.now() + this.parallelPairRetentionMs;
    } };
  }

  _pruneParallelPairs() {
    for (const [key, entry] of this.parallelPairs) {
      if (entry.expiresAt <= this.now()) this.parallelPairs.delete(key);
    }
  }

  parallelPairCapacity() {
    this._pruneParallelPairs();
    return Math.max(0, this.maxParallelPairs - this.parallelPairs.size);
  }

  restoreParallelPairBinding(options) {
    const pair = this._parallelPair(options);
    if (!pair) return;
    const expiresAt = options.expiresAt ?? Infinity;
    if (expiresAt !== Infinity && (!Number.isFinite(expiresAt) || expiresAt < 0)) {
      throw new NoAvailableWebAgentAccountError('parallel_contract_invalid');
    }
    if (expiresAt <= this.now()) return;
    if (!options.accountId) {
      if (!this.parallelPairs.has(pair.key) && this.parallelPairs.size >= this.maxParallelPairs) {
        throw new NoAvailableWebAgentAccountError('parallel_pair_capacity');
      }
      const entry = this.parallelPairs.get(pair.key) || { legs: {}, expiresAt: Infinity };
      entry.blocked = true;
      entry.expiresAt = expiresAt;
      this.parallelPairs.set(pair.key, entry);
      return;
    }
    const lease = this._recordParallelPairLease(pair, options.accountId);
    lease.markUsed();
    lease.release();
    if (options.expiresAt !== undefined) this.parallelPairs.get(pair.key).expiresAt = expiresAt;
  }

  _waitForPairSlot(options) {
    options.signal?.throwIfAborted();
    const lease = this.tryAcquireSlot(options);
    if (lease) return lease;
    if (this.elastic && this.slotWaiters >= this.elastic.config.maxWaiters) {
      throw Object.assign(new NoAvailableWebAgentAccountError('账号等待队列已满'), { code: 'account_wait_queue_full', statusCode: 429 });
    }
    this.slotWaiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, acquired) => {
        if (settled) { acquired?.release(); return; }
        settled = true;
        this.slotWaiters--;
        if (timer) this.clearTimer(timer);
        this.cancelSlotWaiters.delete(cancel);
        unsubscribe();
        options.signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(acquired);
      };
      const abort = () => finish(new Error('request_aborted'));
      const cancel = () => finish(new NoAvailableWebAgentAccountError('服务正在停止'));
      const wake = () => {
        try { const acquired = this.tryAcquireSlot(options); if (acquired) finish(null, acquired); }
        catch (error) { finish(error); }
      };
      const unsubscribe = this.onAvailability(wake);
      if (this.elastic) {
        this.cancelSlotWaiters.add(cancel);
        timer = this.setTimer(() => finish(Object.assign(new NoAvailableWebAgentAccountError('等待账号超时'),
          { code: 'account_wait_timeout' })), this.elastic.config.maxWaitMs);
        // Keep a direct caller alive while it awaits admission; the deadline is bounded.
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort(); else wake();
    });
  }

  _releaseAccount(account) {
    account.activeRequests = Math.max(0, account.activeRequests - 1);
    try { this._notifyState(account); }
    finally { this._notifyAvailability(); }
  }

  async refreshAccount(accountIdOrName, options = {}) {
    const account = this._requireAccount(accountIdOrName);
    return this._runMaintenanceOperation(account, 'refresh', async () => {
      if (typeof account.client.refreshAuth !== 'function') {
        throw createAccountHealthError('auth_expired');
      }
      try {
        await runWithBoundedSignal(
          (signal) => account.client.refreshAuth({ ...options, signal }),
          options.timeoutMs || this.healthCheckTimeoutMs,
        );
        account.client.persistRuntimeEnv?.();
        await this._notifyCredentials(account);
      } catch (error) {
        throw createAccountHealthError(classifyAccountHealthError(error, 'refresh'), error);
      }
      return this._checkAccount(account, options, { refreshed: true });
    });
  }

  async checkAccount(accountIdOrName, options = {}) {
    const account = this._requireAccount(accountIdOrName);
    return this._runMaintenanceOperation(account, 'check', () => this._checkAccount(account, options));
  }

  async _checkAccount(account, options = {}, result = {}) {
    if (typeof account.client.initSession !== 'function') {
      throw createAccountHealthError('web_context_missing');
    }
    const clientContext = account.client.createFirstPartyClientContext?.();
    if (!clientContext) {
      throw createAccountHealthError('web_context_missing');
    }

    try {
      await runWithBoundedSignal(
        (signal) => account.client.initSession({
          signal,
          clientContext,
          // A check must not silently refresh or replace account credentials.
          allowAuthRefresh: false,
        }),
        options.timeoutMs || this.healthCheckTimeoutMs,
      );
    } catch (error) {
      throw createAccountHealthError(classifyAccountHealthError(error, result.refreshed ? 'refresh' : 'check'), error);
    }

    this._notifyState(account);
    return {
      ...this._publicAccountState(account, { includeDetails: true }),
      healthCheck: {
        code: 'ok',
        checkedAt: new Date(this.now()).toISOString(),
        sessionValid: true,
        knowledgeReady: true,
        webReady: true,
        refreshed: Boolean(result.refreshed),
      },
    };
  }

  setAccountDisabled(accountIdOrName, disabled, reason = '') {
    const account = this._requireAccount(accountIdOrName);
    account.disabled = Boolean(disabled);
    account.disabledReason = disabled ? String(reason || 'disabled_by_admin') : '';
    if (!disabled) {
      account.consecutiveErrors = 0;
      account.lastError = '';
      account.cooldownUntil = 0;
    }
    this._notifyState(account);
    this._notifyAvailability();
    return this._publicAccountState(account, { includeDetails: true });
  }

  async _runMaintenanceOperation(account, operation, fn) {
    if (account.maintenanceOperation || account.activeRequests > 0) {
      throw createAccountHealthError('account_operation_in_progress');
    }
    account.maintenanceOperation = operation;
    const generation = account.client.credentialGeneration;
    try {
      const persisted = this._notifyState(account);
      if (persisted && typeof persisted.then === 'function') await persisted;
      if (generation !== account.client.credentialGeneration || account.client.credentialWritesSuspended) {
        throw Object.assign(new Error('credential_generation_stale'), { code: 'credential_generation_stale' });
      }
    }
    catch (error) {
      if (account.maintenanceOperation === operation) account.maintenanceOperation = '';
      this._notifyAvailability();
      throw error;
    }
    let result;
    try {
      result = await fn();
    } finally {
      // Credential replacement may install a quarantine while maintenance runs.
      if (account.maintenanceOperation === operation) account.maintenanceOperation = '';
      try { await this._notifyState(account); }
      finally { this._notifyAvailability(); }
    }
    return { ...result, ...this._publicAccountState(account, { includeDetails: true }) };
  }

  _leaseAccount(eligible) {
    const account = this._findAvailableAccount(eligible);
    return account ? this._reserveAccount(account) : null;
  }

  _findAvailableAccount(eligible = () => true, options = {}) {
    const now = this.now();
    return this.accounts
      .filter(() => this.persistenceReady())
      .filter((account) => !account.disabled)
      .filter((account) => !account.client.pendingCredentialPersistence && !account.client.credentialWritesSuspended)
      .filter(eligible)
      .filter((account) => !account.maintenanceOperation)
      .filter((account) => this._slotAvailable(account, true, options))
      .filter((account) => account.cooldownUntil <= now)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0] || null;
  }

  _reserveAccount(account, beforeNotify) {
    const now = this.now();
    const previousLastUsedAt = account.lastUsedAt;
    const previousTotalRequests = account.totalRequests;
    account.activeRequests += 1;
    account.lastUsedAt = now;
    account.totalRequests += 1;
    try { beforeNotify?.(); this._notifyState(account); }
    catch (error) {
      account.activeRequests -= 1;
      account.lastUsedAt = previousLastUsedAt;
      account.totalRequests = previousTotalRequests;
      throw error;
    }
    return account;
  }

  _hasPotentialAvailability(eligible = () => true) {
    const now = this.now();
    return this.accounts.some(
      (account) => eligible(account) && !account.disabled && (account.activeRequests > 0 || account.cooldownUntil <= now),
    );
  }

  _waitForAnyAccount(signal, eligible) {
    signal?.throwIfAborted();
    const direct = this._leaseAccount(eligible);
    if (direct) {
      return direct;
    }
    if (!this._hasPotentialAvailability(eligible)) {
      throw new NoAvailableWebAgentAccountError();
    }

    return new Promise((resolve, reject) => {
      let waiter;
      const onAbort = () => waiter.reject(new Error('请求已取消'));
      waiter = {
        kind: 'any',
        eligible,
        resolve: (account) => {
          this.waiters.delete(waiter);
          signal?.removeEventListener('abort', onAbort);
          resolve(account);
        },
        reject: (error) => {
          this.waiters.delete(waiter);
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      this.waiters.add(waiter);
      if (signal) {
        if (signal.aborted) {
          waiter.reject(new Error('请求已取消'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this._drainWaiters();
    });
  }

  _waitForPreferredAccount(accountId, signal) {
    signal?.throwIfAborted();
    const account = this.accounts.find((candidate) => candidate.id === accountId || candidate.name === accountId);
    if (!account || account.disabled) {
      throw new NoAvailableWebAgentAccountError('会话绑定的 IMA 账号已不可用，请新建会话后继续');
    }
    if (account.cooldownUntil > this.now()) {
      throw new NoAvailableWebAgentAccountError('会话绑定的 IMA 账号正在冷却，请稍后重试');
    }

    const available = () => {
      const candidateNow = this.now();
      return !account.disabled && !account.maintenanceOperation && account.activeRequests < account.maxConcurrent && account.cooldownUntil <= candidateNow;
    };
    if (available()) {
      return this._reserveAccount(account);
    }

    return new Promise((resolve, reject) => {
      let waiter;
      const onAbort = () => waiter.reject(new Error('请求已取消'));
      waiter = {
        kind: 'preferred',
        account,
        resolve: (reservedAccount) => {
          this.waiters.delete(waiter);
          signal?.removeEventListener('abort', onAbort);
          resolve(reservedAccount);
        },
        reject: (error) => {
          this.waiters.delete(waiter);
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      this.waiters.add(waiter);
      if (signal) {
        if (signal.aborted) {
          waiter.reject(new Error('请求已取消'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this._drainWaiters();
    });
  }

  _drainWaiters() {
    for (const waiter of [...this.waiters]) {
      try {
        if (waiter.kind === 'any') {
          const account = this._leaseAccount(waiter.eligible);
          if (account) {
            waiter.resolve(account);
          } else if (!this._hasPotentialAvailability(waiter.eligible)) {
            waiter.reject(new NoAvailableWebAgentAccountError());
          }
          continue;
        }
        if (waiter.account.disabled) {
          waiter.reject(new NoAvailableWebAgentAccountError('会话绑定的 IMA 账号已不可用，请新建会话后继续'));
          continue;
        }
        if (waiter.account.cooldownUntil > this.now()) {
          waiter.reject(new NoAvailableWebAgentAccountError('会话绑定的 IMA 账号正在冷却，请稍后重试'));
          continue;
        }
        if (!waiter.account.maintenanceOperation && waiter.account.activeRequests < waiter.account.maxConcurrent && waiter.account.cooldownUntil <= this.now()) {
          waiter.resolve(this._reserveAccount(waiter.account));
        }
      } catch (error) {
        waiter.reject(error);
      }
    }
  }

  accountCapacity(account, options = {}) {
    const current = this.accounts.find(row => row.id === account.id) || account;
    return this.elastic ? this.elastic.capacity(current, accountDescriptor(current, options, this.defaultElasticMode)) : current.maxConcurrent;
  }
  capCapacity(capacity) { return this.elastic ? Math.min(capacity, this.elastic.config.maxGlobal) : capacity; }
  availableCapacity(value) {
    return this.elastic ? Math.max(0, Math.min(value, this.elastic.config.maxGlobal
      - this.accounts.reduce((sum, account) => sum + account.activeRequests, 0))) : value;
  }
  _sessionKey(account, options) { return JSON.stringify([account.id, options.sessionId]); }
  _slotAvailable(account, recordDemand = false, options = {}) {
    if (recordDemand && this.elastic && account.activeRequests >= this.accountCapacity(account, options)) this.elastic.markDemand(account);
    return account.activeRequests < this.accountCapacity(account, options) && (!this.elastic || (this.elastic.canStart(account)
      && this.accounts.reduce((sum, row) => sum + row.activeRequests, 0) < this.elastic.config.maxGlobal));
  }

  // A single wake-up for all accounts; no polling and no per-task timer.
  _scheduleAvailability() {
    if (!this.elastic || this.schedulingClosed) return;
    const now = this.now();
    let next = Infinity;
    for (const account of this.accounts) {
      if (account.disabled || account.maintenanceOperation || account.activeRequests >= this.elastic.overallCapacity(account)) continue;
      const at = Math.max(account.cooldownUntil, this.elastic.state(account).nextStartAt);
      if (at > now) next = Math.min(next, at);
    }
    if (this.availabilityTimer && this.availabilityTimerAt === next) return;
    if (this.availabilityTimer) this.clearTimer(this.availabilityTimer);
    this.availabilityTimer = null;
    this.availabilityTimerAt = next;
    if (Number.isFinite(next)) {
      this.availabilityTimer = this.setTimer(() => {
        this.availabilityTimer = null;
        this._notifyAvailability();
      }, Math.max(1, next - now));
      this.availabilityTimer.unref?.();
    }
  }

  closeScheduling() {
    this.schedulingClosed = true;
    for (const cancel of [...this.cancelSlotWaiters]) cancel();
    if (this.availabilityTimer) this.clearTimer(this.availabilityTimer);
    this.availabilityTimer = null;
  }

  _notifyAvailability() {
    this._drainWaiters();
    for (const listener of this.availabilityListeners) {
      try { listener(); }
      catch { this.availabilityObserverErrors += 1; }
    }
    this._scheduleAvailability();
  }

  _markSuccess(account, ticket) {
    if (this.elastic && !this.elastic.success(account, ticket)) return;
    account.consecutiveErrors = 0;
    account.lastError = '';
    account.cooldownUntil = 0;
    return this._notifyState(account);
  }

  _markFailure(account, error) {
    account.consecutiveErrors += 1;
    account.lastError = safeErrorMessage(error);
    if (this.elastic && (isCooldownError(error) || ['upstream_quota', 'rate_limited'].includes(error?.code) || error?.statusCode === 429 || error?.status === 429)) {
      this.elastic.congestion(account);
      return this._notifyState(account);
    }
    if (this.elastic && !isAuthError(error) && error?.code !== 'upstream_auth') this.elastic.congestion(account, 'upstream_error');

    if (isAuthError(error) || (this.elastic && error?.code === 'upstream_auth')) {
      this.elastic?.invalidate(account, 'auth_failed');
      account.disabled = true;
      account.disabledReason = 'auth_failed';
      return this._notifyState(account);
    }

    if (isCooldownError(error) || account.consecutiveErrors >= this.maxConsecutiveErrors) {
      account.cooldownUntil = this.now() + this.cooldownMs;
    }
    return this._notifyState(account);
  }

  stats(options = {}) {
    const now = this.now();
    const accounts = this.accounts.map((account) => this._publicAccountState(account, {
      includeDetails: options.includeDetails,
      now,
    }));

    const summary = {
      totalAccounts: accounts.length,
      totalSlots: this.capCapacity(accounts.reduce((sum, account) => sum + this.accountCapacity(account), 0)),
      activeRequests: accounts.reduce((sum, account) => sum + account.activeRequests, 0),
      waitingRequests: this.waiters.size + this.slotWaiters,
      waitingPreferredRequests: [...this.waiters].filter(waiter => waiter.kind === 'preferred').length,
      availableSlots: Math.max(0, Math.min(this.capCapacity(Infinity) - accounts.reduce((sum, account) => sum + account.activeRequests, 0), accounts.reduce((sum, account) => sum + account.availableSlots, 0))),
      capacity: this.capCapacity(this.accounts.filter(account => !account.disabled && !account.maintenanceOperation
        && account.cooldownUntil <= now).reduce((sum, account) => sum + this.accountCapacity(account), 0)),
      ...(this.elastic ? { elasticScheduling: { enabled: true, maxPerAccount: this.elastic.config.maxPerAccount,
        maxGlobal: this.elastic.config.maxGlobal, directWaiters: this.slotWaiters } } : {}),
      availableAccounts: accounts.filter((account) => account.status === 'available').length,
      busyAccounts: accounts.filter((account) => account.status === 'busy').length,
      coolingDownAccounts: accounts.filter((account) => account.status === 'cooling_down').length,
      unavailableAccounts: accounts.filter((account) => account.status === 'unavailable').length,
      cooldownMs: this.cooldownMs,
      maxConsecutiveErrors: this.maxConsecutiveErrors,
      healthCheckTimeoutMs: this.healthCheckTimeoutMs,
    };
    if (options.includeDetails) {
      summary.accounts = accounts;
    }
    return summary;
  }

  getAuthStatus() {
    return this.stats({ includeDetails: true });
  }

  exportRuntimeState() {
    return this.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      activeRequests: account.activeRequests,
      maxConcurrent: account.maxConcurrent,
      cooldownUntil: account.cooldownUntil,
      consecutiveErrors: account.consecutiveErrors,
      disabled: account.disabled,
      disabledReason: account.disabledReason,
      lastError: account.lastError,
      lastUsedAt: account.lastUsedAt,
      totalRequests: account.totalRequests,
      maintenanceOperation: account.maintenanceOperation || null,
    }));
  }

  _requireAccount(accountIdOrName) {
    const account = this.accounts.find(
      (item) => item.id === accountIdOrName || item.name === accountIdOrName,
    );
    if (!account) {
      const error = new Error('IMA Web Agent account not found');
      error.statusCode = 404;
      throw error;
    }
    return account;
  }

  _publicAccountState(account, options = {}) {
    const now = options.now || this.now();
    const coolingDown = !account.disabled && account.cooldownUntil > now;
    const status = account.disabled || account.maintenanceOperation
      ? 'unavailable'
      : account.activeRequests > 0
        ? 'busy'
        : coolingDown
          ? 'cooling_down'
          : 'available';
    const item = {
      id: account.id,
      name: account.name,
      status,
      disabled: account.disabled,
      disabledReason: account.disabledReason || '',
      activeRequests: account.activeRequests,
      maxConcurrent: account.maxConcurrent,
      ...(this.elastic ? { elastic: this.elastic.snapshot(account, accountDescriptor(account, {}, this.defaultElasticMode)) } : {}),
      availableSlots: !account.disabled && !account.maintenanceOperation && !coolingDown && (!this.elastic || this.elastic.canStart(account))
        ? Math.max(0, this.accountCapacity(account) - account.activeRequests) : 0,
      cooldownSecondsRemaining: coolingDown
        ? Math.max(0, Math.ceil((account.cooldownUntil - now) / 1000))
        : 0,
      consecutiveErrors: account.consecutiveErrors,
      totalRequests: account.totalRequests,
      maintenanceOperation: account.maintenanceOperation || null,
    };

    if (options.includeDetails) {
      item.lastError = account.lastError || null;
      item.lastUsedAt = account.lastUsedAt ? new Date(account.lastUsedAt).toISOString() : null;
      item.auth = account.client.getAuthStatus?.();
    }
    return item;
  }

  _notifyState(account) {
    if (typeof this.onAccountStateChange === 'function') {
      const result = this.onAccountStateChange({
        id: account.id,
        name: account.name,
        activeRequests: account.activeRequests,
        cooldownUntil: account.cooldownUntil,
        consecutiveErrors: account.consecutiveErrors,
        disabled: account.disabled,
        disabledReason: account.disabledReason,
        lastError: account.lastError,
        lastUsedAt: account.lastUsedAt,
        totalRequests: account.totalRequests,
      });
      // Reservations/releases are synchronous. Observe their async failures too.
      if (result && typeof result.catch === 'function') result.catch(() => {
        try { this._notifyAvailability(); } catch { this.availabilityObserverErrors++; }
      });
      return result;
    }
  }

  _notifyCredentials(account, generation = account.client.credentialGeneration) {
    if (!this.accounts.includes(account) || account.maintenanceOperation === 'qualification'
        || account.client.credentialWritesSuspended || generation !== account.client.credentialGeneration) return;
    if (typeof this.onAccountCredentialsChange === 'function') {
      const snapshot = account.client.getConfigSnapshot?.() || {};
      if (!this.managedPersistence) return this.onAccountCredentialsChange(account.id, snapshot);
      const key = createHash('sha256').update(JSON.stringify([generation, snapshot])).digest('hex');
      if (account.persistedCredentialKey === key) return;
      if (account.credentialCommit?.key === key) return account.credentialCommit.promise;
      const promise = Promise.resolve().then(() => {
        if (generation !== account.client.credentialGeneration || account.client.credentialWritesSuspended) throw new Error('credential_generation_stale');
        return this.onAccountCredentialsChange(account.id, snapshot);
      }).then(() => { account.persistedCredentialKey = key; }).finally(() => {
        if (account.credentialCommit?.key === key) account.credentialCommit = null;
      });
      account.credentialCommit = { key, promise }; return promise;
    }
  }
}

function accountId(account, index = 0) {
  return String(account.id || account.accountId || account.name || `account-${index + 1}`);
}

function normalizeAccountMaxConcurrent(value) {
  if (value === undefined) return 1;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError('Account maxConcurrent must be a positive integer');
  return number;
}

function isCooldownError(error) {
  const message = safeErrorMessage(error);
  return /提问太快|too fast|rate limit|429|限流|频繁/i.test(message);
}

function isAuthError(error) {
  const message = safeErrorMessage(error);
  return /登录失败|登录过期|未登录|鉴权|unauthorized|forbidden|401|403/i.test(message);
}

function safeErrorMessage(error) {
  return String(error?.message || error || '服务暂时不可用').slice(0, 240);
}

async function runWithBoundedSignal(run, timeoutMs) {
  const controller = new AbortController();
  const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_ACCOUNT_HEALTH_CHECK_TIMEOUT_MS);
  let timedOut = false;
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      const error = new Error('IMA session health check timed out');
      error.code = 'health_check_timeout';
      reject(error);
    }, boundedTimeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve().then(() => run(controller.signal)), timeoutPromise]);
  } catch (error) {
    if (timedOut && error?.code !== 'health_check_timeout') {
      const timeoutError = new Error('IMA session health check timed out');
      timeoutError.code = 'health_check_timeout';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  DEFAULT_ACCOUNT_COOLDOWN_MS,
  DEFAULT_ACCOUNT_HEALTH_CHECK_TIMEOUT_MS,
  DEFAULT_ACCOUNT_MAX_CONSECUTIVE_ERRORS,
  IMAWebAgentPool,
  NoAvailableWebAgentAccountError,
  isAuthError,
  isCooldownError,
};
