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

test('account overview stays expanded with maintenance and actions visible without a drawer', async t => {
  const { document, calls } = await setup(t);
  const row = document.querySelector('#accountList article.admin-account-row');
  assert.ok(row);
  assert.equal(document.querySelector('#accountList table'), null);
  assert.equal(document.querySelector('#accountDrawer'), null);
  assert.match(row.textContent, /可用于问答/);
  assert.match(row.textContent, /下次自动检查/);
  assert.match(row.textContent, /上游未提供/);
  assert.ok([...row.querySelectorAll('button')].some(button => button.textContent === '重新登录'));
  assert.ok(calls.every(call => !call.method || call.method === 'GET'));
});

test('read-only loading and reload never probe; knowledge is independent of web context failure', async t => {
  const { document, calls } = await setup(t);
  assert.match(document.querySelector('#accountList').textContent, /可用于问答/);
  assert.match(document.querySelector('#accountList').textContent, /不可用/);
  document.querySelector('#reloadButton').click();
  await tick();
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => !call.method || call.method === 'GET'));
  assert.equal(document.querySelectorAll('.admin-account-actions > button').length, 6);
});

test('pending-disabled capture offers verification and manual pause, never a bypass enable action', async t => {
  const account = { ...sample('pending', 'pending'), status: 'disabled',
    disabledReason: 'pending_enrollment_qualification', enrollmentQualificationRequired: true };
  const { document, calls } = await setup(t, { accounts: [account] });
  assert.equal(document.querySelector('.admin-account-actions > button').textContent, '验证问答能力');
  const labels = [...document.querySelectorAll('.admin-account-actions button')].map(button => button.textContent);
  assert.equal(labels.includes('启用'), false);
  assert.equal(labels.includes('停用'), true);
  assert.equal(calls.length, 2);
});

test('missing evidence stays pending and readiness fallback retains separate capabilities', async t => {
  const { document } = await setup(t, { accounts: [
    { id: 'unknown', name: '<img src=x onerror=alert(1)>', availabilityStatus: 'available' },
    { id: 'fallback', name: 'Synthetic fallback' },
  ], readiness: { accounts: [{ id: 'fallback', state: 'ready', qualified: true, schedulable: true }] } });
  const rows = document.querySelectorAll('article.admin-account-row');
  assert.match(rows[0].textContent, /待验证/);
  assert.match(rows[1].textContent, /可用于问答/);
  assert.match(rows[1].textContent, /未验证/);
  assert.equal(rows[0].querySelector('img'), null);
});

test('expanded details display actual zoned maintenance dates and explicit unknown expiry', async t => {
  const { document, calls } = await setup(t);
  const details = document.querySelector('.admin-account-details');
  assert.match(details.textContent, /未知（上游未提供）/);
  assert.match(details.textContent, /2026/);
  assert.ok(details.textContent.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert.match(details.textContent, /下次重试未提供/);
  assert.match(details.textContent, /会话健康可用/);
  assert.doesNotMatch(details.textContent, /知识库.*失败/);
  assert.equal(calls.length, 2);
});

test('visible keyboard-focusable check action only probes after explicit activation', async t => {
  const { document, calls } = await setup(t, undefined, {}, () => ({ operation: { message: 'Synthetic check complete' } }));
  const button = [...document.querySelectorAll('.admin-account-actions button')].find(item => item.textContent === '检查');
  button.focus();
  assert.equal(document.activeElement, button);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  button.click();
  await tick(); await tick();
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls.find(call => call.method === 'POST').url, '/api/admin/accounts/one/check');
});

test('expanded rows retain distinct knowledge states and guarded actions', async t => {
  const states = ['ready', 'pending', 'needs_login', 'disabled', 'verifying', 'busy', 'cooling'];
  const accounts = states.map(state => ({ ...sample(state, state), status: state === 'disabled' ? 'disabled' : 'active' }));
  const { document } = await setup(t, { accounts });
  const rows = [...document.querySelectorAll('article.admin-account-row')];
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map(row => row.querySelector('.admin-account-heading .admin-state').textContent),
    ['可用于问答', '待验证', '需重新登录', '已停用', '验证中', '忙碌', '冷却中']);
  assert.ok([...rows[3].querySelectorAll('button')].some(button => button.textContent === '启用'));
  assert.equal([...rows[4].querySelectorAll('button')].find(button => button.textContent === '验证问答能力').disabled, true);
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

test('enrollment committed update warning overrides stale disabled presentation', async t => {
  const current = { taskId: 'synthetic-committed', state: 'verifying' };
  const { document } = await setup(t, undefined,
    { enrollment: { supportsAdminPageQr: true, activeEnrollment: current } }, (_url, options) => ({
      enrollment: options.method === 'DELETE' ? { ...current, state: 'completed', commitApplied: true,
        warning: 'post_commit_update_failed', detail: 'stale synthetic presentation' } : current,
    }));
  document.querySelector('#startEnrollmentButton').click();
  await tick();
  document.querySelector('#cancelEnrollmentButton').click();
  await tick(); await tick();
  assert.match(document.querySelector('#enrollFeedback').textContent, /资格已提交.*提交未撤销/);
  assert.doesNotMatch(document.querySelector('#enrollFeedback').textContent, /stale/);
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
    [...document.querySelectorAll('.admin-account-actions button')].find(button => button.textContent === '验证问答能力').click();
    document.querySelector('#webActionDialog form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick();
    const feedback = document.querySelector('#accountList .admin-feedback').textContent;
    assert.match(feedback, commitApplied ? /资格已提交/ : /资格未提交/);
    assert.match(feedback, /同步失败.*本机隔离/);
    if (commitApplied) assert.match(feedback, /取消不会撤销/);
  });
}

test('classic layout has no sidebar or drawer and retains mobile and focus rules', async t => {
  const { document } = await setup(t);
  assert.equal(document.querySelector('.admin-sidebar'), null);
  assert.equal(document.querySelector('#accountDrawer'), null);
  assert.equal(document.querySelector('#exercisePanel').hidden, true);
  const css = fs.readFileSync(path.join(__dirname, '../public/admin.css'), 'utf8');
  assert.ok(css.includes('@media (max-width: 680px)'));
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
});

test('maintenance projection states and readiness summary are not legacy basic health counts', async t => {
  const states = ['unobserved', 'disabled', 'checking', 'retry_wait', 'scheduled'];
  const accounts = states.map(state => {
    const account = sample(state);
    account.management.maintenance = { state, nextRetryAt: state === 'retry_wait' ? '2026-10-06T03:00:00Z' : null };
    return account;
  });
  const { document } = await setup(t, { accounts, readiness: { basicHealthy: 99, schedulable: 2, pending: 3, capacity: 2 } });
  const labels = [...document.querySelectorAll('article.admin-account-row')].map(row => row.querySelector('.admin-account-details').textContent);
  ['尚无维护记录', '已停用', '检查中', '等待重试', '已安排'].forEach((label, i) => assert.ok(labels[i].includes(label)));
  assert.match(labels[3], /下次重试.*2026/);
  assert.match(labels[0], /下次自动检查未提供/);
  assert.equal(document.querySelectorAll('#adminSummary .admin-metric strong')[2].textContent, '2');
  assert.doesNotMatch(document.querySelector('#adminPanel').textContent, /基础健康 99/);
});

test('removed accounts disappear from expanded details after reload', async t => {
  const payload = { accounts: [sample('removed')] };
  const { document } = await setup(t, payload);
  assert.equal(document.querySelectorAll('article.admin-account-row').length, 1);
  payload.accounts = [];
  document.querySelector('#reloadButton').click();
  await tick();
  assert.equal(document.querySelectorAll('article.admin-account-row').length, 0);
  assert.match(document.querySelector('#accountList').textContent, /暂无已接入账号/);
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
  const content = document.querySelector('.admin-account-details');
  const value = label => [...content.querySelectorAll('dt')].find(node => node.textContent === label).nextElementSibling.textContent;
  assert.match(value('访问令牌到期'), /未知/);
  for (const label of ['下次自动检查', '下次重试', '上次检查', '可续期时间', '续期凭证到期', '上次成功续期']) {
    assert.match(value(label), /2026/);
    assert.ok(value(label).includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  }
});
