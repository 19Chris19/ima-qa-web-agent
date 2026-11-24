'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const root = process.env.PROVIDER_ADMIN_COMPAT_ROOT;
const tick = () => new Promise(resolve => setImmediate(resolve));

test('migration admin offers matched recovery and sends explicit single-probe consent', {
  skip: !root && 'Set PROVIDER_ADMIN_COMPAT_ROOT to the staged migration admin assets',
}, async t => {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'admin.html'), 'utf8'), {
    url: 'http://127.0.0.1/admin', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window, calls = [];
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    let result;
    if (url === '/api/admin/enrollment-preflight') result = { enrollment: { ready: true } };
    else if (url === '/api/admin/bootstrap') result = { enrollment: { supportsAdminPageQr: true,
      qualification: { required: true, automatic: true, requestsPerTarget: 1 } } };
    else if (url === '/api/admin/accounts?details=1') result = { accounts: [], summary: {}, queue: {} };
    else if (url === '/api/admin/v2/accounts/eligibility') result = { accounts: [] };
    else if (url === '/api/admin/enrollments' || url === '/api/admin/enrollments/synthetic') {
      result = { enrollment: { taskId: 'synthetic', state: 'failed' } };
    } else throw new Error(`Unexpected synthetic request ${url}`);
    return { ok: true, json: async () => result };
  };
  window.eval(fs.readFileSync(path.join(root, 'admin.js'), 'utf8'));
  await tick(); await tick();
  document.querySelector('#restoreAnyAccountButton').click();
  assert.equal(document.querySelector('#enrollmentDialog').open, true);
  assert.equal(document.querySelector('#enrollmentName').hidden, true);
  assert.equal(document.querySelector('#reactivateMatchedRow').hidden, false);
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
  document.querySelector('#reactivateMatchedAccount').checked = true;
  document.querySelector('#enrollmentForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick(); await tick();
  const request = calls.find(call => call.url === '/api/admin/enrollments' && call.method === 'POST');
  assert.ok(request);
  assert.deepEqual(JSON.parse(request.body), { matchExistingAccount: true, reactivateMatchedAccount: true,
    confirmQualification: true, authorizedRequestCount: 1 });
});
