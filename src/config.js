const DEFAULT_MIMO_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
const DEFAULT_MIMO_MODEL = 'mimo-v2.5';
const DEFAULT_WEB_AGENT_MODEL_ID = 'official_3';
const DEFAULT_WEB_AGENT_MODEL_TYPE = 3;
const DEFAULT_QA_PROVIDER = 'openapi-mimo';
const DEFAULT_PORT = 3000;
const DEFAULT_WEB_AGENT_REFRESH_SKEW_MS = 10 * 60 * 1000;
const DEFAULT_WEB_AGENT_REFRESH_INTERVAL_MS = 60 * 1000;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readEnv(env, name) {
  return String(env[name] || '').trim();
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function parsePort(rawPort) {
  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseJsonEnv(rawValue, name) {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    throw new ConfigError(`${name} must be valid JSON`);
  }
}

function parseProvider(rawProvider) {
  const provider = rawProvider || DEFAULT_QA_PROVIDER;
  if (!['openapi-mimo', 'ima-web-agent'].includes(provider)) {
    throw new ConfigError('IMA_QA_PROVIDER must be openapi-mimo or ima-web-agent');
  }
  return provider;
}

function parseOptionalInteger(rawValue, name) {
  if (!rawValue) {
    return null;
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${name} must be a number`);
  }
  return Math.trunc(value);
}

function parseAllowedOrigins(rawValue) {
  return String(rawValue || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getConfig(env = process.env) {
  const qaProvider = parseProvider(readEnv(env, 'IMA_QA_PROVIDER'));
  const requiredNames =
    qaProvider === 'ima-web-agent'
      ? ['IMA_WEB_KNOWLEDGE_BASE_ID', 'IMA_WEB_AGENT_HEADERS_JSON']
      : [
          'IMA_OPENAPI_CLIENTID',
          'IMA_OPENAPI_APIKEY',
          'IMA_SHARED_KNOWLEDGE_BASE_ID',
          'MIMO_API_KEY',
        ];

  const missing = requiredNames.filter((name) => !readEnv(env, name));
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const mimoBaseUrl = readEnv(env, 'MIMO_BASE_URL') || DEFAULT_MIMO_BASE_URL;

  return {
    qaProvider,
    port: parsePort(readEnv(env, 'PORT')),
    limits: {
      maxQuestionLength: 2000,
      maxHistoryTurns: 6,
      maxHistoryContentLength: 1000,
      maxSources: 6,
      maxSnippetLength: 900,
      maxSourceContentLength: 1800,
    },
    security: {
      apiToken: readEnv(env, 'IMA_QA_API_TOKEN'),
      allowedOrigins: parseAllowedOrigins(readEnv(env, 'ALLOWED_ORIGINS')),
    },
    ima: {
      clientId: readEnv(env, 'IMA_OPENAPI_CLIENTID'),
      apiKey: readEnv(env, 'IMA_OPENAPI_APIKEY'),
      sharedKnowledgeBaseId: readEnv(env, 'IMA_SHARED_KNOWLEDGE_BASE_ID'),
    },
    mimo: {
      baseUrl: trimTrailingSlash(mimoBaseUrl),
      apiKey: readEnv(env, 'MIMO_API_KEY'),
      model: readEnv(env, 'MIMO_MODEL') || DEFAULT_MIMO_MODEL,
    },
    webAgent: {
      knowledgeBaseId: readEnv(env, 'IMA_WEB_KNOWLEDGE_BASE_ID'),
      headers: parseJsonEnv(readEnv(env, 'IMA_WEB_AGENT_HEADERS_JSON'), 'IMA_WEB_AGENT_HEADERS_JSON'),
      modelId: readEnv(env, 'IMA_WEB_AGENT_MODEL_ID') || DEFAULT_WEB_AGENT_MODEL_ID,
      modelType: Number(readEnv(env, 'IMA_WEB_AGENT_MODEL_TYPE')) || DEFAULT_WEB_AGENT_MODEL_TYPE,
      runtimeEnvPath: readEnv(env, 'IMA_WEB_AGENT_RUNTIME_ENV_PATH'),
      tokenExpiresAt: parseOptionalInteger(
        readEnv(env, 'IMA_WEB_AGENT_TOKEN_EXPIRES_AT'),
        'IMA_WEB_AGENT_TOKEN_EXPIRES_AT',
      ),
      refreshTokenExpiresAt: parseOptionalInteger(
        readEnv(env, 'IMA_WEB_AGENT_REFRESH_TOKEN_EXPIRES_AT'),
        'IMA_WEB_AGENT_REFRESH_TOKEN_EXPIRES_AT',
      ),
      refreshSkewMs:
        parseOptionalInteger(readEnv(env, 'IMA_WEB_AGENT_REFRESH_SKEW_MS'), 'IMA_WEB_AGENT_REFRESH_SKEW_MS') ||
        DEFAULT_WEB_AGENT_REFRESH_SKEW_MS,
      refreshIntervalMs:
        parseOptionalInteger(
          readEnv(env, 'IMA_WEB_AGENT_REFRESH_INTERVAL_MS'),
          'IMA_WEB_AGENT_REFRESH_INTERVAL_MS',
        ) || DEFAULT_WEB_AGENT_REFRESH_INTERVAL_MS,
    },
  };
}

module.exports = {
  ConfigError,
  DEFAULT_MIMO_BASE_URL,
  DEFAULT_MIMO_MODEL,
  DEFAULT_QA_PROVIDER,
  DEFAULT_WEB_AGENT_REFRESH_INTERVAL_MS,
  DEFAULT_WEB_AGENT_REFRESH_SKEW_MS,
  DEFAULT_WEB_AGENT_MODEL_ID,
  DEFAULT_WEB_AGENT_MODEL_TYPE,
  parseAllowedOrigins,
  getConfig,
};
