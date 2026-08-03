const assert = require('node:assert/strict');
const test = require('node:test');
const { buildMessages } = require('../src/prompt');

const limits = {
  maxHistoryContentLength: 2000,
  maxHistoryTurns: 4,
};

test('buildMessages tells MIMO to answer usable content when sources exist', () => {
  const messages = buildMessages({
    question: 'PostShot 和 BSD 有什么差异？',
    history: [],
    sources: [
      {
        index: 1,
        title: 'group4 / 2026-05-22',
        snippet: 'PostShot 和 BSD 在同一场景下有细节、色彩和错误 splat 的差异。',
      },
    ],
    limits,
  });

  const systemPrompt = messages[0].content;
  assert.match(systemPrompt, /本次检索已经返回 1 条共享知识库片段/);
  assert.match(systemPrompt, /不要输出“我在共享知识库里没有检索到可以支撑这个问题的来源”/);
  assert.match(systemPrompt, /不要因为没有完整教程就拒答/);
  assert.match(systemPrompt, /Markdown 表格/);
  assert.match(systemPrompt, /PostShot 和 BSD 在同一场景下/);
});
