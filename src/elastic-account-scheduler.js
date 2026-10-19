'use strict';
const { normalizeAccountLimits, matchingLimit } = require('./elastic-validation');

// This controller retains counters only. It never holds questions, credentials,
// streams, or a second work queue, and never issues a probe/retry of its own.
const DEFAULTS = Object.freeze({
  enabled: false, initialConcurrent: 1, maxPerAccount: 20, maxGlobal: 100,
  minStartSpacingMs: 3000, maxStartSpacingMs: 30000,
  backoffMs: 15000, maxBackoffMs: 120000,
  growthIntervalMs: 60000, successesToGrow: 10, maxWaiters: 64, maxWaitMs: 180000,
});

function normalizeElasticScheduling(input = {}) {
  const value = { ...DEFAULTS, ...input };
  value.accountLimits = Object.freeze(normalizeAccountLimits(input.accountLimits, value.maxPerAccount, value.initialConcurrent));
  if (typeof value.enabled !== 'boolean') throw new TypeError('elastic enabled must be boolean');
  const bounds = { initialConcurrent: [1, 20], maxPerAccount: [1, 20], maxGlobal: [1, 100],
    minStartSpacingMs: [1, 60000], maxStartSpacingMs: [1, 120000],
    backoffMs: [1, 300000], maxBackoffMs: [1, 300000],
    growthIntervalMs: [1, 3600000], successesToGrow: [1, 10000], maxWaiters: [1, 4096], maxWaitMs: [1, 3600000] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) {
      throw new TypeError(`Invalid elastic ${key}`);
    }
  }
  if (value.initialConcurrent > value.maxPerAccount || value.minStartSpacingMs > value.maxStartSpacingMs
      || value.backoffMs > value.maxBackoffMs) throw new TypeError('Inconsistent elastic scheduling bounds');
  return Object.freeze(value);
}

class ElasticAccountScheduler {
  constructor(config, now = Date.now) {
    this.config = normalizeElasticScheduling(config);
    this.now = now;
    this.states = new Map();
  }

  sync(accounts) {
    const ids = new Set(accounts.map(account => account.id));
    for (const id of this.states.keys()) if (!ids.has(id)) this.states.delete(id);
    for (const account of accounts) {
      if (!this.states.has(account.id)) this.states.set(account.id, {
        limit: this.initial(account), spacingMs: this.config.minStartSpacingMs,
        nextStartAt: 0, epoch: 0, successes: 0, failureStreak: 0,
        lastChangeAt: this.now(), demand: false, reason: 'initial',
      });
    }
  }

  invalidate(account, reason) { const state = this.state(account); state.epoch++; state.successes = 0; state.demand = false; state.reason = reason; }
  markDemand(account) { this.state(account).demand = true; }
  reset(account) {
    const epoch = this.state(account).epoch + 1;
    this.states.set(account.id, { limit: this.initial(account), spacingMs: this.config.minStartSpacingMs,
      nextStartAt: 0, epoch, successes: 0, failureStreak: 0, lastChangeAt: this.now(), demand: false, reason: 'credentials_changed' });
  }
  state(account) { return this.states.get(account.id); }
  initial(account) {
    return Math.max(1, ...this.config.accountLimits.filter(row => row.accountId === account.id
      && row.principalFingerprint === account.principalFingerprint
      && row.modelId === (account.client?.modelId ?? account.modelId)
      && row.modelType === Number(account.client?.modelType ?? account.modelType)).map(row => row.initialConcurrent));
  }
  ceiling(account, descriptor) { return matchingLimit(account, descriptor || {}, this.config.accountLimits)?.validatedMaxConcurrent || 1; }
  capacity(account, descriptor) { return Math.min(this.state(account).limit, this.ceiling(account, descriptor)); }
  overallCapacity(account) { return this.state(account).limit; }
  canStart(account) { return this.state(account).nextStartAt <= this.now(); }
  reserve(account, descriptor) {
    const state = this.state(account);
    state.nextStartAt = this.now() + state.spacingMs;
    return { epoch: state.epoch, saturated: account.activeRequests >= state.limit, validatedCeiling: this.ceiling(account, descriptor) };
  }

  success(account, ticket) {
    const state = this.state(account);
    // A response started before a congestion signal cannot undo that signal.
    if (!ticket || ticket.epoch !== state.epoch) return false;
    if (ticket.saturated) state.successes++;
    if (state.demand && state.successes >= this.config.successesToGrow
        && this.now() - state.lastChangeAt >= this.config.growthIntervalMs) {
      state.limit = Math.min(this.config.maxPerAccount, Math.max(state.limit, Math.min(ticket.validatedCeiling, state.limit + 1)));
      state.spacingMs = Math.max(this.config.minStartSpacingMs, Math.floor(state.spacingMs / 2));
      state.failureStreak = 0;
      state.successes = 0;
      state.lastChangeAt = this.now();
      state.epoch++;
      state.demand = false;
      state.reason = 'healthy_demand';
    }
    return true;
  }

  congestion(account, kind = 'rate_limited') {
    const state = this.state(account);
    state.limit = Math.max(1, Math.floor(state.limit / 2));
    state.failureStreak = Math.min(16, state.failureStreak + 1);
    state.spacingMs = Math.min(this.config.maxStartSpacingMs, state.spacingMs * 2);
    const delay = Math.min(this.config.maxBackoffMs, this.config.backoffMs * 2 ** (state.failureStreak - 1));
    state.nextStartAt = Math.max(state.nextStartAt, this.now() + delay);
    state.lastChangeAt = this.now();
    state.successes = 0;
    state.demand = false;
    state.epoch++;
    state.reason = kind;
  }

  snapshot(account, descriptor) {
    const state = this.state(account);
    return { effectiveMaxConcurrent: this.capacity(account, descriptor), validatedMaxConcurrent: this.ceiling(account, descriptor), ceiling: this.config.maxPerAccount,
      startSpacingMs: state.spacingMs, nextStartInMs: Math.max(0, state.nextStartAt - this.now()),
      reason: state.reason };
  }
}

module.exports = { DEFAULTS, normalizeElasticScheduling, ElasticAccountScheduler };
