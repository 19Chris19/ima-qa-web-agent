'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp } = require('../../src/app');
const { ConversationStore } = require('../../src/conversation-store');
const { normalizeIMAWebAgentEvent } = require('../../src/ima-upstream-protocol');
const knowledge = require('../../src/knowledge-evidence');
const scope = knowledge.hash('synthetic-kb');
const reference = (key, item) => ({ eventName: 'STRUCTURED_BLOCK', data: {
  Id: 'synthetic', Type: 'referenceIndexes', Data: { reference_indexes: { indexes: { [key]: item } } },
} });
const normalize = event => normalizeIMAWebAgentEvent(event, new Set(), { knowledgeScopeRef: scope });
async function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-evidence-test-'));
  const conversations = new ConversationStore({ storePath: path.join(dir, 'history.json') });
  const config = { qaProvider: 'ima-web-agent', webAgent: { sharedKnowledgeBaseId: 'synthetic-kb' },
    conversations: { storePath: conversations.storePath }, limits: { maxQuestionLength: 2000 },
    security: { apiToken: 'synthetic-legacy', internalServiceToken: 'synthetic-legacy-service', applications: [
      { id: 'agent-a', apiTokens: ['synthetic-a'], internalServiceTokens: ['synthetic-a-service'] },
      { id: 'agent-b', apiTokens: ['synthetic-b'], internalServiceTokens: ['synthetic-b-service'] },
    ] }, sourceEvidence: { applications: ['agent-a', 'agent-b'] },
    concurrency: { maxConcurrentAsk: 1, queueLimit: 5 }, rateLimit: { windowMs: 0, max: 0 }, ...options.config };
  let dispatched = 0;
  const app = createApp({ config, conversationStore: conversations, ...(options.app || {}),
    webReadiness: { mode: 'knowledge_agent', snapshot: () => ({ mode: 'knowledge_agent' }) },
    imaWebAgentClient: { async *streamAsk(args) {
      dispatched++; args.onDispatch?.();
      if (options.stream) { yield* options.stream(args); return; }
      yield normalize(reference('42', { type: 2, media_id: 'synthetic-media-a', title: 'Synthetic material A' }));
      yield normalize(reference('9', { type: 2, media_id: 'synthetic-media-b', title: 'Synthetic material B' }));
      yield { type: 'delta', text: 'First[7](@index-ref?id=42); second[2](@index-ref?id=9).' };
      yield normalize(reference('42', { type: 2, media_id: 'synthetic-media-a', title: 'Late material A' }));
      yield { type: 'done' };
    } },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (url, init = {}, token = 'synthetic-a-service', visitor = 'synthetic-visitor') => fetch(base + url, {
    ...init, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token,
      'x-ima-client-id': visitor, ...init.headers } });
  const created = await request('/api/conversations', { method: 'POST', body: '{}' }, 'synthetic-a');
  const conversationId = (await created.json()).conversation.conversationId;
  const submit = async () => {
    const response = await request('/internal/provider-a/tasks', { method: 'POST', headers: { 'Idempotency-Key': 'synthetic-source-task' },
      body: JSON.stringify({ conversationId, question: 'Synthetic question', retrieval_policy: 'knowledge_agent', knowledge_scope_ref: scope }) });
    const { task } = await response.json();
    if (!task) throw new Error('synthetic_submission_failed');
    for (let n = 0; n < 200; n++) {
      if (app.locals.durableQATasks.store.tasks.get(task.id).status === 'succeeded') return task.id;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('synthetic_task_did_not_finish');
  };
  t.after(async () => {
    app.locals.sourceReader?.close?.(); app.locals.sourcePreview?.close?.();
    app.locals.durableQATasks?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, config, conversations, conversationId, app, base, request, submit, calls: () => dispatched };
}
module.exports = { fixture, reference, normalize, scope };
