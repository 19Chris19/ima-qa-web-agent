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
  window.HTMLImageElement.prototype.decode = async () => {};
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

test('web marker previews on hover/focus and links to its exact source; knowledge marker is static and private', t => {
  const p = page(t);
  p.render('Web[7](@index-ref?id=42) Knowledge[2](@index-ref?id=5) Unknown[9](@index-ref?id=404)', { citationMap: mapping });
  const trigger = p.answer.querySelector('[data-citation-key]');
  assert.equal(trigger.textContent, '7');
  assert.equal(trigger.dataset.citationKey, 'index:42');
  assert.equal(trigger.tagName, 'A');
  assert.equal(trigger.href, 'https://example.org/paper');
  assert.equal(trigger.target, '_blank');
  assert.match(trigger.rel, /noopener/);
  assert.match(trigger.rel, /noreferrer/);
  assert.equal(p.answer.querySelectorAll('button').length, 0);
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
  // Escape restores focus; hovering previews again without navigating.
  trigger.dispatchEvent(new p.window.MouseEvent('pointerover', { bubbles: true }));
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


test('dismissal restores the reference after the browser blurs a removed close control', async t => {
  const p = page(t);
  p.render('Web[7](@index-ref?id=42)', { citationMap: mapping });
  const marker = p.answer.querySelector('[data-citation-key]');
  marker.focus();
  p.window.document.querySelector('.chat-card-close').focus();
  p.window.document.querySelector('.chat-card-close').click();
  marker.blur(); // Chromium's default action can follow the close handler.
  await new Promise(resolve => p.window.requestAnimationFrame(resolve));
  assert.equal(p.window.document.activeElement, marker);
  assert.equal(p.window.document.querySelector('.chat-citation-card'), null);
});


test('a unique web marker preserves native activation, while multiple destinations require an explicit choice', t => {
  const p = page(t);
  p.render('Web[7](@index-ref?id=42)', { citationMap: mapping });
  const marker = p.answer.querySelector('[data-citation-key]');
  let componentPrevented;
  // Observe the component before suppressing jsdom's unsupported external navigation.
  p.answer.addEventListener('click', event => { componentPrevented = event.defaultPrevented; event.preventDefault(); }, { once: true });
  marker.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(componentPrevented, false);
  assert.equal(p.window.document.querySelector('.chat-citation-card'), null);
  const a = { url: 'https://example.org/a', title: 'A', snippet: '' };
  const b = { url: 'https://example.org/b', title: 'B', snippet: '' };
  p.render('Multiple[7](@index-ref?id=42)', { citationMap: { 'index:42': { type: 'web', sources: [b, a] } } });
  const multiple = p.answer.querySelector('[data-citation-key]');
  assert.equal(multiple.tagName, 'BUTTON');
  assert.equal(multiple.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, cancelable: true })), false);
  assert.deepEqual([...p.window.document.querySelectorAll('.chat-source-open')].map(n => n.href), [b.url, a.url]);
  p.ui.closeCard();
  p.render('Same page[7](@index-ref?id=42)', { citationMap: { 'index:42': { type: 'web', sources: [a, a] } } });
  assert.equal(p.answer.querySelector('[data-citation-key]').tagName, 'A');
  assert.equal(p.answer.querySelector('[data-citation-key]').href, a.url);
});


test('touch/pen opens a modal source sheet; repeated taps never navigate and backdrop restores focus/draft', async t => {
  const p = page(t);
  p.input.value = 'Keep this draft';
  p.render('Web[7](@index-ref?id=42)', { citationMap: mapping });
  const marker = p.answer.querySelector('[data-citation-key]');
  const pointer = (type, pointerType, node = marker, y = 0) => { const event = new p.window.MouseEvent(type, { bubbles: true, cancelable: true, clientY: y });
    Object.defineProperty(event, 'pointerType', { value: pointerType }); node.dispatchEvent(event); };
  for (const pointerType of ['touch', 'pen']) {
    pointer('pointerover', pointerType); assert.equal(p.window.document.querySelector('.chat-citation-card'), null);
    pointer('pointerdown', pointerType);
    assert.equal(marker.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })), false);
    const card = p.window.document.querySelector('.chat-citation-sheet'); assert.ok(card);
    assert.equal(card.getAttribute('aria-modal'), 'true'); assert.equal(p.window.document.body.style.position, 'fixed');
    assert.equal(card.querySelector('.chat-source-open').href, marker.href);
    assert.equal(p.input.value, 'Keep this draft');
    pointer('pointerdown', pointerType);
    assert.equal(marker.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })), false);
    assert.equal(p.window.document.querySelector('.chat-citation-sheet'), card);
    card.querySelector('.chat-citation-sources').dispatchEvent(new p.window.Event('scroll', { bubbles: true }));
    assert.equal(p.window.document.querySelector('.chat-citation-sheet'), card);
    const last = card.querySelector('a'); last.focus();
    p.window.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(p.window.document.activeElement, card.querySelector('button'));
    p.window.document.querySelector('.chat-citation-backdrop').click();
    assert.equal(p.window.document.querySelector('.chat-citation-card'), null);
    assert.equal(p.window.document.body.style.position, ''); assert.equal(p.window.document.activeElement, marker);
  }
  pointer('pointerdown', 'touch'); marker.dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  const handle = p.window.document.querySelector('.chat-sheet-handle');
  pointer('pointerdown', 'touch', handle, 10); pointer('pointermove', 'touch', handle, 90); pointer('pointerup', 'touch', handle, 90);
  assert.equal(p.window.document.querySelector('.chat-citation-sheet'), null); assert.equal(p.input.value, 'Keep this draft');
});

test('optional cover is delayed, authenticated through callback, revoked on close; late results never attach to another citation', async t => {
  const p = page(t); let calls = 0, revoked = [], finish;
  p.window.URL.createObjectURL = () => 'blob:synthetic'; p.window.URL.revokeObjectURL = url => revoked.push(url);
  const map = { 'index:42': { type: 'web', sources: [{ ...mapping['index:42'].sources[0], sourceId: 'a'.repeat(64) }] } };
  const loadPreview = async (reference, signal) => { calls++; assert.equal(reference.citationKey, 'index:42'); assert.equal(reference.taskId, 'task');
    return { blob: new Blob(['image'], { type: 'image/png' }) }; };
  p.render('Web[7](@index-ref?id=42)', { citationMap: map, conversationId: 'conv', taskId: 'task', loadPreview });
  p.answer.querySelector('[data-citation-key]').focus(); assert.equal(calls, 0);
  await new Promise(resolve => setTimeout(resolve, 330)); assert.equal(calls, 1);
  assert.equal(p.window.document.querySelector('.chat-source-cover img').src, 'blob:synthetic');
  p.ui.closeCard(); assert.deepEqual(revoked, ['blob:synthetic']);
  p.render('Web[7](@index-ref?id=42)', { citationMap: map, loadPreview: () => new Promise(resolve => { finish = resolve; }) });
  p.answer.querySelector('[data-citation-key]').dispatchEvent(new p.window.MouseEvent('pointerover', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 330));
  p.ui.closeCard(); finish({ blob: new Blob(['late']) }); await Promise.resolve(); await Promise.resolve();
  assert.equal(p.window.document.querySelector('.chat-source-cover'), null); assert.equal(revoked.length, 1);
});
