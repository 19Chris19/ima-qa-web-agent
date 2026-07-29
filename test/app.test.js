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
