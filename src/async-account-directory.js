'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { WebAgentAccountDirectory } = require('./web-agent-account-directory');
const { conflict } = require('./generation-store');
const fs = require('node:fs');
const { acquireAccountStoreFence } = require('./account-store-fence');
const errorFor = (code = 'account_store_unavailable', statusCode = 503) => Object.assign(new Error(code), { code, statusCode });
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child); Object.freeze(value);
  }
  return value;
};

class AsyncAccountDirectory extends WebAgentAccountDirectory {
  constructor(options = {}) {
    super(options);
    this.options = { storePath: this.storePath, keyPath: this.keyPath, keyMaterial: this.keyMaterial };
    this.air = options.air === true;
    this.fence = options.fence !== false;
    this.workerFactory = options.workerFactory || ((file, workerOptions) => new Worker(file, workerOptions));
    this.timeoutMs = options.commitTimeoutMs || 20000;
    this.queue = []; this.sequence = 0; this.inflight = null;
    this.persistenceReady = false; this.statisticsReady = true;
    this.runtime = new Map(); this.statistics = new Map(); this.dirtyStats = false;
    this.observedCritical = new Map();
    this.poolSnapshot = []; this.storeDigest = ''; this.metrics = {};
    this.closed = false; this.uncertain = null;
    this.onDiagnostic = options.onDiagnostic || (() => {});
  }
  _setReady(value) {
    if (this.persistenceReady === value) return;
    this.persistenceReady = value;
    try { this.onPersistenceStateChange?.(); this.onDiagnostic({ component: 'account_store', ready: value }); } catch {}
  }
  _setStatisticsReady(value) {
    if (this.statisticsReady === value) return;
    this.statisticsReady = value;
    try { this.onDiagnostic({ component: 'runtime_statistics', ready: value }); } catch {}
  }
  async initialize() {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
    if (this.fence) this.releaseFence = await acquireAccountStoreFence(this.storePath);
    try { this._spawn(); await this._call('init', [], true); this._setReady(true); return this; }
    catch (error) { await this.close().catch(() => {}); throw error; }
  }
  _spawn() {
    this.worker = this.workerFactory(path.join(__dirname, 'account-persistence-worker.js'), { workerData: {
      options: this.options, air: this.air, fence: false, wasExisting: this.wasExisting,
    } });
    this.workerUsable = true;
    const worker = this.worker;
    worker.on('message', message => { if (this.worker === worker) this._receive(message); });
    worker.on('error', () => { if (this.worker === worker) { this.workerUsable = false; this._failed(); } });
    worker.on('exit', () => { if (this.worker === worker) {
      this.workerUsable = false; if (!this.closed && !this.closingWorker) this._failed();
    } });
  }
  load() { if (!this.store) throw errorFor(); return this.store; }
  _writeStore() { throw errorFor('async_account_transaction_required'); }
  listAccounts(options = {}) {
    return super.listAccounts(options).map(row => {
      const stats = this.statistics.get(row.id), activeRequests = this.runtime.get(row.id)?.activeRequests || 0;
      return { ...row, ...(stats ? { totalRequests: stats.totalRequests,
        lastUsedAt: stats.lastUsedAt ? new Date(stats.lastUsedAt).toISOString() : null } : {}), activeRequests,
        status: row.status === 'available' && activeRequests > 0 ? 'busy' : row.status };
    });
  }
  getPoolAccounts() {
    return this.poolSnapshot.map(row => {
      const stats = this.statistics.get(row.id);
      return { ...row, totalRequests: stats?.totalRequests ?? row.totalRequests,
        lastUsedAt: stats?.lastUsedAt ?? row.lastUsedAt,
        activeRequests: this.runtime.get(row.id)?.activeRequests || 0 };
    });
  }
  reload() { return this._call('reload'); }
  initializeWebMode(mode) { return this._call('initializeWebMode', [mode]); }
  setWebMode(mode) { return this._call('setWebMode', [mode]); }
  classifyCapturedIdentity(...args) { return this._call('classifyCapturedIdentity', args); }
  applyKnowledgeAgentQualification(id, proof, expected) {
    const account = this.getAccount(id);
    if (!expected || expected.account !== account || expected.events !== account?.events) return Promise.reject(conflict());
    const { account: ignored, events, ...binding } = expected;
    return this._call('applyKnowledgeAgentQualification', [id, proof, binding]);
  }
  recordRuntimeState(snapshot = {}) {
    const account = this.getAccount(snapshot.id || snapshot.name);
    if (!account) return Promise.resolve(false);
    this.runtime.set(account.id, { activeRequests: Number(snapshot.activeRequests || 0) });
    const previous = this.statistics.get(account.id);
    const stats = { id: account.id, principalFingerprint: account.principalFingerprint || '',
      totalRequests: Number(snapshot.totalRequests || 0), lastUsedAt: Number(snapshot.lastUsedAt || 0) };
    if (!previous || previous.totalRequests !== stats.totalRequests || previous.lastUsedAt !== stats.lastUsedAt) {
      this.statistics.set(account.id, stats); this.dirtyStats = true; this._scheduleStats();
    }
    const critical = { id: account.id };
    const previousCritical = this.observedCritical.get(account.id) || account.runtime;
    for (const key of ['cooldownUntil', 'consecutiveErrors', 'lastError', 'disabled', 'disabledReason']) {
      if (!(key in snapshot) || (['disabled', 'disabledReason'].includes(key) && account.runtime.enrollmentQualificationRequired === true)) continue;
      // Observations may quarantine, but only explicit durable actions may enable.
      if (['disabled', 'disabledReason'].includes(key) && (!snapshot.disabled || account.runtime.disabled)) continue;
      if (previousCritical[key] !== snapshot[key]) critical[key] = snapshot[key];
    }
    if (Object.keys(critical).length === 1) return Promise.resolve(true);
    this.observedCritical.set(account.id, { ...previousCritical, ...critical });
    return this._call('recordRuntimeStateCritical', [critical]);
  }
  _scheduleStats() {
    if (this.statsTimer || this.statsPromise || this.closed || this.closing) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.flushStatistics().catch(() => { this._setStatisticsReady(false); });
    }, 1000);
    this.statsTimer.unref();
  }
  async flushStatistics() {
    if (this.statsPromise) { await this.statsPromise; if (!this.dirtyStats) return; }
    if (!this.dirtyStats) return;
    clearTimeout(this.statsTimer); this.statsTimer = null; this.dirtyStats = false;
    this.statsPromise = this._call('saveStats', [[...this.statistics.values()]]).then(() => {
      this._setStatisticsReady(true);
    }, error => { this.dirtyStats = true; this._setStatisticsReady(false); throw error; });
    const overdue = setTimeout(() => this._setStatisticsReady(false), 1000); overdue.unref();
    try { await this.statsPromise; } finally {
      clearTimeout(overdue); this.statsPromise = null; if (this.dirtyStats) this._scheduleStats();
    }
  }
  _publish(snapshot) {
    if (!snapshot) return;
    if (this.storeDigest !== snapshot.digest) {
      this.store = freeze(snapshot.store); this.storeDigest = snapshot.digest;
      this.poolSnapshot = freeze(snapshot.pool);
    }
    for (const row of snapshot.stats) {
      const local = this.statistics.get(row.id);
      if (!local || local.principalFingerprint !== row.principalFingerprint) this.statistics.set(row.id, row);
    }
    const ids = new Set(this.store.accounts.map(row => row.id));
    for (const id of this.statistics.keys()) if (!ids.has(id)) this.statistics.delete(id);
    this.metrics = snapshot.metrics;
    this.diskDigest = snapshot.diskDigest;
  }
  _call(method, args = [], recovery = false) {
    if (this.closed || (!recovery && !this.persistenceReady)) return Promise.reject(errorFor());
    if (this.queue.length >= 64) return Promise.reject(errorFor('account_store_queue_full', 503));
    return new Promise((resolve, reject) => { this.queue.push({ method, args, resolve, reject, recovery }); this._drain(); });
  }
  _drain() {
    if (this.inflight || !this.queue.length) return;
    const pending = this.queue.shift();
    if (!pending.recovery && !this.persistenceReady) { pending.reject(errorFor()); this._drain(); return; }
    pending.id = ++this.sequence;
    pending.before = this.diskDigest;
    this.inflight = pending; this.worker.ref();
    pending.timer = setTimeout(() => this._failed(), this.timeoutMs);
    this.worker.postMessage({ id: pending.id, method: pending.method, args: pending.args,
      expectedGeneration: this.store?.generation || 0, expectedDigest: this.diskDigest });
  }
  _receive(message) {
    const pending = this.inflight;
    if (!pending || message.id !== pending.id) return;
    if (message.prepared) { pending.receipt = message.prepared; return; }
    clearTimeout(pending.timer); this.inflight = null; this.worker.unref();
    if (message.ok) { this._publish(message.snapshot); pending.resolve(message.result); }
    else {
      const error = errorFor(message.error.code, message.error.statusCode);
      if (['account_store_commit_failed', 'account_store_generation_conflict', 'account_store_locked', 'account_store_invalid'].includes(error.code)) {
        this._setReady(false); this.uncertain = pending.receipt || { before: pending.before, after: pending.before };
      }
      pending.reject(error);
    }
    this._drain();
  }
  _failed() {
    this._setReady(false);
    const pending = this.inflight; this.inflight = null;
    if (!pending && !this.uncertain && this.diskDigest) this.uncertain = { before: this.diskDigest, after: this.diskDigest };
    if (pending) {
      clearTimeout(pending.timer);
      this.uncertain = pending.receipt || { before: pending.before, after: pending.before };
      pending.reject(errorFor('account_store_commit_failed'));
    }
    for (const queued of this.queue.splice(0)) queued.reject(errorFor());
    this.worker?.unref();
  }
  async reconcile() {
    if (!this.uncertain) throw errorFor('commit_outcome_unknown');
    if (!this.workerUsable) { this._spawn(); await this._call('init', [{ readOnly: true }], true); }
    const result = await this._call('reconcile', [this.uncertain], true);
    this.observedCritical.clear(); this.uncertain = null; this._setReady(true); return result;
  }
  async close({ mirrorStatistics = true } = {}) {
    if (this.closed) return;
    this.closing = true;
    clearTimeout(this.statsTimer); this.statsTimer = null;
    try {
      if (this.persistenceReady) {
        await this.flushStatistics();
        if (mirrorStatistics) await this._call('mirrorStats');
        this.closingWorker = true; await this._call('close');
      }
    } finally {
      this.closed = true; this._setReady(false);
      clearTimeout(this.statsTimer);
      await this.worker?.terminate();
      await this.releaseFence?.(); this.releaseFence = null;
    }
  }
}
for (const method of ['beginWebQualification', 'commitWebQualification', 'setMaxConcurrent', 'upsertFromRuntimeEnv',
  'upsertCapturedAccount', 'addCapturedAccount', 'replaceCapturedAccount', 'setDisabled', 'deleteAccount', 'recordEvent',
  'recordAccountHealth', 'updateCredentialsFromClient', 'writeRuntimeEnvFile', 'disableRuntimeEnvExport', 'setRoutingLane',
  'recordKnowledgeAgentQualifications']) {
  AsyncAccountDirectory.prototype[method] = function (...args) { return this._call(method, args); };
}
module.exports = { AsyncAccountDirectory };
