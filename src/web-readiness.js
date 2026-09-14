const crypto = require('node:crypto');
const { IMAWebAgentClient } = require('./ima-web-agent-client');
const { knowledgeAgentContractDigest } = require('./ima-knowledge-agent-contract');
const { classifyAccountHealthError } = require('./account-health');
const { conflict } = require('./generation-store');

const DEFAULT_QUESTION = '请根据当前知识库概括主要主题，并引用相关资料';
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const validProof = account => {
  const proof = account.webQualification || account.runtime?.webQualification;
  return Boolean(account.principalFingerprint && account.knowledgeBaseId && proof && proof.contract === knowledgeAgentContractDigest() &&
    proof.principalFingerprint === account.principalFingerprint &&
    proof.scope === hash(account.knowledgeBaseId) && proof.requests === 1 && proof.terminals === 1);
};

class WebReadiness {
  constructor({ directory, pool, mode, timeoutMs = 60000, clientFactory = config => new IMAWebAgentClient(config) }) {
    if (mode && !['classic_knowledge', 'knowledge_agent'].includes(mode)) throw new Error('不支持的网页问答模式');
    this.directory = directory;
    this.pool = pool;
    this.timeoutMs = timeoutMs;
    this.clientFactory = clientFactory;
    this.jobs = new Map();
    const store = directory.load();
    store.settings ||= {};
    if (!store.settings.webMode) {
      store.settings.webMode = mode || (directory.wasExisting ? 'classic_knowledge' : 'knowledge_agent');
      directory._writeStore();
    }
    this.pool.webReadiness = account => !account.disabled && !account.maintenanceOperation &&
      account.cooldownUntil <= this.pool.now() && validProof(account) &&
      !['auth_expired', 'auth_rejected'].includes(this.directory.getAccount(account.id)?.runtime?.lastCheckCode);
    this.sync();
  }

  get mode() { return this.directory.load().settings?.webMode || 'classic_knowledge'; }

  sync() {
    this.pool.syncAccounts(this.directory.getPoolAccounts());
    this.appliedGeneration = this.directory.load().generation;
  }

  setMode(mode) {
    if (!['classic_knowledge', 'knowledge_agent'].includes(mode)) throw Object.assign(new Error('不支持的问答模式'), { statusCode: 400 });
    this.directory.reload();
    this.directory.store.settings ||= {};
    this.directory.store.settings.webMode = mode;
    this.directory._writeStore();
    this.sync();
    return this.snapshot();
  }

  snapshot() {
    const rows = this.directory.listAccounts();
    const states = rows.map(row => {
      const account = this.pool.accounts.find(a => a.id === row.id);
      const job = this.jobs.get(row.id);
      const qualified = account && validProof(account);
      const needsLogin = ['auth_expired', 'auth_rejected'].includes(row.health?.last_check_code);
      const schedulable = Boolean(account && !account.disabled && !account.maintenanceOperation &&
        !needsLogin &&
        account.activeRequests === 0 && account.cooldownUntil <= this.pool.now() &&
        (this.mode === 'classic_knowledge' || qualified));
      return { id: row.id, qualified: Boolean(qualified), schedulable,
        verifiedAt: account?.webQualification?.verifiedAt || null,
        state: job?.running ? 'verifying' : needsLogin ? 'needs_login' : account?.disabled ? 'disabled' : account?.activeRequests ? 'busy' :
          account?.cooldownUntil > this.pool.now() ? 'cooling' : schedulable ? 'ready' : 'pending',
        reason: needsLogin ? row.health.last_check_code : job?.code || (qualified ? 'ok' : 'qualification_required') };
    });
    const capacity = this.pool.accounts.filter(account => !account.disabled && !account.maintenanceOperation &&
      states.find(state => state.id === account.id)?.state !== 'needs_login' &&
      account.cooldownUntil <= this.pool.now() && (this.mode === 'classic_knowledge' || validProof(account))).length;
    return { mode: this.mode, generation: this.appliedGeneration, capacity,
      basicHealthy: rows.filter(a => a.health?.session_valid && a.health?.knowledge_ready && a.health?.web_ready).length,
      schedulable: states.filter(a => a.schedulable).length,
      pending: states.filter(a => !a.qualified).length, accounts: states };
  }

  async verify(id, question = DEFAULT_QUESTION) {
    if (typeof question !== 'string' || !question.trim() || question.length > 2000) throw Object.assign(new Error('请输入不超过 2000 字的知识库测试问题'), { statusCode: 400 });
    const account = this.pool._requireAccount(id);
    if (this.jobs.get(id)?.running || account.activeRequests || account.maintenanceOperation || account.disabled || account.cooldownUntil > this.pool.now()) {
      throw Object.assign(new Error('账号需要处于启用、空闲且非冷却状态'), { statusCode: 409 });
    }
    const controller = new AbortController();
    const job = { running: true, code: 'probe_in_progress', controller };
    this.jobs.set(id, job);
    account.maintenanceOperation = 'qualification';
    let timer;
    try {
      this.directory.reload();
      const config = this.directory.getPoolAccounts().find(a => a.id === id);
      if (!config) throw conflict();
      // Reverification never inherits a previous successful proof.
      this.directory.getAccount(id).runtime.webQualification = null;
      this.directory._writeStore();
      account.webQualification = null;
      const expectedGeneration = this.directory.load().generation;
      const client = this.clientFactory(config);
      let requests = 0, terminals = 0, answerLength = 0, knowledge = false;
      const run = async () => {
        for await (const event of client.streamAsk({ question, signal: controller.signal, mode: 'knowledge_agent', allowAuthRefresh: false,
          onDispatch: () => { requests++; if (requests > 1) throw new Error('probe_duplicate_request'); } })) {
          if (event.type === 'delta') answerLength += String(event.text || '').trim().length;
          if (event.type === 'sources') knowledge ||= event.sources?.length > 0 && (event.sourceKinds || [event.sourceKind]).includes('knowledge');
          if (event.type === 'done') terminals++;
        }
      };
      await Promise.race([run(), new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new Error('probe_timeout')); controller.abort(); }, this.timeoutMs);
        controller.signal.addEventListener('abort', () => reject(new Error('probe_cancelled')), { once: true });
      })]);
      if (controller.signal.aborted) throw new Error('probe_cancelled');
      if (requests !== 1 || terminals !== 1 || !answerLength || !knowledge) throw new Error('probe_evidence_insufficient');
      const proof = { contract: knowledgeAgentContractDigest(), principalFingerprint: config.principalFingerprint,
        scope: hash(config.knowledgeBaseId), verifiedAt: new Date().toISOString(), requests, terminals };
      this.directory.commitWebQualification(id, proof, expectedGeneration);
      try { this.sync(); } catch { job.code = 'pool_sync_failed'; throw new Error('pool_sync_failed'); }
      job.code = 'ok';
    } catch (error) {
      job.code = ['account_store_generation_conflict', 'account_store_locked'].includes(error.code) ? error.code :
        /^probe_|^pool_sync_failed$/.test(error.message) ? error.message : classifyAccountHealthError(error);
      if (job.code === 'account_store_generation_conflict') {
        try { this.directory.reload(); this.sync(); }
        catch { job.code = 'pool_sync_failed'; }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      job.running = false;
      if (job.code !== 'pool_sync_failed') account.maintenanceOperation = '';
      this.pool._notifyAvailability();
    }
    return { success: job.code === 'ok', code: job.code, ...this.snapshot() };
  }

  cancel(id) { this.jobs.get(id)?.controller.abort(); return { success: true }; }
}
module.exports = { WebReadiness, DEFAULT_QUESTION, validProof };
