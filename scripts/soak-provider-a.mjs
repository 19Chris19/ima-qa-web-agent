import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { createApp } = require('../src/app.js');
const { ConversationStore } = require('../src/conversation-store.js');
const durationMs = Math.max(1000, Number(process.env.SOAK_DURATION_MS || 1_800_000));
const clients = Math.max(2, Math.min(24, Number(process.env.SOAK_CLIENTS || 8)));
const injectFaults = process.env.SOAK_INJECT_FAULTS !== '0';
const root = await mkdtemp(path.join(tmpdir(), 'ima-provider-a-soak-'));
const conversationPath = path.join(root, 'conversations.json');
const config = {
  qaProvider: 'ima-web-agent',
  limits: { maxQuestionLength: 2000, maxHistoryTurns: 6, maxHistoryContentLength: 1000, maxSources: 6, maxSnippetLength: 900 },
  mimo: { model: 'synthetic' },
  security: { apiToken: '', internalServiceToken: 'synthetic-soak-token', adminToken: '', allowedOrigins: [], healthDetails: 'basic', trustProxy: false },
  concurrency: { maxConcurrentAsk: 4, queueLimit: 32, requestTimeoutMs: 10_000 },
  rateLimit: { windowMs: 0, max: 0 },
  conversations: { storePath: conversationPath },
};

const counters = { completed: 0, replayed: 0, timedOut: 0, overloadTimedOut: 0, cancelled: 0, rejectedUnknown: 0, failed: 0, dispatches: 0, crossUserLeak: 0, maxActive: 0, failureCodes: {} };
const sessions = new Map();
const dispatchesByQuestion = new Map();
const activeByClient = new Map();
const streamsByClient = new Map();
const laneTails = Array.from({ length: 4 }, () => Promise.resolve());
let active = 0;
const fakeAgent = {
  async *streamAsk(options) {
    const match = /^client-(\d+) turn-(\d+)(?: (slow|cancel))?$/u.exec(options.question);
    if (!match) throw new Error('synthetic_question_invalid');
    const clientId = Number(match[1]);
    const turn = Number(match[2]);
    streamsByClient.set(clientId, (streamsByClient.get(clientId) || 0) + 1);
    const lane = clientId % laneTails.length;
    let release;
    const previous = laneTails[lane];
    laneTails[lane] = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      active++;
      activeByClient.set(clientId, (activeByClient.get(clientId) || 0) + 1);
      counters.maxActive = Math.max(counters.maxActive, active);
      counters.dispatches++;
      dispatchesByQuestion.set(options.question, (dispatchesByQuestion.get(options.question) || 0) + 1);
      const accountId = `synthetic-account-${lane}`;
      const sessionId = sessions.get(clientId) || `synthetic-session-${clientId}`;
      if (options.sessionId && options.sessionId !== sessionId) throw new Error('synthetic_session_mismatch');
      yield { type: 'route', accountId };
      options.onSession?.(sessionId);
      yield { type: 'session', sessionId };
      if (match[3] === 'slow') await delay(12_000, undefined, { signal: options.signal });
      else if (match[3] === 'cancel') await delay(5000, undefined, { signal: options.signal });
      else await delay(6, undefined, { signal: options.signal });
      sessions.set(clientId, sessionId);
      yield { type: 'sources', sources: [{ index: 1, title: `Synthetic source ${clientId}`, snippet: 'Synthetic evidence' }], searchSummary: 'Synthetic retrieval' };
      yield { type: 'delta', text: `Synthetic answer for client-${clientId}, turn-${turn} [1]` };
      yield { type: 'done' };
    } finally {
      active--;
      activeByClient.set(clientId, Math.max(0, (activeByClient.get(clientId) || 1) - 1));
      streamsByClient.set(clientId, Math.max(0, (streamsByClient.get(clientId) || 1) - 1));
      release();
    }
  },
};

const app = createApp({ config, imaWebAgentClient: fakeAgent, conversationStore: new ConversationStore({ storePath: conversationPath }) });
const server = await new Promise((resolve, reject) => {
  const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  listener.once('error', reject);
});
const base = `http://127.0.0.1:${server.address().port}`;
const expiresAt = Date.now() + durationMs;
let reportedAt = Date.now();

async function ask(client, turn, conversationId, kind = 'normal') {
  const question = `client-${client} turn-${turn}${kind === 'normal' ? '' : ` ${kind}`}`;
  const key = `client-${client}-message-${turn}`;
  const headers = { authorization: 'Bearer synthetic-soak-token', 'content-type': 'application/json', 'X-IMA-Client-Id': `synthetic-user-${client}`, 'Idempotency-Key': key };
  const body = JSON.stringify({ question, ...(conversationId ? { conversationId } : {}) });
  let response;
  try { response = await fetch(`${base}/internal/provider-a/deep-ask`, { method: 'POST', headers, body }); }
  catch (error) {
    if (kind === 'cancel' && error.name === 'AbortError') return { cancelled: true, conversationId };
    const cause = String(error?.cause?.code || error?.cause?.name || error?.name || 'unknown').replace(/[^a-zA-Z0-9_:-]/gu, '_').slice(0, 80);
    throw new Error(`fetch_${cause}`);
  }
  if (kind === 'slow') {
    if (response.status !== 504) throw new Error(`timeout_expected_504_got_${response.status}`);
    const retry = await fetch(`${base}/internal/provider-a/deep-ask`, { method: 'POST', headers, body });
    const retryData = await retry.json().catch(() => ({}));
    if (retry.status !== 409 || !['unknown', 'processing'].includes(retryData.idempotencyState)) {
      throw new Error(`timeout_retry_http_${retry.status}_${retryData.error || 'unexpected_state'}`);
    }
    counters.timedOut++;
    counters.rejectedUnknown++;
    await waitForClientIdle(client);
    return { conversationId, failedTurn: true };
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 504 && data.failureReason === 'timeout' && kind === 'normal') {
      const retry = await fetch(`${base}/internal/provider-a/deep-ask`, { method: 'POST', headers, body });
      const retryData = await retry.json().catch(() => ({}));
      if (retry.status !== 409 || !['unknown', 'processing'].includes(retryData.idempotencyState)) {
        throw new Error(`overload_timeout_retry_http_${retry.status}_${retryData.idempotencyState || 'unexpected_state'}`);
      }
      counters.overloadTimedOut++;
      counters.rejectedUnknown++;
      await waitForClientIdle(client);
      return { conversationId: data.conversationId || conversationId, failedTurn: true };
    }
    const code = responseCode(data, response.status);
    throw new Error(`ask_http_${response.status}_${code}`);
  }
  const result = await response.json();
  if (!result.answer.includes(`client-${client}`)) counters.crossUserLeak++;
  if (!conversationId) conversationId = result.conversationId;
  counters.completed++;
  if (turn % 17 === 0) {
    const replay = await fetch(`${base}/internal/provider-a/deep-ask`, { method: 'POST', headers, body });
    const replayData = await replay.json();
    if (replay.status !== 200 || replayData.idempotentReplay !== true || !replayData.answer.includes(`client-${client}`)) throw new Error('idempotent_replay_failed');
    if (dispatchesByQuestion.get(question) !== 1) throw new Error('duplicate_upstream_dispatch');
    counters.replayed++;
  }
  return { conversationId };
}

async function waitForClientIdle(client) {
  const deadline = Date.now() + 10_000;
  while (((activeByClient.get(client) || 0) > 0 || (streamsByClient.get(client) || 0) > 0) && Date.now() < deadline) await delay(10);
  if ((activeByClient.get(client) || 0) > 0 || (streamsByClient.get(client) || 0) > 0) throw new Error('cancelled_upstream_did_not_stop');
}

function responseCode(data, status) {
  if (data.failureReason) return data.storeErrorCode ? `${data.failureReason}_${data.storeErrorCode}` : data.failureReason;
  if (data.idempotencyState) return `idempotency_${data.idempotencyState}`;
  if (data.error === 'idempotency_conflict') return 'idempotency_conflict';
  if (/^[A-Za-z0-9_:-]{1,80}$/u.test(String(data.error || ''))) return data.error;
  if (String(data.error || '').includes('上一条消息还在处理中')) return 'conversation_busy';
  if (String(data.error || '').includes('幂等存储正在更新')) return 'idempotency_lock_busy';
  if (String(data.error || '').includes('幂等存储')) return 'idempotency_store_unavailable';
  if (String(data.error || '').includes('超时')) return 'request_timeout';
  if (String(data.error || '').includes('排队')) return 'queue_busy';
  return `http_${status}_unclassified`;
}

async function clientLoop(client) {
  let conversationId = '';
  let turn = 0;
  while (Date.now() < expiresAt) {
    turn++;
    try {
      const kind = !injectFaults ? 'normal' : turn % 47 === 0 ? 'slow' : turn % 61 === 0 ? 'cancel' : 'normal';
      if (kind === 'cancel') {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20);
        const headers = { authorization: 'Bearer synthetic-soak-token', 'content-type': 'application/json', 'X-IMA-Client-Id': `synthetic-user-${client}`, 'Idempotency-Key': `client-${client}-message-${turn}` };
        const body = JSON.stringify({ question: `client-${client} turn-${turn} cancel`, ...(conversationId ? { conversationId } : {}) });
        try { await fetch(`${base}/internal/provider-a/deep-ask`, { method: 'POST', headers, body, signal: controller.signal }); }
        catch (error) {
          if (error.name !== 'AbortError') throw new Error(`cancel_fetch_${error?.cause?.code || error?.name || 'unknown'}`);
        }
        clearTimeout(timer);
        await delay(20);
        const retry = await fetch(`${base}/internal/provider-a/deep-ask`, { method: 'POST', headers, body });
        const retryData = await retry.json().catch(() => ({}));
        if (retry.status !== 409 || !['unknown', 'processing'].includes(retryData.idempotencyState)) {
          throw new Error(retry.status === 200 ? 'cancelled_request_was_reissued' : `cancel_retry_http_${retry.status}_${retryData.error || 'unexpected_state'}`);
        }
        counters.cancelled++;
        counters.rejectedUnknown++;
        await waitForClientIdle(client);
      } else {
        const result = await ask(client, turn, conversationId, kind);
        conversationId = result.conversationId || conversationId;
      }
    } catch (error) {
      counters.failed++;
      const code = String(error?.message || error?.name || 'unknown').replace(/[^a-zA-Z0-9_:-]/gu, '_').slice(0, 80) || 'unknown';
      counters.failureCodes[code] = (counters.failureCodes[code] || 0) + 1;
    }
    if (Date.now() - reportedAt >= 60_000) {
      reportedAt = Date.now();
      console.log(JSON.stringify({ elapsedMs: durationMs - Math.max(0, expiresAt - Date.now()), counters }));
    }
  }
}

try {
  await Promise.all(Array.from({ length: clients }, (_, client) => clientLoop(client)));
  const elapsedMs = Date.now() - (expiresAt - durationMs);
  const health = await (await fetch(`${base}/healthz`)).json();
  const final = { elapsedMs, clients, injectFaults, counters, queue: health.queue };
  console.log(JSON.stringify(final));
  if (counters.failed || counters.crossUserLeak || counters.maxActive > 4 || health.queue.queuedRequests !== 0 || health.queue.activeRequests !== 0) throw new Error('soak_invariant_failed');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
