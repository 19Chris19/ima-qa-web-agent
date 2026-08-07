const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_MIMO_BASE_URL,
  DEFAULT_MIMO_MODEL,
  DEFAULT_MAX_CONCURRENT_ASK,
  DEFAULT_QA_PROVIDER,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WEB_AGENT_ACCOUNT_COOLDOWN_MS,
  DEFAULT_WEB_AGENT_ACCOUNT_MAX_CONSECUTIVE_ERRORS,
  DEFAULT_WEB_AGENT_ACCOUNT_STORE_KEY_PATH,
  DEFAULT_WEB_AGENT_ACCOUNT_STORE_PATH,
  DEFAULT_WEB_AGENT_BROWSER_PATH,
  DEFAULT_CONVERSATION_TTL_MS,
  DEFAULT_IMA_OPENAPI_ENRICH_SNIPPET_THRESHOLD,
  DEFAULT_IMA_OPENAPI_MAX_ENRICHED_SOURCES,
  DEFAULT_IMA_OPENAPI_MAX_RETRIES,
  DEFAULT_IMA_OPENAPI_REQUEST_TIMEOUT_MS,
  DEFAULT_IMA_OPENAPI_RETRY_BASE_DELAY_MS,
  DEFAULT_LOCAL_RAG_ADJACENT_CHUNKS,
  DEFAULT_LOCAL_RAG_CHUNK_OVERLAP_MESSAGES,
  DEFAULT_LOCAL_RAG_CHUNK_SIZE,
  DEFAULT_LOCAL_RAG_MAX_EVIDENCE_SOURCES,
  DEFAULT_LOCAL_RAG_MAX_PUBLIC_SOURCES,
  DEFAULT_LOCAL_RAG_MIN_RELEVANCE_SCORE,
  DEFAULT_LOCAL_RAG_MAX_CANDIDATES,
  DEFAULT_LOCAL_RAG_PER_QUERY_CANDIDATES,
  DEFAULT_LOCAL_RAG_QUERY_LIMIT,
  DEFAULT_LOCAL_RAG_MAX_SOURCES,
  getConfig,
  parseAllowedOrigins,
  parseBoolean,
  parseWebAgentAccounts,
} = require('../src/config');
const { defaultRuntimeEnvPath, loadRuntimeEnv } = require('../src/runtime-env');

function completeEnv(overrides = {}) {
  return {
    IMA_OPENAPI_CLIENTID: 'ima-client',
    IMA_OPENAPI_APIKEY: 'ima-key',
    IMA_SHARED_KNOWLEDGE_BASE_ID: 'shared-kb',
    MIMO_API_KEY: 'mimo-key',
    ...overrides,
  };
}

test('getConfig fails fast when required credentials are missing', () => {
  assert.throws(
    () => getConfig({ IMA_OPENAPI_CLIENTID: 'ima-client' }),
    /IMA_OPENAPI_APIKEY.*IMA_SHARED_KNOWLEDGE_BASE_ID.*MIMO_API_KEY/,
  );
});

test('getConfig uses the planned defaults without writing secrets', () => {
  const config = getConfig(completeEnv());

  assert.equal(config.port, 3000);
  assert.equal(config.qaProvider, DEFAULT_QA_PROVIDER);
  assert.equal(config.ima.clientId, 'ima-client');
  assert.equal(config.ima.apiKey, 'ima-key');
  assert.equal(config.ima.sharedKnowledgeBaseId, 'shared-kb');
  assert.equal(config.mimo.baseUrl, DEFAULT_MIMO_BASE_URL);
  assert.equal(config.mimo.model, DEFAULT_MIMO_MODEL);
  assert.equal(config.concurrency.maxConcurrentAsk, DEFAULT_MAX_CONCURRENT_ASK);
  assert.equal(config.concurrency.queueLimit, DEFAULT_QUEUE_LIMIT);
  assert.equal(config.concurrency.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(config.rateLimit.windowMs, DEFAULT_RATE_LIMIT_WINDOW_MS);
  assert.equal(config.rateLimit.max, DEFAULT_RATE_LIMIT_MAX);
  assert.equal(config.ima.requestTimeoutMs, DEFAULT_IMA_OPENAPI_REQUEST_TIMEOUT_MS);
  assert.equal(config.ima.maxRetries, DEFAULT_IMA_OPENAPI_MAX_RETRIES);
  assert.equal(config.ima.retryBaseDelayMs, DEFAULT_IMA_OPENAPI_RETRY_BASE_DELAY_MS);
  assert.equal(config.ima.maxEnrichedSources, DEFAULT_IMA_OPENAPI_MAX_ENRICHED_SOURCES);
  assert.equal(config.ima.enrichSnippetThreshold, DEFAULT_IMA_OPENAPI_ENRICH_SNIPPET_THRESHOLD);
  assert.equal(config.conversations.ttlMs, DEFAULT_CONVERSATION_TTL_MS);
  assert.equal(DEFAULT_CONVERSATION_TTL_MS, 604800000);
});

test('getConfig trims the MIMO base URL and validates PORT', () => {
  const config = getConfig(
    completeEnv({
      MIMO_BASE_URL: 'https://token-plan-cn.xiaomimimo.com/v1/',
      MIMO_MODEL: 'custom-mimo',
      PORT: '3131',
    }),
  );

  assert.equal(config.mimo.baseUrl, 'https://token-plan-cn.xiaomimimo.com/v1');
  assert.equal(config.mimo.model, 'custom-mimo');
  assert.equal(config.port, 3131);
  assert.throws(() => getConfig(completeEnv({ PORT: '70000' })), /PORT/);
});

test('parseAllowedOrigins only accepts exact http(s) origins and removes duplicates', () => {
  assert.deepEqual(
    parseAllowedOrigins('https://portal.example.com/, https://embed.example.com, https://portal.example.com'),
    ['https://portal.example.com', 'https://embed.example.com'],
  );
  assert.throws(
    () => parseAllowedOrigins('https://portal.example.com/embed.html'),
    /exact http\(s\) origins/,
  );
  assert.throws(
    () => parseAllowedOrigins('javascript:alert(1)'),
    /exact http\(s\) origins/,
  );
});

test('getConfig supports optional IMA Web Agent mode', () => {
  const config = getConfig({
    IMA_QA_PROVIDER: 'ima-web-agent',
    IMA_WEB_KNOWLEDGE_BASE_ID: 'web-kb-id',
    IMA_WEB_AGENT_HEADERS_JSON: '{"x-ima-cookie":"cookie","x-ima-bkn":"123"}',
  });

  assert.equal(config.qaProvider, 'ima-web-agent');
  assert.equal(config.webAgent.knowledgeBaseId, 'web-kb-id');
  assert.equal(config.webAgent.headers['x-ima-cookie'], 'cookie');
  assert.equal(config.webAgent.modelId, 'official_3');
  assert.equal(config.webAgent.modelType, 3);
  assert.equal(config.webAgent.accounts.length, 1);
  assert.equal(config.webAgent.accounts[0].name, 'default');
  assert.equal(config.webAgent.accountCooldownMs, DEFAULT_WEB_AGENT_ACCOUNT_COOLDOWN_MS);
  assert.equal(
    config.webAgent.accountMaxConsecutiveErrors,
    DEFAULT_WEB_AGENT_ACCOUNT_MAX_CONSECUTIVE_ERRORS,
  );
});

test('getConfig allows Web Agent control plane startup without pre-seeded accounts', () => {
  const config = getConfig({
    IMA_QA_PROVIDER: 'ima-web-agent',
  });

  assert.equal(config.qaProvider, 'ima-web-agent');
  assert.deepEqual(config.webAgent.accounts, []);
  assert.equal(config.webAgent.accountStorePath, DEFAULT_WEB_AGENT_ACCOUNT_STORE_PATH);
  assert.equal(config.webAgent.accountStoreKeyPath, DEFAULT_WEB_AGENT_ACCOUNT_STORE_KEY_PATH);
  assert.equal(config.webAgent.browserPath, DEFAULT_WEB_AGENT_BROWSER_PATH);
  assert.equal(config.concurrency.maxConcurrentAsk, DEFAULT_MAX_CONCURRENT_ASK);
  assert.equal(config.concurrency.autoScaleWithAccounts, true);
});

test('getConfig keeps the configured Web Agent shared knowledge base before accounts enroll', () => {
  const config = getConfig({
    IMA_QA_PROVIDER: 'ima-web-agent',
    IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID: 'web-kb-id',
  });

  assert.equal(config.webAgent.sharedKnowledgeBaseId, 'web-kb-id');
  assert.deepEqual(config.webAgent.accounts, []);
});

test('getConfig supports local RAG provider with MIMO generation', () => {
  const config = getConfig({
    IMA_QA_PROVIDER: 'local-rag-mimo',
    MIMO_API_KEY: 'mimo-key',
    LOCAL_RAG_CORPUS_ZIP: '/tmp/raw.zip',
    LOCAL_RAG_INDEX_DIR: '/tmp/local-index',
    LOCAL_RAG_QUERY_LIMIT: '9',
    LOCAL_RAG_PER_QUERY_CANDIDATES: '70',
    LOCAL_RAG_MAX_CANDIDATES: '120',
    LOCAL_RAG_MAX_EVIDENCE_SOURCES: '16',
    LOCAL_RAG_MAX_PUBLIC_SOURCES: '9',
    LOCAL_RAG_MIN_RELEVANCE_SCORE: '24',
    LOCAL_RAG_ADJACENT_CHUNKS: '2',
    LOCAL_RAG_ENABLE_SECOND_PASS: 'false',
    LOCAL_RAG_ENABLE_COVERAGE: 'false',
    LOCAL_RAG_CHUNK_SIZE: '2000',
    LOCAL_RAG_CHUNK_OVERLAP_MESSAGES: '6',
  });

  assert.equal(config.qaProvider, 'local-rag-mimo');
  assert.equal(config.mimo.apiKey, 'mimo-key');
  assert.equal(config.localRag.corpusZip, '/tmp/raw.zip');
  assert.equal(config.localRag.indexDir, '/tmp/local-index');
  assert.equal(config.localRag.queryLimit, 9);
  assert.equal(config.localRag.perQueryCandidates, 70);
  assert.equal(config.localRag.maxCandidates, 120);
  assert.equal(config.localRag.maxEvidenceSources, 16);
  assert.equal(config.localRag.maxPublicSources, 9);
  assert.equal(config.localRag.minRelevanceScore, 24);
  assert.equal(config.localRag.adjacentChunks, 2);
  assert.equal(config.localRag.enableSecondPass, false);
  assert.equal(config.localRag.enableCoverage, false);
  assert.equal(config.localRag.chunkSize, 2000);
  assert.equal(config.localRag.chunkOverlapMessages, 6);
});

test('getConfig uses local RAG defaults without IMA OpenAPI credentials', () => {
  const config = getConfig({
    IMA_QA_PROVIDER: 'local-rag-mimo',
    MIMO_API_KEY: 'mimo-key',
  });

  assert.equal(config.localRag.maxSources, DEFAULT_LOCAL_RAG_MAX_SOURCES);
  assert.equal(config.localRag.queryLimit, DEFAULT_LOCAL_RAG_QUERY_LIMIT);
  assert.equal(config.localRag.perQueryCandidates, DEFAULT_LOCAL_RAG_PER_QUERY_CANDIDATES);
  assert.equal(config.localRag.maxCandidates, DEFAULT_LOCAL_RAG_MAX_CANDIDATES);
  assert.equal(config.localRag.maxEvidenceSources, DEFAULT_LOCAL_RAG_MAX_EVIDENCE_SOURCES);
  assert.equal(config.localRag.maxPublicSources, DEFAULT_LOCAL_RAG_MAX_PUBLIC_SOURCES);
  assert.equal(config.localRag.minRelevanceScore, DEFAULT_LOCAL_RAG_MIN_RELEVANCE_SCORE);
  assert.equal(config.localRag.adjacentChunks, DEFAULT_LOCAL_RAG_ADJACENT_CHUNKS);
  assert.equal(config.localRag.enableSecondPass, true);
  assert.equal(config.localRag.enableCoverage, true);
  assert.equal(config.localRag.chunkSize, DEFAULT_LOCAL_RAG_CHUNK_SIZE);
  assert.equal(config.localRag.chunkOverlapMessages, DEFAULT_LOCAL_RAG_CHUNK_OVERLAP_MESSAGES);
});

test('getConfig puts Web Agent account pools into automatic capacity mode by default', () => {
  const config = getConfig({
    IMA_QA_PROVIDER: 'ima-web-agent',
    IMA_WEB_AGENT_ACCOUNTS_JSON: JSON.stringify([
      {
        name: 'account-a',
        knowledgeBaseId: 'web-kb-id',
        headers: { 'x-ima-cookie': 'cookie-a', 'x-ima-bkn': '123' },
        runtimeEnvPath: '/tmp/account-a.env',
      },
      {
        name: 'account-b',
        knowledgeBaseId: 'web-kb-id',
        headers: { 'x-ima-cookie': 'cookie-b', 'x-ima-bkn': '456' },
      },
    ]),
    IMA_WEB_AGENT_ACCOUNT_COOLDOWN_MS: '90000',
    IMA_WEB_AGENT_ACCOUNT_MAX_CONSECUTIVE_ERRORS: '3',
  });

  assert.equal(config.webAgent.accounts.length, 2);
  assert.equal(config.webAgent.accounts[0].name, 'account-a');
  assert.equal(config.webAgent.accounts[0].knowledgeBaseId, 'web-kb-id');
  assert.equal(config.webAgent.accounts[0].headers['x-ima-cookie'], 'cookie-a');
  assert.equal(config.webAgent.accounts[0].runtimeEnvPath, '/tmp/account-a.env');
  assert.equal(config.webAgent.accountCooldownMs, 90000);
  assert.equal(config.webAgent.accountMaxConsecutiveErrors, 3);
  assert.equal(config.concurrency.maxConcurrentAsk, 1);
  assert.equal(config.concurrency.autoScaleWithAccounts, true);
});

test('getConfig rejects pre-seeded accounts outside the configured shared knowledge base', () => {
  assert.throws(
    () =>
      getConfig({
        IMA_QA_PROVIDER: 'ima-web-agent',
        IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID: 'expected-kb',
        IMA_WEB_AGENT_ACCOUNTS_JSON: JSON.stringify([
          {
            name: 'account-a',
            knowledgeBaseId: 'other-kb',
            headers: { 'x-ima-cookie': 'cookie-a', 'x-ima-bkn': '123' },
          },
        ]),
      }),
    /must use IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID/,
  );
});

test('getConfig parses Web Agent local-service refresh settings', () => {
  const config = getConfig({
    IMA_QA_PROVIDER: 'ima-web-agent',
    IMA_WEB_KNOWLEDGE_BASE_ID: 'web-kb-id',
    IMA_WEB_AGENT_HEADERS_JSON: '{"x-ima-cookie":"cookie","x-ima-bkn":"123"}',
    IMA_WEB_AGENT_RUNTIME_ENV_PATH: '/tmp/ima-web-agent.env',
    IMA_WEB_AGENT_TOKEN_EXPIRES_AT: '1785257551943',
    IMA_WEB_AGENT_REFRESH_TOKEN_EXPIRES_AT: '1787842056525',
    IMA_WEB_AGENT_REFRESH_SKEW_MS: '600000',
    IMA_WEB_AGENT_REFRESH_INTERVAL_MS: '30000',
  });

  assert.equal(config.webAgent.runtimeEnvPath, '/tmp/ima-web-agent.env');
  assert.equal(config.webAgent.tokenExpiresAt, 1785257551943);
  assert.equal(config.webAgent.refreshTokenExpiresAt, 1787842056525);
  assert.equal(config.webAgent.refreshSkewMs, 600000);
  assert.equal(config.webAgent.refreshIntervalMs, 30000);
});

test('getConfig parses optional production security settings', () => {
  const config = getConfig({
    IMA_QA_PROVIDER: 'ima-web-agent',
    IMA_WEB_KNOWLEDGE_BASE_ID: 'web-kb-id',
    IMA_WEB_AGENT_HEADERS_JSON: '{"x-ima-cookie":"cookie","x-ima-bkn":"123"}',
    IMA_QA_API_TOKEN: 'server-token',
    IMA_QA_INTERNAL_SERVICE_TOKEN: 'voice-rag-service-token',
    IMA_QA_ADMIN_TOKEN: 'admin-token',
    ALLOWED_ORIGINS: 'https://example.com, https://docs.example.com ',
    TRUST_PROXY: 'true',
    IMA_QA_HEALTH_DETAILS: 'auth',
    IMA_QA_ACCOUNT_POOL_CAPACITY_MODE: 'fixed',
    IMA_QA_MAX_CONCURRENT_ASK: '8',
    IMA_QA_QUEUE_LIMIT: '40',
    IMA_QA_REQUEST_TIMEOUT_MS: '90000',
    IMA_QA_RATE_LIMIT_WINDOW_MS: '30000',
    IMA_QA_RATE_LIMIT_MAX: '12',
    IMA_OPENAPI_REQUEST_TIMEOUT_MS: '20000',
    IMA_OPENAPI_MAX_RETRIES: '4',
    IMA_OPENAPI_RETRY_BASE_DELAY_MS: '1500',
    IMA_OPENAPI_MAX_ENRICHED_SOURCES: '8',
    IMA_OPENAPI_ENRICH_SNIPPET_THRESHOLD: '500',
    IMA_WEB_AGENT_ACCOUNT_COOLDOWN_MS: '120000',
    IMA_WEB_AGENT_ACCOUNT_MAX_CONSECUTIVE_ERRORS: '2',
  });

  assert.equal(config.security.apiToken, 'server-token');
  assert.equal(config.security.internalServiceToken, 'voice-rag-service-token');
  assert.equal(config.security.adminToken, 'admin-token');
  assert.deepEqual(config.security.allowedOrigins, [
    'https://example.com',
    'https://docs.example.com',
  ]);
  assert.equal(config.security.trustProxy, true);
  assert.equal(config.security.healthDetails, 'auth');
  assert.equal(config.concurrency.maxConcurrentAsk, 8);
  assert.equal(config.concurrency.autoScaleWithAccounts, false);
  assert.equal(config.concurrency.queueLimit, 40);
  assert.equal(config.concurrency.requestTimeoutMs, 90000);
  assert.equal(config.rateLimit.windowMs, 30000);
  assert.equal(config.rateLimit.max, 12);
  assert.equal(config.ima.requestTimeoutMs, 20000);
  assert.equal(config.ima.maxRetries, 4);
  assert.equal(config.ima.retryBaseDelayMs, 1500);
  assert.equal(config.ima.maxEnrichedSources, 8);
  assert.equal(config.ima.enrichSnippetThreshold, 500);
  assert.equal(config.webAgent.accountCooldownMs, 120000);
  assert.equal(config.webAgent.accountMaxConsecutiveErrors, 2);
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.equal(parseBoolean('yes'), true);
  assert.equal(parseBoolean('no'), false);
});

test('getConfig accepts automatic account-pool capacity and rejects auto in fixed mode', () => {
  const automatic = getConfig({
    IMA_QA_PROVIDER: 'ima-web-agent',
    IMA_QA_ACCOUNT_POOL_CAPACITY_MODE: 'auto',
    IMA_QA_MAX_CONCURRENT_ASK: 'auto',
  });
  assert.equal(automatic.concurrency.autoScaleWithAccounts, true);
  assert.equal(automatic.concurrency.maxConcurrentAsk, DEFAULT_MAX_CONCURRENT_ASK);

  assert.throws(
    () =>
      getConfig({
        IMA_QA_PROVIDER: 'ima-web-agent',
        IMA_QA_ACCOUNT_POOL_CAPACITY_MODE: 'fixed',
        IMA_QA_MAX_CONCURRENT_ASK: 'auto',
      }),
    /positive integer in fixed mode/,
  );
});

test('getConfig parses persistent conversation settings', () => {
  const config = getConfig({
    IMA_QA_PROVIDER: 'ima-web-agent',
    IMA_QA_CONVERSATION_STORE_PATH: '/tmp/ima-conversations.json',
    IMA_QA_CONVERSATION_TTL_MS: '3600000',
    IMA_QA_CONVERSATION_MAX_TURNS: '8',
    IMA_QA_CONVERSATION_MAX_COUNT: '99',
  });

  assert.equal(config.conversations.storePath, '/tmp/ima-conversations.json');
  assert.equal(config.conversations.ttlMs, 3600000);
  assert.equal(config.conversations.maxTurns, 8);
  assert.equal(config.conversations.maxCount, 99);
});

test('getConfig validates Web Agent mode requirements', () => {
  assert.throws(
    () =>
      getConfig({
        IMA_QA_PROVIDER: 'ima-web-agent',
        IMA_WEB_KNOWLEDGE_BASE_ID: 'web-kb-id',
        IMA_WEB_AGENT_HEADERS_JSON: 'not-json',
      }),
    /valid JSON/,
  );
  assert.throws(
    () =>
      getConfig({
        IMA_QA_PROVIDER: 'ima-web-agent',
        IMA_WEB_AGENT_ACCOUNTS_JSON: JSON.stringify([
          { name: 'account-a', headers: { 'x-ima-cookie': 'cookie' } },
        ]),
      }),
    /knowledgeBaseId/,
  );
  assert.throws(
    () =>
      parseWebAgentAccounts({
        IMA_WEB_AGENT_ACCOUNTS_JSON: JSON.stringify([
          {
            name: 'account-a',
            knowledgeBaseId: 'web-kb-id',
            headers: { 'x-ima-cookie': 'cookie-a' },
          },
          {
            name: 'account-a',
            knowledgeBaseId: 'web-kb-id',
            headers: { 'x-ima-cookie': 'cookie-b' },
          },
        ]),
      }),
    /Duplicate/,
  );
});

test('loadRuntimeEnv loads the local runtime env file without exposing values', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-env-loader-'));
  const appDir = path.join(tempDir, 'apps', 'ima-qa-web');
  const runtimeDir = path.join(tempDir, 'runtime');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, 'ima-web-agent.env'),
    [
      "PORT='3117'",
      'IMA_QA_PROVIDER=ima-web-agent',
      "IMA_WEB_KNOWLEDGE_BASE_ID='web-kb-id'",
      'IMA_WEB_AGENT_HEADERS_JSON=\'{"x-ima-cookie":"cookie","x-ima-bkn":"123"}\'',
      '',
    ].join('\n'),
  );

  const env = {};
  const result = loadRuntimeEnv({ appDir, env });

  assert.equal(result.runtimeEnvPath, defaultRuntimeEnvPath(appDir));
  assert.equal(result.loadedRuntimeEnv, true);
  assert.equal(env.PORT, '3117');
  assert.equal(env.IMA_QA_PROVIDER, 'ima-web-agent');
});
