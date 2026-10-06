const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const sample = (id, state = 'ready') => ({
  id, name: `Synthetic ${id}`, status: 'active', health: { last_check_code: 'web_context_missing', knowledge_ready: false },
  management: {
    knowledge: { state, qualified: state === 'ready', verifiedAt: '2026-10-06T01:00:00Z' },
    web: { state: 'unavailable' }, session: { state: 'ready' },
    maintenance: { state: 'scheduled', nextCheckAt: '2026-10-06T02:00:00Z', expiryKnown: false },
    schedulable: state === 'ready',
  },
});

async function setup(t, payload = { accounts: [sample('one')] }, bootstrap = {}, handler) {
  const dom = new JSDOM(html, { url: 'https://synthetic.test/admin', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const calls = [];
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    let data;
    if (url === '/api/admin/bootstrap') data = bootstrap;
    else if (url === '/api/admin/accounts?details=1') data = payload;
    else if (handler) data = await handler(url, options);
    else throw new Error(`Unexpected mock request: ${url}`);
    return { ok: true, json: async () => data };
  };
  window.eval(script);
  await tick();
  return { window, document: window.document, calls };
}

test('read-only loading and reload never probe; knowledge is independent of web context failure', async t => {
  const { document, calls } = await setup(t);
  assert.match(document.querySelector('#accountList').textContent, /可用于问答/);
  assert.match(document.querySelector('#accountList').textContent, /不可用/);
  document.querySelector('#reloadButton').click();
  await tick();
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => !call.method || call.method === 'GET'));
  assert.equal(document.querySelectorAll('.admin-row-actions > button').length, 1);
  assert.equal(document.querySelectorAll('.admin-more-items button').length, 6);
});

test('pending-disabled capture offers verification and manual pause, never a bypass enable action', async t => {
  const account = { ...sample('pending', 'pending'), status: 'disabled',
    disabledReason: 'pending_enrollment_qualification', enrollmentQualificationRequired: true };
  const { document, calls } = await setup(t, { accounts: [account] });
  assert.equal(document.querySelector('.admin-row-actions > button').textContent, '验证问答能力');
  const labels = [...document.querySelectorAll('.admin-more-items button')].map(button => button.textContent);
  assert.equal(labels.includes('启用'), false);
  assert.equal(labels.includes('停用'), true);
  assert.equal(calls.length, 2);
});

test('missing evidence stays pending and readiness fallback retains separate capabilities', async t => {
  const { document } = await setup(t, { accounts: [
    { id: 'unknown', name: '<img src=x onerror=alert(1)>', availabilityStatus: 'available' },
    { id: 'fallback', name: 'Synthetic fallback' },
  ], readiness: { accounts: [{ id: 'fallback', state: 'ready', qualified: true, schedulable: true }] } });
  const rows = document.querySelectorAll('tbody tr');
  assert.match(rows[0].textContent, /待验证/);
  assert.match(rows[1].textContent, /可用于问答/);
  assert.match(rows[1].textContent, /未验证/);
  assert.equal(rows[0].querySelector('img'), null);
});

test('drawer displays actual zoned maintenance dates, explicit unknown expiry, Escape and focus return', async t => {
  const { document, window, calls } = await setup(t);
  const trigger = document.querySelector('.admin-account-name');
  trigger.focus(); trigger.click();
  const drawer = document.querySelector('#accountDrawer');
  assert.equal(drawer.open, true);
  assert.equal(document.activeElement.id, 'closeAccountDrawer');
  document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  assert.equal(document.activeElement.id, 'closeAccountDrawer');
  document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(document.activeElement.id, 'closeAccountDrawer');
  assert.match(drawer.textContent, /未知（上游未提供）/);
  assert.match(drawer.textContent, /2026/);
  assert.ok(drawer.textContent.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert.match(drawer.textContent, /下次重试未提供/);
  assert.match(drawer.textContent, /会话健康可用/);
  assert.doesNotMatch(drawer.textContent, /知识库.*失败/);
  drawer.dispatchEvent(new window.Event('cancel', { cancelable: true }));
  assert.equal(drawer.open, false);
  assert.equal(document.activeElement, trigger);
  assert.equal(calls.length, 2);
});

test('More supports arrow navigation and Escape; checks require explicit action', async t => {
  const { document, window, calls } = await setup(t, undefined, {}, () => ({ operation: { message: 'Synthetic check complete' } }));
  const menu = document.querySelector('.admin-more');
  const trigger = menu.querySelector('summary');
  trigger.focus();
  trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(menu.open, true);
  assert.equal(document.activeElement.textContent, '检查');
  document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(menu.open, false);
  assert.equal(document.activeElement, trigger);
  menu.querySelector('button').click();
  await tick(); await tick();
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls.find(call => call.method === 'POST').url, '/api/admin/accounts/one/check');
});

test('status selects a single primary action, all knowledge states remain distinct', async t => {
  const states = ['ready', 'pending', 'needs_login', 'disabled', 'verifying', 'busy', 'cooling'];
  const accounts = states.map(state => ({ ...sample(state, state), status: state === 'disabled' ? 'disabled' : 'active' }));
  const { document } = await setup(t, { accounts });
  assert.deepEqual([...document.querySelectorAll('.admin-row-actions > button')].map(button => button.textContent),
    ['详情', '详情', '重新登录', '启用', '详情', '详情', '详情']);
  assert.equal(document.querySelectorAll('tbody tr').length, 7);
  const verifying = [...document.querySelectorAll('tbody tr')][4];
  assert.equal([...verifying.querySelectorAll('.admin-more-items button')].find(button => button.textContent === '验证问答能力').disabled, true);
});

test('identity conflict offers add-as-new only and resumes enrollment through specified contract', async t => {
  let current = { taskId: 'synthetic-enrollment', state: 'identity_conflict', qrAvailable: false };
  const { document, calls } = await setup(t, undefined, { enrollment: { supportsAdminPageQr: true, activeEnrollment: current } }, (url, options) => {
    if (url.endsWith('/identity')) {
      assert.deepEqual(JSON.parse(options.body), { action: 'add', name: 'synthetic-new' });
      current = { ...current, state: 'completed', account: { name: 'synthetic-new' } };
    }
    return { enrollment: current };
  });
  document.querySelector('#startEnrollmentButton').click();
  await tick();
  assert.equal(document.querySelector('#enrollmentIdentityConflict').hidden, false);
  assert.match(document.querySelector('#enrollmentIdentityConflict').textContent, /原账号身份保持不变/);
  document.querySelector('#identityConflictName').value = 'synthetic-new';
  document.querySelector('#addConflictIdentityButton').click();
  document.querySelector('#addConflictIdentityButton').click();
  await tick(); await tick();
  const mutations = calls.filter(call => call.method === 'POST');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].url, '/api/admin/enrollments/synthetic-enrollment/identity');
});

test('identity conflict cancellation uses existing DELETE contract', async t => {
  const current = { taskId: 'synthetic-cancel', state: 'identity_conflict' };
  const { document, calls } = await setup(t, undefined, { enrollment: { supportsAdminPageQr: true, activeEnrollment: current } }, (url, options) => ({ enrollment: { ...current, state: options.method === 'DELETE' ? 'cancelled' : 'identity_conflict' } }));
  document.querySelector('#startEnrollmentButton').click();
  await tick();
  document.querySelector('#cancelEnrollmentButton').click();
  await tick();
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
  assert.equal(document.querySelector('#enrollmentDialog').open, false);
});

test('cancel UI reports committed success returned by the server instead of claiming cancellation', async t => {
  const current = { taskId: 'synthetic-committed', state: 'verifying' };
  const { document } = await setup(t, undefined,
    { enrollment: { supportsAdminPageQr: true, activeEnrollment: current } }, (_url, options) => ({
      enrollment: options.method === 'DELETE' ? { ...current, state: 'completed',
        detail: '问答资格已提交，账号已启用', account: { name: 'Synthetic one' } } : current,
    }));
  document.querySelector('#startEnrollmentButton').click();
  await tick();
  document.querySelector('#cancelEnrollmentButton').click();
  await tick(); await tick();
  assert.match(document.querySelector('#enrollFeedback').textContent, /资格已提交/);
  assert.doesNotMatch(document.querySelector('#enrollFeedback').textContent, /已取消/);
});

for (const commitApplied of [false, true]) {
  test(`verification sync warning distinguishes commitApplied=${commitApplied}`, async t => {
    const { document, window } = await setup(t, undefined, {}, () => ({
      success: false, code: 'pool_sync_failed', warning: 'pool_sync_failed', commitApplied,
    }));
    [...document.querySelectorAll('.admin-more-items button')].find(button => button.textContent === '验证问答能力').click();
    document.querySelector('#webActionDialog form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick();
    const feedback = document.querySelector('#accountList .admin-feedback').textContent;
    assert.match(feedback, commitApplied ? /资格已提交/ : /资格未提交/);
    assert.match(feedback, /同步失败.*本机隔离/);
    if (commitApplied) assert.match(feedback, /取消不会撤销/);
  });
}

test('navigation targets only real panels; mobile and reduced-motion rules are present', async t => {
  const { document } = await setup(t);
  for (const link of document.querySelectorAll('#adminNavigation a')) assert.ok(document.querySelector(link.getAttribute('href')));
  assert.equal(document.querySelector('#exerciseNav').hidden, true);
  const css = fs.readFileSync(path.join(__dirname, '../public/admin.css'), 'utf8');
  assert.match(css, /@media \(max-width: 680px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.admin-account-drawer \{ width: 100%/);
});

test('maintenance projection states and readiness summary are not legacy basic health counts', async t => {
  const states = ['unobserved', 'disabled', 'checking', 'retry_wait', 'scheduled'];
  const accounts = states.map(state => {
    const account = sample(state);
    account.management.maintenance = { state, nextRetryAt: state === 'retry_wait' ? '2026-10-06T03:00:00Z' : null };
    return account;
  });
  const { document } = await setup(t, { accounts, readiness: { basicHealthy: 99, schedulable: 2, pending: 3, capacity: 2 } });
  const labels = [...document.querySelectorAll('tbody tr')].map(row => row.cells[3].textContent);
  ['尚无维护记录', '已停用', '检查中', '等待重试', '已安排'].forEach((label, i) => assert.ok(labels[i].startsWith(label)));
  assert.match(labels[3], /下次重试.*2026/);
  assert.match(labels[0], /下次检查 未提供/);
  assert.equal(document.querySelectorAll('#adminSummary .admin-metric strong')[2].textContent, '2');
  assert.doesNotMatch(document.querySelector('#adminPanel').textContent, /基础健康 99/);
});

test('drawer closes when selected account disappears and returns focus to account heading', async t => {
  const payload = { accounts: [sample('removed')] };
  const { document } = await setup(t, payload);
  document.querySelector('.admin-account-name').click();
  payload.accounts = [];
  document.querySelector('#reloadButton').click();
  await tick();
  assert.equal(document.querySelector('#accountDrawer').open, false);
  assert.equal(document.activeElement.id, 'accountCountLabel');
});

test('identity conflict rejects existing names and preserves the choice after a mocked failure', async t => {
  const current = { taskId: 'synthetic-conflict', state: 'identity_conflict', canContinue: true };
  const { document, calls } = await setup(t, undefined, { enrollment: { supportsAdminPageQr: true, activeEnrollment: current } }, (url) => {
    if (url.endsWith('/identity')) throw new Error('Synthetic connection failure');
    return { enrollment: current };
  });
  document.querySelector('#addAccountButton').click();
  await tick();
  assert.equal(document.querySelector('#continueEnrollmentButton').hidden, true);
  document.querySelector('#identityConflictName').value = 'Synthetic one';
  document.querySelector('#addConflictIdentityButton').click();
  await tick();
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  document.querySelector('#identityConflictName').value = 'synthetic-new';
  document.querySelector('#addConflictIdentityButton').click();
  await tick();
  assert.equal(document.querySelector('#enrollmentIdentityConflict').hidden, false);
  assert.equal(document.querySelector('#addConflictIdentityButton').disabled, false);
  assert.match(document.querySelector('#enrollmentDialogFeedback').textContent, /Synthetic connection failure/);
  assert.equal(document.querySelector('.admin-account-name').textContent, 'Synthetic one');
});

test('all maintenance timestamps use supplied values and invalid expiry is unknown', async t => {
  const account = sample('timed');
  account.management.maintenance = {
    state: 'scheduled', expiryKnown: true,
    nextCheckAt: '2026-10-07T01:00:00Z', nextRetryAt: '2026-10-08T01:00:00Z',
    lastCheckAt: '2026-10-06T01:00:00Z', refreshEligibleAt: '2026-10-09T01:00:00Z',
    tokenExpiresAt: 'invalid', refreshTokenExpiresAt: '2026-10-10T01:00:00Z',
    lastSuccessfulRefreshAt: '2026-10-05T01:00:00Z',
  };
  const { document } = await setup(t, { accounts: [account] });
  document.querySelector('.admin-account-name').click();
  const content = document.querySelector('#accountDrawerContent');
  const value = label => [...content.querySelectorAll('dt')].find(node => node.textContent === label).nextElementSibling.textContent;
  assert.match(value('访问令牌到期'), /未知/);
  for (const label of ['下次自动检查', '下次重试', '上次检查', '可续期时间', '续期凭证到期', '上次成功续期']) {
    assert.match(value(label), /2026/);
    assert.ok(value(label).includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  }
});
