'use strict';

const crypto = require('node:crypto');
const TRUSTED_IDENTITY = Symbol('providerApplicationIdentity');
const APPLICATION_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const digest = value => crypto.createHash('sha256').update(value).digest();
const invalid = () => new TypeError('invalid_application_mapping');

function normalizeApplicationMappings(value = [], security = {}) {
  if (!Array.isArray(value) || value.length > 64) throw invalid();
  const ids = new Set();
  const credentials = new Set([security.apiToken, security.internalServiceToken].map(token => String(token || '').trim()).filter(Boolean));
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).some(key => !['id', 'apiTokens', 'internalServiceTokens'].includes(key)) ||
        !APPLICATION_ID.test(entry.id) || typeof entry.id !== 'string' || ids.has(entry.id)) throw invalid();
    ids.add(entry.id);
    const result = { id: entry.id };
    for (const field of ['apiTokens', 'internalServiceTokens']) {
      const tokens = entry[field] === undefined ? [] : entry[field];
      if (!Array.isArray(tokens) || tokens.length > 8) throw invalid();
      result[field] = tokens.map(token => {
        if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/u.test(token) || credentials.has(token)) throw invalid();
        credentials.add(token);
        return token;
      });
    }
    if (!result.apiTokens.length && !result.internalServiceTokens.length) throw invalid();
    return result;
  });
}

function createApplicationIdentity(security = {}) {
  const applications = normalizeApplicationMappings(security.applications, security);
  const credentials = { ordinary: [], internal: [] };
  for (const [scope, field, legacyField] of [['ordinary', 'apiTokens', 'apiToken'], ['internal', 'internalServiceTokens', 'internalServiceToken']]) {
    const legacy = String(security[legacyField] || '').trim();
    if (legacy) credentials[scope].push({ tokenHash: digest(legacy), applicationKey: scope, applicationId: null });
    for (const app of applications) {
      for (const token of app[field]) credentials[scope].push({ tokenHash: digest(token), applicationKey: `application:${app.id}`, applicationId: app.id });
    }
  }
  return {
    middleware(scope) {
      if (!Object.hasOwn(credentials, scope)) throw invalid();
      return (req, res, next) => {
        const header = String(req.headers.authorization || '');
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        const tokenHash = digest(token);
        const matched = token && credentials[scope].find(item => crypto.timingSafeEqual(item.tokenHash, tokenHash));
        let identity = matched;
        if (!identity && scope === 'ordinary' && !String(security.apiToken || '').trim() &&
            (!header || !applications.length)) identity = { applicationKey: 'ordinary', applicationId: null };
        if (!identity) return res.status(scope === 'internal' && !credentials.internal.length ? 404 : 401)
          .json({ success: false, error: scope === 'internal' && !credentials.internal.length ? 'route_not_configured' : 'unauthorized' });
        Object.defineProperty(req, TRUSTED_IDENTITY, { value: identity, configurable: true });
        req.applicationKey = identity.applicationKey;
        next();
      };
    },
  };
}

function applicationOwnerKey(req, visitorKey) {
  const id = req[TRUSTED_IDENTITY]?.applicationId;
  // '/' is forbidden in raw browser owner IDs, so the legacy namespace cannot forge this prefix.
  return id ? `application/${id}/${digest(visitorKey).toString('hex')}` : visitorKey;
}

function validApplicationKey(value) {
  return value === 'ordinary' || value === 'internal' ||
    (typeof value === 'string' && value.startsWith('application:') && APPLICATION_ID.test(value.slice(12)));
}

module.exports = { normalizeApplicationMappings, createApplicationIdentity, applicationOwnerKey, validApplicationKey };
