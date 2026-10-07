'use strict';

const http = require('node:http');
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { once } = require('node:events');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[a-z0-9-]{1,100}$/i;
const VISITOR = /^[a-z0-9._:-]{1,160}$/i;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const digest = value => createHash('sha256').update(value).digest();

function validateSites(sites) {
  if (!Array.isArray(sites)) throw new Error('invalid_sites');
  const tokens = new Set();
  return sites.map(site => {
    if (!site || typeof site.deploymentId !== 'string' || !/^[a-z0-9._:-]{1,100}$/i.test(site.deploymentId) ||
        typeof site.token !== 'string' || !/^[\x21-\x7e]{24,512}$/.test(site.token) ||
        tokens.has(site.token)) throw new Error('invalid_sites');
    tokens.add(site.token);
    return { deploymentId: site.deploymentId, tokenHash: digest(site.token) };
  });
}

function validateConfig(config) {
  const url = new URL(config.providerUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('provider_must_be_loopback_origin');
  }
  for (const key of ['apiToken', 'serviceToken']) {
    if (typeof config[key] !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(config[key])) {
      throw new Error('invalid_provider_credentials');
    }
  }
  if (typeof config.hmacKey !== 'string' || Buffer.byteLength(config.hmacKey) < 32 ||
      !/^[a-f0-9]{64}$/.test(config.knowledgeScopeRef || '')) throw new Error('invalid_scope_or_key');
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 1 || config.timeoutMs > 600_000)) throw new Error('invalid_timeout');
  return { ...config, providerUrl: url.origin };
}

async function readLimited(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw fail(413, 'body_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function publicHistory(value) {
  const pick = (object, fields) => Object.fromEntries(fields.filter(key =>
    ['string', 'number', 'boolean'].includes(typeof object?.[key])).map(key => [key, object[key]]));
  const conversation = object => pick(object, ['conversationId', 'title', 'createdAt', 'updatedAt', 'expiresAt', 'turnCount']);
  const result = pick(value, ['success']);
  if (value?.conversation) result.conversation = conversation(value.conversation);
  if (Array.isArray(value?.conversations)) result.conversations = value.conversations.map(conversation);
  if (Array.isArray(value?.messages)) result.messages = value.messages.map(message => {
    const item = pick(message, ['role', 'content', 'createdAt', 'searchSummary', 'source_intent',
      'answer_basis', 'source_count', 'knowledge_source_count', 'web_source_count']);
    if (Array.isArray(message?.sources)) item.sources = message.sources.map(source => pick(source, ['index', 'title', 'snippet']));
    return item;
  });
  return result;
}

function route(req) {
  // Match the raw target: URL normalization must not turn traversal into a route.
  const target = req.url;
  if (target === '/v1/capabilities') return { methods: ['GET'], kind: 'capabilities' };
  if (/^\/v1\/conversations(?:\?limit=(?:[1-9]|[1-4][0-9]|50))?$/.test(target)) {
    return { methods: target.includes('?') ? ['GET'] : ['GET', 'POST'],
      kind: 'conversations', path: target.replace('/v1/', '/api/') };
  }
  const match = /^\/v1\/conversations\/([a-z0-9-]{1,100})$/i.exec(target);
  if (match) return { methods: ['GET', 'DELETE'], kind: 'conversation', path: `/api/conversations/${match[1]}` };
  if (target === '/v1/ask') return { methods: ['POST'], kind: 'ask' };
  throw fail(404, 'not_found');
}

async function requestBody(req, kind) {
  const hasBody = req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0;
  if (Number(req.headers['content-length']) > 16_384) throw fail(413, 'body_too_large');
  if (req.method !== 'POST') {
    if (hasBody) throw fail(400, 'body_not_allowed');
    return undefined;
  }
  if (hasBody && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) {
    throw fail(415, 'json_required');
  }
  const raw = await readLimited(req.iterator({ destroyOnReturn: false }), 16_384);
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { throw fail(400, 'invalid_json'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw fail(400, 'invalid_body');
  const allowed = kind === 'ask' ? ['question', 'conversationId', 'request_id', 'sourceIntent'] : [];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw fail(400, 'unknown_field');
  if (kind === 'ask' && (typeof body.question !== 'string' || !body.question.trim() ||
      body.question.length > 1200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.question) ||
      typeof body.request_id !== 'string' || !UUID.test(body.request_id) ||
      (body.conversationId !== undefined && (typeof body.conversationId !== 'string' || !ID.test(body.conversationId))) ||
      (body.sourceIntent !== undefined && body.sourceIntent !== 'web'))) throw fail(400, 'invalid_ask');
  return body;
}

function createSharedGateway(input) {
  const config = validateConfig(input);
  let sites = validateSites(config.sites);
  const mac = (...parts) => createHmac('sha256', config.hmacKey).update(JSON.stringify(parts)).digest('hex');
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(() => {
      abort();
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) {
        res.once('finish', () => req.destroy());
        json(res, 504, { error: 'request_timeout' });
      }
    }, config.timeoutMs || 200_000);
    req.once('aborted', abort);
    res.once('close', abort);
    const upstream = (path, token, options = {}) => fetch(`${config.providerUrl}${path}`, {
      ...options, redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    try {
      const selected = route(req);
      if (!selected.methods.includes(req.method)) throw fail(405, 'method_not_allowed');
      // Do not allow ambiguous credential or visitor headers.
      for (const name of ['authorization', 'x-ima-client-id']) {
        if (req.rawHeaders.filter((value, i) => i % 2 === 0 && value.toLowerCase() === name).length !== 1) {
          throw fail(401, 'unauthorized');
        }
      }
      const authorization = req.headers.authorization || '';
      const supplied = /^Bearer ([\x21-\x7e]{24,512})$/.exec(authorization);
      const hash = digest(supplied?.[1] || '');
      const site = sites.find(entry => timingSafeEqual(entry.tokenHash, hash));
      if (!supplied || !site) throw fail(401, 'unauthorized');
      const visitor = req.headers['x-ima-client-id'];
      if (typeof visitor !== 'string' || !VISITOR.test(visitor)) throw fail(400, 'invalid_client_id');
      const owner = `sg:${mac('owner-v1', site.deploymentId, visitor)}`;
      const body = await requestBody(req, selected.kind);
      if (selected.kind === 'capabilities' || selected.kind === 'ask') {
        const state = { schemaVersion: 1, features: { knowledge_agent_keyed_sse_v1: false },
          connected: false, configured: true, authenticated: false,
          contractSupported: false, ready: false, capacity: 0, active: 0, queued: 0, webIntentSupported: false };
        try {
          const response = await upstream('/internal/provider-a/capacity', config.serviceToken);
          state.connected = true;
          if (response.status === 200) {
            const value = JSON.parse(await readLimited(response.body, 65_536));
            state.contractSupported = value.schemaVersion === 1 && value.features?.knowledge_agent_keyed_sse_v1 === true;
            state.features.knowledge_agent_keyed_sse_v1 = state.contractSupported;
            state.webIntentSupported = state.contractSupported && value.features?.source_intent_web_requested_v1 === true;
            const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
            state.capacity = count(value.policies?.knowledge_agent?.max_concurrent);
            state.active = count(value.active);
            state.queued = count(value.queued);
            const ordinary = await upstream('/api/conversations?limit=1', config.apiToken,
              { headers: { 'X-IMA-Client-Id': owner, Accept: 'application/json' } });
            state.authenticated = ordinary.ok;
            await ordinary.body?.cancel();
            state.ready = state.authenticated && state.contractSupported && state.capacity > 0;
          } else await response.body?.cancel();
        } catch { /* Report only the sanitized readiness state. */ }
        if (selected.kind === 'capabilities') return json(res, 200, state);
        if (!state.ready || (body.sourceIntent === 'web' && !state.webIntentSupported)) {
          throw fail(503, 'provider_not_ready');
        }
      }
      const headers = { 'X-IMA-Client-Id': owner, Accept: 'application/json' };
      let path = selected.path;
      let payload;
      if (selected.kind === 'ask') {
        path = '/internal/provider-a/deep-ask';
        headers.Accept = 'text/event-stream';
        headers['Idempotency-Key'] = mac('request-v1', site.deploymentId, visitor, body.request_id.toLowerCase());
        payload = { question: body.question, ...(body.conversationId ? { conversationId: body.conversationId } : {}),
          retrieval_policy: 'knowledge_agent', knowledge_scope_ref: config.knowledgeScopeRef,
          ...(body.sourceIntent === 'web' ? { source_intent: 'web_requested' } : {}) };
      } else if (req.method === 'POST') payload = {};
      if (payload) headers['Content-Type'] = 'application/json';
      const response = await upstream(path, selected.kind === 'ask' ? config.serviceToken : config.apiToken,
        { method: req.method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      if (!response.ok) {
        await response.body?.cancel();
        throw fail([400, 404, 409, 429].includes(response.status) ? response.status : 502, 'provider_request_failed');
      }
      if (selected.kind === 'ask') {
        if (!/^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type') || '')) {
          await response.body?.cancel();
          throw fail(502, 'invalid_provider_stream');
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        res.flushHeaders();
        for await (const chunk of response.body) {
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        }
        res.end();
      } else {
        const value = JSON.parse(await readLimited(response.body, 2_097_152));
        json(res, response.status, publicHistory(value));
      }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) {
        req.resume();
        json(res, controller.signal.aborted ? 504 : error.status || 502,
          { error: controller.signal.aborted ? 'request_timeout' : error.status ? error.code : 'provider_unavailable' });
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return { server, replaceSites(next) { sites = validateSites(next); },
    listen(port = 8790) { return server.listen(port, '127.0.0.1'); } };
}

module.exports = { createSharedGateway };
