const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('README explains the stable service before operational detail', () => {
  const text = read('README.md');
  assert.match(text, /^# IMA QA Web Agent$/m);
  assert.ok(text.length < 15000);
  for (const value of ['v0.7.0', 'v0.5.0', 'durable_qa_tasks_v1', '合成演示', '不自动重问', 'Windows', 'Linux',
    'sh onboard.sh doctor', 'docs/AGENT_DEPLOYMENT.md']) {
    assert.ok(text.includes(value), value);
  }
  assert.ok(text.indexOf('screenshots/qa-desktop.png') < text.indexOf('## 开始部署'));
  assert.doesNotMatch(text, /若 v0\.7\.0 尚未发布|本分支.*v0\.5\.0-rc\.1|超过 5 个账号前/);
  assert.ok(read('docs/AGENT_DEPLOYMENT.md').includes('v0.7.0'));
});

test('README image and local document targets exist and SVG stays GitHub-safe', () => {
  const text = read('README.md');
  const refs = [];
  marked.walkTokens(marked.lexer(text), token => {
    if (['link', 'image'].includes(token.type) && !token.href.startsWith('#')) refs.push(token.href.split('#')[0]);
  });
  for (const ref of refs) {
    if (/^[a-z]+:/i.test(ref)) continue;
    const file = path.join(root, ref);
    assert.ok(fs.existsSync(file), ref);
    if (ref.endsWith('.svg')) {
      const svg = fs.readFileSync(file, 'utf8');
      assert.match(svg, /<title/); assert.match(svg, /viewBox=/);
      assert.doesNotMatch(svg, /<script|foreignObject|(?:href|src)=["']https?:|url\(https?:/g);
    }
    if (ref.endsWith('.png')) assert.ok(fs.statSync(file).size < 1500000, ref);
  }
  assert.ok(read('assets/readme/ASSETS.md').includes('Synthetic HTTP'));
});
