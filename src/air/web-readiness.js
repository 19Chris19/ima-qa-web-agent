'use strict';

const { WebReadiness } = require('../web-readiness');

class AirWebReadiness extends WebReadiness {
  constructor(options) {
    super(options);
    this.policies = options.policies;
    this.pool.webReadiness = account => this.nativeEligible(account);
  }

  currentAccount(account) {
    const stored = this.directory.getPoolAccounts().find(row => row.id === account.id);
    return { ...stored, ...account, knowledgeAgentQualification: stored?.knowledgeAgentQualification };
  }

  nativeEligible(account) {
    return !['auth_expired', 'auth_rejected'].includes(this.directory.getAccount(account.id)?.runtime?.lastCheckCode)
      && this.policies.eligible(this.currentAccount(account), 'knowledge_agent');
  }

  snapshot() {
    const base = super.snapshot();
    if (!this.policies) return base;
    const rows = this.pool.accounts;
    const accounts = base.accounts.map(row => {
      const account = rows.find(a => a.id === row.id);
      const qualified = Boolean(account && this.policies.nativeQualified(this.currentAccount(account)));
      const schedulable = this.mode === 'knowledge_agent'
        ? Boolean(account && this.nativeEligible(account) && account.activeRequests < account.maxConcurrent) : row.schedulable;
      const job = this.jobs.get(row.id);
      const needsLogin = row.state === 'needs_login';
      return { ...row, qualified, schedulable,
        availableSlots: schedulable ? Math.max(0, account.maxConcurrent - account.activeRequests) : 0,
        verifiedAt: account?.webQualification?.verifiedAt || this.currentAccount(account || { id: row.id }).knowledgeAgentQualification?.verifiedAt || null,
        state: job?.running ? 'verifying' : needsLogin ? 'needs_login' : account?.disabled
          ? account.disabledReason === 'pending_enrollment_qualification' ? 'pending' : 'disabled' : account?.activeRequests ? 'busy' :
          account?.cooldownUntil > this.pool.now() ? 'cooling' : schedulable ? 'ready' : 'pending',
        reason: needsLogin ? row.reason : job?.code || (qualified ? 'ok' : 'qualification_required') };
    });
    const eligible = rows.filter(account => this.nativeEligible(account));
    const capacity = eligible.reduce((sum, account) => sum + account.maxConcurrent, 0);
    return { ...base, knowledgeAgentCapacity: capacity, accounts,
      pending: accounts.filter(row => !row.qualified).length,
      ...(this.mode === 'knowledge_agent' ? { capacity, eligibleAccounts: eligible.length,
        schedulable: accounts.reduce((sum, row) => sum + row.availableSlots, 0),
        schedulableAccounts: accounts.filter(row => row.schedulable).length } : {}) };
  }
}

module.exports = { AirWebReadiness };
