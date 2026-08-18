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

test('answer markdown normalizes IMA html breaks before parsing tables and headings', () => {
  const html = formatAnswerHtml([
    '说明。 ### 3DGS 常用软件对比表',
    '<br>| 软件 | 核心用途 | 优点 |',
    '<br>| :--- | :--- | :--- |',
    '<br>| **PostShot** | 模型训练与渲染 | 速度快<br>细节好 |',
  ].join(''));

  assert.match(html, /<h4>3DGS 常用软件对比表<\/h4>/);
  assert.match(html, /<table class="answer-table">/);
  assert.match(html, /<td data-label="优点" class="align-left">速度快<br>细节好<\/td>/);
  assert.doesNotMatch(html, /&lt;br&gt;|<p>\| 软件/);
});

test('answer markdown separates IMA inline code fences before a following table', () => {
  const html = formatAnswerHtml([
    '可复制流程如下。```text',
    '采集 -> SfM -> 训练',
    '```',
    '| 症状 | 处理动作 |',
    '| :--- | :--- |',
    '| 显存不足 | 降低批次 |',
  ].join('\n'));

  assert.match(html, /<pre class="answer-code"><code class="language-text">采集 -&gt; SfM -&gt; 训练<\/code><\/pre>/);
  assert.match(html, /<table class="answer-table">/);
  assert.doesNotMatch(html, /```/);
});

test('answer markdown normalizes IMA headings and lists joined by html breaks', () => {
  const html = formatAnswerHtml([
    '###一句话结论<br>从小场景开始。',
    '<br>###推荐流程',
    '<br>1. **拍摄素材**',
    '<br>2. **检查对位**',
    '<br>> 先验证小场景。',
    '<br>- **避免模糊**',
    '<br>- **避免低重叠度**',
  ].join(''));

  assert.match(html, /<h4>一句话结论<\/h4>/);
  assert.match(html, /<h4>推荐流程<\/h4>/);
  assert.match(html, /<p>从小场景开始。<\/p>/);
  assert.match(html, /<ol><li><strong>拍摄素材<\/strong><\/li><li><strong>检查对位<\/strong><\/li><\/ol>/);
  assert.match(html, /<blockquote><p>先验证小场景。<\/p><\/blockquote>/);
  assert.match(html, /<ul><li><strong>避免模糊<\/strong><\/li><li><strong>避免低重叠度<\/strong><\/li><\/ul>/);
  assert.doesNotMatch(html, /###|&lt;br&gt;/);
});

test('answer markdown accepts IMA compact list markers and indented continuations', () => {
  const html = formatAnswerHtml([
    '1. **拍摄素材**',
    '   补充说明',
    '2.**检查对位**',
    '* **避免模糊**',
    '***避免低重叠度**',
  ].join('\n'));

  assert.match(html, /<ol><li><strong>拍摄素材<\/strong><br>补充说明<\/li><li><strong>检查对位<\/strong><\/li><\/ol>/);
  assert.match(html, /<ul><li><strong>避免模糊<\/strong><\/li><li><strong>避免低重叠度<\/strong><\/li><\/ul>/);
  assert.doesNotMatch(html, /<p>2\.\*\*|<p>\*\*\*/);
});

test('answer markdown demotes malformed long heading lines to readable paragraphs', () => {
  const html = formatAnswerHtml(
    '### 一句话结论新手应从小场景开始，先检查采集质量和对位结果，再逐步增加训练复杂度，避免把整段建议误显示成醒目的标题。',
  );

  assert.match(html, /<p>一句话结论新手应从小场景开始/);
  assert.doesNotMatch(html, /<h4>/);
  assert.doesNotMatch(html, /###/);
});
