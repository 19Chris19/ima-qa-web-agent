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
  getConfig,
  parseAllowedOrigins,
  parseBoolean,
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
    ALLOWED_ORIGINS: 'https://example.com, https://docs.example.com ',
    TRUST_PROXY: 'true',
    IMA_QA_HEALTH_DETAILS: 'auth',
    IMA_QA_MAX_CONCURRENT_ASK: '8',
    IMA_QA_QUEUE_LIMIT: '40',
    IMA_QA_REQUEST_TIMEOUT_MS: '90000',
    IMA_QA_RATE_LIMIT_WINDOW_MS: '30000',
    IMA_QA_RATE_LIMIT_MAX: '12',
  });

  assert.equal(config.security.apiToken, 'server-token');
  assert.deepEqual(config.security.allowedOrigins, [
    'https://example.com',
    'https://docs.example.com',
  ]);
  assert.equal(config.security.trustProxy, true);
  assert.equal(config.security.healthDetails, 'auth');
  assert.equal(config.concurrency.maxConcurrentAsk, 8);
  assert.equal(config.concurrency.queueLimit, 40);
  assert.equal(config.concurrency.requestTimeoutMs, 90000);
  assert.equal(config.rateLimit.windowMs, 30000);
  assert.equal(config.rateLimit.max, 12);
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.equal(parseBoolean('yes'), true);
  assert.equal(parseBoolean('no'), false);
});

test('getConfig validates Web Agent mode requirements', () => {
  assert.throws(
    () =>
      getConfig({
        IMA_QA_PROVIDER: 'ima-web-agent',
        IMA_WEB_KNOWLEDGE_BASE_ID: 'web-kb-id',
      }),
    /IMA_WEB_AGENT_HEADERS_JSON/,
  );
  assert.throws(
    () =>
      getConfig({
        IMA_QA_PROVIDER: 'ima-web-agent',
        IMA_WEB_KNOWLEDGE_BASE_ID: 'web-kb-id',
        IMA_WEB_AGENT_HEADERS_JSON: 'not-json',
      }),
    /valid JSON/,
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
