const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createApp } = require('../src/app');
const { ConversationStore } = require('../src/conversation-store');

test('agent client against real Provider routes: paired application identity, continuity and source retention', async t => {
  const { ImaClient } = await import('../packages/ima-qa-client/src/client.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-provider-'));
  const storePath = path.join(dir, 'history.json');
  const conversationStore = new ConversationStore({ storePath });
  let calls = 0;
  const app = createApp({ config: { qaProvider: 'ima-web-agent', mimo: {}, webAgent: { sharedKnowledgeBaseId: 'synthetic-kb' },
    conversations: { storePath }, security: { applications: [
      { id: 'agent', apiTokens: ['synthetic-api'], internalServiceTokens: ['synthetic-internal'] },
      { id: 'other', apiTokens: ['synthetic-other'], internalServiceTokens: ['synthetic-other-internal'] },
    ] }, concurrency: { maxConcurrentAsk: 1, queueLimit: 10 }, limits: { maxQuestionLength: 2000 }, rateLimit: { windowMs: 0, max: 0 } },
    conversationStore, webReadiness: { mode: 'knowledge_agent', snapshot: () => ({ mode: 'knowledge_agent' }) },
    imaWebAgentClient: { async *streamAsk(args) {
      calls++; args.onDispatch?.();
      yield { type: 'delta', text: 'synthetic answer '.repeat(1000) };
      yield { type: 'done' };
    } },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { app.locals.durableQATasks.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, applicationId: 'agent', clientId: 'synthetic-client',
    apiToken: 'synthetic-api', internalServiceToken: 'synthetic-internal', stateDir: path.join(dir, 'client'),
    knowledgeScopeRef: crypto.createHash('sha256').update('synthetic-kb').digest('hex') };
  const client = new ImaClient(config, { pollMs: 5 });
  assert.equal((await client.status()).ready, true); assert.equal(calls, 0);
  const first = await client.ask({ question: 'First', requestKey: 'first', waitSeconds: 2 });
  assert.equal(first.status, 'succeeded'); assert.equal(first.complete, true); assert.ok(first.answer.length > 8000);
  const followup = await client.ask({ question: 'Followup', conversationId: first.conversationId, requestKey: 'second', waitSeconds: 2 });
  assert.equal(followup.conversationId, first.conversationId); assert.equal(followup.status, 'succeeded');
  assert.equal((await client.conversation(first.conversationId)).messages.length, 4);
  await client.ask({ question: 'First', requestKey: 'first' }); assert.equal(calls, 2);
  const wrongApp = new ImaClient({ ...config, internalServiceToken: 'synthetic-other-internal', stateDir: path.join(dir, 'wrong') });
  await assert.rejects(wrongApp.task(first.taskId), { code: 'task_not_found' });
});
