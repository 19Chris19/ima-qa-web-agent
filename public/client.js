(function () {
  const chatLog = document.querySelector('#chatLog');
  const form = document.querySelector('#askForm');
  const input = document.querySelector('#questionInput');
  const sendButton = document.querySelector('#sendButton');
  const statusPill = document.querySelector('#statusPill');
  const providerLabel = document.querySelector('#providerLabel');

  const history = [];
  let lastQuestion = '';
  let isBusy = false;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitQuestion(input.value);
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 148)}px`;
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitQuestion(input.value);
    }
  });

  loadHealth();

  async function submitQuestion(rawQuestion) {
    const question = rawQuestion.trim();
    if (!question || isBusy) {
      return;
    }

    isBusy = true;
    lastQuestion = question;
    setStatus('busy', 'run');
    sendButton.disabled = true;
    input.value = '';
    input.style.height = 'auto';

    appendMessage('user', question);
    const assistantMessage = appendMessage('assistant', '', { pending: true });

    try {
      const answer = await streamAnswer(question, assistantMessage);
      assistantMessage.bubble.classList.remove('pending');
      remember('user', question);
      remember('assistant', answer);
      setStatus('', 'ready');
    } catch (error) {
      assistantMessage.bubble.classList.remove('pending');
      assistantMessage.text.textContent = error.message || '服务暂时不可用';
      assistantMessage.bubble.appendChild(createRetryButton());
      setStatus('error', 'error');
    } finally {
      isBusy = false;
      sendButton.disabled = false;
      input.focus();
    }
  }

  async function streamAnswer(question, assistantMessage) {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        question,
        history: history.slice(-6),
      }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `请求失败 (${response.status})`);
    }

    if (!response.body) {
      throw new Error('浏览器不支持流式响应');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let sourceMeta = { count: 0, searchSummary: '' };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = consumeSseBuffer(buffer);
      buffer = parsed.remainder;

      for (const event of parsed.events) {
        if (event.event === 'sources') {
          sourceMeta = renderSources(assistantMessage.bubble, event.data.sources || [], {
            searchSummary: event.data.searchSummary || '',
          });
        }

        if (event.event === 'delta') {
          const text = event.data.text || '';
          answer += text;
          renderAnswer(assistantMessage.text, answer);
          updateSourceAnchorText(assistantMessage.bubble, sourceMeta);
          scrollToBottom();
        }

        if (event.event === 'error') {
          throw new Error(event.data.error || '服务暂时不可用');
        }
      }
    }

    return answer;
  }

  function consumeSseBuffer(buffer) {
    const events = [];
    let boundary = findSseBoundary(buffer);

    while (boundary) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const event = parseSseBlock(block);
      if (event) {
        events.push(event);
      }
      boundary = findSseBoundary(buffer);
    }

    return { events, remainder: buffer };
  }

  function findSseBoundary(buffer) {
    const match = /\r?\n\r?\n/.exec(buffer);
    return match ? { index: match.index, length: match[0].length } : null;
  }

  function parseSseBlock(block) {
    const lines = block.split(/\r?\n/);
    const eventName = lines
      .find((line) => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');

    if (!eventName || !data) {
      return null;
    }

    return {
      event: eventName,
      data: JSON.parse(data),
    };
  }

  function appendMessage(role, content, options = {}) {
    const article = document.createElement('article');
    article.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = role === 'user' ? 'U' : 'A';
    avatar.setAttribute('aria-hidden', 'true');

    const bubble = document.createElement('div');
    bubble.className = options.pending ? 'bubble pending' : 'bubble';

    const paragraph = document.createElement('div');
    paragraph.className = role === 'assistant' ? 'answer-markdown' : '';
    if (role === 'assistant') {
      renderAnswer(paragraph, content);
    } else {
      paragraph.textContent = content;
    }
    bubble.appendChild(paragraph);

    if (role === 'user') {
      article.appendChild(bubble);
      article.appendChild(avatar);
    } else {
      article.appendChild(avatar);
      article.appendChild(bubble);
    }

    chatLog.appendChild(article);
    scrollToBottom();

    return { article, bubble, text: paragraph };
  }

  function renderAnswer(target, markdown) {
    target.innerHTML = formatAnswerHtml(markdown);
  }

  function formatAnswerHtml(markdown) {
    const text = String(markdown || '').trim();
    if (!text) {
      return '<p></p>';
    }

    const blocks = [];
    const lines = text.split(/\n+/);
    let listItems = [];

    function flushList() {
      if (!listItems.length) {
        return;
      }
      blocks.push(`<ul>${listItems.map((item) => `<li>${formatInline(item)}</li>`).join('')}</ul>`);
      listItems = [];
    }

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        flushList();
        continue;
      }

      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        flushList();
        const level = Math.min(heading[1].length + 2, 4);
        blocks.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
        continue;
      }

      const bullet = /^[-*]\s*(.+)$/.exec(line);
      if (bullet) {
        listItems.push(bullet[1]);
        continue;
      }

      const numbered = /^\d+[.、]\s*(.+)$/.exec(line);
      if (numbered) {
        listItems.push(numbered[1]);
        continue;
      }

      flushList();
      blocks.push(`<p>${formatInline(line)}</p>`);
    }

    flushList();
    return blocks.join('');
  }

  function formatInline(value) {
    return escapeHtml(value)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(\d+)\](?:\(@context-ref\?id=\d+\))?/g, '<sup class="citation">[$1]</sup>');
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderSources(bubble, sources, options = {}) {
    const oldSources = bubble.querySelector('.sources');
    oldSources?.remove();

    if (!sources.length) {
      return { count: 0, searchSummary: '' };
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'sources';
    wrapper.dataset.expanded = 'false';

    const count = sources.length;
    const summaryText = options.searchSummary || `找到 ${count} 篇知识库资料`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'source-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = `<span>${summaryText}</span><strong>查看来源</strong>`;

    const preview = document.createElement('div');
    preview.className = 'source-preview';
    for (const source of sources.slice(0, 4)) {
      const chip = document.createElement('span');
      chip.textContent = source.title;
      preview.appendChild(chip);
    }

    const list = document.createElement('div');
    list.className = 'source-list';

    for (const source of sources) {
      const card = document.createElement('section');
      card.className = 'source-card';

      const index = document.createElement('div');
      index.className = 'source-index';
      index.textContent = `[${source.index}]`;

      const body = document.createElement('div');
      const title = document.createElement('p');
      title.className = 'source-title';
      title.textContent = source.title;

      const snippet = document.createElement('p');
      snippet.className = 'source-snippet';
      snippet.textContent = source.snippet || '无可展示片段';

      body.appendChild(title);
      body.appendChild(snippet);
      card.appendChild(index);
      card.appendChild(body);
      list.appendChild(card);
    }

    toggle.addEventListener('click', () => {
      const expanded = wrapper.dataset.expanded === 'true';
      wrapper.dataset.expanded = expanded ? 'false' : 'true';
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      toggle.querySelector('strong').textContent = expanded ? '查看来源' : '收起来源';
    });

    wrapper.appendChild(toggle);
    wrapper.appendChild(preview);
    wrapper.appendChild(list);
    bubble.appendChild(wrapper);
    return { count, searchSummary: summaryText };
  }

  function updateSourceAnchorText(bubble, sourceMeta) {
    if (!sourceMeta.count) {
      return;
    }
    const toggle = bubble.querySelector('.source-toggle span');
    if (toggle) {
      toggle.textContent = sourceMeta.searchSummary || `找到 ${sourceMeta.count} 篇知识库资料`;
    }
  }

  function createRetryButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'retry-button';
    button.textContent = '重试';
    button.addEventListener('click', () => submitQuestion(lastQuestion));
    return button;
  }

  function remember(role, content) {
    history.push({ role, content });
    while (history.length > 12) {
      history.shift();
    }
  }

  function setStatus(className, text) {
    statusPill.className = className ? `status-pill ${className}` : 'status-pill';
    statusPill.textContent = text;
  }

  async function loadHealth() {
    try {
      const response = await fetch('/healthz');
      const data = await response.json();
      const provider =
        data.provider === 'ima-web-agent' ? 'IMA Web Agent' : 'OpenAPI + MIMO';
      if (providerLabel) {
        providerLabel.textContent = `${provider} · ${data.model || 'ready'}`;
      }
    } catch {
      if (providerLabel) {
        providerLabel.textContent = 'IMA Shared KB';
      }
    }
  }

  function scrollToBottom() {
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  input.focus();
})();
