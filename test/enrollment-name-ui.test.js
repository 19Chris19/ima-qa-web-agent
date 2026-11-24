'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const tick = () => new Promise(resolve => setImmediate(resolve));

const root = path.join(__dirname, '../public');
for (const [name, stem] of [['operations admin', 'admin'], ['preserved legacy admin', 'admin-legacy']]) {
  test(`${name} submits Chinese display names unchanged and makes only one enrollment request`, async t => {
    const dom = new JSDOM(fs.readFileSync(path.join(root, `${stem}.html`), 'utf8'), {
      url: 'http://127.0.0.1/admin', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const { window } = dom, { document } = window, calls = [];
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    window.fetch = async (url, options = {}) => {
      calls.push({ url, ...options });
      let value;
      if (url === '/api/admin/bootstrap') value = { enrollment: { supportsAdminPageQr: true,
        qualification: { required: true, automatic: true, requestsPerTarget: 1 } } };
      else if (url === '/api/admin/enrollment-preflight') value = { enrollment: { ready: true } };
      else if (url === '/api/admin/accounts?details=1') value = { accounts: [], summary: {}, queue: {} };
      else if (url === '/api/admin/v2/accounts/eligibility') value = { accounts: [] };
      else if (url === '/api/admin/enrollments' || url === '/api/admin/enrollments/synthetic') {
        value = { enrollment: { taskId: 'synthetic', state: 'failed' } };
      } else throw new Error(`Unexpected mock request ${url}`);
      return { ok: true, json: async () => value };
    };
    window.eval(fs.readFileSync(path.join(root, `${stem}.js`), 'utf8'));
    await tick(); await tick();
    document.querySelector('#addAccountButton').click();
    document.querySelector('#enrollmentName').value = '新测试账号';
    document.querySelector('#enrollmentForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await tick(); await tick();
    const posts = calls.filter(x => x.url === '/api/admin/enrollments' && x.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(JSON.parse(posts[0].body).name, '新测试账号');
  });
}
