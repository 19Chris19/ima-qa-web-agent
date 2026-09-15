import { createHash } from 'node:crypto';
import { BotAdapter } from './adapter.mjs';

const real = process.argv.includes('--real');
const base = process.env.PROVIDER_A_URL;
const token = process.env.PROVIDER_A_SERVICE_TOKEN;
if (real && (!base || !token)) throw new Error('Set PROVIDER_A_URL and PROVIDER_A_SERVICE_TOKEN in the backend environment');
async function request(route, options = {}) {
  const response = await fetch(new URL(route, base), {
    signal: AbortSignal.timeout(10000),
    ...options, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers },
  });
  if (!response.ok) throw new Error(`provider_http_${response.status}`);
  return response.json();
}
const adapter = new BotAdapter({
  capacity: real ? () => request('/internal/provider-a/capacity') : async () => ({ maxConcurrent: 2 }),
  ask: real ? ({ owner, messageId, question, conversationId, signal }) => request('/internal/provider-a/deep-ask', {
    method: 'POST', headers: { 'X-IMA-Client-Id': `bot-demo:${owner}`, 'Idempotency-Key': createHash('sha256').update(messageId).digest('hex') }, signal,
    body: JSON.stringify({ question, conversationId, stream: false }),
  }) : async ({ owner, question, conversationId }) => ({ success: true, answer: `Synthetic answer: ${question}`, conversationId: conversationId || `demo-${owner}` }),
});
const question = process.env.PROVIDER_A_DEMO_QUESTION || '请根据当前知识库概括主要主题，并引用相关资料';
const results = await Promise.all(['user-1', 'user-2'].map(user => adapter.receive({ user, messageId: 'first', question, signal: AbortSignal.timeout(120000) })));
for (const [index, result] of results.entries()) console.log(`模拟用户 ${index + 1}\n${result.answer}\n`);
