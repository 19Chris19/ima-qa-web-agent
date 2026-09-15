const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const publicDirectory = path.join(__dirname, '..', 'public');

test('admin account controls prevent duplicate clicks and render durable health feedback', () => {
  const script = fs.readFileSync(path.join(publicDirectory, 'admin.js'), 'utf8');
  const page = fs.readFileSync(path.join(publicDirectory, 'admin.html'), 'utf8');

  assert.match(script, /accountActionsInFlight\.has\(account\.id\)/);
  assert.match(script, /button\.disabled = Boolean\(disabled\)/);
  assert.match(script, /上次检查/);
  assert.match(script, /上次刷新/);
  assert.match(script, /health\.local_schedulable/);
  assert.match(page, /id="accountFeedback"/);
});
