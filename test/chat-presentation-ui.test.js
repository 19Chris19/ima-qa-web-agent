const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function page(t) {
  const dom = new JSDOM('<div id="message"><div id="answer"></div></div><textarea></textarea>',
    { runScripts: 'outside-only', url: 'http://127.0.0.1', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window;
  for (const file of [require.resolve('marked').replace(/marked\.cjs$/u, 'marked.umd.js'),
    require.resolve('dompurify/dist/purify.min.js'), path.join(__dirname, '../public/chat-presentation.js'),
    path.join(__dirname, '../public/answer-renderer.js')]) window.eval(fs.readFileSync(file, 'utf8'));
  window.Blob = Blob;
  let clipboard;
  window.ClipboardItem = class { constructor(data) { this.data = data; } };
  Object.defineProperty(window.navigator, 'clipboard', { value: { write: async value => { clipboard = value; },
    writeText: async value => { clipboard = value; } } });
  const answer = window.document.querySelector('#answer');
  const render = (markdown, options = {}) => window.ImaAnswerRenderer.updateAnswerElement(answer, markdown,
    { presentation: 'chat_v1', ...options });
  return { window, answer, render, ui: window.ChatPresentation, message: window.document.querySelector('#message'),
    input: window.document.querySelector('textarea'), clipboard: () => clipboard };
}
const mapping = { 'index:42': { type: 'web', sources: [{ url: 'https://example.org/paper', title: '<img onerror=alert(1)> Paper', snippet: 'Actual excerpt' }] },
  'index:5': { type: 'knowledge', sources: [{ url: 'https://example.org/private', title: 'PRIVATE TITLE', snippet: 'PRIVATE FILE' }] } };

test('web marker uses the explicit key, hover/focus/tap preview; knowledge marker is static and private', t => {
  const p = page(t);
  p.render('Web[7](@index-ref?id=42) Knowledge[2](@index-ref?id=5) Unknown[9](@index-ref?id=404)', { citationMap: mapping });
  const trigger = p.answer.querySelector('button');
  assert.equal(trigger.textContent, '7');
  assert.equal(trigger.dataset.citationKey, 'index:42');
  assert.equal(p.answer.querySelectorAll('button').length, 1);
  assert.equal(p.answer.querySelectorAll('.chat-citation-static').length, 2);
  assert.doesNotMatch(p.answer.innerHTML, /PRIVATE/);
  trigger.dispatchEvent(new p.window.MouseEvent('pointerover', { bubbles: true }));
  const card = p.window.document.querySelector('.chat-citation-card');
  assert.match(card.textContent, /Actual excerpt/);
  assert.equal(card.querySelector('.chat-card-close').getAttribute('aria-label'), '关闭引用');
  assert.equal(card.querySelector('img'), null);
  assert.equal(card.querySelector('a').href, 'https://example.org/paper');
  assert.equal(p.window.location.href, 'http://127.0.0.1/');
  p.window.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(p.window.document.querySelector('.chat-citation-card'), null);
  trigger.focus();
  // Escape restores focus; a tap also opens it without navigating.
  trigger.click();
  assert.ok(p.window.document.querySelector('.chat-citation-card'));
  p.window.document.querySelector('.chat-card-close').click();
  assert.equal(p.window.document.querySelector('.chat-citation-card'), null);
  assert.equal(p.window.document.activeElement, trigger);
});

test('ordinary numbers, code and formulas remain literal; source order never turns them into links', t => {
  const p = page(t);
  p.render('Ordinary [1] and 42. `$[7](@index-ref?id=42)$`\n\n$[7](@index-ref?id=42)$\n\n```js\n[7](@index-ref?id=42)\n```',
    { citationMap: mapping, sourceIndexes: [1, 7] });
  assert.equal(p.answer.querySelectorAll('.chat-citation').length, 0);
  assert.match(p.answer.textContent, /Ordinary \[1\]/);
  assert.match(p.answer.querySelector('code').textContent, /@index-ref/);
});

test('table clipboard supplies HTML and TSV, CSV handles BOM/quotes/Chinese/newlines/formulas; streaming blocks exports', async t => {
  const p = page(t);
  const markdown = '| 名称 | 值 |\n| --- | --- |\n| 中文,引号" | =SUM(1,2) |\n| 正常 | -2.5 |';
  p.render(markdown, { streaming: true });
  assert.ok([...p.answer.querySelectorAll('.chat-table-tools button')].every(node => node.disabled));
  p.render(markdown, { partial: true });
  assert.ok([...p.answer.querySelectorAll('.chat-table-tools button')].every(node => !node.disabled));
  assert.match(p.answer.textContent, /部分回答/);
  p.answer.querySelector('[data-chat-action="copy-table"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const item = p.clipboard()[0];
  assert.match(await item.data['text/html'].text(), /<table>/);
  assert.match(await item.data['text/plain'].text(), /名称\t值/);
  assert.match(await item.data['text/html'].text(), /'=SUM/);
  assert.doesNotMatch(await item.data['text/html'].text(), /复制表格|下载 CSV/);
  const output = p.ui.csv([['中文,引号"', 'line\nbreak', '=CMD()', ' \t@SUM(1)', '-2.5']]);
  assert.equal(output.charCodeAt(0), 0xfeff);
  assert.match(output, /"中文,引号"""/);
  assert.match(output, /"line\nbreak"/);
  assert.match(output, /"'=CMD\(\)"/);
  assert.match(output, /"' \t@SUM\(1\)"/);
  assert.match(output, /"-2.5"/);
});

test('stable blocks survive incremental paint; code copy excludes its control', async t => {
  const p = page(t);
  p.render('Stable paragraph\n\n```js\nconst n = 7;\n```');
  const stable = p.answer.firstElementChild;
  p.render('Stable paragraph\n\n```js\nconst n = 7;\n```\n\nNext paragraph');
  assert.equal(p.answer.firstElementChild, stable);
  p.answer.querySelector('[data-chat-action="copy-code"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(p.clipboard(), 'const n = 7;\n');
});

test('followups fill only text, never send or overwrite drafts; process uses fixed labels', t => {
  const p = page(t); let sends = 0;
  p.input.addEventListener('submit', () => sends++);
  p.ui.renderSuggestions(p.message, ['one', 'two', 'three', 'four'], p.input);
  const controls = p.message.querySelectorAll('.chat-suggestions button');
  assert.equal(controls.length, 3);
  controls[0].click();
  assert.equal(p.input.value, 'one'); assert.equal(sends, 0);
  controls[1].click(); assert.equal(p.input.value, 'one', 'late click also guards the current draft');
  p.ui.renderSuggestions(p.message, ['one', 'two', 'three'], p.input);
  assert.ok([...controls].every(control => control.disabled));
  p.ui.renderProcess(p.message, [{ phase: 'web', status: 'running', text: 'PRIVATE IMA' },
    { phase: 'web', status: 'completed' }, { phase: 'unknown', status: 'completed' }], true);
  assert.match(p.message.querySelector('.chat-process').textContent, /联网搜索 · 已完成/);
  assert.doesNotMatch(p.message.querySelector('.chat-process').textContent, /PRIVATE|unknown/);
  assert.equal(p.message.querySelector('.chat-process').open, false);
});


test('malformed table syntax inside code and block formulas never becomes tables or citations', t => {
  const p = page(t);
  p.render('```md\n| A | B |\n| -- | -- |\n| [7](@index-ref?id=42) | code |\n```\n\n$$\n\n[7](@index-ref?id=42)\n\n$$', { citationMap: mapping });
  assert.equal(p.answer.querySelectorAll('.chat-citation').length, 0);
  assert.equal(p.answer.querySelectorAll('table').length, 0);
  assert.match(p.answer.querySelector('pre code').textContent, /\| -- \| -- \|/);
});


test('an already open card refreshes when metadata arrives without replacing the stable marker', t => {
  const p = page(t);
  const first = { 'index:42': { type: 'web', sources: [{ url: 'https://example.org/paper', title: 'Web', snippet: '' }] } };
  p.render('Reference[7](@index-ref?id=42)', { citationMap: first });
  const marker = p.answer.querySelector('[data-citation-key]');
  marker.focus();
  assert.doesNotMatch(p.window.document.querySelector('.chat-citation-card').textContent, /Late excerpt/);
  assert.match(p.window.document.querySelector('.chat-citation-card').textContent, /该网页未提供内容摘录/);
  p.render('Reference[7](@index-ref?id=42)', { citationMap: { 'index:42': { type: 'web', sources: [{ url: 'https://example.org/paper', title: 'Web', snippet: 'Late excerpt' }] } } });
  assert.equal(p.answer.querySelector('[data-citation-key]'), marker);
  assert.match(p.window.document.querySelector('.chat-citation-card').textContent, /Late excerpt/);
  assert.doesNotMatch(p.window.document.querySelector('.chat-citation-card').textContent, /该网页未提供内容摘录/);
});


test('a card near the viewport bottom opens above its marker without intercepting the pending tap', t => {
  const p = page(t);
  p.render('Web[7](@index-ref?id=42)', { citationMap: mapping });
  const marker = p.answer.querySelector('[data-citation-key]');
  marker.getBoundingClientRect = () => ({ left: 10, top: 740, bottom: 760 });
  Object.defineProperty(p.window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true, get() { return this.classList.contains('chat-citation-card') ? 200 : 0; } });
  marker.focus();
  const card = p.window.document.querySelector('.chat-citation-card');
  assert.ok(parseFloat(card.style.top) + card.offsetHeight < marker.getBoundingClientRect().top);
});
