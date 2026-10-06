(function () {
  const chatLog = document.querySelector('#chatLog');
  const form = document.querySelector('#askForm');
  const input = document.querySelector('#questionInput');
  const sendButton = document.querySelector('#sendButton');
  const statusPill = document.querySelector('#statusPill');
  const providerLabel = document.querySelector('#providerLabel');
  const conversationList = document.querySelector('#conversationList');
  const newConversationButton = document.querySelector('#newConversationButton');
  const sidebarToggle = document.querySelector('#sidebarToggle');
  const sidebarBackdrop = document.querySelector('#sidebarBackdrop');
  const workspace = document.querySelector('.workspace');

  const conversationStorageKey = 'ima-qa-conversation-id';
  const embedClientStorageKey = 'ima-qa-embed-client-id';
  const embedClientId = document.body?.dataset?.mode === 'embed' ? getOrCreateEmbedClientId() : '';
  let conversationId = localStorage.getItem(conversationStorageKey) || '';
  let conversationSummaries = [];
  let isBusy = false;
  let activeController = null;
  let followStreamingAnswer = true;
  let lastScrollTop = 0;
  const experience = window.ProviderQaExperience;
  const resizeComposer = experience.composer(form, input);
  const notice = document.querySelector('#composerNotice');
  const latest = experience.button('返回最新回答', 'latest', 'return-latest');
  latest.hidden = true;
  document.querySelector('#readingActions').append(latest);
  experience.selectionCopy(chatLog);
  latest.addEventListener('click', () => {
    followStreamingAnswer = true;
    scrollToBottom({ force: true });
    chatLog.focus({ preventScroll: true });
  });

  function updateComposer() {
    const hasDraft = Boolean(input.value.trim());
    const stop = isBusy;
    sendButton.classList.toggle('is-busy', stop);
    sendButton.title = stop ? '停止回答' : '发送';
    sendButton.setAttribute('aria-label', sendButton.title);
    sendButton.setAttribute('aria-disabled', 'false');
    notice.textContent = isBusy && hasDraft ? '草稿已保留。请先停止或等待当前回答完成，再发送。' : '';
    resizeComposer();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (isBusy) {
      activeController?.abort();
      return;
    }
    submitQuestion(input.value);
  });

  input.addEventListener('input', () => {
    updateComposer();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (isBusy) { updateComposer(); return; }
      submitQuestion(input.value);
    }
  });

  chatLog.addEventListener('scroll', () => {
    if (chatLog.scrollTop < lastScrollTop) followStreamingAnswer = false;
    lastScrollTop = chatLog.scrollTop;
    latest.hidden = followStreamingAnswer || isNearChatBottom();
  });
  const suspendFollowing = () => { followStreamingAnswer = false; };
  chatLog.addEventListener('wheel', event => { if (event.deltaY < 0) suspendFollowing(); }, { passive: true });
  chatLog.addEventListener('touchstart', suspendFollowing, { passive: true });
  chatLog.addEventListener('pointerdown', suspendFollowing);
  chatLog.addEventListener('keydown', event => {
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) suspendFollowing();
  });

  newConversationButton.addEventListener('click', createConversation);
  sidebarToggle.addEventListener('click', () => setSidebarOpen(!workspace.classList.contains('sidebar-open')));
  sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));

  void initialize();

  async function initialize() {
    renderWelcome();
    await Promise.all([loadHealth(), refreshConversationList()]);
    if (conversationId) {
      await openConversation(conversationId, { refreshOnMissing: false });
    }
    input.focus();
  }

  async function createConversation() {
    if (isBusy) {
      setStatus('error', '请等待当前回答完成');
      return;
    }

    try {
      const response = await fetch('/api/conversations', requestOptions({ method: 'POST' }));
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.conversation?.conversationId) {
        throw new Error(data.error || '无法新建会话');
      }
      setCurrentConversation(data.conversation.conversationId);
      renderWelcome();
      await refreshConversationList();
      setSidebarOpen(false);
      setStatus('', 'ready');
      input.focus();
    } catch (error) {
      setStatus('error', '新建失败');
    }
  }

  async function openConversation(nextConversationId, options = {}) {
    if (!nextConversationId || isBusy) {
      if (isBusy) {
        setStatus('error', '请等待当前回答完成');
      }
      return;
    }

    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(nextConversationId)}`,
        requestOptions(),
      );
      if (!response.ok) {
        if (response.status === 404 && nextConversationId === conversationId) {
          clearCurrentConversation();
          renderWelcome();
          if (options.refreshOnMissing !== false) {
            await refreshConversationList();
          }
          return;
        }
        throw new Error('无法读取会话');
      }
      const data = await response.json();
      setCurrentConversation(data.conversation.conversationId);
      renderHistory(data.messages || []);
      renderConversationList();
      setSidebarOpen(false);
      setStatus('', 'ready');
    } catch (error) {
      setStatus('error', '读取会话失败');
    }
  }

  async function deleteConversation(targetConversationId, title) {
    if (isBusy && targetConversationId === conversationId) {
      setStatus('error', '请等待当前回答完成');
      return;
    }
    if (!window.confirm(`删除会话“${title || '未命名会话'}”？此操作不能恢复。`)) {
      return;
    }

    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(targetConversationId)}`, requestOptions({
        method: 'DELETE',
      }));
      if (!response.ok) {
        throw new Error('删除失败');
      }
      if (targetConversationId === conversationId) {
        clearCurrentConversation();
        renderWelcome();
      }
      await refreshConversationList();
      setStatus('', 'ready');
    } catch (error) {
      setStatus('error', '删除失败');
    }
  }

  async function refreshConversationList() {
    try {
      const response = await fetch('/api/conversations?limit=50', requestOptions());
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || '无法读取会话列表');
      }
      conversationSummaries = Array.isArray(data.conversations) ? data.conversations : [];
      renderConversationList();
    } catch {
      conversationSummaries = [];
      renderConversationList();
    }
  }

  function renderConversationList() {
    conversationList.replaceChildren();
    if (!conversationSummaries.length) {
      const empty = document.createElement('p');
      empty.className = 'conversation-empty';
      empty.textContent = '暂无会话';
      conversationList.appendChild(empty);
      return;
    }

    for (const conversation of conversationSummaries) {
      const row = document.createElement('div');
      row.className = conversation.conversationId === conversationId
        ? 'conversation-row selected'
        : 'conversation-row';

      const selectButton = document.createElement('button');
      selectButton.type = 'button';
      selectButton.className = 'conversation-select';
      selectButton.title = conversation.title || '未命名会话';
      selectButton.setAttribute('aria-current', conversation.conversationId === conversationId ? 'page' : 'false');

      const title = document.createElement('span');
      title.className = 'conversation-title';
      title.textContent = conversation.title || '未命名会话';
      const meta = document.createElement('span');
      meta.className = 'conversation-meta';
      meta.textContent = `${formatConversationTime(conversation.updatedAt)} · ${conversation.turnCount || 0} 轮`;
      selectButton.append(title, meta);
      selectButton.addEventListener('click', () => openConversation(conversation.conversationId));

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'conversation-delete';
      deleteButton.title = '删除会话';
      deleteButton.setAttribute('aria-label', `删除会话：${conversation.title || '未命名会话'}`);
      deleteButton.innerHTML = '<svg viewBox="0 0 24 24" role="img" aria-hidden="true"><path d="M5 7h14M10 11v6M14 11v6M9 7l1-2h4l1 2M7 7l1 13h8l1-13" /></svg>';
      deleteButton.addEventListener('click', () => deleteConversation(conversation.conversationId, conversation.title));

      row.append(selectButton, deleteButton);
      conversationList.appendChild(row);
    }
  }

  async function submitQuestion(rawQuestion) {
    const question = rawQuestion.trim();
    if (!question || isBusy) {
      return;
    }

    isBusy = true;
    activeController = new AbortController();
    followStreamingAnswer = true;
    setStatus('busy', '回答中');
    newConversationButton.disabled = true;
    input.value = '';
    updateComposer();

    appendMessage('user', question);
    const assistantMessage = appendMessage('assistant', '', { pending: true });

    let complete = false;
    try {
      await streamAnswer(question, assistantMessage);
      complete = true;
      assistantMessage.bubble.classList.remove('pending');
      experience.answerCopy(assistantMessage);
      await refreshConversationList();
      setStatus('', 'ready');
    } catch (error) {
      assistantMessage.bubble.classList.remove('pending');
      if (assistantMessage.answer) {
        renderAnswer(assistantMessage.text, assistantMessage.answer, {
          sourceIndexes: sourceIndexes(assistantMessage.sources),
        });
      }
      const failure = document.createElement('p');
      failure.className = 'answer-failure';
      failure.textContent = activeController?.signal.aborted
        ? '已停止，以上回答未完成。'
        : `回答未完成：${error.message || '连接中断'}`;
      assistantMessage.bubble.appendChild(failure);
      setStatus('error', '未完成');
    } finally {
      assistantMessage.settled = true;
      experience.answerCopy(assistantMessage, !complete);
      isBusy = false;
      activeController = null;
      updateComposer();
      newConversationButton.disabled = false;
    }
  }

  async function streamAnswer(question, assistantMessage) {
    const response = await fetch('/api/ask', requestOptions({
      method: 'POST',
      signal: activeController.signal,
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        question,
        ...(conversationId ? { conversationId } : {}),
      }),
    }));

    if (!response.ok) {
      throw new Error(await readResponseError(response));
    }
    if (!response.body) {
      throw new Error('浏览器不支持流式响应');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let sourceMeta = { count: 0, searchSummary: '' };
    let sourceList = [];
    let renderScheduled = false;
    let streamingFinished = false;
    let terminalCount = 0;
    const renderStreamingAnswer = () => {
      if (renderScheduled) {
        return;
      }
      renderScheduled = true;
      window.requestAnimationFrame(() => {
        renderScheduled = false;
        if (streamingFinished || assistantMessage.settled) {
          return;
        }
        renderAnswer(assistantMessage.text, answer, {
          streaming: true,
          sourceIndexes: sourceIndexes(sourceList),
        });
        updateSourceAnchorText(assistantMessage.bubble, sourceMeta);
        scrollToBottom({ force: followStreamingAnswer });
      });
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = consumeSseBuffer(buffer);
      buffer = parsed.remainder;

      for (const event of parsed.events) {
        if (event.event === 'conversation' || event.event === 'done') {
          if (event.data.conversationId) {
            setCurrentConversation(event.data.conversationId);
          }
        }

        if (event.event === 'sources') {
          sourceList = event.data.sources || [];
          assistantMessage.sources = sourceList;
          sourceMeta = renderSources(assistantMessage.bubble, sourceList, {
            searchSummary: event.data.searchSummary || '',
          });
        }

        if (event.event === 'delta') {
          const text = event.data.text || '';
          answer += text;
          assistantMessage.answer = answer;
          renderStreamingAnswer();
        }

        if (event.event === 'done') terminalCount += 1;

        if (event.event === 'error') {
          throw new Error(event.data.error || '服务暂时不可用');
        }
      }
    }

    if (terminalCount !== 1) throw new Error('连接中断，上游回答未完整结束');

    if (sourceList.length) {
      sourceMeta = renderSources(assistantMessage.bubble, sourceList, {
        searchSummary: sourceMeta.searchSummary,
        answer,
      });
    }

    streamingFinished = true;
    renderAnswer(assistantMessage.text, answer, { sourceIndexes: sourceIndexes(sourceList) });
    updateSourceAnchorText(assistantMessage.bubble, sourceMeta);
    scrollToBottom({ force: followStreamingAnswer });

    return answer;
  }

  async function readResponseError(response) {
    const contentType = String(response.headers.get('content-type') || '');
    if (contentType.includes('text/event-stream')) {
      const text = await response.text();
      const event = consumeSseBuffer(`${text}\n\n`).events.find((item) => item.event === 'error');
      return event?.data?.error || `请求失败 (${response.status})`;
    }
    const data = await response.json().catch(() => ({}));
    return data.error || `请求失败 (${response.status})`;
  }

  function renderHistory(messages) {
    followStreamingAnswer = true;
    chatLog.replaceChildren();
    if (!messages.length) {
      renderWelcome();
      return;
    }
    for (const message of messages) {
      const view = appendMessage(message.role, message.content || '');
      view.answer = message.content || '';
      view.sources = message.sources || [];
      if (message.role === 'assistant' && message.sources?.length) {
        renderAnswer(view.text, message.content || '', { sourceIndexes: sourceIndexes(message.sources) });
        renderSources(view.bubble, message.sources, {
          searchSummary: message.searchSummary || '',
          answer: message.content || '',
        });
      }
      if (message.role === 'assistant') experience.answerCopy(view, message.complete === false || message.interrupted === true);
    }
    scrollToBottom();
  }

  function renderWelcome() {
    followStreamingAnswer = true;
    chatLog.replaceChildren();
    appendMessage('assistant', '可以开始提问。');
  }

  function setCurrentConversation(nextConversationId) {
    conversationId = String(nextConversationId || '');
    if (conversationId) {
      localStorage.setItem(conversationStorageKey, conversationId);
    }
  }

  function clearCurrentConversation() {
    conversationId = '';
    localStorage.removeItem(conversationStorageKey);
  }

  function setSidebarOpen(open) {
    workspace.classList.toggle('sidebar-open', open);
    sidebarToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
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
    const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!eventName || !data) {
      return null;
    }
    try {
      return { event: eventName, data: JSON.parse(data) };
    } catch {
      return null;
    }
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
    if (role === 'assistant') paragraph.tabIndex = -1;
    if (role === 'assistant') {
      renderAnswer(paragraph, content);
    } else {
      paragraph.textContent = content;
    }
    bubble.appendChild(paragraph);

    if (role === 'user') {
      article.append(bubble, avatar);
    } else {
      article.append(avatar, bubble);
    }
    chatLog.appendChild(article);
    scrollToBottom();
    return { article, bubble, text: paragraph, answer: content, sources: [] };
  }

  function renderAnswer(target, markdown, options = {}) {
    try {
      window.ImaAnswerRenderer.updateAnswerElement(target, markdown, options);
    } catch {
      target.textContent = markdown;
    }
  }

  function sourceIndexes(sources) {
    return (sources || []).map((source) => source.index).filter((index) => Number.isSafeInteger(Number(index)));
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
    bubble.querySelector('.sources')?.remove();
    const compactSources = selectCompactSources(sources, options.answer);
    if (!compactSources.length) {
      return { count: 0, searchSummary: '' };
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'sources';
    wrapper.dataset.expanded = 'false';
    const summaryText = options.searchSummary || `找到 ${sources.length} 篇知识库资料`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'source-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = `<span>${escapeHtml(summaryText)}</span><strong>查看来源</strong>`;

    const preview = document.createElement('div');
    preview.className = 'source-preview';
    for (const source of compactSources.slice(0, 4)) {
      const chip = document.createElement('span');
      chip.textContent = source.title || '知识库资料';
      preview.appendChild(chip);
    }

    const list = document.createElement('div');
    list.className = 'source-list';
    for (const source of compactSources) {
      const card = document.createElement('section');
      card.className = 'source-card';
      const index = document.createElement('div');
      index.className = 'source-index';
      index.textContent = `[${source.index || 1}]`;
      const body = document.createElement('div');
      const title = document.createElement('p');
      title.className = 'source-title';
      title.textContent = source.title || '知识库资料';
      const snippet = document.createElement('p');
      snippet.className = 'source-snippet';
      snippet.textContent = source.snippet || '无可展示片段';
      body.append(title, snippet);
      card.append(index, body);
      list.appendChild(card);
    }

    toggle.addEventListener('click', () => {
      const expanded = wrapper.dataset.expanded === 'true';
      wrapper.dataset.expanded = expanded ? 'false' : 'true';
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      toggle.querySelector('strong').textContent = expanded ? '查看来源' : '收起来源';
    });
    wrapper.append(toggle, preview, list);
    bubble.appendChild(wrapper);
    return { count: compactSources.length, searchSummary: summaryText };
  }

  function selectCompactSources(sources, answer = '') {
    if (!Array.isArray(sources)) {
      return [];
    }
    const citedIndexes = new Set(
      [...String(answer || '').matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])),
    );
    const orderedSources = citedIndexes.size
      ? [
          ...sources.filter((source) => citedIndexes.has(Number(source?.index))),
          ...sources.filter((source) => !citedIndexes.has(Number(source?.index))),
        ]
      : sources;
    const seen = new Set();
    return orderedSources.filter((source) => {
      const key = `${source?.index || ''}\n${source?.title || ''}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }).slice(0, 10);
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

  function setStatus(className, text) {
    statusPill.className = className ? `status-pill ${className}` : 'status-pill';
    statusPill.textContent = text;
  }

  async function loadHealth() {
    try {
      const response = await fetch('/healthz', requestOptions());
      const data = await response.json();
      const provider = data.provider === 'ima-web-agent' ? 'IMA Web Agent' : data.provider === 'local-rag-mimo' ? '本地知识库' : 'OpenAPI + MIMO';
      providerLabel.textContent = `${provider} · ${data.model || 'ready'}`;
    } catch {
      providerLabel.textContent = 'IMA Shared KB';
    }
  }

  function requestOptions(options = {}) {
    if (!embedClientId) {
      return options;
    }
    return {
      ...options,
      headers: {
        'X-IMA-Client-Id': embedClientId,
        ...(options.headers || {}),
      },
    };
  }

  function getOrCreateEmbedClientId() {
    const existing = String(localStorage.getItem(embedClientStorageKey) || '').trim();
    if (/^[a-z0-9._:-]{1,160}$/i.test(existing)) {
      return existing;
    }
    const next = `embed-${createClientId()}`;
    localStorage.setItem(embedClientStorageKey, next);
    return next;
  }

  function createClientId() {
    if (globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID();
    }
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  }

  function formatConversationTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '刚刚';
    }
    const elapsedMs = Date.now() - date.getTime();
    if (elapsedMs >= 0 && elapsedMs < 60_000) {
      return '刚刚';
    }
    if (elapsedMs >= 0 && elapsedMs < 3_600_000) {
      return `${Math.max(1, Math.floor(elapsedMs / 60_000))} 分钟前`;
    }
    if (elapsedMs >= 0 && elapsedMs < 86_400_000) {
      return `${Math.max(1, Math.floor(elapsedMs / 3_600_000))} 小时前`;
    }
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  function isNearChatBottom() {
    return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 72;
  }

  function scrollToBottom(options = {}) {
    if (options.force || followStreamingAnswer) {
      chatLog.scrollTop = chatLog.scrollHeight;
      lastScrollTop = chatLog.scrollTop;
    }
    latest.hidden = followStreamingAnswer || isNearChatBottom();
  }
})();
