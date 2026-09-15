const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { InternalAskIdempotency } = require('../src/internal-ask-idempotency');
const { createInternalIdempotencyMiddleware } = require('../src/app');

test('same-key concurrent claim is not dispatched twice and body changes conflict', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-idempotency-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'ledger.json');
  const first = new InternalAskIdempotency({ storePath });
  const second = first;
  const [one, two] = await Promise.all([
    first.claim('synthetic-user', 'message-1', first.fingerprint('Synthetic question', '')),
    second.claim('synthetic-user', 'message-1', second.fingerprint('Synthetic question', '')),
  ]);
  assert.equal([one, two].filter(result => result.isNew).length, 1);
  assert.equal([one, two].filter(result => !result.isNew).length, 1);
  assert.equal(two.state, 'processing');
  await assert.rejects(second.claim('synthetic-user', 'message-1', second.fingerprint('Different question', '')), { code: 'idempotency_conflict' });
  assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
});

test('a processing receipt from a prior service instance becomes unknown and stays non-retriable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-idempotency-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'ledger.json');
  const oldService = new InternalAskIdempotency({ storePath });
  await oldService.claim('synthetic-user', 'message-2', oldService.fingerprint('Synthetic question', ''));
  const newService = new InternalAskIdempotency({ storePath });
  const recovered = await newService.claim('synthetic-user', 'message-2', newService.fingerprint('Synthetic question', ''));
  assert.equal(recovered.isNew, false);
  assert.equal(recovered.state, 'unknown');
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(storePath))).includes('synthetic-user'), false);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(storePath))).includes('Synthetic question'), false);
});

test('a late completion cannot overwrite a newer claim after the old receipt expires', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-idempotency-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 100;
  const storePath = path.join(root, 'ledger.json');
  const oldService = new InternalAskIdempotency({ storePath, ttlMs: 10, now: () => now });
  const requestHash = oldService.fingerprint('Synthetic question', '');
  const oldClaim = await oldService.claim('synthetic-user', 'message-3', requestHash);
  now = 120;
  const newService = new InternalAskIdempotency({ storePath, ttlMs: 10, now: () => now });
  const newClaim = await newService.claim('synthetic-user', 'message-3', requestHash);
  assert.equal(newClaim.isNew, true);
  await assert.rejects(oldService.complete(oldClaim.key, 'synthetic-user', {
    conversationId: 'synthetic-conversation', question: 'Synthetic question', answer: 'Synthetic answer',
  }), { code: 'idempotency_conflict' });
  const entry = Object.values(JSON.parse(fs.readFileSync(storePath)).entries)[0];
  assert.equal(entry.instanceId, newService.instanceId);
  assert.equal(entry.state, 'processing');
});

test('disconnect during an async claim marks it unknown without continuing to dispatch', async () => {
  let resolveClaimStarted;
  let releaseClaim;
  const claimStarted = new Promise(resolve => { resolveClaimStarted = resolve; });
  const waitingClaim = new Promise(resolve => { releaseClaim = resolve; });
  let markedUnknown = 0;
  let nextCalls = 0;
  const ledger = {
    fingerprint: () => 'synthetic-fingerprint',
    async claim() {
      resolveClaimStarted();
      await waitingClaim;
      return { key: 'synthetic-receipt', state: 'processing', isNew: true };
    },
    async markUnknown() { markedUnknown++; },
  };
  const req = {
    body: { question: 'Synthetic question' },
    headers: { 'x-ima-client-id': 'synthetic-owner' },
    app: { locals: { askLimits: { maxQuestionLength: 100 } } },
    get: name => name.toLowerCase() === 'idempotency-key' ? 'synthetic-message' : '',
    aborted: false,
    destroyed: false,
  };
  class Response extends EventEmitter {
    writableEnded = false;
    destroyed = false;
    headersSent = false;
    statusCode = 200;
    status(code) { this.statusCode = code; return this; }
    json(body) { this.body = body; this.writableEnded = true; return this; }
  }
  const res = new Response();
  const middleware = createInternalIdempotencyMiddleware({ ledger, conversations: {} });
  const pending = middleware(req, res, () => { nextCalls++; });
  await claimStarted;
  res.destroyed = true;
  res.emit('close');
  releaseClaim();
  await pending;
  assert.equal(markedUnknown, 1);
  assert.equal(nextCalls, 0);
  assert.equal(res.body, undefined);
});

test('a consumed request stream is not mistaken for a disconnected response', async () => {
  let nextCalls = 0;
  let markedUnknown = 0;
  const ledger = {
    fingerprint: () => 'synthetic-fingerprint',
    async claim() { return { key: 'synthetic-receipt', state: 'processing', isNew: true }; },
    async markUnknown() { markedUnknown++; },
  };
  const req = {
    body: { question: 'Synthetic question' },
    headers: { 'x-ima-client-id': 'synthetic-owner' },
    app: { locals: { askLimits: { maxQuestionLength: 100 } } },
    get: name => name.toLowerCase() === 'idempotency-key' ? 'synthetic-message' : '',
    aborted: false,
    destroyed: true,
  };
  class Response extends EventEmitter {
    writableEnded = false;
    destroyed = false;
    headersSent = false;
    statusCode = 200;
    status(code) { this.statusCode = code; return this; }
    json(body) { this.body = body; this.writableEnded = true; return this; }
  }
  const res = new Response();
  await createInternalIdempotencyMiddleware({ ledger, conversations: {} })(req, res, () => { nextCalls++; });
  assert.equal(nextCalls, 1);
  assert.equal(markedUnknown, 0);
});
