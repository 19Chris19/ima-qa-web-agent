'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: pause } = require('node:timers/promises');
const { createApp } = require('../src/app');
const { ConversationStore } = require('../src/conversation-store');

test('full-clock task survives 365 seconds, disconnect and resubscription without re-dispatch',
  { skip: process.env.DURABLE_QA_SOAK !== '1', timeout: 400000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-soak-'));
    const storePath = path.join(directory, 'history.json');
    const conversations = new ConversationStore({ storePath });
    const conversationId = conversations.create('synthetic-owner', { mode: 'knowledge_agent' }).conversationId;
    let calls = 0;
    let upstreamSignal;
    const app = createApp({
      config: { qaProvider: 'ima-web-agent', mimo: {}, webAgent: {}, conversations: { storePath },
        security: { apiToken: 'synthetic-api' }, limits: { maxQuestionLength: 2000 },
        concurrency: { maxConcurrentAsk: 1, queueLimit: 1, requestTimeoutMs: 180000 } },
      conversationStore: conversations,
      imaWebAgentClient: { async *streamAsk({ signal, onDispatch, transportTimeouts }) {
        calls++;
        upstreamSignal = signal;
        assert.deepEqual(transportTimeouts, { headersMs: 60000, idleMs: 600000 });
        onDispatch();
        yield { type: 'delta', text: 'Synthetic ' };
        await pause(365000, undefined, { signal });
        yield { type: 'delta', text: 'answer\n' };
        yield { type: 'done' };
      } },
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { app.locals.durableQATasks.close(); server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${server.address().port}/api/tasks`;
    const headers = { authorization: 'Bearer synthetic-api', 'x-ima-client-id': 'synthetic-owner', 'content-type': 'application/json', 'Idempotency-Key': 'synthetic-soak' };
    const started = Date.now();
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ conversationId, question: 'Synthetic soak' }) });
    assert.equal(response.status, 202);
    const { task } = await response.json();
    const subscriber = await fetch(`${url}/${task.id}/events`, { headers });
    await subscriber.body.cancel();
    await pause(181000);
    assert.equal(upstreamSignal.aborted, false);
    const running = await (await fetch(`${url}/${task.id}`, { headers })).json();
    assert.equal(running.task.status, 'running');
    assert.equal(calls, 1);
    const replay = await (await fetch(`${url}/${task.id}/events?after=${running.task.lastEventId}`, { headers })).text();
    assert.match(replay, /event: done/);
    const final = await (await fetch(`${url}/${task.id}`, { headers })).json();
    assert.equal(final.task.status, 'succeeded');
    assert.ok(Date.now() - started >= 365000);
    assert.equal(calls, 1);
    assert.equal(conversations.getHistory(conversationId, 'synthetic-owner').length, 2);
    assert.equal(final.task.trace.disconnects, 1);
    assert.equal(final.task.trace.terminalReason, 'completed');
  });
