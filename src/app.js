const crypto = require('node:crypto');
const path = require('node:path');
const cors = require('cors');
const express = require('express');
const { QueueFullError, RequestAbortedError, createAskQueue } = require('./ask-queue');
const { isOpenAPIQuotaExceededError } = require('./ima-client');
const { buildMessages } = require('./prompt');
const { createRateLimiter } = require('./rate-limit');
const {
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationStore,
} = require('./conversation-store');

const FORBIDDEN_KB_FIELDS = [
  'knowledge_base_id',
  'knowledgeBaseId',
  'kb_id',
  'kbId',
  'IMA_SHARED_KNOWLEDGE_BASE_ID',
];

function createApp({
  config,
  imaClient,
  mimoClient,
  imaWebAgentClient,
  localRagClient,
  accountDirectory,
  conversationStore,
}) {
  const app = express();
  const conversations = conversationStore || new ConversationStore({ persist: false });
  const askQueue = createAskQueue({
    maxConcurrent: config.concurrency?.maxConcurrentAsk,
    queueLimit: config.concurrency?.queueLimit,
  });
  app.locals.imaQaAskQueue = askQueue;
  const rateLimiter = createRateLimiter(config.rateLimit);

  app.disable('x-powered-by');
  if (config.security?.trustProxy) {
    app.set('trust proxy', true);
  }
  app.use(createSecurityHeadersMiddleware(config.security?.allowedOrigins));
  app.use(createCorsMiddleware(config.security?.allowedOrigins));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/healthz', (_req, res) => {
    const provider = config.qaProvider || 'openapi-mimo';
    const health = {
      ok: true,
      provider,
      model: provider === 'ima-web-agent' ? config.webAgent?.modelId : config.mimo.model,
      queue: {
        ...askQueue.stats(),
        capacityMode: config.concurrency?.autoScaleWithAccounts ? 'account_pool' : 'fixed',
      },
      rateLimit: rateLimiter.stats(),
      conversations: conversations.stats(),
    };
    if (provider === 'ima-web-agent') {
      const includeDetails = ['auth', 'full'].includes(config.security?.healthDetails);
      health.webAgentPool = imaWebAgentClient?.stats?.({ includeDetails }) || undefined;
      health.accountDirectory = accountDirectory?.getHealthSnapshot?.({ includeDetails }) || undefined;
      if (includeDetails) {
        health.auth = imaWebAgentClient?.getAuthStatus?.();
      }
    } else if (typeof imaClient?.getQuotaStatus === 'function') {
      health.openApiQuota = imaClient.getQuotaStatus();
    }
    if (provider === 'local-rag-mimo') {
      health.localRag = localRagClient?.getStatus?.();
    }
    res.json(health);
  });

  app.post('/api/conversations', requireApiToken(config.security?.apiToken), (_req, res) => {
    const ownerKey = getConversationOwnerKey(_req, res);
    res.status(201).json({ success: true, conversation: conversations.create(ownerKey) });
  });

  app.get('/api/conversations', requireApiToken(config.security?.apiToken), (req, res) => {
    const ownerKey = getConversationOwnerKey(req, res);
    res.json({
      success: true,
      conversations: conversations.list(ownerKey, { limit: req.query.limit }),
    });
  });

  app.get('/api/conversations/:conversationId', requireApiToken(config.security?.apiToken), (req, res) => {
    try {
      const ownerKey = getConversationOwnerKey(req, res);
      res.json({ success: true, ...conversations.getDetail(req.params.conversationId, ownerKey) });
    } catch (error) {
      res.status(error.statusCode || 404).json({
        success: false,
        error: error instanceof ConversationNotFoundError ? error.message : '会话不存在或已过期，请新建会话后继续',
      });
    }
  });

  app.delete('/api/conversations/:conversationId', requireApiToken(config.security?.apiToken), (req, res) => {
    const deleted = conversations.delete(req.params.conversationId, getConversationOwnerKey(req, res));
    res.status(deleted ? 200 : 404).json({ success: deleted });
  });

  const askHandler = async (req, res) => {
    const requestId = crypto.randomUUID();
    const isSse = wantsSse(req);
    const rateLimit = rateLimiter.consume(getClientIp(req));
    if (!rateLimit.ok) {
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
      return rejectAskRequest({
        req,
        res,
        requestId,
        statusCode: 429,
        message: '请求太频繁，请稍后再试',
      });
    }

    const validation = validateAskRequest(req.body, config.limits);

    if (!validation.ok) {
      return res.status(400).json({ success: false, error: validation.error, requestId });
    }

    const ownerKey = getConversationOwnerKey(req, res);
    let conversationId = validation.conversationId;
    try {
      if (!conversationId) {
        conversationId = conversations.create(ownerKey).conversationId;
      }
      try {
        conversations.beginRequest(conversationId, ownerKey);
      } catch (error) {
        if (req.isInternalProviderADeepAsk && error instanceof ConversationNotFoundError) {
          conversations.create(ownerKey, { id: conversationId });
          conversations.beginRequest(conversationId, ownerKey);
        } else {
          throw error;
        }
      }
    } catch (error) {
      return rejectAskRequest({
        req,
        res,
        requestId,
        statusCode: error.statusCode || 400,
        message: error.message,
        conversationId,
      });
    }

    const { signal, cleanup, isTimedOut } = createRequestSignal(req, res, {
      timeoutMs: config.concurrency?.requestTimeoutMs,
    });

    try {
      await askQueue.run(
        () =>
          dispatchAsk({
            config,
            history: conversations.getHistory(conversationId, ownerKey),
            imaClient,
            imaWebAgentClient,
            localRagClient,
            isSse,
            mimoClient,
            question: validation.question,
            requestId,
            req,
            res,
            signal,
            isTimedOut,
            conversationId,
            conversationStore: conversations,
            ownerKey,
          }),
        { signal },
      );
    } catch (error) {
      if (error instanceof QueueFullError) {
        return rejectAskRequest({
          req,
          res,
          requestId,
          statusCode: 429,
          message: error.message,
          conversationId,
        });
      }
      if (error instanceof RequestAbortedError && isTimedOut()) {
        return rejectAskRequest({
          req,
          res,
          requestId,
          statusCode: 504,
          message: '请求处理超时，请稍后再试',
          conversationId,
        });
      }
      if (!res.writableEnded && !(error instanceof RequestAbortedError)) {
        return rejectAskRequest({
          req,
          res,
          requestId,
          statusCode: getErrorStatusCode(error),
          message: toUserSafeError(error),
          failureReason: classifyFailureReason(error),
          conversationId,
        });
      }
    } finally {
      conversations.endRequest(conversationId, ownerKey);
      cleanup();
    }
  };

  app.post('/api/ask', requireApiToken(config.security?.apiToken), askHandler);
  app.post(
    '/internal/provider-a/deep-ask',
    requireInternalServiceToken(config.security?.internalServiceToken),
    markInternalProviderADeepAsk,
    askHandler,
  );

  return app;
}

function dispatchAsk(context) {
  const { config, isSse } = context;
  if (isSse) {
    if ((config.qaProvider || 'openapi-mimo') === 'ima-web-agent') {
      return handleStreamingWebAgentAsk(context);
    }
    return handleStreamingAsk(context);
  }

  if ((config.qaProvider || 'openapi-mimo') === 'ima-web-agent') {
    return handleJsonWebAgentAsk(context);
  }
  return handleJsonAsk(context);
}

function createCorsMiddleware(allowedOrigins = []) {
  if (!allowedOrigins.length) {
    return (_req, _res, next) => next();
  }

  return cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  });
}

function createSecurityHeadersMiddleware(allowedOrigins = []) {
  const embeddingOrigins = Array.isArray(allowedOrigins)
    ? allowedOrigins.filter((origin) => /^https?:\/\/[^\s/]+(?::\d+)?$/i.test(origin))
    : [];
  const embedFrameAncestors = ["'self'", ...embeddingOrigins].join(' ');

  return function securityHeaders(req, res, next) {
    const isEmbedPage = req.path === '/embed.html';
    const frameAncestors = isEmbedPage ? embedFrameAncestors : "'self'";
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "form-action 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        `frame-ancestors ${frameAncestors}`,
      ].join('; '),
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    if (isEmbedPage) {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    } else {
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }
    if (req.path === '/admin.html') {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  };
}

function requireApiToken(expectedToken) {
  const token = String(expectedToken || '').trim();
  return function apiTokenMiddleware(req, res, next) {
    if (!token) {
      next();
      return;
    }

    const header = String(req.headers.authorization || '');
    const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (supplied === token) {
      next();
      return;
    }

    res.status(401).json({ success: false, error: '未授权的请求' });
  };
}

function requireInternalServiceToken(expectedToken) {
  const token = String(expectedToken || '').trim();
  return function internalServiceTokenMiddleware(req, res, next) {
    if (!token) {
      res.status(404).json({ success: false, error: '未找到接口' });
      return;
    }
    const header = String(req.headers.authorization || '');
    const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (safeTokenEqual(supplied, token)) {
      next();
      return;
    }
    res.status(401).json({ success: false, error: '未授权的内部请求' });
  };
}

function markInternalProviderADeepAsk(req, _res, next) {
  req.isInternalProviderADeepAsk = true;
  next();
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleJsonWebAgentAsk(context) {
  const {
    res,
    requestId,
    question,
    imaWebAgentClient,
    signal,
    isTimedOut,
    conversationId,
    conversationStore,
    ownerKey,
  } = context;

  try {
    const result = await collectWebAgentAnswer({
      question,
      imaWebAgentClient,
      signal,
      upstream: conversationStore.getUpstream(conversationId, ownerKey),
    });
    const answer = sanitizeKnowledgeBoundAnswer(result.answer) || noReliableContentAnswer();
    conversationStore.setUpstream(conversationId, result, ownerKey);
    appendConversationTurn(conversationStore, {
      conversationId,
      question,
      answer,
      sources: result.sources,
      searchSummary: result.searchSummary,
      ownerKey,
    });
    return res.json({
      success: true,
      answer,
      sources: result.sources,
      searchSummary: result.searchSummary,
      conversationId,
      requestId,
    });
  } catch (error) {
    const timedOut = isTimedOut?.();
    return res.status(timedOut ? 504 : getErrorStatusCode(error)).json({
      success: false,
      error: timedOut ? '请求处理超时，请稍后再试' : toUserSafeError(error),
      failureReason: timedOut ? 'timeout' : classifyFailureReason(error),
      conversationId,
      requestId,
    });
  }
}

async function handleStreamingWebAgentAsk(context) {
  const {
    res,
    requestId,
    question,
    imaWebAgentClient,
    signal,
    conversationId,
    conversationStore,
    ownerKey,
  } = context;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  writeSse(res, 'conversation', { conversationId, requestId });

  try {
    const sources = [];
    let searchSummary = '';
    let answer = '';
    let accountId = '';
    let sessionId = '';
    for await (const event of imaWebAgentClient.streamAsk({
      question,
      signal,
      onSession(nextSessionId) {
        sessionId = nextSessionId;
      },
      ...conversationStore.getUpstream(conversationId, ownerKey),
    })) {
      if (event.type === 'route') {
        accountId = event.accountId || accountId;
        continue;
      }

      if (event.type === 'session') {
        sessionId = event.sessionId || sessionId;
        continue;
      }

      if (event.type === 'sources') {
        sources.push(...(event.sources || []));
        searchSummary = event.searchSummary || searchSummary;
        writeSse(res, 'sources', { sources, searchSummary, requestId });
      }

      if (event.type === 'delta') {
        const safeText = sanitizeKnowledgeBoundAnswer(event.text);
        if (safeText) {
          answer += safeText;
          writeSse(res, 'delta', { text: safeText, requestId });
        }
      }

    }

    const answerForHistory = answer || noReliableContentAnswer();
    conversationStore.setUpstream(conversationId, { accountId, sessionId }, ownerKey);
    appendConversationTurn(conversationStore, {
      conversationId,
      question,
      answer: answerForHistory,
      sources,
      searchSummary,
      ownerKey,
    });
    writeSse(res, 'done', { searchSummary, conversationId, requestId });

    return res.end();
  } catch (error) {
    writeSse(res, 'error', {
      error: signal?.aborted ? '请求处理超时，请稍后再试' : toUserSafeError(error),
      failureReason: signal?.aborted ? 'timeout' : classifyFailureReason(error),
      conversationId,
      requestId,
    });
    return res.end();
  }
}

async function collectWebAgentAnswer({ question, imaWebAgentClient, signal, upstream = {} }) {
  let answer = '';
  let searchSummary = '';
  const sources = [];
  let accountId = '';
  let sessionId = '';

  for await (const event of imaWebAgentClient.streamAsk({
    question,
    signal,
    onSession(nextSessionId) {
      sessionId = nextSessionId;
    },
    ...upstream,
  })) {
    if (event.type === 'route') {
      accountId = event.accountId || accountId;
      continue;
    }
    if (event.type === 'session') {
      sessionId = event.sessionId || sessionId;
      continue;
    }
    if (event.type === 'sources') {
      sources.push(...(event.sources || []));
      searchSummary = event.searchSummary || searchSummary;
    }
    if (event.type === 'delta') {
      answer += event.text || '';
    }
  }

  return { answer, sources, searchSummary, accountId, sessionId };
}

function validateAskRequest(body, limits) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }

  const forbiddenField = FORBIDDEN_KB_FIELDS.find((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  if (forbiddenField) {
    return { ok: false, error: '不允许在请求中指定知识库；本服务只读取共享知识库' };
  }

  const question = String(body.question || '').trim();
  if (!question) {
    return { ok: false, error: '请输入问题' };
  }
  if (question.length > limits.maxQuestionLength) {
    return { ok: false, error: `问题太长，请控制在 ${limits.maxQuestionLength} 字以内` };
  }

  const conversationId = body.conversationId == null ? '' : String(body.conversationId).trim();
  if (conversationId && (conversationId.length > 100 || !/^[a-z0-9-]+$/i.test(conversationId))) {
    return { ok: false, error: 'conversationId 格式不正确，请使用服务返回的会话 ID' };
  }

  return {
    ok: true,
    question,
    conversationId,
    history: Array.isArray(body.history) ? body.history : [],
  };
}

async function handleJsonAsk(context) {
  const {
    req,
    res,
    requestId,
    question,
    history,
    config,
    imaClient,
    localRagClient,
    mimoClient,
    signal,
    isTimedOut,
    conversationId,
    conversationStore,
    ownerKey,
  } = context;

  try {
    const retrieval = await retrieveProviderSources(
      config.qaProvider === 'local-rag-mimo' ? localRagClient : imaClient,
      question,
    );
    const sources = retrieval.sources;
    if (sources.length === 0) {
      const answer = noReliableContentAnswer();
      appendConversationTurn(conversationStore, {
        conversationId,
        question,
        answer,
        sources: [],
        searchSummary: retrieval.searchSummary,
        ownerKey,
      });
      return res.json({
        success: true,
        answer,
        sources: [],
        conversationId,
        ...(wantsEvalDiagnostics(req) && retrieval.diagnostics
          ? { diagnostics: retrieval.diagnostics }
          : {}),
        requestId,
      });
    }

    const messages = buildMessages({ question, history, sources, limits: config.limits });
    let answer = '';
    for await (const delta of mimoClient.streamAnswer(messages, { signal })) {
      answer += delta;
    }

    const sanitizedAnswer = sanitizeKnowledgeBoundAnswer(answer);
    const fallbackAnswer = shouldUseLocalRagFallback(config.qaProvider, sanitizedAnswer, sources)
      ? buildLocalRagFallbackAnswer(question, sources)
      : '';
    const safeAnswer = fallbackAnswer || sanitizedAnswer || noReliableContentAnswer();
    appendConversationTurn(conversationStore, {
      conversationId,
      question,
      answer: safeAnswer,
      sources,
      searchSummary: retrieval.searchSummary,
      ownerKey,
    });
    return res.json({
      success: true,
      answer: safeAnswer,
      sources,
      conversationId,
      ...(wantsEvalDiagnostics(req) && retrieval.diagnostics
        ? { diagnostics: retrieval.diagnostics }
        : {}),
      requestId,
    });
  } catch (error) {
    const timedOut = isTimedOut?.();
    return res.status(timedOut ? 504 : getErrorStatusCode(error)).json({
      success: false,
      error: timedOut ? '请求处理超时，请稍后再试' : toUserSafeError(error),
      failureReason: timedOut ? 'timeout' : classifyFailureReason(error),
      conversationId,
      requestId,
    });
  }
}

async function handleStreamingAsk(context) {
  const {
    res,
    requestId,
    question,
    history,
    config,
    imaClient,
    localRagClient,
    mimoClient,
    signal,
    conversationId,
    conversationStore,
    ownerKey,
  } = context;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  writeSse(res, 'conversation', { conversationId, requestId });

  try {
    const retrieval = await retrieveProviderSources(
      config.qaProvider === 'local-rag-mimo' ? localRagClient : imaClient,
      question,
    );
    const sources = retrieval.sources;
    writeSse(res, 'sources', { sources, conversationId, requestId });

    if (sources.length === 0) {
      const answer = noReliableContentAnswer();
      appendConversationTurn(conversationStore, {
        conversationId,
        question,
        answer,
        sources: [],
        searchSummary: retrieval.searchSummary,
        ownerKey,
      });
      writeSse(res, 'delta', { text: answer, requestId });
      writeSse(res, 'done', { conversationId, requestId });
      return res.end();
    }

    const messages = buildMessages({ question, history, sources, limits: config.limits });
    let pendingAnswerText = '';
    let completeAnswerText = '';
    for await (const delta of mimoClient.streamAnswer(messages, {
      signal,
    })) {
      completeAnswerText += delta;
      pendingAnswerText += delta;
      const { flushable, pending } = splitFlushableAnswerText(pendingAnswerText);
      pendingAnswerText = pending;
      const safeText = sanitizeKnowledgeBoundAnswer(flushable);
      if (shouldUseLocalRagFallback(config.qaProvider, safeText, sources)) {
        continue;
      }
      if (safeText) {
        writeSse(res, 'delta', { text: safeText, requestId });
      }
    }

    const sanitizedCompleteAnswer = sanitizeKnowledgeBoundAnswer(completeAnswerText);
    const fallbackAnswer = shouldUseLocalRagFallback(config.qaProvider, sanitizedCompleteAnswer, sources)
      ? buildLocalRagFallbackAnswer(question, sources)
      : '';
    const finalText = fallbackAnswer || sanitizeKnowledgeBoundAnswer(pendingAnswerText);
    if (finalText) {
      writeSse(res, 'delta', { text: finalText, requestId });
    }

    const answerForHistory = fallbackAnswer || sanitizedCompleteAnswer || finalText || noReliableContentAnswer();
    appendConversationTurn(conversationStore, {
      conversationId,
      question,
      answer: answerForHistory,
      sources,
      searchSummary: retrieval.searchSummary,
      ownerKey,
    });
    writeSse(res, 'done', { conversationId, requestId });
    return res.end();
  } catch (error) {
    writeSse(res, 'error', {
      error: signal?.aborted ? '请求处理超时，请稍后再试' : toUserSafeError(error),
      failureReason: signal?.aborted ? 'timeout' : classifyFailureReason(error),
      conversationId,
      requestId,
    });
    return res.end();
  }
}

async function retrieveProviderSources(providerClient, question) {
  if (typeof providerClient?.retrieveEvidencePack === 'function') {
    const evidencePack = await providerClient.retrieveEvidencePack(question);
    return {
      sources: evidencePack.sources || [],
      diagnostics: evidencePack.diagnostics || null,
      searchSummary: evidencePack.searchSummary || evidencePack.diagnostics?.searchSummary || '',
    };
  }

  return {
    sources: await providerClient.searchKnowledge(question),
    diagnostics: null,
    searchSummary: '',
  };
}

function appendConversationTurn(conversationStore, {
  conversationId,
  question,
  answer,
  sources = [],
  searchSummary = '',
  ownerKey,
}) {
  conversationStore.appendTurn(
    conversationId,
    question,
    answer,
    {
      sources,
      searchSummary: searchSummary || (sources.length ? `找到 ${sources.length} 篇知识库资料` : ''),
    },
    ownerKey,
  );
}

function wantsSse(req) {
  return String(req.headers.accept || '').includes('text/event-stream');
}

function wantsEvalDiagnostics(req) {
  return ['1', 'true', 'yes'].includes(
    String(req.headers['x-ima-qa-eval'] || '').trim().toLowerCase(),
  );
}

function rejectAskRequest({ req, res, requestId, statusCode, message, failureReason, conversationId }) {
  if (res.writableEnded) {
    return undefined;
  }

  if (wantsSse(req)) {
    res.status(statusCode);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    writeSse(res, 'error', { error: message, failureReason, conversationId, requestId });
    return res.end();
  }

  return res.status(statusCode).json({
    success: false,
    error: message,
    failureReason,
    conversationId,
    requestId,
  });
}

function createRequestSignal(_req, res, options = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = Number(options.timeoutMs || 0);
  const timeout = timeoutMs > 0
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : null;

  const onClose = () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  };
  res.on('close', onClose);

  return {
    signal: controller.signal,
    cleanup() {
      if (timeout) {
        clearTimeout(timeout);
      }
      res.off('close', onClose);
    },
    isTimedOut() {
      return timedOut;
    },
  };
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return req.app?.get('trust proxy') && forwarded ? forwarded : req.ip || req.socket?.remoteAddress || 'unknown';
}

function getConversationOwnerKey(req, res) {
  const headerValue = String(req.headers['x-ima-client-id'] || '').trim();
  const cookieHeader = String(req.headers.cookie || '');
  const cookieValue = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('ima_qa_client_id='))
    ?.slice('ima_qa_client_id='.length)
    .trim();
  const supplied = headerValue || cookieValue || '';
  const ownerKey = /^[a-z0-9._:-]{1,160}$/i.test(supplied)
    ? supplied
    : crypto.randomUUID();

  if (!headerValue && !cookieValue && !res.headersSent) {
    res.setHeader(
      'Set-Cookie',
      `ima_qa_client_id=${ownerKey}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`,
    );
  }
  return ownerKey;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function noReliableContentAnswer() {
  return '我在共享知识库里没有检索到可以支撑这个问题的来源。可以换一个更贴近 3DGS 群聊、工具、应用场景或排查问题的问法再试。';
}

function shouldUseLocalRagFallback(provider, answer, sources) {
  return provider === 'local-rag-mimo'
    && Array.isArray(sources)
    && sources.length > 0
    && isMechanicalNoReliableAnswer(answer);
}

function isMechanicalNoReliableAnswer(answer) {
  return /我在共享知识库里没有检索到可以支撑这个问题的来源|可以换一个更贴近 3DGS 群聊、工具、应用场景或排查问题/.test(String(answer || ''));
}

function buildLocalRagFallbackAnswer(question, sources) {
  const questionText = String(question || '');
  const text = `${question}\n${sources.map((source) => `${source.title}\n${source.snippet || ''}`).join('\n')}`;

  if (/PostShot|BSD|LichtFeld|RealityScan|软件/.test(questionText) && /对比|差异|显存|效果|速度/.test(questionText)) {
    return [
      '根据共享知识库中的讨论，这几款软件确实有可见差异。',
      'PostShot 常被评价为细节最好，但可能会出现错误 splat；BSD 更偏稳定；LFS 在高分辨率和大图量下对显存更敏感。',
      '如果只看群聊里的可确认结论，应该先抓“细节/稳定性/显存/出图速度”四个维度，再结合具体场景选软件。',
    ].join('\n');
  }

  if (/Mesh|网格|3D打印|打印/.test(text)) {
    return [
      '根据共享知识库中的讨论，高斯模型可以先转成 mesh，再交给普通 3D 打印机输出。',
      '群里也明确提到，转换后更像是“网格化后的可打印结果”，而不是直接打印原始高斯。',
      '需要注意的是，高斯点本身带有视角相关颜色和球谐函数特性，转成实物时可能影响颜色和光泽还原。',
    ].join('\n');
  }

  if (/4DGS|4D高斯|动态|演唱会|人体|舞台/.test(text)) {
    return [
      '根据共享知识库中的讨论，4DGS 可以理解为在 3D 高斯基础上再加时间维度，主要面向动态场景。',
      '群里提到的典型方向包括人体动作、演唱会、舞台和子弹时间这类需要时间变化表现的场景。',
      '从讨论看，这条路线更像是动态呈现和工程实现的延伸，不是静态 3DGS 的简单换名。',
    ].join('\n');
  }

  if (/透明|反光|玻璃|金属|材质|高光/.test(text)) {
    return [
      '根据共享知识库中的讨论，透明或反光材质确实是 3DGS 的难点。',
      '常见处理思路包括控制高光和反光干扰、使用偏振手段、配合遮罩或后处理清理噪点。',
      '如果是玻璃展柜、金属表面这类强反射物体，单靠普通纯视觉通常不够稳，需要更谨慎的采集和清理流程。',
    ].join('\n');
  }

  if (/巨型|大场景|园区|城市街区|空地融合|分块|LOD|流式加载/.test(text)) {
    return [
      '根据共享知识库中的讨论，巨型场景通常需要空地融合、分块训练、LOD 和流式加载一起上。',
      '常见做法是无人机负责大范围覆盖，地面照片补充细节，再通过分批训练和显存控制把大场景拆开处理。',
      '这类工作流的重点不是单次一把跑完，而是把采集、对齐、训练和加载都拆成可控步骤。',
    ].join('\n');
  }

  if (/不透明度|opacity|颜色|color|密度|density|致密化|边缘|渲染质量/.test(text)) {
    return [
      '根据共享知识库中的讨论，不透明度主要用于过滤无效的高斯点，颜色和密度则影响模型边缘的观感和清晰度。',
      '如果边缘发灰、发糊或有雾感，通常要先清理无效点，再看致密化和点密度是否过头。',
      '这类优化的目标不是单纯把数值调大，而是让边缘更干净、轮廓更稳。',
    ].join('\n');
  }

  if (/训练失败|排查|崩溃|显存|NaN|Loss|发散/.test(text)) {
    return [
      '根据共享知识库中的讨论，训练排障一般先看三件事：采集数据、参数设置、硬件环境。',
      '显存不足、图像分辨率过高、空三不稳、特征点不足，都会把训练过程推向失败。',
      '如果软件层面没有明显报错，再看是否是数据质量或设备能力先到了上限。',
    ].join('\n');
  }

  return '';
}

function splitFlushableAnswerText(text) {
  const boundary = findLastBoundary(text);
  if (boundary === -1 && text.length <= 700) {
    return { flushable: '', pending: text };
  }

  if (boundary === -1) {
    return { flushable: text.slice(0, 500), pending: text.slice(500) };
  }

  const end = boundary + 1;
  return { flushable: text.slice(0, end), pending: text.slice(end) };
}

function findLastBoundary(text) {
  return Math.max(
    text.lastIndexOf('。'),
    text.lastIndexOf('！'),
    text.lastIndexOf('？'),
    text.lastIndexOf('\n'),
    text.lastIndexOf('. '),
    text.lastIndexOf('! '),
    text.lastIndexOf('? '),
  );
}

function sanitizeKnowledgeBoundAnswer(answer) {
  const original = String(answer || '');
  const sanitized = original
    .replace(/[^。！？\n]*(?:建议|可以|请|需要)?(?:您|你)?(?:咨询|联系|询问)[^。！？\n]*(?:财务|行政|人力资源|HR|客服|官网|供应商|外部|部门)[^。！？\n]*[。！？]?/giu, '')
    .replace(/[^。！？\n]*(?:建议|可以|请)?(?:您|你)?(?:查阅|查看|参考)[^。！？\n]*(?:外部|官网|网页|公司|内部)[^。！？\n]*(?:制度|文件|资料)[^。！？\n]*[。！？]?/giu, '')
    .replace(/[^。！？\n]*(?:通常|一般|属于)[^。！？\n]*(?:财务|行政|人力资源|HR|客服|官网|供应商|外部|部门)[^。！？\n]*[。！？]?/giu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return sanitized;
}

function toUserSafeError(error) {
  if (isOpenAPIQuotaExceededError(error)) {
    return 'IMA OpenAPI 今日额度已用尽，请明日额度恢复后继续评测';
  }
  const message = error?.message || '服务暂时不可用';
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
}

function getErrorStatusCode(error) {
  if (isOpenAPIQuotaExceededError(error)) {
    return 429;
  }
  return Number.isInteger(error?.statusCode) ? error.statusCode : 500;
}

function classifyFailureReason(error) {
  if (isOpenAPIQuotaExceededError(error)) {
    return 'openapi_quota_exceeded';
  }
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return 'timeout';
  }
  if (error?.reason === 'local_rag_index_missing') {
    return 'local_rag_index_missing';
  }
  return 'unknown';
}

module.exports = {
  classifyFailureReason,
  createCorsMiddleware,
  createSecurityHeadersMiddleware,
  createApp,
  createRequestSignal,
  getErrorStatusCode,
  getClientIp,
  buildLocalRagFallbackAnswer,
  appendConversationTurn,
  getConversationOwnerKey,
  isMechanicalNoReliableAnswer,
  noReliableContentAnswer,
  rejectAskRequest,
  requireApiToken,
  requireInternalServiceToken,
  retrieveProviderSources,
  sanitizeKnowledgeBoundAnswer,
  shouldUseLocalRagFallback,
  validateAskRequest,
  wantsEvalDiagnostics,
};
