'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { WebAgentAccountDirectory: BaseDirectory } = require('../web-agent-account-directory');
const { normalizeKnowledgeAgentQualification, qualificationState } = require('./knowledge-agent-qualification');
const { knowledgeAgentContractDigest } = require('../ima-knowledge-agent-contract');

const digest = account => crypto.createHash('sha256').update(JSON.stringify(account)).digest('hex');
const conflict = () => Object.assign(new Error('qualification_binding_changed'), { code: 'qualification_binding_changed', statusCode: 409 });

class AirAccountDirectory extends BaseDirectory {
  load() {
    if (this.store) return this.store;
    // Retain legacy top-level lane/profile metadata before the base normalizer.
    const legacy = fs.existsSync(this.storePath) ? JSON.parse(fs.readFileSync(this.storePath, 'utf8')) : null;
    const store = super.load();
    let changed = false;
    for (const account of store.accounts) {
      const old = legacy?.accounts?.find(row => row.id === account.id);
      for (const [key, allowed] of [['routingLane', ['knowledge', 'agent', 'flex']],
        ['answerProfile', ['classic_knowledge', 'ima_agent', 'ima_agent_auto']]]) {
        if (!account.runtime[key] && allowed.includes(old?.[key])) {
          account.runtime[key] = old[key]; changed = true;
        }
      }
    }
    if (changed) this._writeStore();
    return store;
  }

  getPoolAccounts() {
    return super.getPoolAccounts().map(row => {
      const account = this.getAccount(row.id);
      return { ...row, routingLane: account.runtime.routingLane || 'flex',
        answerProfile: account.runtime.answerProfile || undefined,
        profileQualifications: account.runtime.profileQualifications || {},
        retrievalPolicyQualifications: account.runtime.retrievalPolicyQualifications || {},
        knowledgeAgentQualification: normalizeKnowledgeAgentQualification(account.runtime.knowledgeAgentQualification) };
    });
  }

  setRoutingLane(accountId, lane) {
    if (!['knowledge', 'agent', 'flex'].includes(lane)) throw new TypeError('routing_lane_invalid');
    this.reload();
    const account = this._requireAccount(accountId);
    account.runtime.routingLane = lane;
    this._writeStore();
    return lane;
  }

  applyKnowledgeAgentQualification(accountId, proof, expected) {
    const account = this._requireAccount(accountId);
    if (!expected || account.id !== accountId || expected.accountId !== accountId
        || expected.account !== account || expected.events !== account.events
        || expected.disabled !== (account.runtime.disabled === true) || expected.digest !== digest(account)) throw conflict();
    const activate = expected.activateEnrollment === true;
    if (activate && (!expected.disabled || !['pending_enrollment_qualification',
      ...(proof.level === 'basic' ? ['migration_verification_required'] : [])].includes(account.runtime.disabledReason))) throw conflict();
    this.commitQualifications([{ account, proof, activate }]);
    return { policy: 'knowledge_agent', qualified: true };
  }

  recordKnowledgeAgentQualifications(entries) {
    if (!Array.isArray(entries) || !entries.length || new Set(entries.map(row => row.accountId)).size !== entries.length) throw conflict();
    const rows = entries.map(({ accountId, proof }) => ({ account: this._requireAccount(accountId), proof }));
    if (rows.some(row => row.account.runtime.disabled)) throw conflict();
    this.commitQualifications(rows);
    return { policy: 'knowledge_agent', qualified: rows.length };
  }

  commitQualifications(rows) {
    const checked = rows.map(row => {
      const proof = normalizeKnowledgeAgentQualification(row.proof);
      if (!['qualified', 'expiring'].includes(qualificationState(proof, row.account,
        knowledgeAgentContractDigest(), Date.parse(this.now())))) throw conflict();
      return { ...row, proof, previous: row.account.runtime, events: row.account.events };
    });
    for (const { account, proof, activate } of checked) {
      account.runtime = { ...account.runtime, knowledgeAgentQualification: proof,
        lastCheckAt: proof.verifiedAt, lastCheckCode: 'ok',
        sessionValid: true, knowledgeReady: true,
        ...(activate ? { disabled: false, disabledReason: '', enrollmentQualificationRequired: false } : {}) };
      account.events = [...(account.events || []), { type: 'knowledge_agent_qualified',
        at: this.now(), message: 'Account knowledge Agent qualified', meta: { passedModes: proof.passedModes } }].slice(-80);
    }
    try { this._writeStore(); }
    catch (error) {
      for (const row of checked) { row.account.runtime = row.previous; row.account.events = row.events; }
      throw error;
    }
  }
}

module.exports = { AirAccountDirectory };
