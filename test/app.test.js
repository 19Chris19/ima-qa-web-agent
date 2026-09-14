const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const {
  buildLocalRagFallbackAnswer,
  createApp,
  isMechanicalNoReliableAnswer,
  noReliableContentAnswer,
  requireApiToken,
  requireInternalServiceToken,
  sanitizeKnowledgeBoundAnswer,
  shouldUseLocalRagFallback,
} = require('../src/app');
const { registerAdminRoutes } = require('../src/admin-routes');
const { IMAOpenAPIQuotaExceededError } = require('../src/ima-client');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { AccountPoolExerciseManager, AccountPoolExerciseReportStore } = require('../src/account-pool-exercise');
const { WebAgentAccountDirectory } = require('../src/web-agent-account-directory');
const { ConversationStore } = require('../src/conversation-store');

const baseConfig = {
  port: 0,
  limits: {
    maxQuestionLength: 2000,
    maxHistoryTurns: 6,
    maxHistoryContentLength: 1000,
    maxSources: 6,
    maxSnippetLength: 900,
  },
  ima: {
    clientId: 'ima-client',
    apiKey: 'ima-key',
    sharedKnowledgeBaseId: 'shared-kb',
  },
  mimo: {
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    apiKey: 'mimo-key',
    model: 'mimo-v2.5',
  },
  security: {
    apiToken: '',
    adminToken: '',
    allowedOrigins: [],
    healthDetails: 'basic',
    trustProxy: false,
  },
  concurrency: {
    maxConcurrentAsk: 6,
    queueLimit: 30,
    requestTimeoutMs: 120000,
  },
  rateLimit: {
    windowMs: 0,
    max: 0,
  },
};

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = options.timeoutMs || 1000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

async function waitForHealth(baseUrl, predicate) {
  await waitFor(async () => {
    const health = await (await fetch(`${baseUrl}/healthz`)).json();
    return predicate(health);
  });
}

async function fsMkdtemp() {
  return fs.mkdtemp(path.join(require('node:os').tmpdir(), 'ima-admin-'));
}

function makeApp(overrides = {}) {
  const app = createApp({
    config: overrides.config || baseConfig,
    imaClient: overrides.imaClient || {
      async searchKnowledge() {
        return [{ index: 1, title: '制度文档', snippet: '报销需要发票。' }];
      },
    },
    mimoClient: overrides.mimoClient || {
      async *streamAnswer() {
        yield '需要提交发票';
        yield ' [1]';
      },
    },
    imaWebAgentClient: overrides.imaWebAgentClient,
    localRagClient: overrides.localRagClient,
    accountDirectory: overrides.accountDirectory,
    conversationStore: overrides.conversationStore,
  });
  if (typeof overrides.createExerciseManager === 'function') {
    app.locals.accountPoolExerciseManager = overrides.createExerciseManager({
      askQueue: app.locals.imaQaAskQueue,
    });
  }
  if (overrides.accountDirectory) {
    registerAdminRoutes(app, {
      config: overrides.config || baseConfig,
      accountDirectory: overrides.accountDirectory,
      imaWebAgentClient: overrides.imaWebAgentClient,
      enrollmentManager: overrides.enrollmentManager,
      accountPoolExerciseManager: app.locals.accountPoolExerciseManager,
    });
  }
  return app;
}

test('account pool exercise routes lock ordinary asks and expose only sanitized reports to administrators', async () => {
  const tempDir = await fsMkdtemp();
  const accountDirectory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });
  for (const [id, name] of [['account-a', '账号 A'], ['account-b', '账号 B']]) {
    accountDirectory.upsertCapturedAccount({
      id,
      name,
      knowledgeBaseId: 'web-kb-id',
      headers: { 'x-ima-cookie': `IMA-UID=${id}; IMA-TOKEN=t; IMA-REFRESH-TOKEN=r`, 'x-ima-bkn': '123' },
    });
  }
  let accountIndex = 0;
  let sessionIndex = 0;
  let initialStartedCount = 0;
  let resolveInitialStarted;
  let releaseInitialTurns;
  const initialStarted = new Promise((resolve) => {
    resolveInitialStarted = resolve;
  });
  const initialTurnsReleased = new Promise((resolve) => {
    releaseInitialTurns = resolve;
  });
  const imaWebAgentClient = {
    syncAccounts() {},
    stats() {
      return { totalAccounts: 2, availableAccounts: 2, unavailableAccounts: 0, busyAccounts: 0, coolingDownAccounts: 0 };
    },
    async *streamAsk(options) {
      const accountId = options.accountId || ['account-a', 'account-b'][accountIndex++ % 2];
      const sessionId = options.sessionId || `internal-session-${++sessionIndex}`;
      yield { type: 'route', accountId };
      yield { type: 'session', sessionId };
      if (!options.sessionId) {
        initialStartedCount += 1;
        if (initialStartedCount === 2) {
          resolveInitialStarted();
        }
      }
      if (!options.sessionId) {
        await initialTurnsReleased;
      }
      yield { type: 'sources', sources: [{ index: 1, title: '知识库资料', snippet: '群聊摘录' }], searchSummary: '找到 1 篇资料' };
      yield { type: 'delta', text: '真实演练回答' };
    },
  };
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      security: { ...baseConfig.security, adminToken: 'admin-token' },
      webAgent: { sharedKnowledgeBaseId: 'web-kb-id' },
    },
    accountDirectory,
    imaWebAgentClient,
    createExerciseManager({ askQueue }) {
      return new AccountPoolExerciseManager({
        askQueue,
        accountDirectory,
        pool: imaWebAgentClient,
        reportStore: new AccountPoolExerciseReportStore({ persist: false }),
      });
    },
  });

  await withServer(app, async (baseUrl) => {
    const headers = { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' };
    const started = await fetch(`${baseUrl}/api/admin/exercises`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profile: 'baseline',
        confirm: true,
        clients: [
          { label: '模拟用户 1', question: '无人机航拍重叠率怎么设置？', followUp: '补充一个注意事项。' },
          { label: '模拟用户 2', question: '显存不足怎么排查？', followUp: '补充一个设置建议。' },
        ],
      }),
    });
    assert.equal(started.status, 201);
    const startData = await started.json();
    await initialStarted;

    const blocked = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '普通用户问题' }),
    });
    assert.equal(blocked.status, 503);
    assert.match((await blocked.json()).error, /容量演练/);
    releaseInitialTurns();

    await waitFor(async () => {
      const reports = await fetch(`${baseUrl}/api/admin/exercises/reports`, { headers });
      return (await reports.json()).reports?.length === 1;
    }, { timeoutMs: 3000 });
    const reportResponse = await fetch(`${baseUrl}/api/admin/exercises/reports/${startData.run.runId}`, { headers });
    const report = await reportResponse.json();
    assert.equal(reportResponse.status, 200);
    assert.equal(report.report.summary.initial.ok, 2);
    assert.equal(report.report.summary.followUp.ok, 2);
    assert.equal(JSON.stringify(report).includes('account-a'), false);
    assert.equal(JSON.stringify(report).includes('internal-session-'), false);

    const scored = await fetch(
      `${baseUrl}/api/admin/exercises/reports/${startData.run.runId}/reviews/0`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ relevance: 2, completeness: 2, sourceTrust: 1, followUpContinuity: 2, note: '可复核' }),
      },
    );
    assert.equal(scored.status, 200);
    assert.equal((await scored.json()).report.reviewSummary.reviewedClients, 1);

    const exported = await fetch(`${baseUrl}/api/admin/exercises/reports/${startData.run.runId}/export`, { headers });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition'), /ima-account-pool-exercise-[0-9a-f-]+\.json/);
    assert.equal(JSON.stringify(await exported.json()).includes('account-a'), false);

    const deleted = await fetch(`${baseUrl}/api/admin/exercises/reports/${startData.run.runId}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).success, true);
  });
});

test('POST /api/ask rejects request-provided knowledge base IDs', async () => {
  let imaCalled = false;
  const app = makeApp({
    imaClient: {
      async searchKnowledge() {
        imaCalled = true;
        return [];
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '问题', knowledge_base_id: 'attacker-kb' }),
    });

    const data = await response.json();
    assert.equal(response.status, 400);
    assert.equal(data.success, false);
    assert.match(data.error, /不允许/);
    assert.equal(imaCalled, false);
  });
});

test('POST /api/ask JSON fallback returns answer, sources, and requestId', async () => {
  const app = makeApp();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '怎么报销？' }),
    });

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.answer, '需要提交发票 [1]');
    assert.deepEqual(data.sources, [{ index: 1, title: '制度文档', snippet: '报销需要发票。' }]);
    assert.match(data.requestId, /^[0-9a-f-]{36}$/);
  });
});

test('conversation APIs list and restore only the current client public history', async () => {
  const conversationStore = new ConversationStore({ persist: false });
  const app = makeApp({ conversationStore });
  const clientAHeaders = {
    'Content-Type': 'application/json',
    'X-IMA-Client-Id': 'client-a-1234567890',
  };

  await withServer(app, async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: clientAHeaders,
    });
    const { conversation } = await created.json();
    conversationStore.setUpstream(
      conversation.conversationId,
      { accountId: 'private-account', sessionId: 'private-session' },
      'client-a-1234567890',
    );
    conversationStore.appendTurn(
      conversation.conversationId,
      '第一个问题',
      '第一个回答',
      {
        searchSummary: '找到 1 篇知识库资料',
        sources: [
          {
            index: 1,
            title: '群聊资料',
            snippet: '可公开的摘要。',
            mediaId: 'internal-media-id',
          },
        ],
      },
      'client-a-1234567890',
    );

    const list = await fetch(`${baseUrl}/api/conversations?limit=50`, { headers: clientAHeaders });
    const listPayload = await list.json();
    assert.equal(list.status, 200);
    assert.equal(listPayload.conversations.length, 1);
    assert.equal(listPayload.conversations[0].title, '第一个问题');
    assert.equal(JSON.stringify(listPayload).includes('private-account'), false);

    const detail = await fetch(`${baseUrl}/api/conversations/${conversation.conversationId}`, {
      headers: clientAHeaders,
    });
    const detailPayload = await detail.json();
    assert.equal(detail.status, 200);
    assert.deepEqual(detailPayload.messages.map((message) => message.role), ['user', 'assistant']);
    assert.equal(detailPayload.messages[1].sources.length, 1);
    assert.equal(detailPayload.messages[1].sources[0].title, '群聊资料');
    assert.equal(JSON.stringify(detailPayload).includes('internal-media-id'), false);
    assert.equal(JSON.stringify(detailPayload).includes('private-session'), false);

    const foreign = await fetch(`${baseUrl}/api/conversations/${conversation.conversationId}`, {
      headers: { 'X-IMA-Client-Id': 'client-b-1234567890' },
    });
    assert.equal(foreign.status, 404);
    assert.match((await foreign.json()).error, /会话不存在|已过期/);
  });
});

test('successful JSON and SSE answers persist compact sources in conversation history', async () => {
  const conversationStore = new ConversationStore({ persist: false });
  const app = makeApp({ conversationStore });
  const headers = {
    'Content-Type': 'application/json',
    'X-IMA-Client-Id': 'client-a-1234567890',
  };

  await withServer(app, async (baseUrl) => {
    const jsonResponse = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ question: 'JSON 问题' }),
    });
    const jsonPayload = await jsonResponse.json();
    const jsonDetail = await (
      await fetch(`${baseUrl}/api/conversations/${jsonPayload.conversationId}`, { headers })
    ).json();
    assert.equal(jsonDetail.messages[1].sources.length, 1);
    assert.equal(jsonDetail.messages[1].sources[0].title, '制度文档');

    const created = await fetch(`${baseUrl}/api/conversations`, { method: 'POST', headers });
    const createdPayload = await created.json();
    const sseResponse = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { ...headers, Accept: 'text/event-stream' },
      body: JSON.stringify({ question: 'SSE 问题', conversationId: createdPayload.conversation.conversationId }),
    });
    assert.equal(sseResponse.status, 200);
    await sseResponse.text();
    const sseDetail = await (
      await fetch(`${baseUrl}/api/conversations/${createdPayload.conversation.conversationId}`, { headers })
    ).json();
    assert.equal(sseDetail.messages[1].sources.length, 1);
    assert.equal(sseDetail.messages[1].searchSummary, '找到 1 篇知识库资料');
  });
});

test('POST /api/ask returns OpenAPI diagnostics only for eval requests', async () => {
  const imaClient = {
    async retrieveEvidencePack() {
      return {
        sources: [{ index: 1, title: '3DGS 资料', snippet: '3DGS 是三维高斯泼溅。' }],
        diagnostics: {
          candidateCount: 3,
          sourceCount: 1,
          profileIncluded: false,
          matchedQueries: ['3DGS 是什么？', '3DGS'],
        },
      };
    },
  };
  const app = makeApp({ imaClient });

  await withServer(app, async (baseUrl) => {
    const normal = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '3DGS 是什么？' }),
    });
    const normalData = await normal.json();
    assert.equal(Object.prototype.hasOwnProperty.call(normalData, 'diagnostics'), false);

    const evalResponse = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IMA-QA-Eval': '1',
      },
      body: JSON.stringify({ question: '3DGS 是什么？' }),
    });
    const evalData = await evalResponse.json();

    assert.equal(evalResponse.status, 200);
    assert.deepEqual(evalData.diagnostics, {
      candidateCount: 3,
      sourceCount: 1,
      profileIncluded: false,
      matchedQueries: ['3DGS 是什么？', '3DGS'],
    });
    assert.equal(JSON.stringify(evalData.diagnostics).includes('mediaId'), false);
  });
});

test('POST /api/ask supports local-rag-mimo provider with diagnostics', async () => {
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'local-rag-mimo',
    },
    localRagClient: {
      async retrieveEvidencePack() {
        return {
          sources: [{ index: 1, title: 'group1 / 2026-03-07', snippet: 'Blender 导出 GLB 变大，可以关闭法线。' }],
          diagnostics: {
            provider: 'local-rag-mimo',
            queryVariantCount: 4,
            sourceCount: 1,
          },
        };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IMA-QA-Eval': '1',
      },
      body: JSON.stringify({ question: 'Blender 导出 GLB 为什么变大？' }),
    });

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.answer, '需要提交发票 [1]');
    assert.equal(data.diagnostics.provider, 'local-rag-mimo');
    assert.match(data.sources[0].title, /group1/);
  });
});

test('POST /api/ask replaces mechanical local RAG refusal with grounded fallback', async () => {
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'local-rag-mimo',
    },
    localRagClient: {
      async retrieveEvidencePack() {
        return {
          sources: [
            {
              index: 1,
              title: 'group2 / 2026-07-03',
              snippet: 'Kiri 是高斯转mesh，用一般的3D打印机也能正常打；高斯模型需要先网格化。',
            },
          ],
          diagnostics: { provider: 'local-rag-mimo' },
        };
      },
    },
    mimoClient: {
      async *streamAnswer() {
        yield noReliableContentAnswer();
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何将3DGS模型转换成网格 Mesh 或用于3D打印？' }),
    });

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.match(data.answer, /高斯模型可以先转成 mesh/);
    assert.doesNotMatch(data.answer, /没有检索到可以支撑/);
  });
});

test('GET /healthz reports local RAG index status without secrets', async () => {
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'local-rag-mimo',
    },
    localRagClient: {
      getStatus() {
        return {
          available: true,
          indexPath: '/runtime/ima-local-rag-index/index.json',
          builtAt: '2026-07-30T00:00:00.000Z',
          stats: { fileCount: 4, chunkCount: 12 },
        };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'local-rag-mimo');
    assert.equal(data.localRag.available, true);
    assert.equal(JSON.stringify(data).includes('mimo-key'), false);
  });
});

test('POST /api/ask maps Provider B quota exhaustion to 429 with a stable failure reason', async () => {
  const app = makeApp({
    imaClient: {
      async retrieveEvidencePack() {
        throw new IMAOpenAPIQuotaExceededError('请求超量，请明日再试');
      },
      getQuotaStatus() {
        return {
          open: true,
          openedAt: '2026-07-30T00:00:00.000Z',
          code: 200005,
          message: 'IMA OpenAPI quota exceeded',
        };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Provider B 额度测试' }),
    });

    const data = await response.json();
    assert.equal(response.status, 429);
    assert.equal(data.success, false);
    assert.equal(data.failureReason, 'openapi_quota_exceeded');
    assert.match(data.error, /OpenAPI 今日额度已用尽/);
    assert.equal(JSON.stringify(data).includes('secret'), false);
  });
});

test('POST /api/ask can require a bearer token for server deployments', async () => {
  const app = makeApp({
    config: {
      ...baseConfig,
      security: { ...baseConfig.security, apiToken: 'server-token' },
    },
  });

  await withServer(app, async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '怎么报销？' }),
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer server-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: '怎么报销？' }),
    });
    assert.equal(authorized.status, 200);
  });
});

test('POST /internal/provider-a/deep-ask is gated by a separate VoiceRAG service token', async () => {
  const app = makeApp({
    config: {
      ...baseConfig,
      security: { ...baseConfig.security, internalServiceToken: 'voice-rag-service-token' },
    },
  });

  await withServer(app, async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/internal/provider-a/deep-ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '请深查' }),
    });
    assert.equal(denied.status, 401);

    const accepted = await fetch(`${baseUrl}/internal/provider-a/deep-ask`, {
      method: 'POST',
      headers: { Authorization: 'Bearer voice-rag-service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '请深查', conversationId: 'voice-deep-conversation-a' }),
    });
    const payload = await accepted.json();
    assert.equal(accepted.status, 200);
    assert.equal(payload.success, true);
  });
});

test('requireApiToken is a no-op when no token is configured', async () => {
  let called = false;
  const middleware = requireApiToken('');
  middleware({}, {}, () => {
    called = true;
  });
  assert.equal(called, true);
});

test('unconfigured CORS stays same-origin and configured origins receive explicit access', async () => {
  const sameOriginOnlyApp = makeApp({
    config: { ...baseConfig, security: { ...baseConfig.security, allowedOrigins: [] } },
  });
  await withServer(sameOriginOnlyApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { Origin: 'https://untrusted.example.com' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  const explicitOriginApp = makeApp({
    config: {
      ...baseConfig,
      security: { ...baseConfig.security, allowedOrigins: ['https://portal.example.com'] },
    },
  });
  await withServer(explicitOriginApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { Origin: 'https://portal.example.com' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://portal.example.com');
  });
});

test('security headers keep admin and main pages same-origin while allowing configured iframe origins', async () => {
  const app = makeApp({
    config: {
      ...baseConfig,
      security: {
        ...baseConfig.security,
        allowedOrigins: ['https://portal.example.com'],
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const main = await fetch(`${baseUrl}/`);
    assert.equal(main.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(main.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal(main.headers.get('x-content-type-options'), 'nosniff');

    const embed = await fetch(`${baseUrl}/embed.html`);
    assert.equal(embed.headers.get('x-frame-options'), null);
    assert.match(
      embed.headers.get('content-security-policy'),
      /frame-ancestors 'self' https:\/\/portal\.example\.com/,
    );
    assert.equal(embed.headers.get('cross-origin-resource-policy'), 'cross-origin');

    const admin = await fetch(`${baseUrl}/admin.html`);
    assert.equal(admin.headers.get('cache-control'), 'no-store');
    assert.equal(admin.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(await admin.text(), /id="exerciseConfirmDialog"/);

    const adminScript = await fetch(`${baseUrl}/admin.js`);
    assert.equal(adminScript.status, 200);
    assert.equal(adminScript.headers.get('cache-control'), 'no-store');
    const adminScriptText = await adminScript.text();
    const startExerciseSource = adminScriptText.slice(
      adminScriptText.indexOf('async function startExercise()'),
      adminScriptText.indexOf('async function cancelExercise()'),
    );
    assert.match(startExerciseSource, /function confirmExerciseStart\(/);
    assert.doesNotMatch(startExerciseSource, /window\.confirm\(/);
  });
});

test('POST /api/ask streams sources, deltas, and done events', async () => {
  const app = makeApp();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: '怎么报销？' }),
    });

    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(text, /event: sources/);
    assert.match(text, /event: delta/);
    assert.match(text, /需要提交发票/);
    assert.match(text, /event: done/);
  });
});

test('POST /api/ask JSON can proxy IMA Web Agent mode', async () => {
  const app = makeApp({
    config: { ...baseConfig, qaProvider: 'ima-web-agent' },
    imaWebAgentClient: {
      async *streamAsk() {
        yield {
          type: 'sources',
          searchSummary: '找到了106篇知识库资料',
          sources: [{ index: 1, title: 'Group One.md', snippet: '' }],
        };
        yield { type: 'delta', text: '3DGS 是三维高斯泼溅。' };
        yield { type: 'done' };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '3DGS 是什么？' }),
    });

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.equal(data.answer, '3DGS 是三维高斯泼溅。');
    assert.equal(data.searchSummary, '找到了106篇知识库资料');
    assert.deepEqual(data.sources, [{ index: 1, title: 'Group One.md', snippet: '' }]);
  });
});

test('POST /api/ask SSE can proxy IMA Web Agent mode', async () => {
  const app = makeApp({
    config: { ...baseConfig, qaProvider: 'ima-web-agent' },
    imaWebAgentClient: {
      async *streamAsk() {
        yield {
          type: 'sources',
          searchSummary: '找到了106篇知识库资料',
          sources: [{ index: 1, title: 'Group One.md', snippet: '' }],
        };
        yield { type: 'delta', text: '3DGS 是三维高斯泼溅。' };
        yield { type: 'done' };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: '3DGS 是什么？' }),
    });

    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /event: sources/);
    assert.match(text, /找到了106篇知识库资料/);
    assert.match(text, /event: delta/);
    assert.match(text, /3DGS 是三维高斯泼溅/);
    assert.match(text, /event: done/);
  });
});

test('POST /api/ask keeps Web Agent conversation session and rejects cross-client reuse', async () => {
  const calls = [];
  const app = makeApp({
    config: { ...baseConfig, qaProvider: 'ima-web-agent' },
    imaWebAgentClient: {
      async *streamAsk(options) {
        calls.push({ question: options.question, accountId: options.accountId, sessionId: options.sessionId });
        yield { type: 'route', accountId: 'account-a' };
        yield { type: 'session', sessionId: options.sessionId || 'session-created' };
        yield { type: 'delta', text: `回答 ${options.question}` };
        yield { type: 'done' };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IMA-Client-Id': 'client-a-1234567890' },
      body: JSON.stringify({ question: '第一问' }),
    });
    const firstPayload = await first.json();
    assert.equal(firstPayload.success, true);
    assert.match(firstPayload.conversationId, /^[0-9a-f-]{36}$/);

    const second = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IMA-Client-Id': 'client-a-1234567890' },
      body: JSON.stringify({ question: '第二问', conversationId: firstPayload.conversationId }),
    });
    const secondPayload = await second.json();
    assert.equal(secondPayload.success, true);
    assert.equal(calls[1].accountId, 'account-a');
    assert.equal(calls[1].sessionId, 'session-created');

    const foreign = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IMA-Client-Id': 'client-b-1234567890' },
      body: JSON.stringify({ question: '偷看', conversationId: firstPayload.conversationId }),
    });
    assert.equal(foreign.status, 404);
    assert.match((await foreign.json()).error, /会话不存在|已过期/);
  });
});

test('POST /api/ask preserves conversations for short trusted client IDs', async () => {
  const calls = [];
  const app = makeApp({
    config: { ...baseConfig, qaProvider: 'ima-web-agent' },
    imaWebAgentClient: {
      async *streamAsk(options) {
        calls.push({ accountId: options.accountId, sessionId: options.sessionId });
        yield { type: 'route', accountId: 'account-a' };
        yield { type: 'session', sessionId: options.sessionId || 'session-short-id' };
        yield { type: 'delta', text: '这是连续会话回答。' };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IMA-Client-Id': 'u1' },
      body: JSON.stringify({ question: '第一问' }),
    });
    const firstPayload = await first.json();
    const second = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-IMA-Client-Id': 'u1' },
      body: JSON.stringify({ question: '追问', conversationId: firstPayload.conversationId }),
    });
    const secondPayload = await second.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(secondPayload.conversationId, firstPayload.conversationId);
    assert.equal(calls[1].sessionId, 'session-short-id');
  });
});

test('GET /healthz exposes sanitized Web Agent auth status', async () => {
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      security: { ...baseConfig.security, healthDetails: 'auth' },
    },
    imaWebAgentClient: {
      getAuthStatus() {
        return {
          tokenExpiresAt: '2026-07-29T00:52:31.943Z',
          tokenSecondsRemaining: 3000,
          runtimePersistence: 'enabled',
        };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    const data = await response.json();
    assert.equal(data.provider, 'ima-web-agent');
    assert.equal(data.auth.tokenSecondsRemaining, 3000);
    assert.equal(data.auth.runtimePersistence, 'enabled');
    assert.equal(JSON.stringify(data).includes('x-ima-cookie'), false);
  });
});

test('GET /healthz defaults to basic queue status without auth details', async () => {
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      concurrency: { ...baseConfig.concurrency, maxConcurrentAsk: 2, queueLimit: 3 },
    },
    imaWebAgentClient: {
      getAuthStatus() {
        return { tokenSecondsRemaining: 3000 };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    const data = await response.json();
    assert.equal(data.provider, 'ima-web-agent');
    assert.equal(data.queue.maxConcurrent, 2);
    assert.equal(data.queue.queueLimit, 3);
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'auth'), false);
  });
});

test('GET /healthz exposes sanitized Provider B quota status', async () => {
  const app = makeApp({
    imaClient: {
      async searchKnowledge() {
        return [];
      },
      getQuotaStatus() {
        return {
          open: true,
          openedAt: '2026-07-30T00:00:00.000Z',
          code: 200005,
          message: 'IMA OpenAPI quota exceeded',
        };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);
    const data = await response.json();
    assert.equal(data.provider, 'openapi-mimo');
    assert.deepEqual(data.openApiQuota, {
      open: true,
      openedAt: '2026-07-30T00:00:00.000Z',
      code: 200005,
      message: 'IMA OpenAPI quota exceeded',
    });
    assert.equal(JSON.stringify(data).includes('ima-key'), false);
  });
});

test('admin routes can inspect and manage Web Agent accounts with token auth', async () => {
  const tempDir = await fsMkdtemp();
  const accountDirectory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });
  accountDirectory.upsertCapturedAccount({
    id: 'account-a',
    name: 'Account A',
    knowledgeBaseId: 'web-kb-id',
    runtimeEnvPath: path.join(tempDir, 'runtime', 'account-a.env'),
    headers: { 'x-ima-cookie': 'IMA-UID=u; IMA-TOKEN=t; IMA-REFRESH-TOKEN=r', 'x-ima-bkn': '123' },
  });

  const calls = [];
  const imaWebAgentClient = {
    syncAccounts(accounts) {
      calls.push({ type: 'sync', accounts });
    },
    stats() {
      return { totalAccounts: 1, availableAccounts: 1 };
    },
    async refreshAccount(accountId) {
      calls.push({ type: 'refresh', accountId });
      return { id: accountId, status: 'available' };
    },
    async checkAccount(accountId) {
      calls.push({ type: 'check', accountId });
      return { id: accountId, status: 'available' };
    },
    setAccountDisabled(accountId, disabled, reason) {
      calls.push({ type: 'disable', accountId, disabled, reason });
      return { id: accountId, status: disabled ? 'disabled' : 'available' };
    },
  };

  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      security: { ...baseConfig.security, adminToken: 'admin-token' },
      webAgent: { sharedKnowledgeBaseId: 'web-kb-id' },
    },
    accountDirectory,
    imaWebAgentClient,
  });

  await withServer(app, async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/api/admin/accounts`);
    assert.equal(unauthorized.status, 401);

    const listResponse = await fetch(`${baseUrl}/api/admin/accounts?details=1`, {
      headers: { Authorization: 'Bearer admin-token' },
    });
    const listData = await listResponse.json();
    assert.equal(listResponse.status, 200);
    assert.equal(listData.success, true);
    assert.equal(listData.accounts[0].name, 'Account A');
    assert.equal(JSON.stringify(listData).includes('IMA-TOKEN'), false);

    const bootstrapResponse = await fetch(`${baseUrl}/api/admin/bootstrap`, {
      headers: { Authorization: 'Bearer admin-token' },
    });
    const bootstrapData = await bootstrapResponse.json();
    assert.equal(bootstrapResponse.status, 200);
    assert.equal(bootstrapData.sharedKnowledgeBaseId, 'web-kb-id');
    assert.equal(bootstrapData.enrollment.requiresGuiMaintenanceMachine, true);

    const mismatchedAccount = await fetch(`${baseUrl}/api/admin/accounts`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 'wrong-kb',
        name: 'Wrong KB',
        knowledgeBaseId: 'other-kb',
        headers: { 'x-ima-cookie': 'IMA-UID=x; IMA-TOKEN=y', 'x-ima-bkn': '123' },
      }),
    });
    const mismatchData = await mismatchedAccount.json();
    assert.equal(mismatchedAccount.status, 409);
    assert.match(mismatchData.error, /同一个 IMA 共享知识库/);
    assert.equal(JSON.stringify(mismatchData).includes('IMA-TOKEN=y'), false);

    const duplicateAccount = await fetch(`${baseUrl}/api/admin/accounts`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 'ACCOUNT-A',
        name: 'Account-A',
        knowledgeBaseId: 'web-kb-id',
        headers: { 'x-ima-cookie': 'IMA-UID=x; IMA-TOKEN=y', 'x-ima-bkn': '123' },
      }),
    });
    assert.equal(duplicateAccount.status, 409);
    assert.match((await duplicateAccount.json()).error, /已存在.*replace/);

    const replacementAccount = await fetch(`${baseUrl}/api/admin/accounts`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 'account-a',
        name: 'Account A',
        knowledgeBaseId: 'web-kb-id',
        replace: true,
        headers: { 'x-ima-cookie': 'IMA-UID=x; IMA-TOKEN=y', 'x-ima-bkn': '123' },
      }),
    });
    assert.equal(replacementAccount.status, 200);
    assert.equal((await replacementAccount.json()).success, true);

    const disableResponse = await fetch(`${baseUrl}/api/admin/accounts/account-a/disable`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'maintenance' }),
    });
    const disableData = await disableResponse.json();
    assert.equal(disableResponse.status, 200);
    assert.equal(disableData.account.status, 'disabled');

    const enableResponse = await fetch(`${baseUrl}/api/admin/accounts/account-a/enable`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
    });
    const enableData = await enableResponse.json();
    assert.equal(enableResponse.status, 200);
    assert.equal(enableData.account.status, 'available');

    assert.ok(calls.some((call) => call.type === 'sync'));
    assert.ok(calls.some((call) => call.type === 'disable' && call.disabled === true));
    assert.ok(calls.some((call) => call.type === 'disable' && call.disabled === false));
  });
});

test('admin account operations use a first-party session context and return one consistent health projection', async () => {
  const tempDir = await fsMkdtemp();
  const accountDirectory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });
  accountDirectory.upsertCapturedAccount({
    id: 'account-health',
    name: 'Account Health',
    knowledgeBaseId: 'web-kb-id',
    headers: {
      'x-ima-cookie': 'IMA-UID=synthetic-user; IMA-TOKEN=synthetic-token; IMA-REFRESH-TOKEN=synthetic-refresh',
      'x-ima-bkn': '123',
    },
  });
  const initCalls = [];
  const pool = new IMAWebAgentPool(
    { accounts: accountDirectory.getPoolAccounts(), healthCheckTimeoutMs: 100 },
    {
      onAccountStateChange(snapshot) {
        accountDirectory.recordRuntimeState(snapshot);
      },
      onAccountCredentialsChange(accountId, snapshot) {
        accountDirectory.updateCredentialsFromClient(accountId, snapshot);
      },
      clientFactory(account) {
        return {
          applyConfig() {},
          createFirstPartyClientContext() {
            return { type: 'synthetic-first-party-context', owner: 'server' };
          },
          async initSession(options) {
            initCalls.push(options);
            return 'synthetic-session';
          },
          async refreshAuth() {},
          persistRuntimeEnv() {
            return true;
          },
          getConfigSnapshot() {
            return {
              id: account.id,
              name: account.name,
              knowledgeBaseId: account.knowledgeBaseId,
              headers: account.headers,
              modelId: account.modelId,
              modelType: account.modelType,
            };
          },
        };
      },
    },
  );
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      security: { ...baseConfig.security, adminToken: 'admin-token' },
      webAgent: { sharedKnowledgeBaseId: 'web-kb-id' },
    },
    accountDirectory,
    imaWebAgentClient: pool,
  });
  const headers = { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' };

  await withServer(app, async (baseUrl) => {
    const before = await (await fetch(`${baseUrl}/api/admin/accounts?details=1`, { headers })).json();
    assert.equal(before.summary.availableAccounts, 0);
    assert.equal(before.accounts[0].availabilityStatus, 'needs_check');
    assert.equal(before.accounts[0].health.local_schedulable, true);

    const check = await fetch(`${baseUrl}/api/admin/accounts/account-health/check`, {
      method: 'POST', headers, body: '{}',
    });
    const checked = await check.json();
    assert.equal(check.status, 200);
    assert.equal(checked.account.availabilityStatus, 'ready');
    assert.equal(checked.summary.availableAccounts, 1);
    assert.equal(checked.consistency.consistent, true);
    assert.equal(initCalls.length, 1);
    assert.equal(initCalls[0].clientContext.owner, 'server');
    assert.equal(initCalls[0].question, undefined);
    assert.equal(JSON.stringify(checked).includes('synthetic-token'), false);
    assert.equal(JSON.stringify(checked).includes('synthetic-refresh'), false);

    const refresh = await fetch(`${baseUrl}/api/admin/accounts/account-health/refresh`, {
      method: 'POST', headers, body: '{}',
    });
    const refreshed = await refresh.json();
    assert.equal(refresh.status, 200);
    assert.equal(refreshed.account.health.last_refresh_code, 'ok');
    assert.equal(initCalls.length, 2);

    const disabled = await (await fetch(`${baseUrl}/api/admin/accounts/account-health/disable`, {
      method: 'POST', headers, body: '{}',
    })).json();
    assert.equal(disabled.consistency.consistent, true);
    assert.equal(disabled.account.status, 'disabled');

    const enabled = await (await fetch(`${baseUrl}/api/admin/accounts/account-health/enable`, {
      method: 'POST', headers, body: '{}',
    })).json();
    assert.equal(enabled.consistency.consistent, true);
    assert.equal(enabled.account.status, 'available');

    const deleted = await (await fetch(`${baseUrl}/api/admin/accounts/account-health`, {
      method: 'DELETE', headers,
    })).json();
    assert.equal(deleted.account, null);
    assert.equal(deleted.consistency.consistent, true);
  });
});

test('admin health APIs persist fixed failure categories without leaking upstream details', async () => {
  const tempDir = await fsMkdtemp();
  const accountDirectory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });
  for (const id of ['account-expired', 'account-temporary', 'account-context']) {
    accountDirectory.upsertCapturedAccount({
      id,
      name: id,
      knowledgeBaseId: 'web-kb-id',
      headers: {
        'x-ima-cookie': `IMA-UID=${id}; IMA-TOKEN=synthetic-token; IMA-REFRESH-TOKEN=synthetic-refresh`,
        'x-ima-bkn': '123',
      },
    });
  }
  const pool = new IMAWebAgentPool(
    { accounts: accountDirectory.getPoolAccounts(), healthCheckTimeoutMs: 100 },
    {
      onAccountStateChange(snapshot) {
        accountDirectory.recordRuntimeState(snapshot);
      },
      clientFactory(account) {
        if (account.id === 'account-context') {
          return { async initSession() { return 'should-not-run'; } };
        }
        return {
          createFirstPartyClientContext() {
            return { type: 'synthetic-first-party-context' };
          },
          async initSession() {
            if (account.id === 'account-temporary') {
              throw new Error('fetch failed: synthetic network detail');
            }
            return 'synthetic-session';
          },
          async refreshAuth() {
            if (account.id === 'account-expired') {
              throw new Error('IMA Web login expired and refresh credentials are unavailable');
            }
          },
        };
      },
    },
  );
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      security: { ...baseConfig.security, adminToken: 'admin-token' },
      webAgent: { sharedKnowledgeBaseId: 'web-kb-id' },
    },
    accountDirectory,
    imaWebAgentClient: pool,
  });
  const headers = { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' };

  await withServer(app, async (baseUrl) => {
    const expired = await fetch(`${baseUrl}/api/admin/accounts/account-expired/refresh`, {
      method: 'POST', headers, body: '{}',
    });
    const expiredBody = await expired.json();
    assert.equal(expired.status, 422);
    assert.equal(expiredBody.code, 'auth_expired');
    assert.match(expiredBody.error, /重新扫码登录/);

    const temporary = await fetch(`${baseUrl}/api/admin/accounts/account-temporary/check`, {
      method: 'POST', headers, body: '{}',
    });
    const temporaryBody = await temporary.json();
    assert.equal(temporary.status, 502);
    assert.equal(temporaryBody.code, 'upstream_temporary');
    assert.equal(JSON.stringify(temporaryBody).includes('synthetic network detail'), false);

    const context = await fetch(`${baseUrl}/api/admin/accounts/account-context/check`, {
      method: 'POST', headers, body: '{}',
    });
    const contextBody = await context.json();
    assert.equal(context.status, 500);
    assert.equal(contextBody.code, 'web_context_missing');
    assert.equal(accountDirectory.listAccounts().find((account) => account.id === 'account-expired').health.session_valid, false);
    assert.equal(accountDirectory.listAccounts().find((account) => account.id === 'account-context').health.web_ready, false);
  });
});

test('admin enrollment routes require a token and keep QR screenshots private', async () => {
  const tempDir = await fsMkdtemp();
  const accountDirectory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });
  const calls = [];
  const enrollmentManager = {
    async start(input) {
      calls.push({ type: 'start', input });
      return {
        taskId: 'enrollment-1',
        name: input.name,
        state: 'waiting_for_scan',
        createdAt: '2026-08-19T00:00:00.000Z',
        expiresAt: '2026-08-19T00:05:00.000Z',
        qrAvailable: true,
        error: null,
        account: null,
      };
    },
    get(taskId) {
      calls.push({ type: 'get', taskId });
      return {
        taskId,
        name: 'account-c',
        state: 'completed',
        createdAt: '2026-08-19T00:00:00.000Z',
        expiresAt: '2026-08-19T00:05:00.000Z',
        qrAvailable: false,
        error: null,
        account: { id: 'account-c', name: 'account-c', status: 'available' },
      };
    },
    getQr(taskId) {
      calls.push({ type: 'qr', taskId });
      return Buffer.from('synthetic-qr-image');
    },
    getQrContentType(taskId) {
      calls.push({ type: 'qr-content-type', taskId });
      return 'image/jpeg';
    },
    async focusWindow(taskId) {
      calls.push({ type: 'focus-window', taskId });
      return {
        taskId,
        name: 'account-c',
        state: 'browser_fallback',
        qrAvailable: false,
        diagnostics: {
          browserFallbackAvailable: true,
          lastFailure: {
            code: 'qr_frame_timeout',
            stage: 'waiting_for_qr',
            message: '二维码框架未就绪',
            retryable: true,
            fallbackAvailable: true,
          },
        },
      };
    },
    async cancel(taskId) {
      calls.push({ type: 'cancel', taskId });
      return { taskId, name: 'account-c', state: 'cancelled', qrAvailable: false, error: '已取消账号接入' };
    },
  };
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      security: { ...baseConfig.security, adminToken: 'admin-token' },
      webAgent: { sharedKnowledgeBaseId: 'web-kb-id', enrollmentTimeoutMs: 300000 },
    },
    accountDirectory,
    imaWebAgentClient: { syncAccounts() {}, stats() { return {}; } },
    enrollmentManager,
  });

  await withServer(app, async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/api/admin/enrollments/enrollment-1/qr`);
    assert.equal(unauthorized.status, 401);
    assert.equal(calls.length, 0);

    const headers = { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' };
    const created = await fetch(`${baseUrl}/api/admin/enrollments`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'account-c', replace: false, knowledgeBaseId: 'attacker-kb' }),
    });
    const createdPayload = await created.json();
    assert.equal(created.status, 201);
    assert.equal(createdPayload.enrollment.taskId, 'enrollment-1');
    assert.deepEqual(calls[0].input, { name: 'account-c', id: undefined, replace: false, reauthAccountId: undefined, testQuestion: undefined });

    const qr = await fetch(`${baseUrl}/api/admin/enrollments/enrollment-1/qr`, {
      headers: { Authorization: 'Bearer admin-token' },
    });
    assert.equal(qr.status, 200);
    assert.equal(qr.headers.get('content-type'), 'image/jpeg');
    assert.equal(qr.headers.get('cache-control'), 'no-store, private');
    assert.equal(await qr.text(), 'synthetic-qr-image');

    const state = await fetch(`${baseUrl}/api/admin/enrollments/enrollment-1`, {
      headers: { Authorization: 'Bearer admin-token' },
    });
    assert.equal(state.status, 200);
    assert.equal((await state.json()).enrollment.account.name, 'account-c');

    const focused = await fetch(`${baseUrl}/api/admin/enrollments/enrollment-1/focus-window`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-token' },
    });
    assert.equal(focused.status, 200);
    assert.equal((await focused.json()).enrollment.state, 'browser_fallback');
    assert.ok(calls.some((call) => call.type === 'focus-window' && call.taskId === 'enrollment-1'));

    const cancelled = await fetch(`${baseUrl}/api/admin/enrollments/enrollment-1`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer admin-token' },
    });
    assert.equal(cancelled.status, 200);
    assert.ok(calls.some((call) => call.type === 'cancel'));
  });
});

test('tokenless local admin compatibility rejects cross-origin browser requests', async () => {
  const tempDir = await fsMkdtemp();
  const accountDirectory = new WebAgentAccountDirectory({
    storePath: path.join(tempDir, 'accounts.json'),
    keyPath: path.join(tempDir, 'accounts.key'),
  });
  const app = makeApp({
    config: { ...baseConfig, qaProvider: 'ima-web-agent', webAgent: { sharedKnowledgeBaseId: 'web-kb-id' } },
    accountDirectory,
    imaWebAgentClient: { syncAccounts() {} },
  });

  await withServer(app, async (baseUrl) => {
    const local = await fetch(`${baseUrl}/api/admin/bootstrap`);
    assert.equal(local.status, 200);

    const crossOrigin = await fetch(`${baseUrl}/api/admin/bootstrap`, {
      headers: { Origin: 'https://untrusted.example.com' },
    });
    assert.equal(crossOrigin.status, 403);
  });
});

test('POST /api/ask rate limits by client IP', async () => {
  const app = makeApp({
    config: {
      ...baseConfig,
      rateLimit: { windowMs: 60000, max: 1 },
    },
  });

  await withServer(app, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '怎么报销？' }),
    });
    const second = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '怎么报销？' }),
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
    const data = await second.json();
    assert.match(data.error, /频繁/);
    assert.match(second.headers.get('retry-after'), /\d+/);
  });
});

test('POST /api/ask can rate limit with trusted X-Forwarded-For clients', async () => {
  const app = makeApp({
    config: {
      ...baseConfig,
      security: { ...baseConfig.security, trustProxy: true },
      rateLimit: { windowMs: 60000, max: 1 },
    },
  });

  await withServer(app, async (baseUrl) => {
    const request = (ip) =>
      fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
        body: JSON.stringify({ question: '怎么报销？' }),
      });

    assert.equal((await request('203.0.113.1')).status, 200);
    assert.equal((await request('203.0.113.2')).status, 200);
    assert.equal((await request('203.0.113.1')).status, 429);
  });
});

test('POST /api/ask queues concurrent Web Agent requests and rejects when queue is full', async () => {
  let releaseFirst;
  let activeStreams = 0;
  let streamCalls = 0;
  const firstBlocker = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      concurrency: { ...baseConfig.concurrency, maxConcurrentAsk: 1, queueLimit: 1 },
    },
    imaWebAgentClient: {
      async *streamAsk() {
        streamCalls += 1;
        activeStreams += 1;
        if (streamCalls === 1) {
          await firstBlocker;
        }
        yield {
          type: 'sources',
          searchSummary: '找到了1篇知识库资料',
          sources: [{ index: streamCalls, title: `资料 ${streamCalls}`, snippet: '' }],
        };
        yield { type: 'delta', text: `答案 ${streamCalls}` };
        yield { type: 'done' };
        activeStreams -= 1;
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const first = fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '问题1' }),
    });
    await waitFor(() => streamCalls === 1 && activeStreams === 1);

    const second = fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '问题2' }),
    });
    await waitForHealth(baseUrl, (health) => health.queue.activeRequests === 1 && health.queue.queuedRequests === 1);

    const third = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '问题3' }),
    });
    assert.equal(third.status, 429);

    releaseFirst();
    const firstData = await (await first).json();
    const secondData = await (await second).json();
    assert.equal(firstData.answer, '答案 1');
    assert.equal(secondData.answer, '答案 2');
    const finalHealth = await (await fetch(`${baseUrl}/healthz`)).json();
    assert.equal(finalHealth.queue.activeRequests, 0);
    assert.equal(finalHealth.queue.queuedRequests, 0);
  });
});

test('POST /api/ask aborts active Web Agent requests on timeout and releases the slot', async () => {
  let streamCalls = 0;
  let aborts = 0;
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      concurrency: { maxConcurrentAsk: 1, queueLimit: 1, requestTimeoutMs: 30 },
    },
    imaWebAgentClient: {
      async *streamAsk({ signal }) {
        streamCalls += 1;
        if (streamCalls === 1) {
          await new Promise((resolve, reject) => {
            if (signal.aborted) {
              aborts += 1;
              reject(new Error('aborted'));
              return;
            }
            signal.addEventListener(
              'abort',
              () => {
                aborts += 1;
                reject(new Error('aborted'));
              },
              { once: true },
            );
          });
        }
        yield { type: 'delta', text: `答案 ${streamCalls}` };
        yield { type: 'done' };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '慢问题' }),
    });
    assert.equal(first.status, 504);
    assert.match((await first.json()).error, /超时/);
    assert.equal(aborts, 1);

    const afterTimeoutHealth = await (await fetch(`${baseUrl}/healthz`)).json();
    assert.equal(afterTimeoutHealth.queue.activeRequests, 0);
    assert.equal(afterTimeoutHealth.queue.queuedRequests, 0);

    const second = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '后续问题' }),
    });
    const data = await second.json();
    assert.equal(second.status, 200);
    assert.equal(data.answer, '答案 2');
  });
});

test('POST /api/ask releases the slot when the client disconnects', async () => {
  let streamCalls = 0;
  let aborts = 0;
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      concurrency: { maxConcurrentAsk: 1, queueLimit: 1, requestTimeoutMs: 1000 },
    },
    imaWebAgentClient: {
      async *streamAsk({ signal }) {
        streamCalls += 1;
        await new Promise((resolve, reject) => {
          if (signal.aborted) {
            aborts += 1;
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              aborts += 1;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
        yield { type: 'delta', text: '不会走到这里' };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const controller = new AbortController();
    const request = fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ question: '断开连接测试' }),
    }).catch(() => null);

    await waitFor(() => streamCalls === 1);
    controller.abort();
    await request;
    await waitForHealth(baseUrl, (health) => health.queue.activeRequests === 0 && health.queue.queuedRequests === 0);
    assert.equal(aborts, 1);
  });
});

test('POST /api/ask times out queued Web Agent requests', async () => {
  let releaseFirst;
  const firstBlocker = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let streamCalls = 0;
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      concurrency: { maxConcurrentAsk: 1, queueLimit: 1, requestTimeoutMs: 30 },
    },
    imaWebAgentClient: {
      async *streamAsk() {
        streamCalls += 1;
        if (streamCalls === 1) {
          await firstBlocker;
        }
        yield { type: 'delta', text: '答案' };
        yield { type: 'done' };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const first = fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '问题1' }),
    });
    await waitFor(() => streamCalls === 1);

    const second = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '问题2' }),
    });
    assert.equal(second.status, 504);
    assert.match((await second.json()).error, /超时/);

    releaseFirst();
    await first;
  });
});

test('POST /api/ask keeps answers and sources isolated across 10 concurrent Web Agent requests', async () => {
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      concurrency: { maxConcurrentAsk: 6, queueLimit: 30, requestTimeoutMs: 1000 },
    },
    imaWebAgentClient: {
      async *streamAsk({ question }) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield {
          type: 'sources',
          searchSummary: `只检索 ${question}`,
          sources: [{ index: 1, title: `资料 ${question}`, snippet: '' }],
        };
        yield { type: 'delta', text: `答案 ${question}` };
        yield { type: 'done' };
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const questions = Array.from({ length: 10 }, (_, index) => `问题${index + 1}`);
    const responses = await Promise.all(
      questions.map((question) =>
        fetch(`${baseUrl}/api/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question }),
        }),
      ),
    );
    const payloads = await Promise.all(responses.map((response) => response.json()));

    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 200);
      assert.equal(payloads[index].answer, `答案 ${questions[index]}`);
      assert.deepEqual(payloads[index].sources, [
        { index: 1, title: `资料 ${questions[index]}`, snippet: '' },
      ]);
      assert.equal(payloads[index].searchSummary, `只检索 ${questions[index]}`);
    }

    const finalHealth = await (await fetch(`${baseUrl}/healthz`)).json();
    assert.equal(finalHealth.queue.activeRequests, 0);
    assert.equal(finalHealth.queue.queuedRequests, 0);
  });
});

test('POST /api/ask uses a five-account Web Agent pool without sharing account concurrency', async () => {
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const accountNames = ['account-a', 'account-b', 'account-c', 'account-d', 'account-e'];
  const activeByAccount = new Map();
  const maxActiveByAccount = new Map();
  let startedStreams = 0;
  const pool = new IMAWebAgentPool(
    {
      accounts: accountNames.map((name) => ({
        name,
        knowledgeBaseId: 'web-kb-id',
        headers: { 'x-ima-cookie': `${name}-cookie`, 'x-ima-bkn': '123' },
        modelId: 'official_3',
        modelType: 3,
      })),
      accountCooldownMs: 120000,
      accountMaxConsecutiveErrors: 2,
    },
    {
      clientFactory(account) {
        return {
          async *streamAsk({ question }) {
            startedStreams += 1;
            const nextActive = (activeByAccount.get(account.name) || 0) + 1;
            activeByAccount.set(account.name, nextActive);
            maxActiveByAccount.set(
              account.name,
              Math.max(maxActiveByAccount.get(account.name) || 0, nextActive),
            );
            await blocker;
            yield {
              type: 'sources',
              searchSummary: `${account.name} 检索 ${question}`,
              sources: [{ index: 1, title: `${account.name} 资料`, snippet: '' }],
            };
            yield { type: 'delta', text: `${account.name} 回答 ${question}` };
            yield { type: 'done' };
            activeByAccount.set(account.name, activeByAccount.get(account.name) - 1);
          },
        };
      },
    },
  );
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      concurrency: { maxConcurrentAsk: 5, queueLimit: 10, requestTimeoutMs: 1000 },
    },
    imaWebAgentClient: pool,
  });

  await withServer(app, async (baseUrl) => {
    const questions = Array.from({ length: 10 }, (_, index) => `问题${index + 1}`);
    const responses = questions.map((question) =>
      fetch(`${baseUrl}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      }),
    );

    await waitFor(() => startedStreams === 5);
    await waitForHealth(baseUrl, (health) => (
      health.queue.activeRequests === 5 &&
      health.queue.queuedRequests === 5 &&
      health.webAgentPool.busyAccounts === 5
    ));

    release();
    const payloads = await Promise.all(responses.map(async (response) => (await response).json()));
    for (const payload of payloads) {
      assert.equal(payload.success, true);
      assert.match(payload.answer, /account-[a-e] 回答 问题\d+/);
      assert.match(payload.searchSummary, /account-[a-e] 检索 问题\d+/);
      assert.equal(payload.sources.length, 1);
    }

    for (const name of accountNames) {
      assert.equal(maxActiveByAccount.get(name), 1);
    }
    const finalHealth = await (await fetch(`${baseUrl}/healthz`)).json();
    assert.equal(finalHealth.queue.activeRequests, 0);
    assert.equal(finalHealth.queue.queuedRequests, 0);
    assert.equal(finalHealth.webAgentPool.availableAccounts, 5);
  });
});

test('GET /healthz exposes Web Agent pool details only in auth mode', async () => {
  const pool = new IMAWebAgentPool(
    {
      accounts: [
        {
          name: 'account-a',
          knowledgeBaseId: 'web-kb-id',
          headers: { 'x-ima-cookie': 'cookie-a', 'x-ima-bkn': '123' },
          modelId: 'official_3',
          modelType: 3,
        },
      ],
      accountCooldownMs: 120000,
      accountMaxConsecutiveErrors: 2,
    },
    {
      clientFactory() {
        return {
          getAuthStatus() {
            return { tokenSecondsRemaining: 3000, runtimePersistence: 'enabled' };
          },
          async *streamAsk() {
            yield { type: 'done' };
          },
        };
      },
    },
  );

  const basicApp = makeApp({
    config: { ...baseConfig, qaProvider: 'ima-web-agent' },
    imaWebAgentClient: pool,
  });
  await withServer(basicApp, async (baseUrl) => {
    const data = await (await fetch(`${baseUrl}/healthz`)).json();
    assert.equal(data.webAgentPool.totalAccounts, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(data.webAgentPool, 'accounts'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'auth'), false);
  });

  const authApp = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'ima-web-agent',
      security: { ...baseConfig.security, healthDetails: 'auth' },
    },
    imaWebAgentClient: pool,
  });
  await withServer(authApp, async (baseUrl) => {
    const data = await (await fetch(`${baseUrl}/healthz`)).json();
    assert.equal(data.webAgentPool.accounts[0].auth.tokenSecondsRemaining, 3000);
    assert.equal(JSON.stringify(data).includes('cookie-a'), false);
  });
});

test('POST /api/ask JSON strips external-channel advice from model output', async () => {
  const app = makeApp({
    mimoClient: {
      async *streamAnswer() {
        yield '知识库内没有包含报销流程信息。';
        yield '建议您咨询所在组织的财务部门。';
        yield '可以换一个更贴近本共享知识库的问题。';
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '报销流程是什么？' }),
    });

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.match(data.answer, /知识库内没有包含报销流程信息/);
    assert.doesNotMatch(data.answer, /财务部门/);
    assert.match(data.answer, /更贴近本共享知识库/);
  });
});

test('POST /api/ask SSE strips external-channel advice from streamed output', async () => {
  const app = makeApp({
    mimoClient: {
      async *streamAnswer() {
        yield '知识库内没有包含报销流程信息。';
        yield '建议您咨询财务或行政部门。';
        yield '可以换一个更贴近本共享知识库的问题。';
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: '报销流程是什么？' }),
    });

    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /知识库内没有包含报销流程信息/);
    assert.doesNotMatch(text, /财务|行政部门/);
    assert.match(text, /更贴近本共享知识库/);
  });
});

test('POST /api/ask does not call MIMO when IMA returns no sources', async () => {
  let mimoCalled = false;
  const app = makeApp({
    imaClient: {
      async searchKnowledge() {
        return [];
      },
    },
    mimoClient: {
      async *streamAnswer() {
        mimoCalled = true;
        yield 'should not happen';
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '未知问题' }),
    });

    const data = await response.json();
    assert.equal(data.answer, noReliableContentAnswer());
    assert.deepEqual(data.sources, []);
    assert.equal(mimoCalled, false);
  });
});

test('POST /api/ask does not call MIMO when local RAG relevance gate returns no sources', async () => {
  let mimoCalled = false;
  const app = makeApp({
    config: {
      ...baseConfig,
      qaProvider: 'local-rag-mimo',
    },
    localRagClient: {
      async retrieveEvidencePack() {
        return {
          sources: [],
          diagnostics: {
            provider: 'local-rag-mimo',
            relevanceGate: {
              accepted: false,
              reason: 'off_domain_generic_question',
            },
            publicSourceCount: 0,
          },
        };
      },
    },
    mimoClient: {
      async *streamAnswer() {
        mimoCalled = true;
        yield 'should not happen';
      },
    },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IMA-QA-Eval': '1',
      },
      body: JSON.stringify({ question: '今天晚上吃什么？' }),
    });

    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.answer, noReliableContentAnswer());
    assert.deepEqual(data.sources, []);
    assert.equal(data.diagnostics.relevanceGate.accepted, false);
    assert.equal(mimoCalled, false);
  });
});

test('debug knowledge-base listing endpoint is not exposed', async () => {
  const app = makeApp();

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/knowledge-bases`);
    assert.equal(response.status, 404);
  });
});

test('sanitizeKnowledgeBoundAnswer removes outside-source recommendations', () => {
  const answer = sanitizeKnowledgeBoundAnswer(
    '当前知识库没有定义。报销流程通常属于公司行政、财务或人力资源范畴。建议您咨询所在组织的财务部门。可以换一个更贴近本共享知识库的问题。',
  );

  assert.match(answer, /当前知识库没有定义/);
  assert.doesNotMatch(answer, /行政|财务|人力资源|咨询/);
  assert.match(answer, /更贴近本共享知识库/);
});

test('local RAG fallback helpers detect mechanical refusal and build topical answers', () => {
  const refusal = noReliableContentAnswer();
  const sources = [
    {
      title: 'group1 / 2026-04-01',
      snippet: 'Kiri 是高斯转mesh，用一般的3D打印机也能正常打；左边是高斯，右边是可被3D打印的网格。',
    },
  ];

  assert.equal(isMechanicalNoReliableAnswer(refusal), true);
  assert.equal(shouldUseLocalRagFallback('local-rag-mimo', refusal, sources), true);
  assert.equal(shouldUseLocalRagFallback('openapi-mimo', refusal, sources), false);
  assert.match(
    buildLocalRagFallbackAnswer('如何将3DGS模型转换成网格 Mesh 或用于3D打印？', sources),
    /网格化后的可打印结果/,
  );
});
