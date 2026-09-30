import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

const directory = path.dirname(fileURLToPath(import.meta.url));
const page = await readFile(path.join(directory, 'index.html'));
const stylesheet = await readFile(path.join(directory, 'style.css'));
const clientScript = await readFile(path.join(directory, 'client.js'));
const sseScript = await readFile(path.join(directory, 'sse.mjs'));
const cookieName = 'web_bff_demo';

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendEvent(res, name, value) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8192) throw new Error('request_too_large');
  }
  return JSON.parse(raw || '{}');
}

export function createWebBff({ mode = 'synthetic', providerUrl = '', apiToken = '', serviceToken = '', scopeRef = '', fetchImpl = fetch } = {}) {
  if (mode === 'real' && (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/u.test(providerUrl) ||
      !apiToken || !serviceToken || !/^[a-f0-9]{64}$/u.test(scopeRef))) {
    throw new Error('real mode requires a localhost Provider URL, separate API and service tokens, and a knowledge scope SHA-256');
  }
  const signingKey = randomBytes(32);
  const syntheticSessions = new Map();
  const syntheticReceipts = new Map();

  function ownerFor(req, res) {
    const rawCookie = String(req.headers.cookie || '').split(';').map(part => part.trim())
      .find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '';
    const [id, signature] = rawCookie.split('.');
    if (/^[a-f0-9-]{36}$/u.test(id || '') && /^[a-f0-9]{64}$/u.test(signature || '')) {
      const expected = createHmac('sha256', signingKey).update(id).digest('hex');
      if (timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return `web-demo:${id}`;
    }
    const next = randomUUID();
    const mac = createHmac('sha256', signingKey).update(next).digest('hex');
    res.setHeader('Set-Cookie', `${cookieName}=${next}.${mac}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return `web-demo:${next}`;
  }

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; connect-src 'self'");
    const owner = ownerFor(req, res);
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method === 'POST' && (req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') {
      return sendJson(res, 415, { error: 'json_required' });
    }
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      return sendJson(res, 403, { error: 'cross_origin_request' });
    }
    const staticFiles = { '/style.css': [stylesheet, 'text/css'], '/client.js': [clientScript, 'text/javascript'], '/sse.mjs': [sseScript, 'text/javascript'] };
    if (req.method === 'GET' && staticFiles[pathname]) {
      const [contents, type] = staticFiles[pathname];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(contents);
      return;
    }
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      if (mode === 'synthetic') return sendJson(res, 200, { ready: true, capacity: 1, synthetic: true });
      try {
        const [capacity, ordinary] = await Promise.all([
          fetchImpl(`${providerUrl}/internal/provider-a/capacity`, { headers: { Authorization: `Bearer ${serviceToken}` }, signal: AbortSignal.timeout(3500) }),
          fetchImpl(`${providerUrl}/api/conversations?limit=1`, { headers: { Authorization: `Bearer ${apiToken}`, 'X-IMA-Client-Id': owner }, signal: AbortSignal.timeout(3500) }),
        ]);
        const data = capacity.ok ? await capacity.json() : {};
        const native = Number(data.policies?.knowledge_agent?.max_concurrent || 0);
        const contractSupported = data.schemaVersion === 1 && data.features?.knowledge_agent_keyed_sse_v1 === true;
        return sendJson(res, 200, { ready: capacity.ok && ordinary.ok && contractSupported && native > 0, capacity: native,
          authenticated: capacity.ok && ordinary.ok, contractSupported,
          webIntentSupported: contractSupported && data.features?.source_intent_web_requested_v1 === true });
      } catch { return sendJson(res, 503, { ready: false, capacity: 0 }); }
    }
    const detail = /^\/api\/conversations\/([a-f0-9-]{36})$/u.exec(pathname);
    if (req.method === 'GET' && detail) {
      if (mode === 'synthetic') {
        const session = syntheticSessions.get(`${owner}:${detail[1]}`);
        return sendJson(res, session ? 200 : 404, session || { error: 'not_found' });
      }
      try {
        const upstream = await fetchImpl(`${providerUrl}/api/conversations/${detail[1]}`, {
          headers: { Authorization: `Bearer ${apiToken}`, 'X-IMA-Client-Id': owner }, signal: AbortSignal.timeout(3500),
        });
        return sendJson(res, upstream.status, await upstream.json());
      } catch { return sendJson(res, 503, { error: 'provider_unavailable' }); }
    }
    if (req.method === 'POST' && pathname === '/api/ask') {
      let input;
      try { input = await readJson(req); }
      catch { return sendJson(res, 400, { error: 'invalid_request' }); }
      const question = typeof input.question === 'string' ? input.question.trim() : '';
      const conversationId = input.conversationId || '';
      const requestId = input.requestId || '';
      const sourceIntent = input.sourceIntent || '';
      if (!question || question.length > 2000 || (conversationId && !/^[a-f0-9-]{36}$/u.test(conversationId)) ||
          !/^[a-f0-9-]{36}$/u.test(requestId) || !['', 'web'].includes(sourceIntent)) {
        return sendJson(res, 400, { error: 'invalid_request' });
      }
      const fingerprint = createHash('sha256').update(JSON.stringify({ question, conversationId, sourceIntent })).digest('hex');
      const receiptKey = `${owner}:${requestId}`;
      if (mode === 'synthetic') {
        if (syntheticReceipts.has(receiptKey)) return sendJson(res, 409, { error: 'duplicate_request' });
        syntheticReceipts.set(receiptKey, fingerprint);
        if (syntheticReceipts.size > 1000) syntheticReceipts.delete(syntheticReceipts.keys().next().value);
        const id = conversationId || randomUUID();
        const key = `${owner}:${id}`;
        const session = syntheticSessions.get(key) || { conversation: { conversationId: id }, messages: [] };
        const answer = session.messages.length ? '这是合成追问回答。真实模式由 Provider A 生成正文和来源。' : '这是合成首问回答。真实模式由 Provider A 生成正文和来源。';
        session.messages.push({ role: 'user', content: question }, { role: 'assistant', content: answer,
          source_intent: sourceIntent === 'web' ? 'web_requested' : '', answer_basis: 'knowledge',
          source_count: 1, knowledge_source_count: 1, web_source_count: 0 });
        syntheticSessions.set(key, session);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
        sendEvent(res, 'conversation', { conversationId: id });
        sendEvent(res, 'sources', { sources: [{ title: '合成知识库来源' }] });
        sendEvent(res, 'delta', { text: answer });
        sendEvent(res, 'done', { conversationId: id, source_intent: sourceIntent === 'web' ? 'web_requested' : '',
          answer_basis: 'knowledge', source_count: 1, knowledge_source_count: 1, web_source_count: 0 });
        res.end();
        return;
      }
      const key = createHash('sha256').update(`web-bff:v1:${owner}:${requestId}`).digest('hex');
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      try {
        const upstream = await fetchImpl(`${providerUrl}/internal/provider-a/deep-ask`, {
          method: 'POST', signal: controller.signal, redirect: 'manual',
          headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json', Accept: 'text/event-stream',
            'X-IMA-Client-Id': owner, 'Idempotency-Key': key },
          body: JSON.stringify({ question, ...(conversationId ? { conversationId } : {}), retrieval_policy: 'knowledge_agent',
            knowledge_scope_ref: scopeRef, ...(sourceIntent === 'web' ? { source_intent: 'web_requested' } : {}) }),
        });
        if (!upstream.ok || !String(upstream.headers.get('content-type') || '').includes('text/event-stream') || !upstream.body) {
          return sendJson(res, upstream.status >= 400 ? upstream.status : 502, { error: 'provider_request_failed' });
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' });
        for await (const chunk of upstream.body) res.write(chunk);
        res.end();
      } catch {
        if (!res.headersSent) sendJson(res, 503, { error: 'provider_unavailable' });
        else if (!res.destroyed) res.end();
      }
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dotenv.config({ path: path.join(directory, '.env.local') });
  const server = createWebBff({ mode: process.env.WEB_BFF_MODE || 'synthetic', providerUrl: process.env.PROVIDER_A_URL || '',
    apiToken: process.env.PROVIDER_A_API_TOKEN || '', serviceToken: process.env.PROVIDER_A_SERVICE_TOKEN || '',
    scopeRef: process.env.PROVIDER_A_KNOWLEDGE_SCOPE_REF || '' });
  const port = Number(process.env.WEB_BFF_PORT || 4320);
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Web BFF example: http://127.0.0.1:${port}/\n`));
}
