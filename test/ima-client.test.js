const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildQueryCandidates,
  IMAClient,
  looksLikeBinarySource,
  normalizeKnowledgeResults,
} = require('../src/ima-client');

test('IMAClient sends search_knowledge to the exact shared knowledge base', async () => {
  const requests = [];
  const fetchMock = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    if (url.endsWith('/get_knowledge_base')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: { infos: { 'shared-only': { name: '共享库', recommended_questions: [] } } },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith('/get_knowledge_list')) {
      return new Response(
        JSON.stringify({ code: 0, msg: 'success', data: { knowledge_list: [] } }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        code: 0,
        msg: 'success',
        data: {
          info_list: [
            {
              media_id: 'm1',
              title: '资料 A',
              highlight_content: '答案片段',
            },
          ],
        },
      }),
      { status: 200 },
    );
  };

  const client = new IMAClient(
    {
      clientId: 'client-id',
      apiKey: 'api-key',
      sharedKnowledgeBaseId: 'shared-only',
      maxSources: 6,
      maxSnippetLength: 900,
    },
    fetchMock,
  );

  const sources = await client.searchKnowledge('怎么报销？');

  const searchRequest = requests.find((request) => request.url.endsWith('/search_knowledge'));
  assert.equal(searchRequest.url, 'https://ima.qq.com/openapi/wiki/v1/search_knowledge');
  assert.equal(searchRequest.options.method, 'POST');
  assert.equal(searchRequest.options.headers['ima-openapi-clientid'], 'client-id');
  assert.equal(searchRequest.options.headers['ima-openapi-apikey'], 'api-key');
  assert.deepEqual(searchRequest.body, {
    query: '怎么报销？',
    cursor: '',
    knowledge_base_id: 'shared-only',
  });
  assert.deepEqual(sources, [
    { index: 1, title: '资料 A', snippet: '答案片段' },
    { index: 2, title: '共享库', snippet: '知识库名称：共享库' },
  ]);
});

test('IMAClient falls back to domain keywords and enriches note sources', async () => {
  const requests = [];
  const fetchMock = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });

    if (url.endsWith('/search_knowledge') && requests.length === 1) {
      return new Response(JSON.stringify({ code: 0, msg: 'success', data: { info_list: [] } }));
    }

    if (url.endsWith('/search_knowledge')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            info_list: [
              {
                media_id: 'note-media',
                title: '欢迎来到 3DGS 共享知识库',
                highlight_content: '',
              },
            ],
          },
        }),
      );
    }

    if (url.endsWith('/get_media_info')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            media_type: 11,
            notebook_ext_info: { notebook_id: 'note-id' },
          },
        }),
      );
    }

    if (url.endsWith('/get_doc_content')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: { content: '这是 3DGS 共享知识库的使用说明。' },
        }),
      );
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  const client = new IMAClient(
    {
      clientId: 'client-id',
      apiKey: 'api-key',
      sharedKnowledgeBaseId: 'shared-only',
      maxSources: 6,
      maxSnippetLength: 900,
      maxSourceContentLength: 1800,
    },
    fetchMock,
  );

  const sources = await client.searchKnowledge('3DGS 是什么？');

  assert.equal(requests[0].body.query, '3DGS 是什么？');
  assert.equal(requests[1].body.query, '3DGS');
  assert.deepEqual(sources, [
    {
      index: 1,
      title: '欢迎来到 3DGS 共享知识库',
      snippet: '这是 3DGS 共享知识库的使用说明。',
    },
  ]);
});

test('IMAClient keeps searching rewritten queries after the first grounded hit', async () => {
  const requests = [];
  const fetchMock = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });

    if (url.endsWith('/search_knowledge')) {
      const query = JSON.parse(options.body).query;
      const title = query === '3DGS 是什么？' ? '概念资料' : '工具资料';
      const snippet = query === '3DGS 是什么？' ? '3DGS 是一种三维技术。' : 'Postshot、SuperSplat 常用于 3DGS 流程。';
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            is_end: true,
            info_list: [{ media_id: query, title, highlight_content: snippet }],
          },
        }),
      );
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  const client = new IMAClient(
    {
      clientId: 'client-id',
      apiKey: 'api-key',
      sharedKnowledgeBaseId: 'shared-only',
      maxSources: 2,
      maxSnippetLength: 900,
    },
    fetchMock,
  );

  const sources = await client.searchKnowledge('3DGS 是什么？');
  const searchedQueries = requests
    .filter((request) => request.url.endsWith('/search_knowledge'))
    .map((request) => request.body.query);

  assert.deepEqual(searchedQueries, ['3DGS 是什么？', '3DGS']);
  assert.deepEqual(
    sources.map((source) => source.title),
    ['概念资料', '工具资料'],
  );
});

test('IMAClient appends shared knowledge base profile to grounded results', async () => {
  const requests = [];
  const fetchMock = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });

    if (url.endsWith('/search_knowledge')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            info_list: [
              {
                media_id: 'welcome-note',
                title: '欢迎来到 3DGS 共享知识库',
                highlight_content: '基于四个 3DGS 群长期聊天的真实经验。',
              },
            ],
          },
        }),
      );
    }

    if (url.endsWith('/get_knowledge_base')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            infos: {
              'shared-only': {
                name: '共享知识库',
                description: '',
                recommended_questions: ['新手入门3D高斯泼溅，需要什么设备和软件？'],
              },
            },
          },
        }),
      );
    }

    if (url.endsWith('/get_knowledge_list')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            knowledge_list: [
              { title: '欢迎来到 3DGS 共享知识库' },
              { title: 'NotebookLM-group4-raw' },
            ],
          },
        }),
      );
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  const client = new IMAClient(
    {
      clientId: 'client-id',
      apiKey: 'api-key',
      sharedKnowledgeBaseId: 'shared-only',
      maxSources: 6,
      maxSnippetLength: 900,
      maxSourceContentLength: 1800,
    },
    fetchMock,
  );

  const sources = await client.searchKnowledge('3DGS 是什么？');

  assert.equal(
    requests.every(
      (request) =>
        request.body.knowledge_base_id === 'shared-only' || request.body.ids?.[0] === 'shared-only',
    ),
    true,
  );
  assert.equal(sources.length, 2);
  assert.equal(sources[0].title, '欢迎来到 3DGS 共享知识库');
  assert.equal(sources[1].title, '共享知识库');
  assert.match(sources[1].snippet, /3D高斯泼溅/);
});

test('IMAClient builds a shared corpus overview from raw knowledge folders', async () => {
  const fetchMock = async (url, options) => {
    const body = JSON.parse(options.body);

    if (url.endsWith('/search_knowledge')) {
      return new Response(JSON.stringify({ code: 0, msg: 'success', data: { info_list: [] } }));
    }

    if (url.endsWith('/get_knowledge_base')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            infos: {
              'shared-only': {
                name: '共享知识库',
                recommended_questions: ['新手入门3D高斯泼溅，需要什么设备和软件？'],
              },
            },
          },
        }),
      );
    }

    if (url.endsWith('/get_knowledge_list') && !body.folder_id) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            is_end: true,
            knowledge_list: [
              { media_id: 'folder-raw', media_type: 99, title: 'NotebookLM-group1-raw' },
              { media_id: 'note-welcome', media_type: 11, title: '欢迎来到 3DGS 共享知识库' },
            ],
          },
        }),
      );
    }

    if (url.endsWith('/get_knowledge_list') && body.folder_id === 'folder-raw') {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            is_end: true,
            knowledge_list: [
              { media_id: 'raw-1', media_type: 7, title: '2026-07-27 Group One RAW L10V8' },
              { media_id: 'raw-2', media_type: 7, title: '2026-07-26 Group One RAW L6V0' },
            ],
          },
        }),
      );
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  const client = new IMAClient(
    {
      clientId: 'client-id',
      apiKey: 'api-key',
      sharedKnowledgeBaseId: 'shared-only',
      maxSources: 6,
      maxSnippetLength: 900,
      maxSourceContentLength: 1800,
    },
    fetchMock,
  );

  const sources = await client.searchKnowledge('3DGS 是什么？');

  assert.equal(sources.length, 1);
  assert.equal(sources[0].title, '共享知识库');
  assert.match(sources[0].snippet, /共享库资料调度概览/);
  assert.match(sources[0].snippet, /已浏览 2 条资料标题/);
  assert.match(sources[0].snippet, /2026-07-27 Group One RAW/);
});

test('IMAClient does not append profile when source cap is full', async () => {
  let profileCalled = false;
  const fetchMock = async (url) => {
    if (url.endsWith('/search_knowledge')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            info_list: [
              { media_id: 'a', title: 'A', highlight_content: '片段 A' },
            ],
          },
        }),
      );
    }

    profileCalled = true;
    throw new Error(`Unexpected URL ${url}`);
  };

  const client = new IMAClient(
    {
      clientId: 'client-id',
      apiKey: 'api-key',
      sharedKnowledgeBaseId: 'shared-only',
      maxSources: 1,
      maxSnippetLength: 900,
      maxSourceContentLength: 1800,
    },
    fetchMock,
  );

  const sources = await client.searchKnowledge('问题');
  assert.deepEqual(sources, [{ index: 1, title: 'A', snippet: '片段 A' }]);
  assert.equal(profileCalled, false);
});

test('IMAClient falls back to same shared knowledge base profile when search has no snippets', async () => {
  const requests = [];
  const fetchMock = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });

    if (url.endsWith('/search_knowledge')) {
      return new Response(JSON.stringify({ code: 0, msg: 'success', data: { info_list: [] } }));
    }

    if (url.endsWith('/get_knowledge_base')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            infos: {
              'shared-only': {
                name: '共享知识库',
                description: '',
                recommended_questions: ['新手入门3D高斯泼溅需要什么？'],
              },
            },
          },
        }),
      );
    }

    if (url.endsWith('/get_knowledge_list')) {
      return new Response(
        JSON.stringify({
          code: 0,
          msg: 'success',
          data: {
            knowledge_list: [
              { title: '欢迎来到 3DGS 共享知识库' },
              { title: '订阅知识库报告.pdf' },
            ],
          },
        }),
      );
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  const client = new IMAClient(
    {
      clientId: 'client-id',
      apiKey: 'api-key',
      sharedKnowledgeBaseId: 'shared-only',
      maxSources: 6,
      maxSnippetLength: 900,
      maxSourceContentLength: 1800,
    },
    fetchMock,
  );

  const sources = await client.searchKnowledge('完全不命中的问题');

  assert.equal(
    requests.every(
      (request) =>
        request.body.knowledge_base_id === 'shared-only' || request.body.ids?.[0] === 'shared-only',
    ),
    true,
  );
  assert.equal(sources.length, 1);
  assert.match(sources[0].snippet, /共享知识库/);
  assert.match(sources[0].snippet, /欢迎来到 3DGS 共享知识库/);
  assert.doesNotMatch(sources[0].snippet, /pdf/i);
});

test('IMAClient exposes IMA business errors without leaking credentials', async () => {
  const client = new IMAClient(
    {
      clientId: 'client-id',
      apiKey: 'secret-key',
      sharedKnowledgeBaseId: 'shared-only',
    },
    async () =>
      new Response(JSON.stringify({ code: 1001, msg: '知识库无权限' }), { status: 200 }),
  );

  await assert.rejects(() => client.searchKnowledge('问题'), /知识库无权限/);
});

test('normalizeKnowledgeResults handles empty, duplicate, long, and malformed results', () => {
  assert.deepEqual(normalizeKnowledgeResults(null), []);

  const sources = normalizeKnowledgeResults(
    [
      { media_id: 'a', title: '  标题  ', highlight_content: '<em>第一段</em>' },
      { media_id: 'a', title: '重复', highlight_content: '重复段' },
      { title: '无 ID', highlight_content: 'x'.repeat(20) },
      null,
    ],
    { maxSources: 3, maxSnippetLength: 8 },
  );

  assert.deepEqual(sources, [
    { index: 1, mediaId: 'a', title: '标题', snippet: '第一段' },
    { index: 2, mediaId: '', title: '无 ID', snippet: 'xxxxxxx…' },
  ]);
});

test('buildQueryCandidates extracts useful fallback queries', () => {
  assert.deepEqual(buildQueryCandidates('3DGS 是什么？').slice(0, 2), ['3DGS 是什么？', '3DGS']);
  assert.ok(buildQueryCandidates('这个共享知识库主要包含什么内容？').includes('知识库'));
});

test('looksLikeBinarySource skips documents that should not be fetched as text', () => {
  assert.equal(looksLikeBinarySource('报告.pdf', 'https://example.com/file.pdf'), true);
  assert.equal(looksLikeBinarySource('说明', 'https://example.com/page.html'), false);
});
