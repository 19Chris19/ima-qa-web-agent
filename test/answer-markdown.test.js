const assert = require('node:assert/strict');
const test = require('node:test');
const { formatAnswerHtml, parseMarkdownTable } = require('../public/answer-markdown');

test('answer markdown renders pipe tables with alignment and citations', () => {
  const html = formatAnswerHtml([
    '工具 | 速度 | 适用场景',
    ':--- | ---: | :---:',
    'PostShot | 快 | 快速预览 [1]',
    'BSD | 中等 | **稳定交付**',
  ].join('\n'));

  assert.match(html, /<table class="answer-table">/);
  assert.match(html, /<th class="align-left">工具<\/th>/);
  assert.match(html, /<th class="align-right">速度<\/th>/);
  assert.match(html, /<th class="align-center">适用场景<\/th>/);
  assert.match(html, /<sup class="citation">\[1\]<\/sup>/);
  assert.match(html, /<strong>稳定交付<\/strong>/);
  assert.doesNotMatch(html, /<p>工具 \| 速度/);
});

test('answer markdown supports escaped pipes, missing cells, and safe cell text', () => {
  const html = formatAnswerHtml([
    '| 项目 | 说明 | 备注 |',
    '| --- | --- | --- |',
    '| A | `a\\|b` | <script>alert(1)</script> |',
    '| B | 只有两列 |',
  ].join('\n'));

  assert.match(html, /a\|b/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<td class="align-left"><\/td>/);
});

test('answer markdown keeps ordinary pipe text as paragraphs without a separator row', () => {
  const table = parseMarkdownTable(['注意：A | B', '这不是表格'].map((line) => line), 0);
  assert.equal(table, null);
  const html = formatAnswerHtml('注意：A | B\n这不是表格');
  assert.match(html, /<p>注意：A \| B<\/p>/);
});
