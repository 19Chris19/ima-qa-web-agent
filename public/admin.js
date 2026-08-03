(function () {
  const login = document.querySelector('#adminLogin');
  const panel = document.querySelector('#adminPanel');
  const tokenForm = document.querySelector('#adminTokenForm');
  const tokenInput = document.querySelector('#adminTokenInput');
  const loginFeedback = document.querySelector('#loginFeedback');
  const reloadButton = document.querySelector('#reloadButton');
  const summary = document.querySelector('#adminSummary');
  const accountList = document.querySelector('#accountList');
  const accountCountLabel = document.querySelector('#accountCountLabel');
  const enrollName = document.querySelector('#enrollName');
  const enrollCommand = document.querySelector('#enrollCommand');
  const copyEnrollCommand = document.querySelector('#copyEnrollCommand');
  const enrollFeedback = document.querySelector('#enrollFeedback');

  const tokenStorageKey = 'ima-qa-admin-token';
  let token = sessionStorage.getItem(tokenStorageKey) || '';
  let bootstrap = null;
  let accounts = [];

  tokenInput.value = token;
  tokenForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    token = tokenInput.value.trim();
    await loadAdminState();
  });
  reloadButton.addEventListener('click', () => loadAdminState());
  enrollName.addEventListener('input', renderEnrollCommand);
  copyEnrollCommand.addEventListener('click', copyEnrollCommandText);

  void loadAdminState();

  async function loadAdminState() {
    setFeedback(loginFeedback, '');
    reloadButton.disabled = true;
    try {
      const [bootstrapPayload, accountPayload] = await Promise.all([
        request('/api/admin/bootstrap'),
        request('/api/admin/accounts?details=1'),
      ]);
      bootstrap = bootstrapPayload;
      accounts = Array.isArray(accountPayload.accounts) ? accountPayload.accounts : [];
      sessionStorage.setItem(tokenStorageKey, token);
      login.hidden = true;
      panel.hidden = false;
      renderSummary(accountPayload.pool, accountPayload.queue);
      renderEnrollCommand();
      renderAccounts();
    } catch (error) {
      sessionStorage.removeItem(tokenStorageKey);
      token = '';
      tokenInput.value = '';
      login.hidden = false;
      panel.hidden = true;
      setFeedback(loginFeedback, error.message || '无法读取账号状态', true);
    } finally {
      reloadButton.disabled = false;
    }
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-IMA-Admin-Token': token } : {}),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      throw new Error(payload.error || `请求失败 (${response.status})`);
    }
    return payload;
  }

  function renderSummary(pool, queue) {
    const total = Number(pool?.totalAccounts || accounts.length || 0);
    const available = Number(pool?.availableAccounts || 0);
    const busy = Number(pool?.busyAccounts || 0);
    const cooling = Number(pool?.coolingDownAccounts || 0);
    summary.replaceChildren(
      createMetric('账号总数', total),
      createMetric('可用', available),
      createMetric('忙碌', busy),
      createMetric('冷却', cooling),
      createMetric('问答并发', Number(queue?.maxConcurrent || 1)),
    );
  }

  function createMetric(label, value) {
    const item = document.createElement('div');
    item.className = 'admin-metric';
    const number = document.createElement('strong');
    number.textContent = String(value);
    const text = document.createElement('span');
    text.textContent = label;
    item.append(number, text);
    return item;
  }

  function renderEnrollCommand() {
    const name = cleanAccountName(enrollName.value) || 'account-a';
    const sharedKnowledgeBaseId = String(bootstrap?.sharedKnowledgeBaseId || '').trim();
    const command = [
      'npm run admin:enroll --',
      `--name ${shellQuote(name)}`,
      sharedKnowledgeBaseId ? `--kb ${shellQuote(sharedKnowledgeBaseId)}` : '',
      `--server-url ${shellQuote(window.location.origin)}`,
    ].filter(Boolean).join(' ');
    enrollCommand.textContent = command;
  }

  async function copyEnrollCommandText() {
    try {
      await navigator.clipboard.writeText(enrollCommand.textContent);
      setFeedback(enrollFeedback, '已复制');
    } catch {
      setFeedback(enrollFeedback, '复制失败，请手动复制', true);
    }
  }

  function renderAccounts() {
    accountList.replaceChildren();
    accountCountLabel.textContent = `${accounts.length} 个账号`;
    if (!accounts.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-empty';
      empty.textContent = '暂无已接入账号';
      accountList.appendChild(empty);
      return;
    }

    for (const account of accounts) {
      const row = document.createElement('article');
      row.className = 'admin-account-row';
      const heading = document.createElement('div');
      heading.className = 'admin-account-heading';
      const name = document.createElement('h3');
      name.textContent = account.name;
      const status = document.createElement('span');
      status.className = `admin-account-status ${account.status || 'unknown'}`;
      status.textContent = statusLabel(account.status);
      heading.append(name, status);

      const meta = document.createElement('p');
      meta.className = 'admin-account-meta';
      meta.textContent = accountMeta(account);

      const actions = document.createElement('div');
      actions.className = 'admin-account-actions';
      actions.append(
        createAction('检查', () => runAccountAction(account.id, 'check')),
        createAction('刷新', () => runAccountAction(account.id, 'refresh')),
        createAction(account.status === 'disabled' ? '启用' : '停用', () =>
          runAccountAction(account.id, account.status === 'disabled' ? 'enable' : 'disable'),
        ),
        createAction('删除', () => deleteAccount(account)),
      );
      row.append(heading, meta, actions);
      accountList.appendChild(row);
    }
  }

  function createAction(label, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }

  async function runAccountAction(accountId, action) {
    try {
      await request(`/api/admin/accounts/${encodeURIComponent(accountId)}/${action}`, { method: 'POST', body: '{}' });
      await loadAdminState();
    } catch (error) {
      setFeedback(enrollFeedback, error.message || '账号操作失败', true);
    }
  }

  async function deleteAccount(account) {
    if (!window.confirm(`删除账号“${account.name}”？此操作不会删除 IMA 账号本身。`)) {
      return;
    }
    try {
      await request(`/api/admin/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
      await loadAdminState();
    } catch (error) {
      setFeedback(enrollFeedback, error.message || '删除失败', true);
    }
  }

  function accountMeta(account) {
    const items = [];
    if (Number(account.activeRequests || 0)) {
      items.push(`处理中 ${account.activeRequests}`);
    }
    if (Number(account.cooldownSecondsRemaining || 0)) {
      items.push(`冷却 ${account.cooldownSecondsRemaining} 秒`);
    }
    if (account.tokenExpiresAt) {
      items.push(`访问令牌 ${formatDate(account.tokenExpiresAt)}`);
    }
    if (account.refreshTokenExpiresAt) {
      items.push(`刷新令牌 ${formatDate(account.refreshTokenExpiresAt)}`);
    }
    if (account.lastError) {
      items.push(account.lastError);
    }
    return items.join(' · ') || '尚未使用';
  }

  function statusLabel(status) {
    return {
      available: '可用',
      busy: '处理中',
      cooling_down: '冷却中',
      disabled: '已停用',
    }[status] || '未知';
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
  }

  function setFeedback(target, message, isError = false) {
    target.textContent = message;
    target.classList.toggle('error', Boolean(isError));
  }

  function cleanAccountName(value) {
    return String(value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80);
  }

  function shellQuote(value) {
    return `'${String(value || '').replace(/'/g, "'\\''")}'`;
  }
})();
