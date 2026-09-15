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
    this.now = options.now || Date.now;
    this.waiters = new Set();
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
    const existingById = new Map(this.accounts.map((account) => [account.id, account]));
    const next = [];
    const added = [];
    const seen = new Set();

    accounts.forEach((config, index) => {
      const id = accountId(config, index);
      const existing = existingById.get(id);
      if (existing) {
        existing.name = config.name || existing.name || id;
        existing.webQualification = config.webQualification || null;
        existing.principalFingerprint = config.principalFingerprint;
        existing.knowledgeBaseId = config.knowledgeBaseId;
        existing.client.applyConfig?.({ ...config, id, name: existing.name });
        existing.disabled = Boolean(config.disabled);
        existing.disabledReason = config.disabledReason || '';
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
      next.push(account);
      added.push(account);
      seen.add(id);
      this._notifyState(account);
    });

    for (const account of this.accounts) {
      if (!seen.has(account.id) && account.activeRequests > 0) {
        account.disabled = true;
        account.disabledReason = 'removed_while_active';
        next.push(account);
        this._notifyState(account);
      }
    }

    this.accounts = next;
    if (this.autoRefreshStarted) {
      for (const account of added) {
        account.client.startAutoRefresh?.();
      }
    }
    this._notifyAvailability();
  }

  async ensureFreshAuth() {
    const results = await Promise.allSettled(
      this.accounts.map(async (account) => {
        if (typeof account.client.ensureFreshAuth !== 'function') {
          return false;
        }
        const refreshed = await account.client.ensureFreshAuth();
        if (typeof account.client.persistRuntimeEnv === 'function') {
          account.client.persistRuntimeEnv();
        }
        if (refreshed) {
          this._notifyCredentials(account);
        }
        return refreshed;
      }),
    );
    return results.some((result) => result.status === 'fulfilled' && result.value);
  }

  startAutoRefresh() {
    this.autoRefreshStarted = true;
    for (const account of this.accounts) {
      account.client.startAutoRefresh?.();
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
    let preferredAccountId = String(options.accountId || '').trim();
    if (options.mode === 'knowledge_agent' && this.webReadiness) {
      const eligible = this.accounts.filter(account => this.webReadiness(account));
      if (preferredAccountId && !eligible.some(account => account.id === preferredAccountId)) throw new NoAvailableWebAgentAccountError('会话账号需要重新验证');
      preferredAccountId ||= eligible.find(account => !account.activeRequests)?.id || eligible[0]?.id;
      if (!preferredAccountId) throw new NoAvailableWebAgentAccountError('暂无通过问答验证的账号');
    }
    const account = preferredAccountId
      ? await this._waitForPreferredAccount(preferredAccountId, options.signal)
      : await this._waitForAnyAccount(options.signal);
    let sessionId = '';
    yield { type: 'route', accountId: account.id };
    const upstreamOnSession = options.onSession;
    const clientOptions = {
      ...options,
      sessionId: options.sessionId || '',
      onSession(nextSessionId) {
        sessionId = nextSessionId;
        upstreamOnSession?.(nextSessionId);
      },
    };
    delete clientOptions.accountId;
    try {
      if (options.mode === 'knowledge_agent' && this.webReadiness && !this.webReadiness(account)) {
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
      this._markSuccess(account);
    } catch (error) {
      if (!options.signal?.aborted) {
        this._markFailure(account, error);
      }
      throw error;
    } finally {
      account.activeRequests = Math.max(0, account.activeRequests - 1);
      this._notifyState(account);
      this._notifyAvailability();
    }
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
        this._notifyCredentials(account);
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
    return this._publicAccountState(account, { includeDetails: true });
  }

  async _runMaintenanceOperation(account, operation, fn) {
    if (account.maintenanceOperation) {
      throw createAccountHealthError('account_operation_in_progress');
    }
    account.maintenanceOperation = operation;
    this._notifyState(account);
    try {
      return await fn();
    } finally {
      account.maintenanceOperation = '';
      this._notifyState(account);
    }
  }

  _leaseAccount() {
    const account = this._findAvailableAccount();
    return account ? this._reserveAccount(account) : null;
  }

  _findAvailableAccount() {
    const now = this.now();
    return this.accounts
      .filter((account) => !account.disabled)
      .filter((account) => !account.maintenanceOperation)
      .filter((account) => account.activeRequests === 0)
      .filter((account) => account.cooldownUntil <= now)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0] || null;
  }

  _reserveAccount(account) {
    const now = this.now();
    account.activeRequests = 1;
    account.lastUsedAt = now;
    account.totalRequests += 1;
    this._notifyState(account);
    return account;
  }

  _hasPotentialAvailability() {
    const now = this.now();
    return this.accounts.some(
      (account) => !account.disabled && (account.activeRequests > 0 || account.cooldownUntil <= now),
    );
  }

  _waitForAnyAccount(signal) {
    const direct = this._leaseAccount();
    if (direct) {
      return direct;
    }
    if (!this._hasPotentialAvailability()) {
      throw new NoAvailableWebAgentAccountError();
    }

    return new Promise((resolve, reject) => {
      let waiter;
      const onAbort = () => waiter.reject(new Error('请求已取消'));
      waiter = {
        kind: 'any',
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
    const account = this.accounts.find((candidate) => candidate.id === accountId || candidate.name === accountId);
    if (!account || account.disabled) {
      throw new NoAvailableWebAgentAccountError('会话绑定的 IMA 账号已不可用，请新建会话后继续');
    }
    if (account.cooldownUntil > this.now()) {
      throw new NoAvailableWebAgentAccountError('会话绑定的 IMA 账号正在冷却，请稍后重试');
    }

    const available = () => {
      const candidateNow = this.now();
      return !account.disabled && !account.maintenanceOperation && account.activeRequests === 0 && account.cooldownUntil <= candidateNow;
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
      if (waiter.kind === 'any') {
        const account = this._leaseAccount();
        if (account) {
          waiter.resolve(account);
        } else if (!this._hasPotentialAvailability()) {
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
      if (!waiter.account.maintenanceOperation && waiter.account.activeRequests === 0 && waiter.account.cooldownUntil <= this.now()) {
        waiter.resolve(this._reserveAccount(waiter.account));
      }
    }
  }

  _notifyAvailability() {
    this._drainWaiters();
  }

  _markSuccess(account) {
    account.consecutiveErrors = 0;
    account.lastError = '';
    account.cooldownUntil = 0;
    this._notifyState(account);
  }

  _markFailure(account, error) {
    account.consecutiveErrors += 1;
    account.lastError = safeErrorMessage(error);

    if (isAuthError(error)) {
      account.disabled = true;
      account.disabledReason = 'auth_failed';
      this._notifyState(account);
      return;
    }

    if (isCooldownError(error) || account.consecutiveErrors >= this.maxConsecutiveErrors) {
      account.cooldownUntil = this.now() + this.cooldownMs;
    }
    this._notifyState(account);
  }

  stats(options = {}) {
    const now = this.now();
    const accounts = this.accounts.map((account) => this._publicAccountState(account, {
      includeDetails: options.includeDetails,
      now,
    }));

    const summary = {
      totalAccounts: accounts.length,
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
    const status = account.disabled
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
      this.onAccountStateChange({
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
    }
  }

  _notifyCredentials(account) {
    if (typeof this.onAccountCredentialsChange === 'function') {
      this.onAccountCredentialsChange(account.id, account.client.getConfigSnapshot?.() || {});
    }
  }
}

function accountId(account, index = 0) {
  return String(account.id || account.accountId || account.name || `account-${index + 1}`);
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
