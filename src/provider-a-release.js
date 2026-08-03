const crypto = require('node:crypto');

function createSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function buildProviderAEnv(options = {}) {
  const sharedKnowledgeBaseId = cleanRequired(
    options.sharedKnowledgeBaseId,
    'IMA Web 共享知识库 ID',
  );
  const adminToken = cleanRequired(options.adminToken || createSecret(), 'IMA_QA_ADMIN_TOKEN');
  const allowedOrigins = cleanSingleLine(options.allowedOrigins || '');
  const port = cleanPort(options.port || '3000', 'PORT');
  const hostPort = cleanPort(options.hostPort || '3117', 'HOST_PORT');

  const lines = [
    '# IMA QA Provider A deployment configuration.',
    '# This file is private. Do not commit it or send it to anyone.',
    'IMA_QA_PROVIDER=ima-web-agent',
    `PORT=${port}`,
    `HOST_PORT=${hostPort}`,
    'HOST_BIND=127.0.0.1',
    '',
    '# IMA Web shared knowledge base numeric ID. This is not the OpenAPI base64 ID.',
    `IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID=${escapeEnvValue(sharedKnowledgeBaseId)}`,
    'IMA_WEB_AGENT_MODEL_ID=official_3',
    'IMA_WEB_AGENT_MODEL_TYPE=3',
    '',
    '# Private persisted state. Back up the whole runtime directory with mode 700.',
    'IMA_WEB_AGENT_ACCOUNT_STORE_PATH=./runtime/ima-web-agent-accounts.json',
    'IMA_WEB_AGENT_ACCOUNT_STORE_KEY_PATH=./runtime/ima-web-agent-accounts.key',
    'IMA_QA_CONVERSATION_STORE_PATH=./runtime/ima-qa-conversations.json',
    'IMA_QA_CONVERSATION_TTL_MS=604800000',
    '',
    '# The admin token protects account enrolment and account operations.',
    `IMA_QA_ADMIN_TOKEN=${escapeEnvValue(adminToken)}`,
    '# Keep IMA_QA_API_TOKEN empty when using the bundled same-origin chat page.',
    '# IMA_QA_API_TOKEN=',
    '# Leave empty for the bundled same-origin chat page. Add exact origins to allow an external iframe or API call.',
    `ALLOWED_ORIGINS=${escapeEnvValue(allowedOrigins)}`,
    'TRUST_PROXY=false',
    'IMA_QA_HEALTH_DETAILS=basic',
    '',
    '# Public traffic controls. One active ask per IMA account is the stable baseline.',
    '# Auto mode follows the number of enabled accounts without restarting the service.',
    'IMA_QA_ACCOUNT_POOL_CAPACITY_MODE=auto',
    'IMA_QA_MAX_CONCURRENT_ASK=auto',
    'IMA_QA_QUEUE_LIMIT=30',
    'IMA_QA_REQUEST_TIMEOUT_MS=180000',
    'IMA_QA_RATE_LIMIT_WINDOW_MS=60000',
    'IMA_QA_RATE_LIMIT_MAX=20',
    '',
    '# IMA refreshes web auth with the saved refresh token before it expires.',
    'IMA_WEB_AGENT_REFRESH_SKEW_MS=600000',
    'IMA_WEB_AGENT_REFRESH_INTERVAL_MS=60000',
  ];
  return `${lines.join('\n')}\n`;
}

function cleanRequired(value, name) {
  const text = cleanSingleLine(value);
  if (!text) {
    throw new Error(`${name}不能为空`);
  }
  return text;
}

function cleanSingleLine(value) {
  return String(value || '').replace(/[\r\n]+/g, '').trim();
}

function cleanPort(value, name) {
  const port = Number(cleanSingleLine(value));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name}必须是 1 到 65535 之间的端口`);
  }
  return String(port);
}

function escapeEnvValue(value) {
  const text = cleanSingleLine(value);
  if (!/[\s#'"\\]/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

module.exports = {
  buildProviderAEnv,
  createSecret,
};
