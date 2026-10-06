'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const publicRoot = path.resolve(__dirname, '../public');

async function pageWithAnswer(events) {
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.TextDecoder = TextDecoder;
  window.confirm = () => true;
  window.fetch = async (url) => {
    if (url === '/healthz') return Response.json({ provider: 'ima-web-agent', model: 'synthetic' });
    if (url.startsWith('/api/conversations?')) return Response.json({ conversations: [] });
    if (url === '/api/ask') {
      const body = events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
      return new Response(new TextEncoder().encode(body), { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  for (const file of ['vendor/marked.umd.js', 'vendor/purify.min.js', 'answer-renderer.js', 'qa-experience.js', 'client.js']) {
    window.eval(fs.readFileSync(path.join(publicRoot, file), 'utf8'));
  }
  await waitFor(() => window.document.querySelector('#providerLabel').textContent.includes('synthetic'));
  const input = window.document.querySelector('#questionInput');
  input.value = '合成问题';
  window.document.querySelector('#askForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => window.document.querySelector('#sendButton').getAttribute('aria-label') === '发送'
    && window.document.querySelectorAll('.message.assistant').length >= 2
    && !window.document.querySelector('#chatLog .message:last-child .bubble.pending'));
  return dom;
}

async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1500) throw new Error('UI did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('successful SSE keeps a GFM table and known citation after completion', async () => {
  const dom = await pageWithAnswer([
    ['conversation', { conversationId: 'synthetic-conversation' }],
    ['sources', { sources: [{ index: 1, title: '合成资料', snippet: '' }] }],
    ['delta', { text: '| 名称 | 用途 |\n| --- | --- |\n| 手机 | 拍摄 | [1]' }],
    ['done', { conversationId: 'synthetic-conversation' }],
  ]);
  const { document } = dom.window;
  const answer = document.querySelector('#chatLog .message:last-child .answer-markdown');
  assert.equal(answer.querySelectorAll('table').length, 1, document.querySelector('.answer-failure')?.textContent);
  assert.equal(answer.querySelector('td').getAttribute('data-label'), '名称');
  assert.doesNotMatch(answer.textContent, /\[1\]/u);
  assert.equal(document.querySelector('.answer-failure'), null);
  dom.window.close();
});

test('an SSE connection without done retains partial text and marks it incomplete', async () => {
  const dom = await pageWithAnswer([
    ['conversation', { conversationId: 'synthetic-conversation' }],
    ['delta', { text: '已经收到的部分回答。' }],
  ]);
  const { document } = dom.window;
  assert.match(document.querySelector('#chatLog .message:last-child .answer-markdown').textContent, /已经收到的部分回答/u,
    document.querySelector('.answer-failure')?.textContent);
  assert.match(document.querySelector('.answer-failure').textContent, /未完成/u);
  assert.equal(document.querySelector('#statusPill').textContent, '未完成');
  dom.window.close();
});

test('duplicate success terminals are not displayed as a completed answer', async () => {
  const dom = await pageWithAnswer([
    ['delta', { text: '部分正文' }],
    ['done', { conversationId: 'synthetic-conversation' }],
    ['done', { conversationId: 'synthetic-conversation' }],
  ]);
  const { document } = dom.window;
  assert.match(document.querySelector('#chatLog .message:last-child .answer-markdown').textContent, /部分正文/u);
  assert.match(document.querySelector('.answer-failure').textContent, /未完成/u);
  dom.window.close();
});

test('the send control becomes stop and aborts exactly one in-flight request', async () => {
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.TextDecoder = TextDecoder;
  let asks = 0;
  window.fetch = async (url, options = {}) => {
    if (url === '/healthz') return Response.json({ provider: 'ima-web-agent', model: 'synthetic' });
    if (url.startsWith('/api/conversations?')) return Response.json({ conversations: [] });
    if (url === '/api/ask') {
      asks += 1;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
        () => reject(new window.DOMException('aborted', 'AbortError')), { once: true }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  for (const file of ['vendor/marked.umd.js', 'vendor/purify.min.js', 'answer-renderer.js', 'qa-experience.js', 'client.js']) {
    window.eval(fs.readFileSync(path.join(publicRoot, file), 'utf8'));
  }
  await waitFor(() => window.document.querySelector('#providerLabel').textContent.includes('synthetic'));
  window.document.querySelector('#questionInput').value = '合成取消题';
  window.document.querySelector('#askForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => window.document.querySelector('#sendButton').getAttribute('aria-label') === '停止回答');
  window.document.querySelector('#sendButton').click();
  await waitFor(() => window.document.querySelector('.answer-failure'));
  assert.equal(asks, 1);
  assert.match(window.document.querySelector('.answer-failure').textContent, /已停止/u);
  assert.equal(window.document.querySelector('#sendButton').getAttribute('aria-label'), '发送');
  window.close();
});
