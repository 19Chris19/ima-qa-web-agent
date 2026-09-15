const fs = require('node:fs');
const path = require('node:path');

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
const DEFAULT_WEB_AGENT_ACCOUNT_COOLDOWN_MS = 120 * 1000;
const DEFAULT_WEB_AGENT_ACCOUNT_MAX_CONSECUTIVE_ERRORS = 2;
const DEFAULT_WEB_AGENT_HEALTH_CHECK_TIMEOUT_MS = 15 * 1000;
const DEFAULT_WEB_AGENT_ACCOUNT_POOL_CAPACITY_MODE = 'auto';
const DEFAULT_WEB_AGENT_ENROLLMENT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_WEB_AGENT_ENROLLMENT_SCREENSHOT_INTERVAL_MS = 900;
const DEFAULT_WEB_AGENT_ENROLLMENT_BROWSER_LAUNCH_TIMEOUT_MS = 75 * 1000;
const DEFAULT_WEB_AGENT_ENROLLMENT_BROWSER_MODE = 'visible';
const DEFAULT_WEB_AGENT_ACCOUNT_STORE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'runtime',
  'ima-web-agent-accounts.json',
);
const DEFAULT_WEB_AGENT_ACCOUNT_STORE_KEY_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'runtime',
  'ima-web-agent-accounts.key',
);
const DEFAULT_CONVERSATION_STORE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'runtime',
  'ima-qa-conversations.json',
);
const DEFAULT_CONVERSATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CONVERSATION_MAX_TURNS = 12;
const DEFAULT_CONVERSATION_MAX_COUNT = 5000;
const DEFAULT_ACCOUNT_POOL_EXERCISE_REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ACCOUNT_POOL_EXERCISE_REPORT_MAX_COUNT = 30;
const DEFAULT_ACCOUNT_POOL_EXERCISE_REPORT_STORE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'runtime',
  'ima-qa-account-pool-exercises.json',
);
const DEFAULT_WEB_AGENT_BROWSER_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_IMA_OPENAPI_REQUEST_TIMEOUT_MS = 15 * 1000;
const DEFAULT_IMA_OPENAPI_MAX_RETRIES = 2;
const DEFAULT_IMA_OPENAPI_RETRY_BASE_DELAY_MS = 800;
const DEFAULT_IMA_OPENAPI_MAX_ENRICHED_SOURCES = 6;
const DEFAULT_IMA_OPENAPI_ENRICH_SNIPPET_THRESHOLD = 700;
const DEFAULT_LOCAL_RAG_MAX_SOURCES = 8;
const DEFAULT_LOCAL_RAG_QUERY_LIMIT = 12;
const DEFAULT_LOCAL_RAG_PER_QUERY_CANDIDATES = 80;
const DEFAULT_LOCAL_RAG_MAX_CANDIDATES = 700;
const DEFAULT_LOCAL_RAG_MAX_EVIDENCE_SOURCES = 18;
const DEFAULT_LOCAL_RAG_MAX_PUBLIC_SOURCES = 10;
const DEFAULT_LOCAL_RAG_MIN_RELEVANCE_SCORE = 18;
const DEFAULT_LOCAL_RAG_ADJACENT_CHUNKS = 1;
const DEFAULT_LOCAL_RAG_CHUNK_SIZE = 1800;
const DEFAULT_LOCAL_RAG_CHUNK_OVERLAP_MESSAGES = 4;

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
  if (!['openapi-mimo', 'ima-web-agent', 'local-rag-mimo'].includes(provider)) {
    throw new ConfigError('IMA_QA_PROVIDER must be openapi-mimo, ima-web-agent, or local-rag-mimo');
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
  const values = String(rawValue || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return [...new Set(values.map(normalizeAllowedOrigin))];
}

function normalizeAllowedOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`ALLOWED_ORIGINS contains an invalid origin: ${value}`);
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new ConfigError(`ALLOWED_ORIGINS must contain exact http(s) origins: ${value}`);
  }
  return parsed.origin;
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

function parseWebAgentAccounts(env) {
  const rawAccounts = readEnv(env, 'IMA_WEB_AGENT_ACCOUNTS_JSON');
  const sharedKnowledgeBaseId = getWebAgentSharedKnowledgeBaseId(env);
  const commonModelId = readEnv(env, 'IMA_WEB_AGENT_MODEL_ID') || DEFAULT_WEB_AGENT_MODEL_ID;
  const commonModelType = Number(readEnv(env, 'IMA_WEB_AGENT_MODEL_TYPE')) || DEFAULT_WEB_AGENT_MODEL_TYPE;
  const commonRefreshSkewMs =
    parseOptionalInteger(readEnv(env, 'IMA_WEB_AGENT_REFRESH_SKEW_MS'), 'IMA_WEB_AGENT_REFRESH_SKEW_MS') ||
    DEFAULT_WEB_AGENT_REFRESH_SKEW_MS;
  const commonRefreshIntervalMs =
    parseOptionalInteger(
      readEnv(env, 'IMA_WEB_AGENT_REFRESH_INTERVAL_MS'),
      'IMA_WEB_AGENT_REFRESH_INTERVAL_MS',
    ) || DEFAULT_WEB_AGENT_REFRESH_INTERVAL_MS;

  if (rawAccounts) {
    const parsed = parseJsonEnv(rawAccounts, 'IMA_WEB_AGENT_ACCOUNTS_JSON');
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new ConfigError('IMA_WEB_AGENT_ACCOUNTS_JSON must be a non-empty JSON array');
    }

    const names = new Set();
    const accounts = parsed.map((account, index) => {
      if (!account || typeof account !== 'object' || Array.isArray(account)) {
        throw new ConfigError('Each IMA Web Agent account must be a JSON object');
      }
      const name = String(account.name || '').trim();
      const id = String(account.id || account.accountId || name).trim();
      const knowledgeBaseId = String(account.knowledgeBaseId || account.knowledge_base_id || '').trim();
      const headers = account.headers;
      if (!name) {
        throw new ConfigError('Each IMA Web Agent account requires a name');
      }
      if (names.has(name)) {
        throw new ConfigError(`Duplicate IMA Web Agent account name: ${name}`);
      }
      names.add(name);
      if (!knowledgeBaseId) {
        throw new ConfigError(`IMA Web Agent account ${name} requires knowledgeBaseId`);
      }
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new ConfigError(`IMA Web Agent account ${name} requires headers`);
      }

      return {
        id,
        name,
        knowledgeBaseId,
        headers,
        modelId: String(account.modelId || commonModelId),
        modelType: Number(account.modelType || commonModelType) || DEFAULT_WEB_AGENT_MODEL_TYPE,
        runtimeEnvPath: String(account.runtimeEnvPath || '').trim(),
        tokenExpiresAt: parseOptionalInteger(
          account.tokenExpiresAt,
          `IMA_WEB_AGENT_ACCOUNTS_JSON[${index}].tokenExpiresAt`,
        ),
        refreshTokenExpiresAt: parseOptionalInteger(
          account.refreshTokenExpiresAt,
          `IMA_WEB_AGENT_ACCOUNTS_JSON[${index}].refreshTokenExpiresAt`,
        ),
        refreshSkewMs: Number(account.refreshSkewMs || commonRefreshSkewMs),
        refreshIntervalMs: Number(account.refreshIntervalMs || commonRefreshIntervalMs),
      };
    });
    if (
      sharedKnowledgeBaseId &&
      accounts.some((account) => account.knowledgeBaseId !== sharedKnowledgeBaseId)
    ) {
      throw new ConfigError(
        'IMA_WEB_AGENT_ACCOUNTS_JSON accounts must use IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID',
      );
    }
    return accounts;
  }

  const legacyHeaders = readEnv(env, 'IMA_WEB_AGENT_HEADERS_JSON');
  if (!legacyHeaders) {
    return [];
  }
  if (!sharedKnowledgeBaseId) {
    throw new ConfigError(
      'IMA_WEB_AGENT_HEADERS_JSON requires IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID or IMA_WEB_KNOWLEDGE_BASE_ID',
    );
  }

  return [
    {
      id: readEnv(env, 'IMA_WEB_AGENT_ACCOUNT_ID') || 'default',
      name: 'default',
      knowledgeBaseId: sharedKnowledgeBaseId,
      headers: parseJsonEnv(legacyHeaders, 'IMA_WEB_AGENT_HEADERS_JSON'),
      modelId: commonModelId,
      modelType: commonModelType,
      runtimeEnvPath: readEnv(env, 'IMA_WEB_AGENT_RUNTIME_ENV_PATH'),
      tokenExpiresAt: parseOptionalInteger(
        readEnv(env, 'IMA_WEB_AGENT_TOKEN_EXPIRES_AT'),
        'IMA_WEB_AGENT_TOKEN_EXPIRES_AT',
      ),
      refreshTokenExpiresAt: parseOptionalInteger(
        readEnv(env, 'IMA_WEB_AGENT_REFRESH_TOKEN_EXPIRES_AT'),
        'IMA_WEB_AGENT_REFRESH_TOKEN_EXPIRES_AT',
      ),
      refreshSkewMs: commonRefreshSkewMs,
      refreshIntervalMs: commonRefreshIntervalMs,
    },
  ];
}

function getWebAgentSharedKnowledgeBaseId(env) {
  return (
    readEnv(env, 'IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID') ||
    readEnv(env, 'IMA_WEB_KNOWLEDGE_BASE_ID')
  );
}

function getConfig(env = process.env) {
  const qaProvider = parseProvider(readEnv(env, 'IMA_QA_PROVIDER'));
  const accountStorePath =
    readEnv(env, 'IMA_WEB_AGENT_ACCOUNT_STORE_PATH') || DEFAULT_WEB_AGENT_ACCOUNT_STORE_PATH;
  const hasAccountStore = fs.existsSync(accountStorePath);
  const requiredNames =
    qaProvider === 'ima-web-agent'
      ? []
      : qaProvider === 'local-rag-mimo'
          ? ['MIMO_API_KEY']
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
  const webAgentAccounts = qaProvider === 'ima-web-agent' ? parseWebAgentAccounts(env) : [];
  const webAgentSharedKnowledgeBaseId = getWebAgentSharedKnowledgeBaseId(env);
  const primaryWebAgentAccount = webAgentAccounts[0] || {};
  const accountPoolCapacityMode =
    qaProvider === 'ima-web-agent'
      ? parseEnum(
          readEnv(env, 'IMA_QA_ACCOUNT_POOL_CAPACITY_MODE'),
          ['auto', 'fixed'],
          DEFAULT_WEB_AGENT_ACCOUNT_POOL_CAPACITY_MODE,
        )
      : 'fixed';
  const rawMaxConcurrentAsk = readEnv(env, 'IMA_QA_MAX_CONCURRENT_ASK');
  if (accountPoolCapacityMode === 'fixed' && rawMaxConcurrentAsk.toLowerCase() === 'auto') {
    throw new ConfigError('IMA_QA_MAX_CONCURRENT_ASK must be a positive integer in fixed mode');
  }

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
      internalServiceToken: readEnv(env, 'IMA_QA_INTERNAL_SERVICE_TOKEN'),
      adminToken: readEnv(env, 'IMA_QA_ADMIN_TOKEN'),
      allowedOrigins: parseAllowedOrigins(readEnv(env, 'ALLOWED_ORIGINS')),
      trustProxy: parseBoolean(readEnv(env, 'TRUST_PROXY')),
      healthDetails: parseEnum(readEnv(env, 'IMA_QA_HEALTH_DETAILS'), ['basic', 'auth', 'full'], DEFAULT_HEALTH_DETAILS),
    },
    concurrency: {
      maxConcurrentAsk:
        accountPoolCapacityMode === 'auto'
          ? DEFAULT_MAX_CONCURRENT_ASK
          : parseIntegerWithDefault(
              rawMaxConcurrentAsk,
              'IMA_QA_MAX_CONCURRENT_ASK',
              DEFAULT_MAX_CONCURRENT_ASK,
              { min: 1 },
            ),
      autoScaleWithAccounts: accountPoolCapacityMode === 'auto',
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
    conversations: {
      storePath:
        readEnv(env, 'IMA_QA_CONVERSATION_STORE_PATH') || DEFAULT_CONVERSATION_STORE_PATH,
      ttlMs: parseIntegerWithDefault(
        readEnv(env, 'IMA_QA_CONVERSATION_TTL_MS'),
        'IMA_QA_CONVERSATION_TTL_MS',
        DEFAULT_CONVERSATION_TTL_MS,
        { min: 1 },
      ),
      maxTurns: parseIntegerWithDefault(
        readEnv(env, 'IMA_QA_CONVERSATION_MAX_TURNS'),
        'IMA_QA_CONVERSATION_MAX_TURNS',
        DEFAULT_CONVERSATION_MAX_TURNS,
        { min: 1 },
      ),
      maxCount: parseIntegerWithDefault(
        readEnv(env, 'IMA_QA_CONVERSATION_MAX_COUNT'),
        'IMA_QA_CONVERSATION_MAX_COUNT',
        DEFAULT_CONVERSATION_MAX_COUNT,
        { min: 1 },
      ),
    },
    exercises: {
      reportStorePath:
        readEnv(env, 'IMA_QA_EXERCISE_REPORT_STORE_PATH') || DEFAULT_ACCOUNT_POOL_EXERCISE_REPORT_STORE_PATH,
      reportTtlMs: parseIntegerWithDefault(
        readEnv(env, 'IMA_QA_EXERCISE_REPORT_TTL_MS'),
        'IMA_QA_EXERCISE_REPORT_TTL_MS',
        DEFAULT_ACCOUNT_POOL_EXERCISE_REPORT_TTL_MS,
        { min: 1 },
      ),
      reportMaxCount: parseIntegerWithDefault(
        readEnv(env, 'IMA_QA_EXERCISE_REPORT_MAX_COUNT'),
        'IMA_QA_EXERCISE_REPORT_MAX_COUNT',
        DEFAULT_ACCOUNT_POOL_EXERCISE_REPORT_MAX_COUNT,
        { min: 1 },
      ),
    },
    ima: {
      clientId: readEnv(env, 'IMA_OPENAPI_CLIENTID'),
      apiKey: readEnv(env, 'IMA_OPENAPI_APIKEY'),
      sharedKnowledgeBaseId: readEnv(env, 'IMA_SHARED_KNOWLEDGE_BASE_ID'),
      requestTimeoutMs: parseIntegerWithDefault(
        readEnv(env, 'IMA_OPENAPI_REQUEST_TIMEOUT_MS'),
        'IMA_OPENAPI_REQUEST_TIMEOUT_MS',
        DEFAULT_IMA_OPENAPI_REQUEST_TIMEOUT_MS,
        { min: 1 },
      ),
      maxRetries: parseIntegerWithDefault(
        readEnv(env, 'IMA_OPENAPI_MAX_RETRIES'),
        'IMA_OPENAPI_MAX_RETRIES',
        DEFAULT_IMA_OPENAPI_MAX_RETRIES,
        { min: 0 },
      ),
      retryBaseDelayMs: parseIntegerWithDefault(
        readEnv(env, 'IMA_OPENAPI_RETRY_BASE_DELAY_MS'),
        'IMA_OPENAPI_RETRY_BASE_DELAY_MS',
        DEFAULT_IMA_OPENAPI_RETRY_BASE_DELAY_MS,
        { min: 0 },
      ),
      maxEnrichedSources: parseIntegerWithDefault(
        readEnv(env, 'IMA_OPENAPI_MAX_ENRICHED_SOURCES'),
        'IMA_OPENAPI_MAX_ENRICHED_SOURCES',
        DEFAULT_IMA_OPENAPI_MAX_ENRICHED_SOURCES,
        { min: 0 },
      ),
      enrichSnippetThreshold: parseIntegerWithDefault(
        readEnv(env, 'IMA_OPENAPI_ENRICH_SNIPPET_THRESHOLD'),
        'IMA_OPENAPI_ENRICH_SNIPPET_THRESHOLD',
        DEFAULT_IMA_OPENAPI_ENRICH_SNIPPET_THRESHOLD,
        { min: 0 },
      ),
    },
    mimo: {
      baseUrl: trimTrailingSlash(mimoBaseUrl),
      apiKey: readEnv(env, 'MIMO_API_KEY'),
      model: readEnv(env, 'MIMO_MODEL') || DEFAULT_MIMO_MODEL,
    },
    webAgent: {
      webMode: readEnv(env, 'IMA_WEB_AGENT_WEB_MODE') || undefined,
      ...primaryWebAgentAccount,
      accounts: webAgentAccounts,
      sharedKnowledgeBaseId: webAgentSharedKnowledgeBaseId,
      accountStorePath,
      accountStoreKeyPath:
        readEnv(env, 'IMA_WEB_AGENT_ACCOUNT_STORE_KEY_PATH') ||
        DEFAULT_WEB_AGENT_ACCOUNT_STORE_KEY_PATH,
      browserPath: readEnv(env, 'IMA_WEB_AGENT_BROWSER_PATH') || DEFAULT_WEB_AGENT_BROWSER_PATH,
      enrollmentTimeoutMs: parseIntegerWithDefault(
        readEnv(env, 'IMA_WEB_AGENT_ENROLLMENT_TIMEOUT_MS'),
        'IMA_WEB_AGENT_ENROLLMENT_TIMEOUT_MS',
        DEFAULT_WEB_AGENT_ENROLLMENT_TIMEOUT_MS,
        { min: 30 * 1000 },
      ),
      enrollmentScreenshotIntervalMs: parseIntegerWithDefault(
        readEnv(env, 'IMA_WEB_AGENT_ENROLLMENT_SCREENSHOT_INTERVAL_MS'),
        'IMA_WEB_AGENT_ENROLLMENT_SCREENSHOT_INTERVAL_MS',
        DEFAULT_WEB_AGENT_ENROLLMENT_SCREENSHOT_INTERVAL_MS,
        { min: 250 },
      ),
      enrollmentBrowserLaunchTimeoutMs: parseIntegerWithDefault(
        readEnv(env, 'IMA_WEB_AGENT_ENROLLMENT_BROWSER_LAUNCH_TIMEOUT_MS'),
        'IMA_WEB_AGENT_ENROLLMENT_BROWSER_LAUNCH_TIMEOUT_MS',
        DEFAULT_WEB_AGENT_ENROLLMENT_BROWSER_LAUNCH_TIMEOUT_MS,
        { min: 1000 },
      ),
      enrollmentBrowserMode: parseEnum(
        readEnv(env, 'IMA_WEB_AGENT_ENROLLMENT_BROWSER_MODE'),
        ['background', 'visible'],
        DEFAULT_WEB_AGENT_ENROLLMENT_BROWSER_MODE,
      ),
      accountCooldownMs: parseIntegerWithDefault(
        readEnv(env, 'IMA_WEB_AGENT_ACCOUNT_COOLDOWN_MS'),
        'IMA_WEB_AGENT_ACCOUNT_COOLDOWN_MS',
        DEFAULT_WEB_AGENT_ACCOUNT_COOLDOWN_MS,
        { min: 1 },
      ),
      accountMaxConsecutiveErrors: parseIntegerWithDefault(
        readEnv(env, 'IMA_WEB_AGENT_ACCOUNT_MAX_CONSECUTIVE_ERRORS'),
        'IMA_WEB_AGENT_ACCOUNT_MAX_CONSECUTIVE_ERRORS',
        DEFAULT_WEB_AGENT_ACCOUNT_MAX_CONSECUTIVE_ERRORS,
        { min: 1 },
      ),
      healthCheckTimeoutMs: parseIntegerWithDefault(
        readEnv(env, 'IMA_WEB_AGENT_HEALTH_CHECK_TIMEOUT_MS'),
        'IMA_WEB_AGENT_HEALTH_CHECK_TIMEOUT_MS',
        DEFAULT_WEB_AGENT_HEALTH_CHECK_TIMEOUT_MS,
        { min: 1000 },
      ),
    },
    localRag: {
      corpusZip: readEnv(env, 'LOCAL_RAG_CORPUS_ZIP'),
      corpusDir: readEnv(env, 'LOCAL_RAG_CORPUS_DIR'),
      indexDir: readEnv(env, 'LOCAL_RAG_INDEX_DIR'),
      queryLimit: parseIntegerWithDefault(
        readEnv(env, 'LOCAL_RAG_QUERY_LIMIT'),
        'LOCAL_RAG_QUERY_LIMIT',
        DEFAULT_LOCAL_RAG_QUERY_LIMIT,
        { min: 1 },
      ),
      perQueryCandidates: parseIntegerWithDefault(
        readEnv(env, 'LOCAL_RAG_PER_QUERY_CANDIDATES'),
        'LOCAL_RAG_PER_QUERY_CANDIDATES',
        DEFAULT_LOCAL_RAG_PER_QUERY_CANDIDATES,
        { min: 1 },
      ),
      maxSources: parseIntegerWithDefault(
        readEnv(env, 'LOCAL_RAG_MAX_SOURCES'),
        'LOCAL_RAG_MAX_SOURCES',
        DEFAULT_LOCAL_RAG_MAX_SOURCES,
        { min: 1 },
      ),
      maxCandidates: parseIntegerWithDefault(
        readEnv(env, 'LOCAL_RAG_MAX_CANDIDATES'),
        'LOCAL_RAG_MAX_CANDIDATES',
        DEFAULT_LOCAL_RAG_MAX_CANDIDATES,
        { min: 1 },
      ),
      maxEvidenceSources: parseIntegerWithDefault(
        readEnv(env, 'LOCAL_RAG_MAX_EVIDENCE_SOURCES'),
        'LOCAL_RAG_MAX_EVIDENCE_SOURCES',
        DEFAULT_LOCAL_RAG_MAX_EVIDENCE_SOURCES,
        { min: 1 },
      ),
      maxPublicSources: parseIntegerWithDefault(
        readEnv(env, 'LOCAL_RAG_MAX_PUBLIC_SOURCES'),
        'LOCAL_RAG_MAX_PUBLIC_SOURCES',
        DEFAULT_LOCAL_RAG_MAX_PUBLIC_SOURCES,
        { min: 1 },
      ),
      minRelevanceScore: parseIntegerWithDefault(
        readEnv(env, 'LOCAL_RAG_MIN_RELEVANCE_SCORE'),
        'LOCAL_RAG_MIN_RELEVANCE_SCORE',
        DEFAULT_LOCAL_RAG_MIN_RELEVANCE_SCORE,
        { min: 0 },
      ),
      enableSecondPass: readEnv(env, 'LOCAL_RAG_ENABLE_SECOND_PASS')
        ? parseBoolean(readEnv(env, 'LOCAL_RAG_ENABLE_SECOND_PASS'))
        : true,
      enableCoverage: readEnv(env, 'LOCAL_RAG_ENABLE_COVERAGE')
        ? parseBoolean(readEnv(env, 'LOCAL_RAG_ENABLE_COVERAGE'))
        : true,
      adjacentChunks: parseIntegerWithDefault(
        readEnv(env, 'LOCAL_RAG_ADJACENT_CHUNKS'),
        'LOCAL_RAG_ADJACENT_CHUNKS',
        DEFAULT_LOCAL_RAG_ADJACENT_CHUNKS,
        { min: 0 },
      ),
      chunkSize: parseIntegerWithDefault(
        readEnv(env, 'LOCAL_RAG_CHUNK_SIZE'),
        'LOCAL_RAG_CHUNK_SIZE',
        DEFAULT_LOCAL_RAG_CHUNK_SIZE,
        { min: 200 },
      ),
      chunkOverlapMessages: parseIntegerWithDefault(
        readEnv(env, 'LOCAL_RAG_CHUNK_OVERLAP_MESSAGES'),
        'LOCAL_RAG_CHUNK_OVERLAP_MESSAGES',
        DEFAULT_LOCAL_RAG_CHUNK_OVERLAP_MESSAGES,
        { min: 0 },
      ),
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
  DEFAULT_WEB_AGENT_ACCOUNT_COOLDOWN_MS,
  DEFAULT_WEB_AGENT_ACCOUNT_MAX_CONSECUTIVE_ERRORS,
  DEFAULT_WEB_AGENT_HEALTH_CHECK_TIMEOUT_MS,
  DEFAULT_WEB_AGENT_ACCOUNT_POOL_CAPACITY_MODE,
  DEFAULT_WEB_AGENT_ENROLLMENT_TIMEOUT_MS,
  DEFAULT_WEB_AGENT_ENROLLMENT_SCREENSHOT_INTERVAL_MS,
  DEFAULT_WEB_AGENT_ENROLLMENT_BROWSER_LAUNCH_TIMEOUT_MS,
  DEFAULT_WEB_AGENT_ENROLLMENT_BROWSER_MODE,
  DEFAULT_WEB_AGENT_ACCOUNT_STORE_PATH,
  DEFAULT_CONVERSATION_STORE_PATH,
  DEFAULT_CONVERSATION_TTL_MS,
  DEFAULT_CONVERSATION_MAX_TURNS,
  DEFAULT_CONVERSATION_MAX_COUNT,
  DEFAULT_ACCOUNT_POOL_EXERCISE_REPORT_STORE_PATH,
  DEFAULT_ACCOUNT_POOL_EXERCISE_REPORT_TTL_MS,
  DEFAULT_ACCOUNT_POOL_EXERCISE_REPORT_MAX_COUNT,
  DEFAULT_WEB_AGENT_ACCOUNT_STORE_KEY_PATH,
  DEFAULT_WEB_AGENT_BROWSER_PATH,
  DEFAULT_IMA_OPENAPI_REQUEST_TIMEOUT_MS,
  DEFAULT_IMA_OPENAPI_MAX_RETRIES,
  DEFAULT_IMA_OPENAPI_RETRY_BASE_DELAY_MS,
  DEFAULT_IMA_OPENAPI_MAX_ENRICHED_SOURCES,
  DEFAULT_IMA_OPENAPI_ENRICH_SNIPPET_THRESHOLD,
  DEFAULT_LOCAL_RAG_MAX_SOURCES,
  DEFAULT_LOCAL_RAG_QUERY_LIMIT,
  DEFAULT_LOCAL_RAG_PER_QUERY_CANDIDATES,
  DEFAULT_LOCAL_RAG_MAX_CANDIDATES,
  DEFAULT_LOCAL_RAG_MAX_EVIDENCE_SOURCES,
  DEFAULT_LOCAL_RAG_MAX_PUBLIC_SOURCES,
  DEFAULT_LOCAL_RAG_MIN_RELEVANCE_SCORE,
  DEFAULT_LOCAL_RAG_ADJACENT_CHUNKS,
  DEFAULT_LOCAL_RAG_CHUNK_SIZE,
  DEFAULT_LOCAL_RAG_CHUNK_OVERLAP_MESSAGES,
  parseAllowedOrigins,
  parseBoolean,
  getWebAgentSharedKnowledgeBaseId,
  parseWebAgentAccounts,
  getConfig,
};
