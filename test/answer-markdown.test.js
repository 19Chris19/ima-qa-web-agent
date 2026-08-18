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
  assert.match(html, /<td data-label="备注" class="align-left"><\/td>/);
});

test('answer markdown keeps ordinary pipe text as paragraphs without a separator row', () => {
  const table = parseMarkdownTable(['注意：A | B', '这不是表格'].map((line) => line), 0);
  assert.equal(table, null);
  const html = formatAnswerHtml('注意：A | B\n这不是表格');
  assert.match(html, /<p>注意：A \| B<br>这不是表格<\/p>/);
});

test('answer markdown renders structured blocks without exposing markdown control symbols', () => {
  const html = formatAnswerHtml([
    '# 处理步骤',
    '',
    '1. **准备素材**',
    '2. 检查 `SfM` 结果',
    '',
    '> 先用小场景验证流程。',
    '',
    '```bash',
    'npm run start',
    '```',
    '',
    '[查看文档](https://example.com/docs) ~~旧方案~~',
  ].join('\n'));

  assert.match(html, /<h3>处理步骤<\/h3>/);
  assert.match(html, /<ol><li><strong>准备素材<\/strong><\/li>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre class="answer-code"><code class="language-bash">npm run start<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/example\.com\/docs"/);
  assert.match(html, /<del>旧方案<\/del>/);
  assert.doesNotMatch(html, /```|^\s*#{1,6}\s/m);
});

test('answer markdown keeps incomplete streaming tables readable', () => {
  const html = formatAnswerHtml([
    '| 工具 | 速度 | 适用场景 |',
    '| :--- | ---:',
  ].join('\n'), { streaming: true });

  assert.match(html, /<table class="answer-table answer-table-preview">/);
  assert.match(html, /<th class="align-left">工具<\/th>/);
  assert.doesNotMatch(html, /\|/);
  assert.doesNotMatch(html, /---/);
});

test('answer markdown renders incomplete code fences without the fence markers', () => {
  const html = formatAnswerHtml(['```json', '{"ok": true}'].join('\n'), { streaming: true });

  assert.match(html, /<pre class="answer-code"><code class="language-json">\{&quot;ok&quot;: true\}<\/code><\/pre>/);
  assert.doesNotMatch(html, /```/);
});

test('answer markdown adds table labels for mobile reading', () => {
  const html = formatAnswerHtml([
    '| 工具 | 速度 |',
    '| --- | --- |',
    '| PostShot | 快 |',
  ].join('\n'));

  assert.match(html, /<td data-label="工具" class="align-left">PostShot<\/td>/);
  assert.match(html, /<td data-label="速度" class="align-left">快<\/td>/);
});

test('answer markdown hides incomplete streaming block markers and table rows', () => {
  const markerHtml = formatAnswerHtml('#\n-\n1.\n`', { streaming: true });
  const tableHtml = formatAnswerHtml([
    '| 工具 | 速度 |',
    '| --- | --- |',
    '| PostShot',
  ].join('\n'), { streaming: true });

  assert.doesNotMatch(markerHtml, /#|-|1\.|`/);
  assert.match(tableHtml, /<td data-label="工具" class="align-left">PostShot<\/td>/);
  assert.doesNotMatch(tableHtml, /\||---/);
});

test('answer markdown hides unmatched inline markers while streaming', () => {
  const html = formatAnswerHtml('正在**整理 ~~风险 `参数', { streaming: true });

  assert.match(html, /正在整理 风险 参数/);
  assert.doesNotMatch(html, /\*\*|~~|`/);
});

test('answer markdown only permits safe external links', () => {
  const html = formatAnswerHtml('[文档](https://example.com/docs) [危险](javascript:alert(1))');

  assert.match(html, /href="https:\/\/example\.com\/docs"/);
  assert.doesNotMatch(html, /javascript:|<a[^>]*>危险<\/a>/);
  assert.match(html, /危险/);
});
