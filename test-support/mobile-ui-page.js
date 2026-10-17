(function () {
  'use strict';
  const website = document.body.classList.contains('app-page');
  const log = document.querySelector('#chatLog');
  document.querySelector('#main')?.classList.remove('is-empty');
  const thread = document.createElement('div'); thread.className = 'chat-thread';
  const message = document.createElement('article'); message.className = 'message assistant';
  const answer = document.createElement('div'); answer.className = website ? 'message-content' : 'answer-markdown';
  if (website) message.append(answer);
  else {
    const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = 'A'; avatar.setAttribute('aria-hidden', 'true');
    const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.append(answer); message.append(avatar, bubble);
  }
  thread.append(message); log.replaceChildren(thread);
  const source = n => ({ title: `Local source ${n}`, url: `${location.origin}/destination/${n}`, snippet: `Exact source ${n}; local fixture only.` });
  const citationMap = {};
  // Display numbers deliberately differ from keys and source arrival order.
  const keys = ['index:42', 'index:8', 'index:73', 'index:11', 'index:5', 'index:91'];
  for (let n = keys.length - 1; n >= 0; n--) citationMap[keys[n]] = { type: 'web', sources: [source(n + 1)] };
  citationMap['index:300'] = { type: 'web', sources: [source(3), source(1)] };
  citationMap['index:900'] = { type: 'knowledge' };
  const refs = keys.map((key, n) => `[${n + 1}](@index-ref?id=${key.split(':')[1]})`).join('');
  const markdown = '# 移动交互测试\n\n这是本地测试资料，不连接真实问答。\n\n'
    + `相邻网页来源：${refs} 知识库[9](@index-ref?id=900)。\n\n`
    + `换行与混合引用：${'用于检查窄屏自然换行。'.repeat(6)}${refs}[9](@index-ref?id=900)\n\n`
    + '一个角标多个网页[7](@index-ref?id=300)。\n\n'
    + '| 项目 | 来源 |\n| --- | --- |\n| 窄表格 | ' + refs + ' |\n| 另一行 | 本地资料 |\n\n'
    + '```js\nconst value = "local test";\n```\n\n'
    + ('正常阅读、复制与草稿保留。\n\n'.repeat(12)) + '最后一行不会被输入栏遮挡。';
  (window.ImaAnswerRenderer || window.ImaAnswerMarkdown).updateAnswerElement(answer, markdown, { presentation: 'chat_v1', citationMap });
  const input = document.querySelector('textarea'); input.value = '保留这份草稿';
  if (window.ProviderQaExperience) window.ProviderQaExperience.composer(document.querySelector('#askForm'), input);
  document.querySelector('#askForm').addEventListener('submit', event => event.preventDefault());
  // Mirror the website's clearance observer without importing its API client.
  if (website) new ResizeObserver(() => {
    log.style.setProperty('--composer-clearance', `${Math.ceil(document.querySelector('#composerWrap').getBoundingClientRect().height + 24)}px`);
  }).observe(document.querySelector('#composerWrap'));
  window.mobileFixture = { keys, citationMap, website, answer, log, input };
  window.mobileFixtureReady = true;
})();
