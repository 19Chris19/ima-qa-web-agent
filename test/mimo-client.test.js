const assert = require('node:assert/strict');
const test = require('node:test');
const {
  findSseBoundary,
  parseOpenAICompatibleStream,
  parseStreamEvent,
} = require('../src/mimo-client');

test('findSseBoundary accepts LF and CRLF server-sent event boundaries', () => {
  assert.deepEqual(findSseBoundary('event: x\n\nnext'), { index: 8, length: 2 });
  assert.deepEqual(findSseBoundary('event: x\r\n\r\nnext'), { index: 8, length: 4 });
  assert.equal(findSseBoundary('event: x\npartial'), null);
});

test('parseStreamEvent extracts OpenAI-compatible delta text', () => {
  const delta = parseStreamEvent(
    'data: {"choices":[{"delta":{"content":"片段"}}]}\r\n',
  );

  assert.deepEqual(delta, { done: false, text: '片段' });
  assert.deepEqual(parseStreamEvent('data: [DONE]'), { done: true, text: '' });
});

test('parseOpenAICompatibleStream stops as soon as DONE arrives', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
            'data: [DONE]\n\n' +
            'data: {"choices":[{"delta":{"content":"late"}}]}\n\n',
        ),
      );
      controller.close();
    },
  });

  const chunks = [];
  for await (const chunk of parseOpenAICompatibleStream({ body: stream })) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, ['ok']);
});
