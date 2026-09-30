'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAnswerTextStream, sanitizeIMAAnswerText } = require('../src/answer-text-stream');

test('preserves arbitrary whitespace and removes only a complete terminal marker', () => {
  const chunks = ['## 标题\n', '\n| A | B |\n', '| --- | --- |\n', '| 1 | 2 |\n  ', '（@context-', 'ref?id=12）'];
  const stream = createAnswerTextStream();
  const output = chunks.map(chunk => stream.push(chunk)).join('') + stream.finish();
  assert.equal(output, '## 标题\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.equal(sanitizeIMAAnswerText('训练需要 12 GB 显存。'), '训练需要 12 GB 显存。');
});

test('keeps incomplete or embedded references as original answer text', () => {
  const stream = createAnswerTextStream();
  assert.equal(stream.push('引用（@context-ref?id=12'), '引用');
  assert.equal(stream.finish(), '（@context-ref?id=12');
  assert.equal(sanitizeIMAAnswerText('例子（@context-ref?id=12）继续'), '例子（@context-ref?id=12）继续');
});
