const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildRuntimeEnvText,
  extractExpiryMs,
  getBkn,
  IMAWebAgentClient,
  mapIMAWebAgentEvent,
  parseCookieHeader,
  parseIMAWebAgentEvent,
  stringifyCookie,
} = require('../src/ima-web-agent-client');

function sseStream(blocks) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(blocks.join('\n\n')));
      controller.close();
    },
  });
}

test('parseIMAWebAgentEvent parses named JSON SSE events', () => {
  const event = parseIMAWebAgentEvent(
    'event: MESSAGE\ndata: {"Text":"答案片段"}',
  );

  assert.equal(event.eventName, 'MESSAGE');
  assert.deepEqual(event.data, { Text: '答案片段' });
});

test('mapIMAWebAgentEvent maps sources, deltas, and completion', () => {
  const seen = new Set();
  const sources = mapIMAWebAgentEvent(
    {
      eventName: 'SEARCH_MEDIAS',
      data: {
        processing: '找到了106篇知识库资料',
        medias: [
          { id: 'm1', title: 'Group One.md', type: 7 },
          { id: 'm1', title: '重复', type: 7 },
        ],
      },
    },
    seen,
  );

  assert.deepEqual(sources, {
    type: 'sources',
    searchSummary: '找到了106篇知识库资料',
    sources: [{ index: 1, title: 'Group One.md', snippet: '' }],
  });
  assert.deepEqual(
    mapIMAWebAgentEvent({ eventName: 'MESSAGE', data: { Text: '3DGS 是三维高斯泼溅。' } }, seen),
    { type: 'delta', text: '3DGS 是三维高斯泼溅。' },
  );
  assert.deepEqual(mapIMAWebAgentEvent({ eventName: 'COMPLETED', data: { Code: 0 } }, seen), {
    type: 'done',
  });
});

test('IMAWebAgentClient sends init_session then assistant/qa and streams mapped events', async () => {
  const requests = [];
  const fetchMock = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), headers: options.headers });

    if (url.endsWith('/init_session')) {
      return new Response(JSON.stringify({ code: 0, session_id: 'session-1' }), { status: 200 });
    }

    if (url.endsWith('/assistant/qa')) {
      return new Response(
        sseStream([
          'event: SEARCH_MEDIAS\ndata: {"processing":"找到了2篇知识库资料","medias":[{"id":"m1","title":"资料 A","type":7}]}',
          'event: MESSAGE\ndata: {"Text":"答案"}',
          'event: COMPLETED\ndata: {"Code":0,"Msg":""}',
        ]),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  const client = new IMAWebAgentClient(
    {
      knowledgeBaseId: 'web-kb-id',
      headers: { 'x-ima-cookie': 'cookie', 'x-ima-bkn': '123' },
      modelId: 'official_3',
      modelType: 3,
    },
    fetchMock,
  );

  const events = [];
  for await (const event of client.streamAsk({ question: '3DGS 是什么？' })) {
    events.push(event);
  }

  assert.equal(requests[0].url, 'https://ima.qq.com/cgi-bin/session_logic/init_session');
  assert.equal(requests[0].body.knowledgeBaseInfoWithFolder.knowledgeBaseId, 'web-kb-id');
  assert.equal(requests[0].headers['x-ima-cookie'], 'cookie');
  assert.equal(requests[1].url, 'https://ima.qq.com/cgi-bin/assistant/qa');
  assert.equal(requests[1].body.question, '3DGS 是什么？');
  assert.equal(requests[1].body.model_info.model_id, 'official_3');
  assert.deepEqual(events, [
    {
      type: 'sources',
      searchSummary: '找到了2篇知识库资料',
      sources: [{ index: 1, title: '资料 A', snippet: '' }],
    },
    { type: 'delta', text: '答案' },
    { type: 'done' },
  ]);
});

test('IMAWebAgentClient refreshes expired web auth and retries init_session once', async () => {
  const requests = [];
  let initCount = 0;
  const fetchMock = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), headers: options.headers });

    if (url.endsWith('/init_session')) {
      initCount += 1;
      if (initCount === 1) {
        return new Response(JSON.stringify({ code: 41, msg: '登录失败，请重新登录' }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ code: 0, session_id: 'session-2' }), { status: 200 });
    }

    if (url.endsWith('/auth_login/refresh')) {
      assert.equal(JSON.parse(options.body).refresh_token, 'refresh-old');
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            token: 'token-new',
            refreshToken: 'refresh-new',
            userId: 'user-1',
            tokenType: 0,
          },
        }),
        { status: 200 },
      );
    }

    if (url.endsWith('/assistant/qa')) {
      return new Response(
        sseStream([
          'event: MESSAGE\ndata: {"Text":"续期后回答"}',
          'event: COMPLETED\ndata: {"Code":0,"Msg":""}',
        ]),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  const cookie = stringifyCookie({
    'IMA-UID': 'user-1',
    'IMA-TOKEN': 'token-old',
    'IMA-REFRESH-TOKEN': 'refresh-old',
    'TOKEN-TYPE': '0',
  });
  const client = new IMAWebAgentClient(
    {
      knowledgeBaseId: 'web-kb-id',
      headers: { 'x-ima-cookie': cookie, 'x-ima-bkn': String(getBkn('token-old')) },
      modelId: 'official_3',
      modelType: 3,
    },
    fetchMock,
  );

  const events = [];
  for await (const event of client.streamAsk({ question: '问题' })) {
    events.push(event);
  }

  const refreshedInit = requests.filter((request) => request.url.endsWith('/init_session'))[1];
  const refreshedCookie = parseCookieHeader(refreshedInit.headers['x-ima-cookie']);
  assert.equal(refreshedCookie['IMA-TOKEN'], 'token-new');
  assert.equal(refreshedCookie['IMA-REFRESH-TOKEN'], 'refresh-new');
  assert.deepEqual(events, [{ type: 'delta', text: '续期后回答' }, { type: 'done' }]);
});

test('IMAWebAgentClient proactively refreshes near-expired auth and persists runtime env', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-web-agent-'));
  const runtimeEnvPath = path.join(tempDir, 'ima-web-agent.env');
  const cookie = stringifyCookie({
    'IMA-UID': 'user-1',
    'IMA-TOKEN': 'token-old',
    'IMA-REFRESH-TOKEN': 'refresh-old',
    'TOKEN-TYPE': '0',
  });
  const requests = [];
  const fetchMock = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body), headers: options.headers });

    if (url.endsWith('/auth_login/refresh')) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            token: 'token-new',
            refreshToken: 'refresh-new',
            userId: 'user-1',
            tokenType: 0,
            tokenValidTime: 7200,
            refreshTokenValidTime: 2592000,
          },
        }),
        { status: 200 },
      );
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  const client = new IMAWebAgentClient(
    {
      knowledgeBaseId: 'web-kb-id',
      headers: { 'x-ima-cookie': cookie, 'x-ima-bkn': String(getBkn('token-old')) },
      modelId: 'official_3',
      modelType: 3,
      runtimeEnvPath,
      tokenExpiresAt: Date.now() + 1000,
      refreshTokenExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      refreshSkewMs: 600000,
      refreshIntervalMs: 0,
    },
    fetchMock,
  );

  assert.equal(await client.ensureFreshAuth(), true);

  const persisted = fs.readFileSync(runtimeEnvPath, 'utf8');
  const mode = fs.statSync(runtimeEnvPath).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.match(persisted, /IMA_QA_PROVIDER=ima-web-agent/);
  assert.match(persisted, /IMA_WEB_AGENT_RUNTIME_ENV_PATH=/);
  assert.match(persisted, /IMA_WEB_AGENT_TOKEN_EXPIRES_AT=/);
  assert.doesNotMatch(persisted, /token-old/);
  assert.match(persisted, /token-new/);
  assert.equal(requests.length, 1);
});

test('buildRuntimeEnvText and extractExpiryMs format local service state', () => {
  const text = buildRuntimeEnvText({
    port: 3117,
    knowledgeBaseId: 'web-kb-id',
    headers: { 'x-ima-cookie': 'a=b', 'x-ima-bkn': '123' },
    modelId: 'official_3',
    modelType: 3,
    runtimeEnvPath: '/tmp/ima.env',
    tokenExpiresAt: 1785257551943,
    refreshTokenExpiresAt: 1787842056525,
    refreshSkewMs: 600000,
    refreshIntervalMs: 60000,
  });

  assert.match(text, /PORT='3117'/);
  assert.match(text, /IMA_WEB_AGENT_HEADERS_JSON=/);
  assert.equal(extractExpiryMs({ tokenExpiredTime: 1785257551943 }, ['tokenExpiredTime']), 1785257551943);
  assert.equal(extractExpiryMs({ tokenExpiredTime: 1785257551 }, ['tokenExpiredTime']), 1785257551000);
});
