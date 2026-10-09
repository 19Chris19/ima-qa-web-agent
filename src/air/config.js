'use strict';

const path = require('node:path');
const { RecentContextConsumer } = require('../bot-recent-context');
const { normalizeAnswerProfile } = require('../ima-answer-profile');

function getAirConfig(env = {}, repositoryRoot = path.resolve(__dirname, '../..')) {
  const read = key => String(env[key] || '').trim();
  const enabled = /^(1|true|yes)$/iu.test(read('IMA_QA_AIR_BOT_EXTENSIONS'));
  if (!enabled) return { enabled: false };
  const bool = key => /^(1|true|yes)$/iu.test(read(key));
  const integer = (key, fallback, min, max) => {
    const value = read(key) ? Number(read(key)) : fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${key}_invalid`);
    return value;
  };
  const external = key => {
    const value = read(key);
    if (!value) return '';
    const relative = path.relative(repositoryRoot, path.resolve(value));
    if (!path.isAbsolute(value) || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)
        || relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new TypeError(`${key}_must_be_external_absolute_path`);
    }
    return path.resolve(value);
  };
  const recentContext = { enabled: Boolean(read('IMA_QA_RECENT_CONTEXT_URL')),
    baseUrl: read('IMA_QA_RECENT_CONTEXT_URL'), token: read('IMA_QA_RECENT_CONTEXT_TOKEN'),
    timeoutMs: integer('IMA_QA_RECENT_CONTEXT_TIMEOUT_MS', 3000, 500, 10000) };
  if (recentContext.enabled !== Boolean(recentContext.token)
      || (recentContext.token && recentContext.token === read('IMA_QA_INTERNAL_SERVICE_TOKEN'))) {
    throw new TypeError('recent_context_config_invalid');
  }
  if (recentContext.enabled) new RecentContextConsumer(recentContext);
  const observability = { enabled: bool('WECHAT_QA_OBSERVABILITY_ENABLED'),
    socketPath: external('WECHAT_QA_OBSERVABILITY_SOCKET_PATH'),
    maxQueue: integer('WECHAT_QA_OBSERVABILITY_MAX_QUEUE', 1024, 1, 65536) };
  if (observability.enabled && !observability.socketPath) throw new TypeError('observation_socket_required');
  const diagnosticsEnabled = bool('IMA_UPSTREAM_PROTOCOL_DIAGNOSTICS_ENABLED');
  const diagnosticPath = external('IMA_UPSTREAM_PROTOCOL_DIAGNOSTICS_PATH');
  const instanceId = read('IMA_UPSTREAM_PROTOCOL_DIAGNOSTICS_INSTANCE_ID') || `port-${read('PORT') || '3117'}`;
  if (diagnosticsEnabled && (!diagnosticPath || !/^[A-Za-z0-9_-]{1,64}$/u.test(instanceId))) {
    throw new TypeError('protocol_diagnostics_config_invalid');
  }
  const extension = path.extname(diagnosticPath);
  const protocolDiagnostics = { enabled: diagnosticsEnabled, instanceId,
    filePath: diagnosticsEnabled ? `${diagnosticPath.slice(0, extension ? -extension.length : undefined)}.${instanceId}${extension}` : '',
    maxBytes: integer('IMA_UPSTREAM_PROTOCOL_DIAGNOSTICS_MAX_BYTES', 262144, 1024, 16 * 1024 * 1024),
    maxFiles: integer('IMA_UPSTREAM_PROTOCOL_DIAGNOSTICS_MAX_FILES', 3, 1, 10) };
  const capabilityDigest = read('IMA_WEB_AGENT_PROFILE_CAPABILITY_DIGEST');
  if (capabilityDigest && !/^[0-9a-f]{64}$/u.test(capabilityDigest)) throw new TypeError('profile_digest_invalid');
  return { enabled, recentContext, observability, protocolDiagnostics,
    answerProfile: normalizeAnswerProfile(read('IMA_WEB_AGENT_ANSWER_PROFILE') || 'classic_knowledge'),
    capabilityDigest };
}

module.exports = { getAirConfig };
