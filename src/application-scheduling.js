'use strict';
const { validApplicationKey } = require('./application-identity');
const BASE = Object.freeze({ maxConcurrent: 100, queueLimit: 30, weight: 1, maxWaitMs: 180000 });
const bounds = { maxConcurrent: [0, 100], queueLimit: [0, 4096], weight: [1, 20], maxWaitMs: [1, 3600000] };
const invalid = () => new TypeError('Invalid application scheduling configuration');
function policy(value = {}, base = BASE) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(bounds, key))) throw invalid();
  const result = { ...base, ...value };
  for (const [key, [min, max]] of Object.entries(bounds)) if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max) throw invalid();
  return Object.freeze(result);
}
function normalizeApplicationScheduling(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['enabled', 'default', 'applications'].includes(key))
      || (value.enabled !== undefined && typeof value.enabled !== 'boolean')) throw invalid();
  const defaults = policy(value.default); const applications = value.applications === undefined ? {} : value.applications;
  if (!applications || typeof applications !== 'object' || Array.isArray(applications) || Object.keys(applications).length > 64) throw invalid();
  const rows = Object.entries(applications).map(([key, config]) => {
    if (!validApplicationKey(key)) throw invalid(); return [key, policy(config, defaults)];
  });
  return Object.freeze({ enabled: value.enabled === true, default: defaults, applications: Object.freeze(Object.fromEntries(rows)) });
}
module.exports = { normalizeApplicationScheduling };
