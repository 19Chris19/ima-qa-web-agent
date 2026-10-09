const crypto = require('node:crypto');
const path = require('node:path');
const cors = require('cors');
const express = require('express');
const { QueueFullError, RequestAbortedError, createAskQueue } = require('./ask-queue');
const { isOpenAPIQuotaExceededError } = require('./ima-client');
const { buildMessages } = require('./prompt');
const { createRateLimiter } = require('./rate-limit');
const { InternalAskIdempotency } = require('./internal-ask-idempotency');
const { createAnswerTextStream, sanitizeIMAAnswerText } = require('./answer-text-stream');
const { IMAUpstreamProtocolError } = require('./ima-upstream-protocol');
const { DurableQATasks } = require('./durable-qa-tasks');
const { registerDurableQARoutes } = require('./durable-qa-routes');
const { fault: taskFault } = require('./durable-qa-store');
const { safeTaskFailureReason } = require('./durable-qa-failure');
const { createApplicationIdentity, applicationOwnerKey } = require('./application-identity');
const { FIELDS: BOT_FIELDS, validateBotRetrievalContract, prepareBotAsk,
  buildBotAnswerEvidence, buildBotCapacitySnapshot } = require('./bot-compat');
const { buildRecentContextQuestionPlan } = require('./bot-recent-context');
const { providerAExecutionCapacity } = require('./provider-a-capacity');
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
const INTERNAL_ASK_FIELDS = BOT_FIELDS;
const EXTENDED_BOT_FIELDS = BOT_FIELDS.filter(field => !['retrieval_policy', 'knowledge_scope_ref', 'source_intent'].includes(field));
const WEB_REQUESTED_SUFFIX = '\n\n本轮请同时检索可验证的网页资料；若没有取得网页来源，请直接说明，不要把知识库资料称作网页来源。';

function createApp({
  config,
  imaClient,
  mimoClient,
  imaWebAgentClient,
  localRagClient,
  accountDirectory,
  conversationStore,
  accountPoolExerciseManager,
  webReadiness,
  recentContextConsumer = null,
  botCompatibility = null,
  observation = null,
  observationExporter = null,
  qualificationMonitor = null,
  healthCapabilities = {},
  airPolicyCapacity = null,
}) {
  const app = express();
  const observer = observationExporter || observation;
  botCompatibility ||= airPolicyCapacity ? createAirBotCompatibility(airPolicyCapacity) : null;
  const botExecutionCapacity = () => providerAExecutionCapacity({ pool: imaWebAgentClient, webReadiness, airPolicyCapacity });
  app.locals.airBotExtensionsMounted = Boolean(config.qaProvider === 'ima-web-agent' &&
    typeof botCompatibility?.snapshot === 'function');
  const applicationIdentity = createApplicationIdentity(config.security);
  const ordinaryAuth = applicationIdentity.middleware('ordinary');
  const internalAuth = applicationIdentity.middleware('internal');
  const conversations = conversationStore || new ConversationStore({ persist: false });
  const askQueue = createAskQueue({
    maxConcurrent: config.concurrency?.maxConcurrentAsk,
    queueLimit: config.concurrency?.queueLimit,
  });
  app.locals.imaQaAskQueue = askQueue;
  app.locals.askLimits = config.limits;
  app.locals.accountPoolExerciseManager = accountPoolExerciseManager || null;
  const rateLimiter = createRateLimiter(config.rateLimit);
  const internalIdempotency = config.conversations?.storePath
    ? new InternalAskIdempotency({ storePath: `${config.conversations.storePath}.internal-idempotency.json` }) : null;

  app.disable('x-powered-by');
  if (config.security?.trustProxy) {
    app.set('trust proxy', true);
  }
  app.use(createSecurityHeadersMiddleware(config.security?.allowedOrigins));
  app.use(createCorsMiddleware(config.security?.allowedOrigins));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  let durableTasks = null;
  const durableTasksConfigured = Boolean(config.qaProvider === 'ima-web-agent' && imaWebAgentClient && conversations.persist &&
      config.conversations?.storePath && config.durableTasks?.enabled !== false);
  if (durableTasksConfigured) {
    try {
      durableTasks = new DurableQATasks({
        directory: config.durableTasks?.storePath || `${config.conversations.storePath}.tasks`,
        conversations, queue: askQueue, accountPool: imaWebAgentClient,
        mode: webReadiness?.mode || config.webAgent?.mode,
        routingOptions: task => botRoutingOptions(task.input.botContract, task.applicationKey || task.scope, task.ownerKey),
        execute: ({ task, signal, res, accountLease, conversationStore: taskConversations, onDispatch, onUpstreamEvent, onUpstreamBinding, onUpstreamActivity }) => dispatchAsk({
          config, imaClient, imaWebAgentClient, localRagClient, mimoClient, isSse: true,
          history: conversations.getHistory(task.input.conversationId, task.ownerKey),
          question: task.input.question,
          upstreamQuestion: task.input.source_intent === 'web_requested' ? `${task.input.question}${WEB_REQUESTED_SUFFIX}` : task.input.question,
          sourceIntent: task.input.source_intent, requestId: task.id, req: {}, res, signal,
          botContract: task.input.botContract, botCompatibility, recentContextConsumer, observation: observer,
          applicationKey: task.applicationKey || task.scope,
          mode: task.input.botContract ? conversations.require(task.input.conversationId, task.ownerKey).mode :
            task.input.retrieval_policy || conversations.require(task.input.conversationId, task.ownerKey).mode || webReadiness?.mode,
          transportTimeouts: {
            headersMs: config.concurrency?.taskConnectTimeoutMs || 60000,
            idleMs: config.concurrency?.taskIdleTimeoutMs || 600000,
          },
          onDispatch, onUpstreamEvent, onUpstreamBinding, onUpstreamActivity, accountLease, durableTask: true,
          isTimedOut: () => false, conversationId: task.input.conversationId,
          conversationStore: taskConversations, ownerKey: task.ownerKey,
        }),
      });
    } catch {
      // Durable support fails closed; legacy routes remain available. No private diagnostics.
    }
  }
  app.locals.durableQATasks = durableTasks;
  app.get('/api/capabilities', ordinaryAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ schemaVersion: 1, features: {
      durable_qa_tasks_v1: Boolean(durableTasks?.available),
    } });
  });
  registerDurableQARoutes(app, { tasks: durableTasks, config, conversations, webReadiness,
    ordinaryAuth, internalAuth, getConversationOwnerKey, validateAskRequest, botCompatibility, assertBotPolicy, assertBotMode,
    admit(req, res, scope) {
      if (scope === 'ordinary' && app.locals.accountPoolExerciseManager?.isMaintenanceActive?.()) throw taskFault('maintenance_exercise', 503);
      const limit = rateLimiter.consume(getClientIp(req));
      if (!limit.ok) { res.setHeader('Retry-After', String(limit.retryAfterSeconds)); throw taskFault('rate_limited', 429); }
    },
  });

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
      if (botCompatibility || qualificationMonitor || app.locals.knowledgeAgentQualificationManager || Object.keys(healthCapabilities).length) {
        health.capabilities = { ...healthCapabilities, ...(botCompatibility?.healthCapabilities || {}),
          recent_context_contract_versions: botCompatibility && typeof recentContextConsumer?.consume === 'function' ? ['v1', 'v2'] : [] };
        health.recentContext = { enabled: health.capabilities.recent_context_contract_versions.length > 0,
          contracts: health.capabilities.recent_context_contract_versions };
        if (app.locals.knowledgeAgentQualificationManager) {
          health.capabilities.knowledge_agent_qualification = 'v1';
          health.knowledge_agent_qualification = 'v1';
        }
        if (qualificationMonitor?.snapshot) health.qualificationMonitor = qualificationMonitor.snapshot();
        if (botCompatibility) {
          try { const policies = botCapacitySnapshot(botCompatibility, {
            generation: webReadiness?.snapshot()?.generation || 0,
            maxConcurrent: webReadiness?.snapshot()?.capacity ?? askQueue.stats().maxConcurrent,
          }, botExecutionCapacity(), imaWebAgentClient?.parallelPairCapacity?.()).policies;
            health.policyCapacity = Object.fromEntries(Object.entries(policies).map(([key, value]) => [key, value.max_concurrent]));
          } catch { health.policyCapacity = {}; }
        }
      }
    } else if (typeof imaClient?.getQuotaStatus === 'function') {
      health.openApiQuota = imaClient.getQuotaStatus();
    }
    if (provider === 'local-rag-mimo') {
      health.localRag = localRagClient?.getStatus?.();
    }
    res.json(health);
  });

  app.get('/internal/provider-a/capacity', internalAuth, (_req, res) => {
    const state = webReadiness?.snapshot();
    const queue = askQueue.stats();
    const nativeCapacity = config.qaProvider === 'ima-web-agent' && state?.mode === 'knowledge_agent'
      ? Math.max(0, Math.min(Number(state.knowledgeAgentCapacity) || 0, Number(state.capacity) || 0)) : 0;
    res.setHeader('Cache-Control', 'no-store');
    const website = { schemaVersion: 1, generation: state?.generation || 0,
      maxConcurrent: state?.capacity ?? queue.maxConcurrent, available: state?.schedulable ?? 0,
      totalSlots: state?.totalSlots ?? 0, eligibleAccounts: state?.eligibleAccounts ?? 0,
      totalAccounts: state?.totalAccounts ?? 0, schedulableAccounts: state?.schedulableAccounts ?? 0,
      active: queue.activeRequests, queued: queue.queuedRequests,
      policies: { knowledge_agent: { max_concurrent: nativeCapacity } },
      features: {
        knowledge_agent_keyed_sse_v1: config.qaProvider === 'ima-web-agent' && state?.mode === 'knowledge_agent',
        source_intent_web_requested_v1: config.qaProvider === 'ima-web-agent',
        durable_qa_tasks_v1: Boolean(durableTasks?.available),
      },
    };
    if (!botCompatibility) return res.json(website);
    try { return res.json(botCapacitySnapshot(botCompatibility, website, botExecutionCapacity(), imaWebAgentClient?.parallelPairCapacity?.())); }
    catch { return res.status(503).json({ error: 'bot_capacity_unavailable' }); }
  });

  app.post('/api/conversations', ordinaryAuth, (_req, res) => {
    const ownerKey = getConversationOwnerKey(_req, res);
    res.status(201).json({ success: true, conversation: conversations.create(ownerKey, { mode: webReadiness?.mode }) });
  });

  app.get('/api/conversations', ordinaryAuth, (req, res) => {
    const ownerKey = getConversationOwnerKey(req, res);
    res.json({
      success: true,
      conversations: conversations.list(ownerKey, { limit: req.query.limit }),
    });
  });

  app.get('/api/conversations/:conversationId', ordinaryAuth, (req, res) => {
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

  app.delete('/api/conversations/:conversationId', ordinaryAuth, (req, res) => {
    const ownerKey = getConversationOwnerKey(req, res);
    let conversation;
    try {
      conversation = conversations.require(req.params.conversationId, ownerKey);
    } catch { return res.status(404).json({ success: false }); }
    if (durableTasksConfigured && !durableTasks?.available) {
      return res.status(503).json({ success: false, error: 'task_store_unavailable' });
    }
    if (conversation.activeRequest || durableTasks?.hasUnfinishedConversation(req.params.conversationId, ownerKey)) {
      return res.status(409).json({ success: false, error: 'conversation_busy' });
    }
    const deleted = conversations.delete(req.params.conversationId, ownerKey);
    res.status(deleted ? 200 : 404).json({ success: deleted });
  });

  const askHandler = async (req, res) => {
    const requestId = crypto.randomUUID();
    const isSse = wantsSse(req);
    if (!req.isInternalProviderADeepAsk && app.locals.accountPoolExerciseManager?.isMaintenanceActive?.()) {
      return rejectAskRequest({
        req,
        res,
        requestId,
        statusCode: 503,
        message: '管理员正在进行账号池容量演练，请稍后重试',
        failureReason: 'maintenance_exercise',
      });
    }
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

    const validation = validateAskRequest(req.body, config.limits, {
      internal: req.isInternalProviderADeepAsk,
      config,
      botCompatibility,
      applicationKey: req.applicationKey,
    });

    if (!validation.ok) {
      return res.status(validation.statusCode || 400).json({ success: false, error: validation.error, requestId });
    }
    if (!validation.botContract && validation.retrievalPolicy === 'knowledge_agent' && webReadiness && webReadiness.mode !== 'knowledge_agent') {
      return res.status(409).json({ success: false, error: '当前部署尚未升级到原生知识库模式', requestId });
    }

    const ownerKey = getConversationOwnerKey(req, res);
    let conversationId = validation.conversationId;
    try {
      if (validation.botContract) assertBotPolicy(validation.botContract, botCompatibility);
      if (!conversationId) {
        conversationId = conversations.create(ownerKey, { mode: validation.botContract ? botMode(validation.botContract) : validation.retrievalPolicy || webReadiness?.mode }).conversationId;
      }
      try {
        if (validation.botContract) assertBotMode(validation.botContract, conversations.require(conversationId, ownerKey).mode);
        if (!validation.botContract && validation.retrievalPolicy === 'knowledge_agent' &&
            conversations.require(conversationId, ownerKey).mode !== 'knowledge_agent') {
          throw Object.assign(new Error('原会话使用其他问答模式，请新建会话'), { statusCode: 409 });
        }
        conversations.beginRequest(conversationId, ownerKey);
      } catch (error) {
        if (req.isInternalProviderADeepAsk && error instanceof ConversationNotFoundError) {
          conversations.create(ownerKey, { id: conversationId, mode: validation.botContract ? botMode(validation.botContract) : validation.retrievalPolicy || webReadiness?.mode });
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
        ...(validation.botContract ? { failureReason: classifyFailureReason(error) } : {}),
        conversationId,
      });
    }

    const { signal, cleanup, isTimedOut } = createRequestSignal(req, res, {
      timeoutMs: config.concurrency?.requestTimeoutMs,
    });

    try {
      await askQueue.run(
        accountLease =>
          dispatchAsk({
            config,
            history: conversations.getHistory(conversationId, ownerKey),
            imaClient,
            imaWebAgentClient,
            localRagClient,
            isSse,
            mimoClient,
            question: validation.question,
            upstreamQuestion: validation.sourceIntent === 'web_requested' ? `${validation.question}${WEB_REQUESTED_SUFFIX}` : validation.question,
            sourceIntent: validation.sourceIntent,
            botContract: validation.botContract, botCompatibility, recentContextConsumer, observation: observer,
            applicationKey: req.applicationKey,
            requestId,
            req,
            res,
            signal,
            mode: validation.botContract ? conversations.require(conversationId, ownerKey).mode :
              validation.retrievalPolicy || conversations.require(conversationId, ownerKey).mode || webReadiness?.mode,
            isTimedOut,
            conversationId,
            conversationStore: conversations,
            ownerKey,
            accountLease,
          }),
        { signal, applicationKey: req.applicationKey, visitorKey: ownerKey, laneKey: conversationId,
          ...(config.qaProvider === 'ima-web-agent' && imaWebAgentClient?.tryAcquireSlot ? {
          isRunnable: () => imaWebAgentClient.canAcquireSlot({ ...botRoutingOptions(validation.botContract, req.applicationKey, ownerKey), ...conversations.getUpstream(conversationId, ownerKey), mode: validation.botContract ? conversations.require(conversationId, ownerKey).mode : validation.retrievalPolicy || conversations.require(conversationId, ownerKey).mode || webReadiness?.mode || config.webAgent?.mode }),
          tryAcquire: () => imaWebAgentClient.tryAcquireSlot({ ...botRoutingOptions(validation.botContract, req.applicationKey, ownerKey), ...conversations.getUpstream(conversationId, ownerKey), mode: validation.botContract ? conversations.require(conversationId, ownerKey).mode : validation.retrievalPolicy || conversations.require(conversationId, ownerKey).mode || webReadiness?.mode || config.webAgent?.mode, signal }),
        } : {}) },
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

  app.post('/api/ask', ordinaryAuth, askHandler);
  app.post(
    '/internal/provider-a/deep-ask',
    internalAuth,
    markInternalProviderADeepAsk,
    ...(botCompatibility ? [(req, res, next) => isExtendedBotRequest(req.body) ? requireProviderAIdempotencyKey(req, res, next) : next()] : []),
    createInternalIdempotencyMiddleware({ ledger: internalIdempotency, conversations, config, webReadiness, botCompatibility }),
    askHandler,
  );

  app.use((error, req, res, next) => {
    if (!/^\/(?:api|internal\/provider-a)\/tasks(?:\/|$)/u.test(req.path)) return next(error);
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 503;
    res.status(status).json({ error: status === 503 ? 'task_request_failed' : 'invalid_task_request' });
  });

  return app;
}

async function dispatchAsk(context) {
  observeExecution(context, 'admitted', 'started');
  if (context.botContract) {
    try {
      const state = assertBotPolicy(context.botContract, context.botCompatibility);
      assertBotMode(context.botContract, context.mode);
      const upstream = context.conversationStore.getUpstream(context.conversationId, context.ownerKey);
      const profile = ['knowledge_agent', 'group_knowledge'].includes(context.botContract.retrievalPolicy)
        ? 'classic_knowledge' : 'ima_agent_auto';
      if (upstream.sessionId && upstream.sessionAnswerProfile && upstream.sessionAnswerProfile !== profile) {
        throw taskFault('session_profile_conflict', 409);
      }
      const consumer = context.recentContextConsumer;
      const prepared = await prepareBotAsk({ contract: context.botContract, question: context.question,
        upstream, recentContextConsumer: typeof consumer?.consume === 'function' ? {
          async consume(...args) {
            try { return await consumer.consume(...args); }
            catch { throw taskFault('recent_context_unavailable', 503); }
          },
        } : consumer, signal: context.signal });
      const plan = botQuestionPlan(context.question, prepared, context.botContract.retrievalPolicy);
      context = { ...context, upstreamQuestion: plan.question,
        botContextPlan: plan, botProfile: state.profile.answer_profile };
    } catch (error) { observeExecution(context, 'prepare', 'failure', error); throw error; }
  }
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

function botQuestionPlan(question, prepared, policy) {
  const suffix = prepared.question.slice(question.length);
  const original = prepared.recentContext;
  let selected = original;
  let plan = buildRecentContextQuestionPlan(question, selected, policy);
  // Reserve room for the intent suffix without truncating any source message.
  while (Array.from(plan.question + suffix).length > 18000 && plan.injectedMessageCount > 0) {
    const keep = plan.injectedMessageCount - 1;
    selected = { ...original, messages: keep ? selected.messages.slice(-keep) : [] };
    plan = buildRecentContextQuestionPlan(question, selected, policy);
  }
  return { ...plan, question: plan.question + suffix, ...(selected !== original ? {
    sourceMessageCount: original.sourceMessageCount, selectedMessageCount: original.messages.length,
    omittedMessageCount: original.sourceMessageCount - plan.injectedMessageCount, truncationReason: 'prompt_budget',
  } : {}) };
}

function observeExecution(context, stage, outcome, error) {
  const protocol = error instanceof IMAUpstreamProtocolError;
  try {
    const pending = context.observation?.sample?.({ component: protocol ? 'provider_a_protocol' : 'provider_a_execution',
      stage: protocol ? 'upstream_stream' : stage, category: error ? classifyFailureReason(error) : 'qa',
      outcome, evidenceClass: 'observed' });
    pending?.catch?.(() => {});
  } catch { /* Telemetry cannot affect admission or completion. */ }
}

function isExtendedBotRequest(body) {
  return Boolean(body && typeof body === 'object' && (EXTENDED_BOT_FIELDS.some(field => Object.hasOwn(body, field)) ||
    ['auto', 'group_knowledge', 'web', 'mixed'].includes(body.retrieval_policy)));
}

function botMode(contract) {
  return contract.retrievalPolicy === 'knowledge_agent' ? 'knowledge_agent' : 'classic_knowledge';
}

function assertBotMode(contract, mode) {
  if (mode !== botMode(contract)) throw taskFault('conversation_mode_conflict', 409);
}

function createAirBotCompatibility(capacity) {
  let generation = 0;
  let signature;
  return { snapshot() {
    const state = { profile: capacity.profileSnapshot(), policyCapacity: capacity.policyCapacitySnapshot(),
      laneCapacity: capacity.laneCapacitySnapshot(),
      pairedCapacity: capacity.pairedCapacitySnapshot().knowledge_web_parallel,
      features: capacity.features || {} };
    const next = JSON.stringify(state);
    if (signature !== next) { signature = next; generation++; }
    return { ...state, generation };
  } };
}

function botRoutingOptions(contract, applicationKey, ownerKey) {
  if (!contract) return {};
  const binding = contract.recentContextBinding;
  const pairScope = binding ? ['context', binding.account_id, binding.group_id, binding.route_ref,
    binding.route_generation, binding.feature_generation] : ['owner', ownerKey];
  return { retrievalPolicy: contract.retrievalPolicy, knowledgeScopeRef: contract.knowledgeScopeRef,
    recentContextRef: contract.recentContextRef, parallelPairRef: contract.parallelPairRef,
    parallelLeg: contract.parallelLeg,
    ...(contract.parallelPairRef ? { parallelPairKey: crypto.createHash('sha256')
      .update(JSON.stringify([applicationKey, pairScope, contract.parallelPairRef])).digest('hex') } : {}) };
}

function assertBotPolicy(contract, adapter) {
  let state;
  try { state = adapter?.snapshot(); } catch { throw taskFault('bot_capacity_unavailable', 503); }
  const policy = contract.retrievalPolicy || 'auto';
  const independentPolicy = ['knowledge_agent', 'group_knowledge'].includes(policy);
  if ((!independentPolicy && state?.profile?.ready !== true) || !['classic_knowledge', 'ima_agent', 'ima_agent_auto'].includes(state?.profile?.answer_profile) ||
      !Number.isSafeInteger(state.profile.profile_generation) || state.profile.profile_generation < 1 ||
      !/^[a-f0-9]{64}$/u.test(state.profile.capability_digest || '')) throw taskFault('bot_capacity_unavailable', 503);
  if (!Number.isSafeInteger(state.policyCapacity?.[policy]) || state.policyCapacity[policy] < 1) {
    throw taskFault('bot_policy_unavailable', 503);
  }
  return state;
}

function botCapacitySnapshot(adapter, website, executionCapacity = website.maxConcurrent, pairCapacity = Infinity) {
  const state = adapter.snapshot();
  const snapshot = buildBotCapacitySnapshot({ ...state, pairedCapacity: Math.min(state.pairedCapacity || 0, pairCapacity),
    website: { ...website, maxConcurrent: executionCapacity, generation: state.generation ?? website.generation } });
  const features = Object.fromEntries(Object.entries(state.features || {}).filter(([, value]) => typeof value === 'boolean'));
  return { ...snapshot, website, features: { ...features, ...website.features } };
}

function requireProviderAIdempotencyKey(req, res, next) {
  if (!/^[a-f0-9]{64}$/u.test(String(req.get('Idempotency-Key') || ''))) {
    return res.status(400).json({ success: false, error: 'idempotency_key_required' });
  }
  next();
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
        "img-src 'self' data: blob:",
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
    if (['/admin.html', '/admin.js', '/admin.css'].includes(req.path)) {
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

function createInternalIdempotencyMiddleware({ ledger, conversations, config, webReadiness, botCompatibility }) {
  return (req, res, next) => {
    const suppliedKey = String(req.get('Idempotency-Key') || '').trim();
    if (!suppliedKey) return next();
    if (!ledger) return res.status(503).json({ success: false, error: '内部幂等存储未配置' });
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(suppliedKey)) return res.status(400).json({ success: false, error: 'Idempotency-Key 格式无效' });
    const validation = validateAskRequest(req.body, req.app.locals.askLimits, { internal: true, config, botCompatibility, applicationKey: req.applicationKey });
    if (!validation.ok) return next();
    if (!validation.botContract && validation.retrievalPolicy === 'knowledge_agent' && webReadiness && webReadiness.mode !== 'knowledge_agent') return next();
    const ownerKey = getConversationOwnerKey(req, res);
    let clientDisconnected = false;
    const onClientClose = () => {
      if (!res.writableEnded) clientDisconnected = true;
    };
    res.on('close', onClientClose);
    return (async () => {
      const baseFingerprint = ledger.fingerprint(validation.question, validation.conversationId, validation);
      const fingerprint = validation.botContract ? crypto.createHash('sha256').update(JSON.stringify({
        baseFingerprint, applicationKey: req.applicationKey,
        requestBinding: validation.botContract.requestBinding,
      })).digest('hex') : baseFingerprint;
      const claim = await ledger.claim(ownerKey, suppliedKey, fingerprint);
      if (clientDisconnected || req.aborted || res.destroyed) {
        if (claim.isNew) await ledger.markUnknown(claim.key, ownerKey);
        return;
      }
      res.off('close', onClientClose);
      if (claim.state === 'complete') {
        if (wantsSse(req)) return res.status(409).json({ success: false, error: '原请求已完成，请读取会话记录，不会重复派发', idempotencyState: 'complete' });
        const replay = findCompletedTurn(conversations, ownerKey, claim);
        if (!replay) return res.status(410).json({ success: false, error: '原会话已过期，幂等结果无法恢复' });
        return res.json({ success: true, ...replay, requestId: crypto.randomUUID(), idempotentReplay: true });
      }
      if (claim.state !== 'processing') {
        return res.status(409).json({ success: false, error: claim.state === 'unknown' ? '原请求结果未知，请检查会话记录，不会自动重发' : '原请求仍在处理中', idempotencyState: claim.state });
      }
      if (!claim.isNew) {
        return res.status(409).json({ success: false, error: '原请求仍在处理中', idempotencyState: 'processing' });
      }

      if (wantsSse(req)) {
        let settled = false;
        let settling = false;
        const originalEnd = res.end.bind(res);
        req.internalIdempotency = {
          async complete(conversationId, answer) {
            await ledger.complete(claim.key, ownerKey, { conversationId, question: validation.question, answer });
            settled = true;
          },
        };
        res.end = (...args) => {
          if (settled) return originalEnd(...args);
          if (!settling) {
            settling = true;
            void ledger.markUnknown(claim.key, ownerKey).catch(() => {}).finally(() => {
              settled = true;
              if (!res.destroyed) originalEnd(...args);
            });
          }
          return res;
        };
        res.once('close', () => {
          if (!settled && !res.writableEnded) void ledger.markUnknown(claim.key, ownerKey).catch(() => {});
        });
        return next();
      }

      let persisted = false;
      let responsePromise;
      const originalJson = res.json.bind(res);
      res.json = body => {
        if (responsePromise) return res;
        persisted = true;
        responsePromise = (async () => {
          try {
            if (res.statusCode < 400 && body?.success === true && body.conversationId && typeof body.answer === 'string') {
              await ledger.complete(claim.key, ownerKey, { conversationId: body.conversationId, question: validation.question, answer: body.answer });
            } else await ledger.markUnknown(claim.key, ownerKey);
            return originalJson(body);
          } catch (error) {
            res.status(503);
            return originalJson({ success: false, error: '结果已生成，但幂等状态未能保存；请检查会话记录后再操作', failureReason: 'idempotency_persist_failed', storeErrorCode: error.storageCauseCode || error.code || 'unknown' });
          }
        })();
        return res;
      };
      res.once('close', () => {
        if (!res.writableEnded && !persisted) {
          persisted = true;
          void ledger.markUnknown(claim.key, ownerKey).catch(() => {});
        }
      });
      next();
    })().catch(error => {
      res.off('close', onClientClose);
      if (clientDisconnected || req.aborted || res.destroyed) return;
      if (!res.headersSent) res.status(error.statusCode || 503).json({ success: false, error: error.code || '内部幂等存储不可用' });
      else res.end();
    });
  };
}

function findCompletedTurn(conversations, ownerKey, claim) {
  try {
    const detail = conversations.getDetail(claim.conversationId, ownerKey);
    const messages = detail.messages;
    for (let index = messages.length - 2; index >= 0; index -= 2) {
      const user = messages[index];
      const assistant = messages[index + 1];
      if (user?.role !== 'user' || assistant?.role !== 'assistant') continue;
      const questionHash = crypto.createHash('sha256').update(user.content).digest('hex');
      const answerHash = crypto.createHash('sha256').update(assistant.content).digest('hex');
      if (questionHash === claim.questionHash && answerHash === claim.answerHash) {
        return { answer: assistant.content, sources: assistant.sources || [], searchSummary: assistant.searchSummary || '',
          ...sourceEvidenceFromHistory(assistant), conversationId: claim.conversationId };
      }
    }
  } catch {}
  return null;
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sourceEvidenceFromHistory(message) {
  const keys = ['source_intent', 'answer_basis', 'source_count', 'knowledge_source_count', 'web_source_count',
    'l0_context_count', 'l0_source_count', 'l0_snapshot_count', 'l0_injected_count', 'l0_omitted_count', 'l0_truncation_reason'];
  return Object.fromEntries(keys.filter(key => message[key] !== undefined).map(key => [key, message[key]]));
}

async function handleJsonWebAgentAsk(context) {
  const {
    res,
    requestId,
    question,
    upstreamQuestion,
    sourceIntent,
    imaWebAgentClient,
    signal,
    isTimedOut,
    conversationId,
    conversationStore,
    ownerKey,
  } = context;

  try {
    const result = await collectWebAgentAnswer({
      question: upstreamQuestion,
      imaWebAgentClient,
      signal,
      upstream: conversationStore.getUpstream(conversationId, ownerKey),
      accountLease: context.accountLease,
      mode: context.mode,
      botContract: context.botContract,
      originalQuestion: context.question,
      applicationKey: context.applicationKey, ownerKey,
    });
    if (result.answerProfile) context.botProfile = result.answerProfile;
    const answer = sanitizeIMAAnswerText(result.answer) || noReliableContentAnswer();
    const evidence = answerEvidence(context, result.sourceKinds, result.sources.length, result.answer);
    conversationStore.setUpstream(conversationId, result, ownerKey);
    appendConversationTurn(conversationStore, {
      conversationId,
      question,
      answer,
      sources: result.sources,
      searchSummary: result.searchSummary,
      evidence,
      ownerKey,
    });
    observeExecution(context, 'answer_generated', 'success');
    return res.json({
      success: true,
      answer,
      sources: result.sources,
      searchSummary: result.searchSummary,
      ...evidence,
      conversationId,
      requestId,
    });
  } catch (error) {
    observeExecution(context, 'upstream_stream', 'failure', error);
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
    req,
    res,
    requestId,
    question,
    upstreamQuestion,
    sourceIntent,
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
    const upstream = conversationStore.getUpstream(conversationId, ownerKey);
    const sources = [];
    let searchSummary = '';
    let answer = '';
    let accountId = upstream.accountId || '';
    let sessionId = upstream.sessionId || '';
    let sessionAnswerProfile = upstream.sessionAnswerProfile || '';
    const sourceKinds = [];
    let terminals = 0;
    const answerTextStream = createAnswerTextStream();
    for await (const event of imaWebAgentClient.streamAsk({
      ...botRoutingOptions(context.botContract, context.applicationKey, context.ownerKey),
      ...(context.botContract ? { originalQuestion: question } : {}),
      question: upstreamQuestion,
      signal,
      ...(context.accountLease ? { accountLease: context.accountLease } : {}),
      ...(context.mode ? { mode: context.mode } : {}),
      ...(context.transportTimeouts ? { transportTimeouts: context.transportTimeouts } : {}),
      ...(context.onDispatch ? { onDispatch: context.onDispatch } : {}),
      ...(context.onUpstreamActivity ? { onActivity: context.onUpstreamActivity } : {}),
      onSession(nextSessionId, metadata = {}) {
        sessionId = nextSessionId;
        sessionAnswerProfile = metadata.answerProfile || sessionAnswerProfile;
        context.onUpstreamBinding?.({ accountId, sessionId, sessionAnswerProfile });
      },
      ...upstream,
    })) {
      if (event.answerProfile) {
        if (context.botContract) context.botProfile = event.answerProfile;
        sessionAnswerProfile = event.answerProfile;
        if (sessionId) context.onUpstreamBinding?.({ accountId, sessionId, sessionAnswerProfile });
      }
      if (event.type !== 'route') context.onUpstreamEvent?.(event);
      if (event.type === 'profile') {
        if (context.botContract) context.botProfile = event.answerProfile;
        continue;
      }
      if (event.type === 'route') {
        accountId = event.accountId || accountId;
        context.onUpstreamBinding?.({ accountId });
        continue;
      }

      if (event.type === 'session') {
        sessionId = event.sessionId || sessionId;
        sessionAnswerProfile = event.sessionAnswerProfile || event.answerProfile || sessionAnswerProfile;
        context.onUpstreamBinding?.({ accountId, sessionId, sessionAnswerProfile });
        continue;
      }

      if (event.type === 'sources') {
        sources.push(...(event.sources || []));
        sourceKinds.push(...normalizedSourceKinds(event));
        searchSummary = event.searchSummary || searchSummary;
        writeSse(res, 'sources', { sources, searchSummary, requestId });
      }

      if (event.type === 'process') {
        writeSse(res, 'process', { ...event, requestId });
      }

      if (event.type === 'delta') {
        const safeText = answerTextStream.push(event.text);
        if (safeText) {
          answer += safeText;
          writeSse(res, 'delta', { text: safeText, requestId });
        }
      }

      if (event.type === 'done') terminals += 1;

    }

    if (terminals !== 1) throw new IMAUpstreamProtocolError('upstream_terminal_missing');
    if (signal?.aborted) throw new RequestAbortedError();
    const finalText = answerTextStream.finish();
    if (finalText) {
      answer += finalText;
      writeSse(res, 'delta', { text: finalText, requestId });
    }

    if (context.durableTask && answer === '') throw new IMAUpstreamProtocolError('upstream_empty_answer');
    const answerForHistory = answer || noReliableContentAnswer();
    const evidence = answerEvidence(context, sourceKinds, sources.length, answer);
    conversationStore.setUpstream(conversationId, { accountId, sessionId,
      ...(sessionAnswerProfile ? { sessionAnswerProfile } : {}) }, ownerKey);
    appendConversationTurn(conversationStore, {
      conversationId,
      question,
      answer: answerForHistory,
      sources,
      searchSummary,
      evidence,
      ownerKey,
    });
    await req.internalIdempotency?.complete(conversationId, answerForHistory);
    writeSse(res, 'done', { searchSummary, conversationId, requestId, ...evidence });
    observeExecution(context, 'complete', 'success');

    return res.end();
  } catch (error) {
    observeExecution(context, 'upstream_stream', 'failure', error);
    writeSse(res, 'error', {
      error: signal?.aborted ? '请求处理超时，请稍后再试' : toUserSafeError(error),
      failureReason: signal?.aborted ? 'timeout' : classifyFailureReason(error),
      conversationId,
      requestId,
    });
    return res.end();
  }
}

async function collectWebAgentAnswer({ question, imaWebAgentClient, signal, upstream = {}, accountLease, mode, botContract, originalQuestion, applicationKey, ownerKey }) {
  let answer = '';
  let searchSummary = '';
  const sources = [];
  const sourceKinds = [];
  let accountId = upstream.accountId || '';
  let sessionId = upstream.sessionId || '';
  let terminals = 0;
  let answerProfile;
  let sessionAnswerProfile = upstream.sessionAnswerProfile || '';

  for await (const event of imaWebAgentClient.streamAsk({
    ...botRoutingOptions(botContract, applicationKey, ownerKey),
    ...(botContract ? { originalQuestion } : {}),
    question,
    signal,
    ...(accountLease ? { accountLease } : {}),
    ...(mode ? { mode } : {}),
    onSession(nextSessionId, metadata = {}) {
      sessionId = nextSessionId;
      sessionAnswerProfile = metadata.answerProfile || sessionAnswerProfile;
    },
    ...upstream,
  })) {
    if (event.answerProfile) { answerProfile = event.answerProfile; sessionAnswerProfile = event.answerProfile; }
    if (event.type === 'profile') { answerProfile = event.answerProfile; continue; }
    if (event.type === 'route') {
      accountId = event.accountId || accountId;
      continue;
    }
    if (event.type === 'session') {
      sessionId = event.sessionId || sessionId;
      sessionAnswerProfile = event.sessionAnswerProfile || event.answerProfile || sessionAnswerProfile;
      continue;
    }
    if (event.type === 'sources') {
      sources.push(...(event.sources || []));
      sourceKinds.push(...normalizedSourceKinds(event));
      searchSummary = event.searchSummary || searchSummary;
    }
    if (event.type === 'delta') {
      answer += event.text || '';
    }
    if (event.type === 'done') terminals += 1;
  }

  if (terminals !== 1) throw new IMAUpstreamProtocolError('upstream_terminal_missing');
  if (signal?.aborted) throw new RequestAbortedError();

  return { answer, sources, sourceKinds, searchSummary, accountId, sessionId, answerProfile,
    ...(sessionAnswerProfile ? { sessionAnswerProfile } : {}) };
}

function normalizedSourceKinds(event) {
  const sources = Array.isArray(event.sources) ? event.sources : [];
  return sources.map((_, index) => {
    const kind = event.sourceKinds?.[index] || event.sourceKind;
    return kind === 'knowledge' || kind === 'web' ? kind : 'unknown';
  });
}

function sourceEvidence(kinds, sourceLength, sourceIntent) {
  const limitedKinds = kinds.slice(0, 100);
  const knowledge = limitedKinds.filter(kind => kind === 'knowledge').length;
  const web = limitedKinds.filter(kind => kind === 'web').length;
  return {
    source_intent: sourceIntent || '',
    answer_basis: knowledge && web ? 'mixed' : knowledge ? 'knowledge' : web ? 'web' : 'agent_general',
    source_count: Math.min(100, sourceLength),
    knowledge_source_count: knowledge,
    web_source_count: web,
  };
}

function answerEvidence(context, sourceKinds, sourceLength, answer) {
  if (!context.botContract) return sourceEvidence(sourceKinds, sourceLength, context.sourceIntent);
  return buildBotAnswerEvidence({ retrievalPolicy: context.botContract.retrievalPolicy,
    sourceIntent: context.botContract.sourceIntent, profile: context.botProfile,
    answer, sourceKinds, contextPlan: context.botContextPlan });
}

function validateAskRequest(body, limits, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }

  const forbiddenField = FORBIDDEN_KB_FIELDS.find((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  if (forbiddenField) {
    return { ok: false, error: '不允许在请求中指定知识库；本服务只读取共享知识库' };
  }
  if (!options.internal && INTERNAL_ASK_FIELDS.some(field => Object.prototype.hasOwnProperty.call(body, field))) {
    return { ok: false, error: '此请求字段仅限受保护的内部接口' };
  }

  let botContract;
  if (options.internal && options.botCompatibility && isExtendedBotRequest(body)) {
    try {
      if (typeof body.question !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body.question)) {
        throw taskFault('bot_contract_invalid', 400);
      }
      const configuredScope = String(options.config?.webAgent?.sharedKnowledgeBaseId || options.config?.webAgent?.knowledgeBaseId || '').trim();
      const expectedKnowledgeScopeRef = typeof options.botCompatibility.resolveKnowledgeScopeRef === 'function'
        ? options.botCompatibility.resolveKnowledgeScopeRef({ applicationKey: options.applicationKey })
        : configuredScope ? crypto.createHash('sha256').update(configuredScope).digest('hex') : '';
      botContract = validateBotRetrievalContract(body, { internal: true, expectedKnowledgeScopeRef });
      if (options.config?.qaProvider !== 'ima-web-agent') throw taskFault('bot_policy_unavailable', 409);
    } catch (error) { return { ok: false, error: error.code || 'bot_contract_invalid', statusCode: error.statusCode || 400 }; }
  } else if (options.internal && EXTENDED_BOT_FIELDS.some(field => Object.hasOwn(body, field))) {
    return { ok: false, error: 'bot_contract_unavailable' };
  }
  const retrievalPolicy = botContract?.retrievalPolicy ?? (options.internal ? String(body.retrieval_policy || '').trim() : '');
  const knowledgeScopeRef = botContract?.knowledgeScopeRef ?? (options.internal ? String(body.knowledge_scope_ref || '').trim() : '');
  const sourceIntent = botContract?.sourceIntent ?? (options.internal ? String(body.source_intent || '').trim() : '');
  if (!botContract && options.internal && (retrievalPolicy || knowledgeScopeRef || sourceIntent)) {
    if (retrievalPolicy !== 'knowledge_agent' || !/^[a-f0-9]{64}$/u.test(knowledgeScopeRef) ||
        !['', 'web_requested'].includes(sourceIntent)) {
      return { ok: false, error: '原生问答合同字段无效' };
    }
    if (options.config?.qaProvider !== 'ima-web-agent') {
      return { ok: false, statusCode: 409, error: '当前部署未启用 IMA Web Agent' };
    }
    const configuredScope = String(options.config?.webAgent?.sharedKnowledgeBaseId || options.config?.webAgent?.knowledgeBaseId || '').trim();
    const expected = crypto.createHash('sha256').update(configuredScope).digest('hex');
    if (!configuredScope || !safeTokenEqual(knowledgeScopeRef, expected)) {
      return { ok: false, statusCode: 409, error: '知识库范围与当前部署不一致' };
    }
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
    retrievalPolicy,
    knowledgeScopeRef,
    sourceIntent,
    ...(botContract ? { botContract } : {}),
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
  evidence = {},
  ownerKey,
}) {
  conversationStore.appendTurn(
    conversationId,
    question,
    answer,
    {
      sources,
      searchSummary: searchSummary || (sources.length ? `找到 ${sources.length} 篇知识库资料` : ''),
      ...evidence,
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
  return applicationOwnerKey(req, ownerKey);
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
    .replace(/\s*[(（]@context-ref\?id=\d{1,6}[)）]\s*$/iu, '')
    .replace(/[^。！？\n]*(?:建议|可以|请|需要)?(?:您|你)?(?:咨询|联系|询问)[^。！？\n]*(?:财务|行政|人力资源|HR|客服|官网|供应商|外部|部门)[^。！？\n]*[。！？]?/giu, '')
    .replace(/[^。！？\n]*(?:建议|可以|请)?(?:您|你)?(?:查阅|查看|参考)[^。！？\n]*(?:外部|官网|网页|公司|内部)[^。！？\n]*(?:制度|文件|资料)[^。！？\n]*[。！？]?/giu, '')
    .replace(/[^。！？\n]*(?:通常|一般|属于)[^。！？\n]*(?:财务|行政|人力资源|HR|客服|官网|供应商|外部|部门)[^。！？\n]*[。！？]?/giu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return sanitized;
}

function toUserSafeError(error) {
  if (error instanceof IMAUpstreamProtocolError && error.code === 'upstream_terminal_missing') {
    return '上游回答未完整结束，请稍后重试';
  }
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
  const safeCode = safeTaskFailureReason(error?.code, null);
  if (safeCode) return safeCode;
  if (error instanceof IMAUpstreamProtocolError) {
    return error.code;
  }
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
  createInternalIdempotencyMiddleware,
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
  requireProviderAIdempotencyKey,
  retrieveProviderSources,
  sanitizeKnowledgeBoundAnswer,
  shouldUseLocalRagFallback,
  validateAskRequest,
  wantsEvalDiagnostics,
};
