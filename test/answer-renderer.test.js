'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const publicRoot = path.resolve(__dirname, '../public');

function createRenderer() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.test/', runScripts: 'outside-only',
  });
  for (const file of ['vendor/marked.umd.js', 'vendor/purify.min.js', 'answer-renderer.js']) {
    dom.window.eval(fs.readFileSync(path.join(publicRoot, file), 'utf8'));
  }
  return dom.window;
}

test('GFM structure and mobile table labels survive final and history rendering', () => {
  const window = createRenderer();
  const raw = '## 设备\n\n**入门**\n\n| 名称 | 用途 |\n| --- | --- |\n| 手机 | 拍摄 |\n\n```js\nconst x = 1;\n```';
  const target = window.document.createElement('div');
  window.ImaAnswerRenderer.updateAnswerElement(target, raw);
  assert.equal(target.querySelector('h2').textContent, '设备');
  assert.equal(target.querySelector('strong').textContent, '入门');
  assert.equal(target.querySelector('td').getAttribute('data-label'), '名称');
  assert.equal(target.querySelector('pre code').textContent.trim(), 'const x = 1;');
  const completed = target.innerHTML;
  window.ImaAnswerRenderer.updateAnswerElement(target, raw);
  assert.equal(target.innerHTML, completed);
  window.close();
});

test('known source citations are hidden only in prose, not code or unrelated links', () => {
  const window = createRenderer();
  const html = window.ImaAnswerRenderer.formatAnswerHtml(
    '来源[1]，编号[3]。`[1]` [链接](https://example.test/1) [1](@context-ref?id=9)',
    { sourceIndexes: [1] },
  );
  assert.doesNotMatch(html, /来源\[1\]/u);
  assert.match(html, /编号\[3\]/u);
  assert.match(html, /<code>\[1\]<\/code>/u);
  assert.match(html, /href="https:\/\/example.test\/1"/u);
  window.close();
});

test('raw HTML and unsafe media or links cannot execute', () => {
  const window = createRenderer();
  const html = window.ImaAnswerRenderer.formatAnswerHtml(
    '<img src=x onerror=alert(1)> [危险](javascript:alert(1)) ![图](https://example.test/a.png)',
  );
  const container = window.document.createElement('div');
  container.innerHTML = html;
  assert.equal(container.querySelector('img, script, [onerror], a[href^="javascript:"]'), null);
  assert.match(html, /图片内容尚未接通/u);
  window.close();
});

test('malformed table keeps original row text without fabricated cells or a diagnostic', () => {
  const window = createRenderer();
  const html = window.ImaAnswerRenderer.formatAnswerHtml('| A | B |\n| --- |\n| 1 | 2 |');
  assert.doesNotMatch(html, /<table/u);
  assert.match(html, /1 \| 2/u);
  assert.doesNotMatch(html, /查看原文|格式不完整/u);
  window.close();
});

test('a stable completed block is retained while the pending block grows', () => {
  const window = createRenderer();
  const target = window.document.createElement('div');
  window.ImaAnswerRenderer.updateAnswerElement(target, '第一段。\n\n| A | B |');
  const first = target.firstElementChild;
  window.ImaAnswerRenderer.updateAnswerElement(target, '第一段。\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.equal(target.firstElementChild, first);
  assert.equal(target.querySelector('table')?.rows.length, 2);
  window.close();
});
