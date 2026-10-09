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
  let activeView = null;
  let viewEpoch = 0;
  let tasksEnabled = false;
  let legacyProvider = false;
  let navigating = true;
  let recoveryRequired = false;
  let connectionNotice = '';
  const taskStorageKey = 'ima-qa-task-reference';
  const tasks = window.ProviderQaTasks.create(requestOptions);
  const terminal = window.ProviderQaTasks.terminal;
  let followStreamingAnswer = true;
  let lastScrollTop = 0;
  const experience = window.ProviderQaExperience;
  const resizeComposer = experience.composer(form, input);
  const notice = document.querySelector('#composerNotice');
  const latest = experience.button('返回最新回答', 'latest', 'return-latest');
  latest.hidden = true;
  document.querySelector('#readingActions').append(latest);
  const reconnect = document.createElement('button');
  reconnect.type = 'button';
  reconnect.className = 'source-toggle task-reconnect';
  reconnect.textContent = '重新连接';
  reconnect.hidden = true;
  document.querySelector('#readingActions').append(reconnect);
  reconnect.addEventListener('click', () => {
    if (!activeView) { void openConversation(conversationId); return; }
    reconnect.hidden = true;
    if (activeView.task) void watchTask(activeView);
    else void recoverSubmission(activeView);
  });
  window.addEventListener('pagehide', () => activeView?.controller?.abort());
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
    sendButton.disabled = navigating || recoveryRequired || (!tasksEnabled && !legacyProvider)
      || (isBusy && ((!legacyProvider && !activeView?.task) || activeView.stopping));
    sendButton.setAttribute('aria-disabled', String(sendButton.disabled));
    notice.textContent = connectionNotice || (!tasksEnabled && !legacyProvider ? '持久任务暂不可用。'
      : isBusy && hasDraft ? '草稿已保留。请先停止或等待当前回答完成，再发送。' : '');
    newConversationButton.disabled = navigating;
    resizeComposer();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (isBusy) {
      void stopTask();
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
    updateComposer();
    await Promise.all([loadHealth(), loadCapabilities()]);
    // Establish the ordinary owner cookie before concurrent owner-scoped reads.
    await refreshConversationList();
    if (conversationId) {
      await openConversation(conversationId, { refreshOnMissing: false });
    }
    navigating = false;
    updateComposer();
    input.focus();
  }

  async function createConversation() {
    const epoch = detachView();
    navigating = true;
    updateComposer();
    try {
      const response = await fetch('/api/conversations', requestOptions({ method: 'POST' }));
      const data = await response.json().catch(() => ({}));
      if (epoch !== viewEpoch) return;
      if (!response.ok || !data.conversation?.conversationId) {
        throw new Error(data.error || '无法新建会话');
      }
      setCurrentConversation(data.conversation.conversationId);
      renderWelcome();
      await refreshConversationList();
      if (epoch !== viewEpoch) return;
      setSidebarOpen(false);
      setStatus('', 'ready');
      input.focus();
    } catch (error) {
      if (epoch === viewEpoch) setStatus('error', '新建失败');
    } finally {
      if (epoch === viewEpoch) { navigating = false; updateComposer(); }
    }
  }

  async function openConversation(nextConversationId, options = {}) {
    if (!nextConversationId) return;
    const epoch = detachView();
    navigating = true;
    updateComposer();
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(nextConversationId)}`,
        requestOptions(),
      );
      if (epoch !== viewEpoch) return;
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
      if (epoch !== viewEpoch) return;
      setCurrentConversation(data.conversation.conversationId);
      renderHistory(data.messages || []);
      renderConversationList();
      setSidebarOpen(false);
      setStatus('', 'ready');
      if (tasksEnabled) await restoreTask(epoch, nextConversationId);
    } catch (error) {
      if (epoch === viewEpoch) {
        recoveryRequired = true;
        showReconnect('读取会话或任务失败，请重新连接');
      }
    } finally {
      if (epoch === viewEpoch) { navigating = false; updateComposer(); }
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
    if (!question || isBusy || navigating || recoveryRequired || (!tasksEnabled && !legacyProvider)) return;
    const view = beginView();
    followStreamingAnswer = true;
    setStatus('busy', '提交中');
    input.value = '';
    updateComposer();
    appendMessage('user', question);
    view.message = appendMessage('assistant', '', { pending: true });
    if (legacyProvider) {
      try {
        await tasks.legacyAsk(question, conversationId, {
          signal: view.controller.signal,
          onEvent: event => {
            if (!current(view)) return;
            if (['conversation', 'done'].includes(event.event) && event.data.conversationId) setCurrentConversation(event.data.conversationId);
            renderTaskEvent(view, event);
          },
        });
        finishTask(view, 'succeeded');
      } catch (error) {
        finishTask(view, view.controller.signal.aborted ? 'cancelled' : 'failed', error.message);
      }
      return;
    }
    try {
      if (!conversationId) {
        const response = await fetch('/api/conversations', requestOptions({ method: 'POST' }));
        const data = await response.json();
        if (!current(view)) return;
        if (!response.ok || !data.conversation?.conversationId) throw new Error('无法新建会话');
        setCurrentConversation(data.conversation.conversationId);
      }
      const identity = await tasks.identity();
      if (!current(view)) return;
      view.reference = { conversationId, requestKey: identity.requestKey };
      localStorage.setItem(taskStorageKey, JSON.stringify(view.reference));
      view.submitted = true;
      const task = await tasks.submit(question, conversationId, identity.key);
      if (!current(view)) return;
      attachTask(view, task);
      void refreshConversationList();
      void watchTask(view);
    } catch (error) {
      if (!current(view)) return;
      if (view.submitted && (!error.status || error.status >= 500)) {
        await recoverSubmission(view);
      } else {
        finishTask(view, 'failed', error.message);
      }
    }
  }

  function detachView() {
    activeView?.controller?.abort();
    activeView = null;
    isBusy = false;
    recoveryRequired = false;
    connectionNotice = '';
    reconnect.hidden = true;
    return ++viewEpoch;
  }

  function beginView(epoch = detachView()) {
    const view = { epoch, controller: new AbortController(), message: null, restored: false, subscription: 0 };
    activeView = view;
    isBusy = true;
    return view;
  }

  function current(view) { return activeView === view && view.epoch === viewEpoch; }

  function attachTask(view, task) {
    view.task = task;
    if (view.restored && task.status !== 'succeeded' && !task.eventsExpired && !view.userRendered && typeof task.question === 'string') {
      appendMessage('user', task.question);
      view.userRendered = true;
    }
    view.reference = { ...view.reference, id: task.id, conversationId: task.conversationId };
    localStorage.setItem(taskStorageKey, JSON.stringify(view.reference));
    updateComposer();
  }

  async function recoverSubmission(view) {
    connectionNotice = '';
    setStatus('busy', '确认提交结果');
    try {
      const matches = await tasks.list({ conversationId: view.reference.conversationId, requestKey: view.reference.requestKey });
      if (!current(view)) return;
      const match = matches.find(task => task.requestKey === view.reference.requestKey);
      if (!match) throw new Error('提交结果未知');
      attachTask(view, match);
      void watchTask(view);
    } catch {
      if (current(view)) showReconnect('提交结果未知，请重新连接或稍后查看历史');
    }
  }

  async function restoreTask(epoch, id) {
    const candidates = await tasks.list({ conversationId: id });
    if (epoch !== viewEpoch) return;
    let reference;
    try { reference = JSON.parse(localStorage.getItem(taskStorageKey)); } catch { /* No valid saved task. */ }
    if (reference?.conversationId !== id) reference = null;
    const remembered = candidates.find(item => item.id === reference?.id || (reference?.requestKey && item.requestKey === reference.requestKey));
    const task = (remembered && !terminal(remembered.status) ? remembered : null)
      || candidates.find(item => !terminal(item.status)) || remembered;
    if (!task && !reference?.requestKey) return;
    const view = beginView(epoch);
    view.restored = true;
    view.reference = reference || { conversationId: id };
    if (task) { attachTask(view, task); void watchTask(view); }
    else void recoverSubmission(view);
  }

  function showReconnect(message) {
    connectionNotice = message;
    setStatus('error', '待恢复');
    reconnect.hidden = false;
    updateComposer();
  }

  async function watchTask(view) {
    if (!current(view) || view.watching) return;
    view.watching = true;
    connectionNotice = '';
    updateComposer();
    const subscription = ++view.subscription;
    const subscribed = () => current(view) && subscription === view.subscription;
    reconnect.hidden = true;
    // A fresh subscription replays the full snapshot into the same answer slot.
    if (view.message) {
      view.message.answer = '';
      view.message.sources = [];
      view.message.bubble.querySelector('.sources')?.remove();
    }
    view.error = '';
    try {
      const result = await tasks.follow(view.task.id, {
        signal: view.controller.signal,
        onEvent: event => {
          if (subscribed() && !(view.restored && view.task.status === 'succeeded')) renderTaskEvent(view, event);
        },
        onStatus: status => {
          if (subscribed()) setStatus('busy', status === 'queued' ? '排队中' : '回答中');
        },
        onReconnect: () => { if (subscribed()) setStatus('busy', '重新连接中'); },
      });
      if (!subscribed() || !result) return;
      if ((view.restored && result.task.status === 'succeeded') || result.eventsExpired) {
        const response = await fetch(`/api/conversations/${encodeURIComponent(view.reference.conversationId)}`, requestOptions());
        if (!response.ok) throw new Error('无法恢复会话历史');
        const data = await response.json();
        if (!subscribed()) return;
        renderHistory(data.messages || []);
        view.message = null;
      }
      finishTask(view, result.task.status, view.error);
    } catch (error) {
      if (subscribed()) showReconnect(error.message || '连接中断，任务仍在后台');
    } finally {
      if (subscription === view.subscription) view.watching = false;
    }
  }

  function renderTaskEvent(view, event) {
    if (!['sources', 'delta', 'process', 'error'].includes(event.event)) return;
    const message = view.message ||= appendMessage('assistant', '', { pending: true });
    if (event.event === 'sources') {
      message.sources = event.data.sources || [];
      message.searchSummary = event.data.searchSummary || '';
      renderSources(message.bubble, message.sources, { searchSummary: message.searchSummary });
    }
    if (event.event === 'delta') message.answer += event.data.text || '';
    if (event.event === 'error') view.error = event.data.error || '回答未完成';
    if (event.event === 'process') {
      const text = event.data.message || event.data.text || event.data.label;
      if (typeof text === 'string' && text) {
        let process = message.bubble.querySelector('.task-process');
        if (!process) {
          process = document.createElement('p');
          process.className = 'task-process';
          message.bubble.prepend(process);
        }
        process.textContent = text;
      }
    }
    renderAnswer(message.text, message.answer, { streaming: true, sourceIndexes: sourceIndexes(message.sources) });
    scrollToBottom({ force: followStreamingAnswer });
  }

  function finishTask(view, status, error = '') {
    if (!current(view)) return;
    const message = view.message;
    if (message) {
      message.settled = true;
      message.bubble.classList.remove('pending');
      message.bubble.querySelector('.task-process')?.remove();
      renderAnswer(message.text, message.answer, { sourceIndexes: sourceIndexes(message.sources) });
      renderSources(message.bubble, message.sources, { searchSummary: message.searchSummary, answer: message.answer });
      if (status !== 'succeeded') {
        const failure = document.createElement('p');
        failure.className = 'answer-failure';
        failure.textContent = status === 'cancelled' ? '已停止，以上回答未完成。' : `回答未完成：${error || status}`;
        message.bubble.append(failure);
      }
      experience.answerCopy(message, status !== 'succeeded');
    }
    setStatus(status === 'succeeded' ? '' : 'error', {
      succeeded: 'ready', cancelled: '已停止', failed: '未完成', indeterminate: '结果未知',
    }[status] || '未完成');
    localStorage.removeItem(taskStorageKey);
    isBusy = false;
    connectionNotice = '';
    activeView = null;
    reconnect.hidden = true;
    updateComposer();
    void refreshConversationList();
  }

  async function stopTask() {
    const view = activeView;
    if (legacyProvider) { view?.controller.abort(); return; }
    if (!view?.task || view.stopping) return;
    view.stopping = true;
    updateComposer();
    try {
      await tasks.cancel(view.task.id);
      if (!current(view)) return;
      // Cancellation's response is not a replay snapshot; GET confirms the outcome.
      view.controller.abort();
      view.controller = new AbortController();
      view.watching = false;
      void watchTask(view);
    } catch {
      if (current(view)) showReconnect('停止结果尚未确认，请重新连接');
    } finally {
      view.stopping = false;
      if (current(view)) updateComposer();
    }
  }

  async function loadCapabilities() {
    try { tasksEnabled = (await tasks.capabilities()).features?.durable_qa_tasks_v1 === true; }
    catch { tasksEnabled = false; }
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

  function setStatus(className, text) {
    statusPill.className = className ? `status-pill ${className}` : 'status-pill';
    statusPill.textContent = text;
  }

  async function loadHealth() {
    try {
      const response = await fetch('/healthz', requestOptions());
      const data = await response.json();
      legacyProvider = ['openapi-mimo', 'local-rag-mimo'].includes(data.provider);
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
