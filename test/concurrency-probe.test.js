const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function loadProbe() {
  return import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'test-concurrency.mjs')));
}

test('concurrency probe verifies independent conversations and follow-up history', async () => {
  const { runConcurrencyProbe } = await loadProbe();
  const conversations = new Map();
  let askCount = 0;

  const fetchMock = async (url, options = {}) => {
    if (url.endsWith('/healthz')) {
      return new Response(
        JSON.stringify({ ok: true, queue: { activeRequests: 0, queuedRequests: 0 } }),
        { status: 200 },
      );
    }

    if (url.endsWith('/api/ask')) {
      askCount += 1;
      const clientId = options.headers['X-IMA-Client-Id'];
      const body = JSON.parse(options.body);
      const conversationId = body.conversationId || `conversation-${clientId}`;
      const messages = conversations.get(conversationId) || [];
      messages.push(body.question);
      conversations.set(conversationId, messages);
      return new Response(
        [
          'event: conversation',
          `data: ${JSON.stringify({ conversationId })}`,
          '',
          'event: delta',
          `data: ${JSON.stringify({ text: `回答 ${askCount}` })}`,
          '',
          'event: done',
          `data: ${JSON.stringify({ conversationId })}`,
          '',
        ].join('\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }

    const conversationId = decodeURIComponent(url.split('/').pop());
    const messages = conversations.get(conversationId) || [];
    return new Response(
      JSON.stringify({
        success: true,
        conversation: { conversationId },
        messages: messages.map((content, index) => ({
          role: index % 2 === 0 ? 'user' : 'assistant',
          content,
        })),
      }),
      { status: 200 },
    );
  };

  const report = await runConcurrencyProbe(
    {
      baseUrl: 'http://127.0.0.1:3117',
      concurrency: 2,
      followUp: true,
      mode: 'sse',
      out: '',
      question: ['问题 A', '问题 B'],
      questionsFile: '',
      requests: 2,
      timeoutMs: 1000,
      token: '',
    },
    fetchMock,
  );

  assert.equal(report.initial.ok, 2);
  assert.equal(report.initial.uniqueConversationCount, 2);
  assert.equal(report.followUp.ok, 2);
  assert.equal(report.isolation.uniqueConversationCountMatchesRequestCount, true);
  assert.equal(report.isolation.crossContextSuspected, false);
  assert.equal(report.isolation.historyOwnershipChecked, 4);
  assert.equal(report.results.filter((result) => result.historyMessageCount > 0).length, 4);
});

test('concurrency probe parser supports the app SSE contract', async () => {
  const { parseArgs, parseSseResponse, buildQuestions } = await loadProbe();
  const args = parseArgs(['--base-url', 'http://127.0.0.1:3117', '--concurrency', '5', '--follow-up']);
  assert.equal(args.baseUrl, 'http://127.0.0.1:3117');
  assert.equal(args.requests, 5);
  assert.equal(args.followUp, true);
  assert.deepEqual(buildQuestions({ ...args, question: ['甲', '乙'] }), ['甲', '乙', '甲', '乙', '甲']);

  const parsed = parseSseResponse([
    'event: conversation',
    'data: {"conversationId":"conversation-a"}',
    '',
    'event: sources',
    'data: {"sources":[{"index":1,"title":"资料"}],"searchSummary":"找到 1 篇"}',
    '',
    'event: delta',
    'data: {"text":"答案"}',
    '',
    'event: done',
    'data: {"conversationId":"conversation-a"}',
    '',
  ].join('\n'));
  assert.equal(parsed.conversationId, 'conversation-a');
  assert.equal(parsed.answer, '答案');
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.searchSummary, '找到 1 篇');
});
