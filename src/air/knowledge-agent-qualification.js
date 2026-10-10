'use strict';

const { createHash } = require('node:crypto');
const { knowledgeScopeDigest } = require('./classic-knowledge-contract-proof');

// Strict import/dormant renewal policy. Runtime expiry is deferred by the
// September 6 release decision; importing old evidence never renews it.
const QUALIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const QUALIFICATION_WARNING_MS = 60 * 60 * 1000;
const QUALIFICATION_ALERTS_ENABLED = false;
const digest = (value) => /^[a-f0-9]{64}$/u.test(String(value || ''));
const validPrincipalFingerprint = (value) => typeof value === 'string'
  && (/^[A-Za-z0-9_-]{43}$/u.test(value) || digest(value));

function normalizeKnowledgeAgentQualification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { capabilityDigest, knowledgeScopeRef, principalFingerprint, verifiedAt } = value;
  const time = Date.parse(verifiedAt);
  if (![capabilityDigest, knowledgeScopeRef].every(digest) || !validPrincipalFingerprint(principalFingerprint)
      || typeof verifiedAt !== 'string' || !Number.isFinite(time)
      || new Date(time).toISOString() !== verifiedAt
      || value.unknownSourceCount !== 0) return null;
  if (value.level === 'basic') {
    if (value.requests !== 1 || value.terminalCount !== 1 || value.passedModes !== 1
        || !Number.isSafeInteger(value.knowledgeSourceCount)
        || value.knowledgeSourceCount < 1) return null;
    return { level: 'basic', capabilityDigest, knowledgeScopeRef, principalFingerprint,
      verifiedAt, requests: 1, terminalCount: 1, passedModes: 1,
      knowledgeSourceCount: value.knowledgeSourceCount, unknownSourceCount: 0 };
  }
  if (value.requests !== 6 || value.terminalCount !== 6 || value.passedModes !== 6) return null;
  return { capabilityDigest, knowledgeScopeRef, principalFingerprint, verifiedAt,
    requests: 6, terminalCount: 6, passedModes: 6, unknownSourceCount: 0 };
}

function qualificationState(value, account, capabilityDigest, now = Date.now()) {
  const proof = normalizeKnowledgeAgentQualification(value);
  if (!proof || !Number.isFinite(now) || Date.parse(proof.verifiedAt) > now) return 'invalid';
  if (!account?.knowledgeBaseId || !validPrincipalFingerprint(account.principalFingerprint)
      || proof.capabilityDigest !== capabilityDigest
      || proof.principalFingerprint !== account.principalFingerprint
      || proof.knowledgeScopeRef !== knowledgeScopeDigest(account.knowledgeBaseId)) return 'binding_changed';
  const remaining = Date.parse(proof.verifiedAt) + QUALIFICATION_TTL_MS - now;
  if (remaining <= 0) return 'expired';
  return remaining <= QUALIFICATION_WARNING_MS ? 'expiring' : 'qualified';
}

function qualificationAccountSetDigest(accounts) {
  const rows = accounts.map((a) => [String(a.id), a.principalFingerprint || '',
    a.knowledgeBaseId ? knowledgeScopeDigest(a.knowledgeBaseId) : '', a.disabled === true]);
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function runtimeQualificationState(value, account, capabilityDigest, now = Date.now()) {
  const state = qualificationState(value, account, capabilityDigest, now);
  // Only evidence age is deferred. Invalid/future evidence and changed binding
  // remain ineligible; original timestamps and strict import checks are intact.
  return state === 'expired' || state === 'expiring' ? 'qualified' : state;
}

module.exports = { QUALIFICATION_TTL_MS, QUALIFICATION_WARNING_MS,
  QUALIFICATION_ALERTS_ENABLED, runtimeQualificationState,
  normalizeKnowledgeAgentQualification, qualificationState, qualificationAccountSetDigest, validPrincipalFingerprint };
