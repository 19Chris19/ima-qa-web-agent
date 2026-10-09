'use strict';

const { AnswerProfileController, answerProfileContractDigest } = require('../ima-answer-profile');
const { knowledgeAgentContractDigest } = require('../ima-knowledge-agent-contract');
const { runtimeQualificationState, qualificationState } = require('./knowledge-agent-qualification');
const { POLICIES } = require('../bot-compat');
const { validProof } = require('../web-readiness');

class AirPolicyCapacity {
  constructor({ directory, pool, profile = 'classic_knowledge', capabilityDigest = '', now = Date.now }) {
    this.directory = directory;
    this.pool = pool;
    this.now = now;
    this.generation = 0;
    this.signature = '';
    this.profileController = new AnswerProfileController({ profile,
      capabilityDigest: capabilityDigest || answerProfileContractDigest(profile),
      ready: profile === 'classic_knowledge' || Boolean(capabilityDigest) });
  }

  profileSnapshot() { return this.profileController.snapshot(); }

  nativeQualified(account) {
    return Boolean(account && (validProof(account) || runtimeQualificationState(account.knowledgeAgentQualification,
      account, knowledgeAgentContractDigest(), this.now()) === 'qualified'));
  }

  snapshot() {
    const value = { profile: this.profileSnapshot(), policyCapacity: this.policyCapacitySnapshot(),
      laneCapacity: this.laneCapacitySnapshot(), pairedCapacity: this.pairedCapacitySnapshot().knowledge_web_parallel };
    const signature = JSON.stringify(value);
    if (signature !== this.signature) { this.signature = signature; this.generation++; }
    return { generation: this.generation, ...value };
  }

  eligible(account, policy) {
    if (!POLICIES.includes(policy) || !account || account.disabled || account.maintenanceOperation
        || Number(account.cooldownUntil || 0) > this.now()) return false;
    if (policy === 'knowledge_agent') return this.nativeQualified(account);
    const lane = account.routingLane || 'flex';
    if (lane !== 'flex' && lane !== (policy === 'group_knowledge' ? 'knowledge' : 'agent')) return false;
    const profile = policy === 'group_knowledge' ? 'classic_knowledge' : 'ima_agent_auto';
    const state = this.profileSnapshot();
    if (profile === 'ima_agent_auto' && (state.answer_profile !== profile || !state.ready)) return false;
    const expected = profile === 'classic_knowledge' ? answerProfileContractDigest(profile) : state.capability_digest;
    const proof = account.retrievalPolicyQualifications?.[policy];
    const allowed = { group_knowledge: ['knowledge'], web: ['web'], mixed: ['mixed'],
      auto: ['knowledge', 'web', 'mixed', 'agent_general'] }[policy];
    return Boolean(proof && proof.capabilityDigest === expected && allowed.includes(proof.answerBasis));
  }

  accounts() {
    const stored = new Map(this.directory.getPoolAccounts().map(row => [row.id, row]));
    return this.pool.accounts.map(row => ({ ...stored.get(row.id), ...row,
      ...Object.fromEntries(['routingLane', 'profileQualifications', 'retrievalPolicyQualifications', 'knowledgeAgentQualification']
        .map(key => [key, stored.get(row.id)?.[key]])) }));
  }

  policyCapacitySnapshot() {
    const accounts = this.accounts();
    return Object.fromEntries(POLICIES.map(policy => [policy, accounts.reduce((sum, account) =>
      sum + (this.eligible(account, policy) ? Number(account.maxConcurrent || 1) : 0), 0)]));
  }

  laneCapacitySnapshot() {
    const accounts = this.accounts();
    return Object.fromEntries(['knowledge', 'agent', 'flex'].map(lane => [lane, accounts.reduce((sum, account) =>
      sum + ((account.routingLane || 'flex') === lane && POLICIES.some(policy => this.eligible(account, policy))
        ? Number(account.maxConcurrent || 1) : 0), 0)]));
  }

  pairedCapacitySnapshot() {
    // Pair legs must use distinct accounts, even with multiple slots per account.
    const accounts = this.accounts();
    const k = accounts.filter(a => this.eligible(a, 'group_knowledge')).length;
    const w = accounts.filter(a => this.eligible(a, 'web')).length;
    const union = accounts.filter(a => this.eligible(a, 'group_knowledge') || this.eligible(a, 'web')).length;
    return { knowledge_web_parallel: Math.min(k, w, Math.floor(union / 2)) };
  }

  qualificationAlertSnapshot() {
    const counts = { capacity: this.policyCapacitySnapshot().knowledge_agent };
    for (const account of this.accounts()) {
      if (account.disabled || !account.knowledgeAgentQualification) continue;
      const state = qualificationState(account.knowledgeAgentQualification, account, knowledgeAgentContractDigest(), this.now());
      counts[state] = (counts[state] || 0) + 1;
    }
    return counts;
  }

  eligibilitySnapshot() {
    const profile = this.profileSnapshot();
    const active = account => {
      const qualified = profile.ready && (profile.answer_profile !== 'ima_agent_auto'
        || (account.profileQualifications?.ima_agent_auto?.capabilityDigest === profile.capability_digest
          && account.profileQualifications.ima_agent_auto.answerBasis === 'mixed'));
      const schedulable = Boolean(qualified && !account.disabled && !account.maintenanceOperation && account.cooldownUntil <= this.now());
      return { qualified: Boolean(qualified), schedulable, available_now: schedulable && account.activeRequests < account.maxConcurrent,
        reason_code: !qualified ? 'profile_qualification_missing' : schedulable ? 'schedulable' : 'account_unavailable',
        proof_state: qualified ? 'qualified' : 'missing', verified_at: account.profileQualifications?.[profile.answer_profile]?.verifiedAt || null };
    };
    const accounts = this.accounts().map(account => ({ id: account.id, name: account.name,
      active_profile: active(account), routing_lane: account.routingLane || 'flex', strategies: Object.fromEntries(POLICIES.map(policy => {
        const eligible = this.eligible(account, policy);
        return [policy, { qualified: eligible, schedulable: eligible,
          available_now: eligible && account.activeRequests < account.maxConcurrent,
          reason_code: eligible ? 'schedulable' : 'policy_unavailable', proof_state: eligible ? 'qualified' : 'not_applicable',
          verified_at: policy === 'knowledge_agent' ? account.knowledgeAgentQualification?.verifiedAt || account.webQualification?.verifiedAt || null
            : account.retrievalPolicyQualifications?.[policy]?.verifiedAt || null }];
      })) }));
    return { schema_version: 'provider.a.account-eligibility.v2', observed_at: new Date(this.now()).toISOString(),
      active_profile: { name: profile.answer_profile, generation: profile.profile_generation,
        ready: profile.ready, reason_code: profile.ready ? 'ready' : 'profile_not_ready' }, summary: { total_accounts: accounts.length,
        active_profile_capacity: accounts.filter(a => a.active_profile.schedulable).length,
        active_profile_available_now: accounts.filter(a => a.active_profile.available_now).length,
        pending_active_profile_qualification: accounts.filter(a => !a.active_profile.qualified).length,
        active_profile_reason_counts: accounts.reduce((counts, a) => {
          counts[a.active_profile.reason_code] = (counts[a.active_profile.reason_code] || 0) + 1; return counts;
        }, {}),
        strategies: Object.fromEntries(POLICIES.map(policy => [policy, { capacity: this.policyCapacitySnapshot()[policy],
          available_now: accounts.filter(a => a.strategies[policy].available_now).length }])) }, accounts };
  }
}

module.exports = { AirPolicyCapacity };
