const assert = require('node:assert/strict');
const test = require('node:test');
const dotenv = require('dotenv');
const { getConfig } = require('../src/config');
const { buildProviderAEnv } = require('../src/provider-a-release');

test('Provider A setup output starts without OpenAPI or MIMO credentials', () => {
  const text = buildProviderAEnv({
    sharedKnowledgeBaseId: 'web-kb-123',
    adminToken: 'admin-token',
    allowedOrigins: 'https://portal.example.com',
  });
  const config = getConfig(dotenv.parse(text));

  assert.equal(config.qaProvider, 'ima-web-agent');
  assert.equal(config.webAgent.sharedKnowledgeBaseId, 'web-kb-123');
  assert.equal(config.webAgent.accountStorePath, './runtime/ima-web-agent-accounts.json');
  assert.equal(config.security.adminToken, 'admin-token');
  assert.equal(config.concurrency.maxConcurrentAsk, 1);
  assert.equal(config.concurrency.autoScaleWithAccounts, true);
  assert.equal(config.mimo.apiKey, '');
  assert.equal(text.includes('MIMO_API_KEY'), false);
  assert.equal(text.includes('IMA_OPENAPI_APIKEY'), false);
});

test('Provider A setup safely quotes configured origins', () => {
  const text = buildProviderAEnv({
    sharedKnowledgeBaseId: 'web-kb-123',
    adminToken: 'admin-token',
    allowedOrigins: 'https://one.example.com, https://two.example.com',
  });
  const parsed = dotenv.parse(text);
  assert.equal(parsed.ALLOWED_ORIGINS, 'https://one.example.com, https://two.example.com');
});
