const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const {
  createApp,
  noReliableContentAnswer,
  requireApiToken,
  sanitizeKnowledgeBoundAnswer,
} = require('../src/app');

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
    allowedOrigins: [],
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

function makeApp(overrides = {}) {
  return createApp({
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
  });
}

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

test('requireApiToken is a no-op when no token is configured', async () => {
  let called = false;
  const middleware = requireApiToken('');
  middleware({}, {}, () => {
    called = true;
  });
  assert.equal(called, true);
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

test('GET /healthz exposes sanitized Web Agent auth status', async () => {
  const app = makeApp({
    config: { ...baseConfig, qaProvider: 'ima-web-agent' },
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
