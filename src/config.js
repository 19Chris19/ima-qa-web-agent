const DEFAULT_MIMO_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
const DEFAULT_MIMO_MODEL = 'mimo-v2.5';
const DEFAULT_WEB_AGENT_MODEL_ID = 'official_3';
const DEFAULT_WEB_AGENT_MODEL_TYPE = 3;
const DEFAULT_QA_PROVIDER = 'openapi-mimo';
const DEFAULT_PORT = 3000;
const DEFAULT_WEB_AGENT_REFRESH_SKEW_MS = 10 * 60 * 1000;
const DEFAULT_WEB_AGENT_REFRESH_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_CONCURRENT_ASK = 1;
const DEFAULT_QUEUE_LIMIT = 30;
const DEFAULT_REQUEST_TIMEOUT_MS = 180 * 1000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_RATE_LIMIT_MAX = 20;
const DEFAULT_HEALTH_DETAILS = 'basic';

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

function parseBoolean(rawValue) {
  return ['1', 'true', 'yes', 'on'].includes(String(rawValue || '').trim().toLowerCase());
}

function parseEnum(rawValue, allowedValues, fallback) {
  const value = String(rawValue || '').trim() || fallback;
  if (!allowedValues.includes(value)) {
    throw new ConfigError(`${value} is not a supported value`);
  }
  return value;
}

function parseIntegerWithDefault(rawValue, name, fallback, options = {}) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  const min = Number.isFinite(options.min) ? options.min : 0;
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${name} must be an integer greater than or equal to ${min}`);
  }
  return value;
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
      trustProxy: parseBoolean(readEnv(env, 'TRUST_PROXY')),
      healthDetails: parseEnum(readEnv(env, 'IMA_QA_HEALTH_DETAILS'), ['basic', 'auth', 'full'], DEFAULT_HEALTH_DETAILS),
    },
    concurrency: {
      maxConcurrentAsk: parseIntegerWithDefault(
        readEnv(env, 'IMA_QA_MAX_CONCURRENT_ASK'),
        'IMA_QA_MAX_CONCURRENT_ASK',
        DEFAULT_MAX_CONCURRENT_ASK,
        { min: 1 },
      ),
      queueLimit: parseIntegerWithDefault(
        readEnv(env, 'IMA_QA_QUEUE_LIMIT'),
        'IMA_QA_QUEUE_LIMIT',
        DEFAULT_QUEUE_LIMIT,
        { min: 0 },
      ),
      requestTimeoutMs: parseIntegerWithDefault(
        readEnv(env, 'IMA_QA_REQUEST_TIMEOUT_MS'),
        'IMA_QA_REQUEST_TIMEOUT_MS',
        DEFAULT_REQUEST_TIMEOUT_MS,
        { min: 1 },
      ),
    },
    rateLimit: {
      windowMs: parseIntegerWithDefault(
        readEnv(env, 'IMA_QA_RATE_LIMIT_WINDOW_MS'),
        'IMA_QA_RATE_LIMIT_WINDOW_MS',
        DEFAULT_RATE_LIMIT_WINDOW_MS,
        { min: 0 },
      ),
      max: parseIntegerWithDefault(
        readEnv(env, 'IMA_QA_RATE_LIMIT_MAX'),
        'IMA_QA_RATE_LIMIT_MAX',
        DEFAULT_RATE_LIMIT_MAX,
        { min: 0 },
      ),
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
  DEFAULT_HEALTH_DETAILS,
  DEFAULT_MAX_CONCURRENT_ASK,
  DEFAULT_WEB_AGENT_REFRESH_INTERVAL_MS,
  DEFAULT_WEB_AGENT_REFRESH_SKEW_MS,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WEB_AGENT_MODEL_ID,
  DEFAULT_WEB_AGENT_MODEL_TYPE,
  parseAllowedOrigins,
  parseBoolean,
  getConfig,
};
