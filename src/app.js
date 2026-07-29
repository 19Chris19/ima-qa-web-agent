const crypto = require('node:crypto');
const path = require('node:path');
const cors = require('cors');
const express = require('express');
const { QueueFullError, RequestAbortedError, createAskQueue } = require('./ask-queue');
const { buildMessages } = require('./prompt');
const { createRateLimiter } = require('./rate-limit');

const FORBIDDEN_KB_FIELDS = [
  'knowledge_base_id',
  'knowledgeBaseId',
  'kb_id',
  'kbId',
  'IMA_SHARED_KNOWLEDGE_BASE_ID',
];

function createApp({ config, imaClient, mimoClient, imaWebAgentClient }) {
  const app = express();
  const askQueue = createAskQueue({
    maxConcurrent: config.concurrency?.maxConcurrentAsk,
    queueLimit: config.concurrency?.queueLimit,
  });
  const rateLimiter = createRateLimiter(config.rateLimit);

  app.disable('x-powered-by');
  if (config.security?.trustProxy) {
    app.set('trust proxy', true);
  }
  app.use(createCorsMiddleware(config.security?.allowedOrigins));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/healthz', (_req, res) => {
    const provider = config.qaProvider || 'openapi-mimo';
    const health = {
      ok: true,
      provider,
      model: provider === 'ima-web-agent' ? config.webAgent?.modelId : config.mimo.model,
      queue: askQueue.stats(),
      rateLimit: rateLimiter.stats(),
    };
    if (
      provider === 'ima-web-agent' &&
      ['auth', 'full'].includes(config.security?.healthDetails)
    ) {
      health.auth = imaWebAgentClient?.getAuthStatus?.();
    }
    res.json(health);
  });

  app.post('/api/ask', requireApiToken(config.security?.apiToken), async (req, res) => {
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

    const { signal, cleanup, isTimedOut } = createRequestSignal(req, res, {
      timeoutMs: config.concurrency?.requestTimeoutMs,
    });

    try {
      await askQueue.run(
        () =>
          dispatchAsk({
            config,
            history: validation.history,
            imaClient,
            imaWebAgentClient,
            isSse,
            mimoClient,
            question: validation.question,
            requestId,
            req,
            res,
            signal,
            isTimedOut,
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
        });
      }
      if (error instanceof RequestAbortedError && isTimedOut()) {
        return rejectAskRequest({
          req,
          res,
          requestId,
          statusCode: 504,
          message: '请求处理超时，请稍后再试',
        });
      }
      if (!res.writableEnded && !(error instanceof RequestAbortedError)) {
        return rejectAskRequest({
          req,
          res,
          requestId,
          statusCode: 500,
          message: toUserSafeError(error),
        });
      }
    } finally {
      cleanup();
    }
  });

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
    return cors();
  }

  return cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Not allowed by CORS'));
    },
  });
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

async function handleJsonWebAgentAsk(context) {
  const { res, requestId, question, imaWebAgentClient, signal, isTimedOut } = context;

  try {
    const { answer, sources, searchSummary } = await collectWebAgentAnswer({
      question,
      imaWebAgentClient,
      signal,
    });
    return res.json({
      success: true,
      answer: sanitizeKnowledgeBoundAnswer(answer) || noReliableContentAnswer(),
      sources,
      searchSummary,
      requestId,
    });
  } catch (error) {
    return res.status(isTimedOut?.() ? 504 : 500).json({
      success: false,
      error: isTimedOut?.() ? '请求处理超时，请稍后再试' : toUserSafeError(error),
      requestId,
    });
  }
}

async function handleStreamingWebAgentAsk(context) {
  const { res, requestId, question, imaWebAgentClient, signal } = context;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    const sources = [];
    let searchSummary = '';
    for await (const event of imaWebAgentClient.streamAsk({
      question,
      signal,
    })) {
      if (event.type === 'sources') {
        sources.push(...(event.sources || []));
        searchSummary = event.searchSummary || searchSummary;
        writeSse(res, 'sources', { sources, searchSummary, requestId });
      }

      if (event.type === 'delta') {
        const safeText = sanitizeKnowledgeBoundAnswer(event.text);
        if (safeText) {
          writeSse(res, 'delta', { text: safeText, requestId });
        }
      }

      if (event.type === 'done') {
        writeSse(res, 'done', { searchSummary, requestId });
      }
    }

    return res.end();
  } catch (error) {
    writeSse(res, 'error', {
      error: signal?.aborted ? '请求处理超时，请稍后再试' : toUserSafeError(error),
      requestId,
    });
    return res.end();
  }
}

async function collectWebAgentAnswer({ question, imaWebAgentClient, signal }) {
  let answer = '';
  let searchSummary = '';
  const sources = [];

  for await (const event of imaWebAgentClient.streamAsk({ question, signal })) {
    if (event.type === 'sources') {
      sources.push(...(event.sources || []));
      searchSummary = event.searchSummary || searchSummary;
    }
    if (event.type === 'delta') {
      answer += event.text || '';
    }
  }

  return { answer, sources, searchSummary };
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

  return {
    ok: true,
    question,
    history: Array.isArray(body.history) ? body.history : [],
  };
}

async function handleJsonAsk(context) {
  const { res, requestId, question, history, config, imaClient, mimoClient, signal, isTimedOut } = context;

  try {
    const sources = await imaClient.searchKnowledge(question);
    if (sources.length === 0) {
      return res.json({
        success: true,
        answer: noReliableContentAnswer(),
        sources: [],
        requestId,
      });
    }

    const messages = buildMessages({ question, history, sources, limits: config.limits });
    let answer = '';
    for await (const delta of mimoClient.streamAnswer(messages, { signal })) {
      answer += delta;
    }

    const safeAnswer = sanitizeKnowledgeBoundAnswer(answer) || noReliableContentAnswer();
    return res.json({
      success: true,
      answer: safeAnswer,
      sources,
      requestId,
    });
  } catch (error) {
    return res.status(isTimedOut?.() ? 504 : 500).json({
      success: false,
      error: isTimedOut?.() ? '请求处理超时，请稍后再试' : toUserSafeError(error),
      requestId,
    });
  }
}

async function handleStreamingAsk(context) {
  const { res, requestId, question, history, config, imaClient, mimoClient, signal } = context;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    const sources = await imaClient.searchKnowledge(question);
    writeSse(res, 'sources', { sources, requestId });

    if (sources.length === 0) {
      const answer = noReliableContentAnswer();
      writeSse(res, 'delta', { text: answer, requestId });
      writeSse(res, 'done', { requestId });
      return res.end();
    }

    const messages = buildMessages({ question, history, sources, limits: config.limits });
    let pendingAnswerText = '';
    for await (const delta of mimoClient.streamAnswer(messages, {
      signal,
    })) {
      pendingAnswerText += delta;
      const { flushable, pending } = splitFlushableAnswerText(pendingAnswerText);
      pendingAnswerText = pending;
      const safeText = sanitizeKnowledgeBoundAnswer(flushable);
      if (safeText) {
        writeSse(res, 'delta', { text: safeText, requestId });
      }
    }

    const finalText = sanitizeKnowledgeBoundAnswer(pendingAnswerText);
    if (finalText) {
      writeSse(res, 'delta', { text: finalText, requestId });
    }

    writeSse(res, 'done', { requestId });
    return res.end();
  } catch (error) {
    writeSse(res, 'error', {
      error: signal?.aborted ? '请求处理超时，请稍后再试' : toUserSafeError(error),
      requestId,
    });
    return res.end();
  }
}

function wantsSse(req) {
  return String(req.headers.accept || '').includes('text/event-stream');
}

function rejectAskRequest({ req, res, requestId, statusCode, message }) {
  if (res.writableEnded) {
    return undefined;
  }

  if (wantsSse(req)) {
    res.status(statusCode);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    writeSse(res, 'error', { error: message, requestId });
    return res.end();
  }

  return res.status(statusCode).json({ success: false, error: message, requestId });
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

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function noReliableContentAnswer() {
  return '我在共享知识库里没有检索到可以支撑这个问题的来源。可以换一个更贴近 3DGS 群聊、工具、应用场景或排查问题的问法再试。';
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
  const message = error?.message || '服务暂时不可用';
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]');
}

module.exports = {
  createCorsMiddleware,
  createApp,
  createRequestSignal,
  getClientIp,
  noReliableContentAnswer,
  rejectAskRequest,
  requireApiToken,
  sanitizeKnowledgeBoundAnswer,
  validateAskRequest,
};
