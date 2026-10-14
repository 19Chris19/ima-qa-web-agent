import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomic, optionalJson, digest, lock, fault } from './config.mjs';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'indeterminate']);
const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw fault('invalid_id');
  return encodeURIComponent(value);
};
export function project(snapshot) {
  const { task } = snapshot;
  const events = snapshot.snapshot?.events || [];
  let answer = '', sources = [], citationMap = {}, done = null, failureReason;
  for (const { event, data = {} } of events) {
    if (event === 'delta') answer += data.text || '';
    if (Array.isArray(data.sources)) sources = data.sources;
    if (data.citationMap) citationMap = { ...citationMap, ...data.citationMap };
    if (event === 'done') done = data;
    if (event === 'error') failureReason = data.failureReason;
  }
  return { taskId: task.id, conversationId: task.conversationId, status: task.status, question: task.question,
    answer, sources, citationMap, complete: task.status === 'succeeded' && !task.eventsExpired && !snapshot.snapshot?.eventsExpired && Boolean(done) && done.complete !== false && !done.interrupted,
    eventsExpired: Boolean(task.eventsExpired || snapshot.snapshot?.eventsExpired),
    answerBasis: done?.answer_basis ?? done?.answerBasis ?? 'unknown',
    sourceCount: done?.source_count ?? done?.sourceCount ?? sources.length,
    knowledgeSourceCount: done?.knowledge_source_count ?? done?.knowledgeSourceCount ?? null,
    webSourceCount: done?.web_source_count ?? done?.webSourceCount ?? null,
    failureReason: failureReason || (task.status === 'indeterminate' ? 'execution_interrupted' : null),
    lastEventId: task.lastEventId, observedAt: new Date().toISOString() };
}
export class ImaClient {
  constructor(config, { fetchImpl = fetch, pollMs = 1000 } = {}) { this.config = config; this.fetch = fetchImpl; this.pollMs = pollMs; }
  async request(path, { method = 'GET', body, internal = true, key, timeoutMs = 10000 } = {}) {
    const p = this.config;
    let response;
    try {
      response = await this.fetch(`${p.baseUrl}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        headers: { authorization: `Bearer ${internal ? p.internalServiceToken : p.apiToken}`, 'x-ima-client-id': p.clientId,
          ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw fault('provider_transport_error', { retryable: true }); }
    let value;
    try { value = await response.json(); } catch { throw fault('invalid_provider_response'); }
    if (!response.ok) throw fault(/^[a-z_]{1,64}$/.test(value.error || '') ? value.error : 'provider_request_failed', { status: response.status });
    return value;
  }
  async status() {
    const value = await this.request('/internal/provider-a/capacity');
    const capacity = value.website || value;
    // Checking both credentials is read-only and never submits a probe question.
    await this.request('/api/conversations?limit=1', { internal: false });
    return { profile: this.config.profile, applicationId: this.config.applicationId, clientId: this.config.clientId,
      knowledgeBase: this.config.knowledgeBaseName || null,
      ready: capacity.features?.durable_qa_tasks_v1 === true && capacity.features?.knowledge_agent_keyed_sse_v1 === true,
      capacity, identityPairing: 'Configure both tokens under the same Provider application; status cannot prove pairing.' };
  }
  async ask({ question, conversationId, requestKey = randomUUID(), waitSeconds = 25, sourceIntent = 'knowledge' }) {
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 25) throw fault('invalid_wait');
    if (typeof question !== 'string' || !question.trim()) throw fault('question_required');
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestKey)) throw fault('invalid_request_key');
    if (!['knowledge', 'web'].includes(sourceIntent)) throw fault('invalid_source_intent');
    const path = join(this.config.stateDir, 'requests', `${digest(requestKey)}.json`);
    let receipt;
    await lock(`${path}.lock`, async () => {
      receipt = await optionalJson(path);
      if (receipt && (receipt.question !== question || receipt.sourceIntent !== sourceIntent ||
        (conversationId && receipt.conversationId !== conversationId))) throw fault('request_key_conflict');
      if (!receipt) {
        if (!conversationId) {
          const result = await this.request('/api/conversations', { method: 'POST', internal: false, body: {} });
          conversationId = result.conversation.conversationId;
        }
        id(conversationId);
        receipt = { requestKey, question, conversationId, sourceIntent, taskId: null };
        // This write precedes task submission: a lost POST response is replayed with the exact same body/key.
        await atomic(path, receipt);
      }
      if (!receipt.taskId) {
        try {
          const result = await this.request('/internal/provider-a/tasks', { method: 'POST', key: digest(requestKey), body: {
            question, conversationId: receipt.conversationId, retrieval_policy: 'knowledge_agent',
            knowledge_scope_ref: this.config.knowledgeScopeRef, ...(sourceIntent === 'web' ? { source_intent: 'web_requested' } : {}) } });
          receipt.taskId = result.task.id;
          await atomic(path, receipt);
        } catch (error) { error.requestKey = requestKey; error.conversationId = receipt.conversationId; throw error; }
      }
    });
    try { return { ...await this.task(receipt.taskId, { waitSeconds }), requestKey }; }
    catch (error) {
      error.taskId = receipt.taskId; error.requestKey = requestKey; error.conversationId = receipt.conversationId;
      throw error;
    }
  }
  async task(taskId, { waitSeconds = 0 } = {}) {
    id(taskId);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 25) throw fault('invalid_wait');
    const path = join(this.config.stateDir, 'results', `${taskId}.json`);
    const cached = await optionalJson(path);
    if (cached && terminal.has(cached.status) && !cached.eventsExpired) return cached;
    const deadline = Date.now() + waitSeconds * 1000;
    let value;
    do {
      const result = await this.request(`/internal/provider-a/tasks/${id(taskId)}`, { timeoutMs: value ? Math.min(10000, Math.max(1, deadline - Date.now())) : 10000 });
      value = project(result);
      if (terminal.has(value.status)) {
        await atomic(path, value);
        return value;
      }
      if (Date.now() >= deadline) break;
      await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    return value;
  }
  conversation(conversationId) { return this.request(`/api/conversations/${id(conversationId)}`, { internal: false }); }
  cancel(taskId) { return this.request(`/internal/provider-a/tasks/${id(taskId)}`, { method: 'DELETE' }); }
}
export function markdown(result) {
  return `# IMA 研究记录\n\n- 任务：${result.taskId}\n- 会话：${result.conversationId}\n- 状态：${result.status}\n- 完整：${result.complete}\n- 回答依据：${result.answerBasis}\n- 采集时间：${result.observedAt}\n\n## 问题\n\n${result.question || ''}\n\n## 回答\n\n${result.answer}\n\n## 来源与引用映射（原始数据）\n\n\`\`\`json\n${JSON.stringify({ sources: result.sources, citationMap: result.citationMap }, null, 2).replace(/`/g, '\\u0060')}\n\`\`\`\n`;
}
