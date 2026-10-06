'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const publicRoot = path.resolve(__dirname, '../public');
const tick = () => new Promise(resolve => setTimeout(resolve, 30));

async function page(t, { mode = 'index', history = null, clipboardFails = false } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(publicRoot, `${mode}.html`), 'utf8'), {
    url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  const copied = [], asks = [];
  let stream;
  w.TextDecoder = TextDecoder;
  w.Range.prototype.getBoundingClientRect = () => ({ left: 100, right: 200, top: 100, bottom: 120 });
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => {
    if (clipboardFails) throw Error('synthetic permission denial');
    copied.push(text);
  } } });
  if (history) w.localStorage.setItem('ima-qa-conversation-id', 'synthetic-history');
  w.fetch = async (url, options = {}) => {
    if (url === '/healthz') return Response.json({ provider: 'ima-web-agent', model: 'synthetic' });
    if (url.startsWith('/api/conversations?')) return Response.json({ conversations: [] });
    if (url === '/api/conversations/synthetic-history') return Response.json({
      conversation: { conversationId: 'synthetic-history' }, messages: history,
    });
    if (url === '/api/ask') {
      asks.push(options);
      const body = new ReadableStream({ start(controller) {
        stream = controller;
        options.signal.addEventListener('abort', () => controller.error(new w.DOMException('aborted', 'AbortError')));
      } });
      return new Response(body);
    }
    throw Error(`Unexpected synthetic URL: ${url}`);
  };
  for (const file of ['vendor/marked.umd.js', 'vendor/purify.min.js', 'answer-renderer.js', 'qa-experience.js', 'client.js']) {
    w.eval(fs.readFileSync(path.join(publicRoot, file), 'utf8'));
  }
  await tick();
  const input = d.querySelector('#questionInput'), form = d.querySelector('#askForm');
  function draft(text) { input.value = text; input.dispatchEvent(new w.Event('input')); }
  function submit() { form.dispatchEvent(new w.Event('submit', { cancelable: true })); }
  return { w, d, input, form, copied, asks, draft, submit,
    emit(type, data) { stream.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); },
    finish() { stream.close(); },
  };
}

for (const mode of ['index', 'embed']) {
  test(`${mode}: busy draft never sends concurrently, survives stop and does not auto-submit`, async t => {
    const p = await page(t, { mode });
    p.draft('synthetic question'); p.submit(); await tick();
    assert.equal(p.d.querySelector('#sendButton').getAttribute('aria-label'), '停止回答');
    p.emit('delta', { text: 'Received 123' }); await tick();
    assert.equal(p.d.querySelector('.answer-copy'), null);
    p.draft('retained draft'); p.submit();
    p.input.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(p.asks.length, 1);
    assert.equal(p.asks[0].signal.aborted, false);
    assert.match(p.d.querySelector('#composerNotice').textContent, /停止或等待/);
    assert.equal(p.d.querySelector('#sendButton').getAttribute('aria-label'), '发送');
    p.d.querySelector('#draftStopButton').click(); await tick();
    assert.equal(p.asks[0].signal.aborted, true);
    assert.equal(p.input.value, 'retained draft');
    assert.equal(p.asks.length, 1);
    p.d.querySelector('.answer-copy').click(); await tick();
    assert.deepEqual(p.copied, ['Received 123']);
    assert.match(p.d.querySelector('.answer-copy').getAttribute('aria-label'), /部分/);
    assert.equal(p.d.querySelector('#questionInput'), p.input);
    if (mode === 'embed') assert.match(p.asks[0].headers['X-IMA-Client-Id'], /^embed-/);
  });
}

test('IME/Shift Enter do not submit; resize preserves the textarea and caps height', async t => {
  const p = await page(t);
  p.draft('synthetic');
  for (const options of [{ isComposing: true }, { shiftKey: true }, { keyCode: 229 }]) {
    p.input.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', ...options }));
  }
  assert.equal(p.asks.length, 0);
  Object.defineProperty(p.input, 'scrollHeight', { configurable: true, value: 300 });
  p.draft('line one\nline two');
  assert.equal(p.form.dataset.layout, 'stacked');
  assert.equal(p.input.style.height, '144px');
  assert.equal(p.input.style.overflowY, 'auto');
  p.draft('');
  assert.equal(p.form.dataset.layout, 'compact');
  assert.equal(p.input.style.height, '24px');
  assert.equal(p.d.querySelector('#questionInput'), p.input);
});

test('terminal copy reuses renderer citation rules without source or failure metadata', async t => {
  const p = await page(t);
  p.draft('synthetic'); p.submit(); await tick();
  p.emit('sources', { sources: [{ index: 1, title: 'PRIVATE SOURCE METADATA' }] });
  p.emit('delta', { text: 'Value 123 [1] [9] `code[1]` [1](@context-ref?id=1)\n\n| A | B |\n| --- | --- |\n| one | two |' });
  p.emit('done', {}); p.finish(); await tick();
  p.d.querySelector('.answer-copy').click(); await tick();
  assert.match(p.copied[0], /Value 123\s+\[9\] `code\[1\]`/);
  assert.doesNotMatch(p.copied[0], /PRIVATE|@context|未完成/);
  assert.match(p.copied[0], /\| A \| B \|\n\| --- \| --- \|\n\| one \| two \|/);
  assert.equal(p.d.querySelector('.answer-copy').getAttribute('aria-label'), '复制回答');
});

test('EOF and error expose only received text; empty interruption has no copy', async t => {
  for (const kind of ['eof', 'error', 'empty']) {
    const p = await page(t);
    p.draft('synthetic'); p.submit(); await tick();
    if (kind !== 'empty') p.emit('delta', { text: 'partial received' });
    if (kind === 'error') p.emit('error', { error: 'synthetic failure' });
    p.finish(); await tick();
    const copy = p.d.querySelector('.answer-copy');
    if (kind === 'empty') assert.equal(copy, null);
    else { copy.click(); await tick(); assert.equal(p.copied[0], 'partial received'); }
    assert.ok(p.d.querySelector('.answer-failure'));
  }
});

test('history uses the same renderer/copy and clipboard fallback is selectable and dismissible', async t => {
  const p = await page(t, { clipboardFails: true, history: [
    { role: 'user', content: 'synthetic history' },
    { role: 'assistant', content: 'Saved 42 [1]', sources: [{ index: 1, title: 'source metadata' }], interrupted: true },
  ] });
  const button = p.d.querySelector('.answer-copy'); button.click(); await tick();
  const field = p.d.querySelector('.copy-fallback textarea');
  assert.equal(field.value, 'Saved 42 ');
  assert.equal(field.readOnly, true);
  assert.equal(field.selectionEnd, field.value.length);
  assert.match(button.getAttribute('aria-label'), /部分/);
  field.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(p.d.querySelector('.copy-fallback'), null);
  assert.equal(p.d.activeElement, button);
});

test('manual reading suspends follow even near bottom until explicit latest', async t => {
  const p = await page(t);
  const log = p.d.querySelector('#chatLog');
  let height = 1000;
  Object.defineProperties(log, { scrollHeight: { get: () => height }, clientHeight: { value: 500 } });
  p.draft('synthetic'); p.submit(); await tick();
  log.scrollTop = 450;
  log.dispatchEvent(new p.w.WheelEvent('wheel', { deltaY: -10 }));
  log.dispatchEvent(new p.w.Event('scroll'));
  height = 1400;
  p.emit('delta', { text: 'new content' }); await tick();
  assert.equal(log.scrollTop, 450);
  const latest = p.d.querySelector('.return-latest');
  assert.equal(latest.hidden, false);
  assert.equal(latest.getAttribute('aria-label'), '返回最新回答');
  latest.click();
  assert.equal(log.scrollTop, 1400);
  assert.equal(latest.hidden, true);
  p.emit('done', {}); p.finish(); await tick();
});

function select(p, start, end = start) {
  const range = p.d.createRange();
  range.setStart(start.firstChild, 0);
  range.setEnd(end.firstChild, end.firstChild.textContent.length);
  const selection = p.w.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  p.d.dispatchEvent(new p.w.Event('selectionchange'));
  return selection;
}

test('selection copy allows only one assistant answer, preserves selection and supports Tab/Escape', async t => {
  const p = await page(t, { history: [
    { role: 'user', content: 'user words' },
    { role: 'assistant', content: 'answer words', sources: [{ index: 1, title: 'source words' }] },
    { role: 'assistant', content: 'other answer' },
  ] });
  const toolbar = p.d.querySelector('.selection-copy-toolbar');
  const answer = p.d.querySelector('.answer-markdown p');
  select(p, p.d.querySelector('.message.user .bubble > div'));
  assert.equal(toolbar.hidden, true);
  select(p, p.d.querySelector('.source-title'));
  assert.equal(toolbar.hidden, true);
  select(p, answer, p.d.querySelectorAll('.answer-markdown p')[1]);
  assert.equal(toolbar.hidden, true);
  const selection = select(p, answer);
  assert.equal(toolbar.hidden, false);
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
  assert.equal(p.d.activeElement, toolbar.querySelector('button'));
  toolbar.querySelector('button').click(); await tick();
  assert.equal(p.copied[0], 'answer words');
  assert.equal(selection.toString(), 'answer words');
  p.d.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(toolbar.hidden, true);
  assert.equal(p.d.activeElement, answer.parentElement);
});

test('selection popover hides on scroll/outside click and offers clipboard failure fallback', async t => {
  const p = await page(t, { clipboardFails: true, history: [{ role: 'assistant', content: 'only selected words' }] });
  const answer = p.d.querySelector('.answer-markdown p');
  const toolbar = p.d.querySelector('.selection-copy-toolbar');
  select(p, answer);
  toolbar.querySelector('button').click(); await tick();
  assert.equal(toolbar.querySelector('textarea').value, 'only selected words');
  p.d.querySelector('#chatLog').dispatchEvent(new p.w.Event('scroll'));
  assert.equal(toolbar.hidden, true);
  assert.equal(toolbar.querySelector('textarea'), null);
  p.input.focus();
  p.w.getSelection().removeAllRanges(); p.d.dispatchEvent(new p.w.Event('selectionchange'));
  answer.firstChild.textContent = 'new selection';
  select(p, answer);
  p.d.body.dispatchEvent(new p.w.Event('pointerdown', { bubbles: true }));
  assert.equal(toolbar.hidden, true);
});

test('soft wrapping uses compact measurement without replacing the input', async t => {
  const p = await page(t);
  const mirror = p.d.querySelector('.qa-measure');
  Object.defineProperty(mirror, 'scrollHeight', { configurable: true, value: 48 });
  p.draft('wrapped synthetic text');
  assert.equal(p.form.dataset.layout, 'stacked');
  Object.defineProperty(mirror, 'scrollHeight', { configurable: true, value: 24 });
  p.draft('short');
  assert.equal(p.form.dataset.layout, 'compact');
  assert.equal(p.d.querySelector('#questionInput'), p.input);
});

test('late clipboard rejection cannot reopen a dismissed selection fallback', async t => {
  const p = await page(t, { history: [{ role: 'assistant', content: 'synthetic selected text' }] });
  let reject;
  p.w.navigator.clipboard.writeText = () => new Promise((_resolve, fail) => { reject = fail; });
  select(p, p.d.querySelector('.answer-markdown p'));
  const toolbar = p.d.querySelector('.selection-copy-toolbar');
  toolbar.querySelector('button').click();
  p.d.querySelector('#chatLog').dispatchEvent(new p.w.Event('scroll'));
  reject(Error('synthetic late denial')); await tick();
  assert.equal(toolbar.hidden, true);
  assert.equal(toolbar.querySelector('textarea'), null);
});

test('normal completion retains a busy draft without auto-submitting it', async t => {
  const p = await page(t);
  p.draft('first'); p.submit(); await tick();
  p.draft('second draft');
  p.emit('delta', { text: 'synthetic complete answer' }); p.emit('done', {}); p.finish();
  await tick();
  assert.equal(p.asks.length, 1);
  assert.equal(p.input.value, 'second draft');
  assert.equal(p.d.querySelector('#sendButton').getAttribute('aria-disabled'), 'false');
});

test('answer copy preserves table syntax, code fences, indentation and line breaks exactly', async t => {
  const p = await page(t);
  const markdown = '\n## Heading\n\n| A | B |\n| :--- | ---: |\n| **item** [1] | `value[1]` |\n\n'
    + '```js\nconst items = [1];\n  // [1] stays in code\n```\n\n    indented [1]\n\nText  \nnext [1]\n';
  assert.equal(p.w.ProviderQaExperience.answerText(markdown, [{ index: 1 }]),
    markdown.replace('**item** [1]', '**item** ').replace('next [1]', 'next '));
});

test('copy removes only mapped prose/context-ref citations and protects Markdown literals', async t => {
  const p = await page(t);
  const markdown = '123 [1] [2] [9] **bold [1]** \\[1] `code[1]` '
    + '[1](@context-ref?id=1) [9](@context-ref?id=9) [1](https://example.test) '
    + '![1](https://example.test/image.png)\n\n> quote [2]\n\n- item [1]\n';
  const expected = '123   [9] **bold ** \\[1] `code[1]` '
    + ' [9](@context-ref?id=9) [1](https://example.test) '
    + '![1](https://example.test/image.png)\n\n> quote \n\n- item \n';
  assert.equal(p.w.ProviderQaExperience.answerText(markdown, [{ index: 1 }, { index: '2' }]), expected);
  assert.equal(p.w.ProviderQaExperience.answerText(markdown), markdown);
  assert.equal(p.w.ProviderQaExperience.answerText(markdown, [{ index: 0 }, { index: -1 }, { index: 'unknown' }]), markdown);
});

test('copy keeps CRLF and incomplete received code fences without normalizing Markdown', async t => {
  const p = await page(t);
  const markdown = 'Text [1]\r\n\r\n```text\r\n  unfinished [1]\r\n';
  assert.equal(p.w.ProviderQaExperience.answerText(markdown, [{ index: 1 }]), markdown.replace('Text [1]', 'Text '));
});

test('clipboard fallback retains original answer Markdown', async t => {
  const content = '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```text\n  code\n```\n';
  const p = await page(t, { clipboardFails: true, history: [{ role: 'assistant', content }] });
  p.d.querySelector('.answer-copy').click(); await tick();
  assert.equal(p.d.querySelector('.copy-fallback textarea').value, content);
});

for (const selection of [false, true]) {
  test(`${selection ? 'selection' : 'answer'} copy success resets at 1500ms and repeat restarts timeout`, async t => {
    const p = await page(t, { history: [{ role: 'assistant', content: '**synthetic words**' }] });
    let now = 0, id = 100000;
    const timers = new Map();
    const originalSet = p.w.setTimeout.bind(p.w), originalClear = p.w.clearTimeout.bind(p.w);
    p.w.setTimeout = (callback, delay) => {
      if (delay !== 1500) return originalSet(callback, delay);
      timers.set(++id, { callback, due: now + delay });
      return id;
    };
    p.w.clearTimeout = key => { if (!timers.delete(key)) originalClear(key); };
    function advance(ms) {
      now += ms;
      for (const [key, timer] of timers) {
        if (timer.due <= now) { timers.delete(key); timer.callback(); }
      }
    }
    if (selection) {
      const strong = p.d.querySelector('.answer-markdown strong');
      select(p, strong);
    }
    const host = p.d.querySelector(selection ? '.selection-copy-toolbar' : '.answer-tools');
    const button = host.querySelector('button'), status = host.querySelector('.copy-status');
    button.click(); await tick();
    assert.equal(p.copied[0], selection ? 'synthetic words' : '**synthetic words**');
    assert.equal(status.textContent, '已复制');
    advance(1499); assert.equal(status.textContent, '已复制');
    advance(1); assert.equal(status.textContent, '');
    button.click(); await tick();
    advance(1000);
    button.click(); await tick();
    advance(500); assert.equal(status.textContent, '已复制');
    advance(999); assert.equal(status.textContent, '已复制');
    advance(1); assert.equal(status.textContent, '');
  });
}
