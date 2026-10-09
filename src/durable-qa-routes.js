'use strict';

const express = require('express');
const { fault } = require('./durable-qa-store');

function registerDurableQARoutes(app, { tasks, config, conversations, webReadiness,
  ordinaryAuth, internalAuth, requireApiToken, requireInternalServiceToken, getConversationOwnerKey, validateAskRequest, admit }) {
  for (const [base, scope, auth] of [
    ['/api/tasks', 'ordinary', ordinaryAuth || requireApiToken(config.security?.apiToken)],
    ['/internal/provider-a/tasks', 'internal', internalAuth || requireInternalServiceToken(config.security?.internalServiceToken)],
  ]) {
    const router = express.Router();
    router.use(auth, (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!tasks?.available) return res.status(503).json({ error: 'task_store_unavailable', failureReason: 'task_store_unavailable' });
      req.taskOwner = getConversationOwnerKey(req, res);
      next();
    });
    const route = handler => (req, res) => {
      try { handler(req, res); }
      catch (error) {
        if (res.headersSent) { res.end(); return; }
        const code = /^[a-z_]{1,64}$/u.test(error.code || '') ? error.code :
          error.statusCode === 404 ? 'conversation_not_found' : error.statusCode === 409 ? 'conversation_busy' : 'task_request_failed';
        res.status(error.statusCode || 503).json({ error: code, failureReason: code });
      }
    };
    router.post('/', route((req, res) => {
      const key = req.get('Idempotency-Key');
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(key)) throw fault('idempotency_key_required', 400);
      if (!req.body || Array.isArray(req.body) || typeof req.body.question !== 'string' ||
          typeof req.body.conversationId !== 'string' || !req.body.conversationId ||
          ['retrieval_policy', 'knowledge_scope_ref', 'source_intent'].some(field =>
            Object.hasOwn(req.body, field) && typeof req.body[field] !== 'string')) throw fault('invalid_task_request', 400);
      const validation = validateAskRequest(req.body, config.limits, { internal: scope === 'internal', config });
      if (!validation.ok || req.body.question.length > config.limits.maxQuestionLength) throw fault('invalid_task_request', validation.statusCode || 400);
      if (validation.retrievalPolicy === 'knowledge_agent' && webReadiness && webReadiness.mode !== 'knowledge_agent') throw fault('knowledge_agent_unavailable', 409);
      const input = { question: req.body.question, conversationId: validation.conversationId,
        retrieval_policy: validation.retrievalPolicy, knowledge_scope_ref: validation.knowledgeScopeRef, source_intent: validation.sourceIntent };
      const result = tasks.submit({ ownerKey: req.taskOwner, scope, applicationKey: req.applicationKey || scope, key, input, validateNew() {
        admit(req, res, scope);
        const conversation = conversations.require(input.conversationId, req.taskOwner);
        if (input.retrieval_policy === 'knowledge_agent' && conversation.mode !== 'knowledge_agent') throw fault('conversation_mode_conflict', 409);
      } });
      res.status(result.isNew ? 202 : 200).json({ task: result.task });
    }));
    router.get('/', route((req, res) => {
      const { requestKey, conversationId } = req.query;
      if (requestKey !== undefined && (typeof requestKey !== 'string' || !/^[a-f0-9]{64}$/u.test(requestKey))) throw fault('invalid_request_key', 400);
      if (conversationId !== undefined && (typeof conversationId !== 'string' || !/^[a-z0-9-]{1,100}$/iu.test(conversationId))) throw fault('invalid_conversation_id', 400);
      res.json({ tasks: tasks.store.list(req.taskOwner, scope, requestKey, conversationId, req.applicationKey || scope) });
    }));
    router.get('/:id', route((req, res) => {
      const task = tasks.store.owned(req.params.id, req.taskOwner, scope, req.applicationKey || scope);
      res.json({ task: tasks.store.publicTask(task), snapshot: { events: task.events,
        ...(task.eventsExpired ? { eventsExpired: true, history: { conversationId: task.input.conversationId, taskId: task.id } } : {}) } });
    }));
    router.delete('/:id', route((req, res) => {
      res.json({ task: tasks.cancel(req.params.id, req.taskOwner, scope, req.applicationKey || scope) });
    }));
    router.get('/:id/events', route((req, res) => {
      const task = tasks.store.owned(req.params.id, req.taskOwner, scope, req.applicationKey || scope);
      const cursor = req.query.after === undefined ? (req.get('Last-Event-ID') || '0') : req.query.after;
      if (typeof cursor !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw fault('invalid_cursor', 400);
      const after = Number(cursor);
      if (after > (task.lastEventId ?? task.events.length)) throw fault('cursor_ahead', 409);
      if (task.eventsExpired) throw fault('task_events_expired', 410);
      tasks.subscribe(task, after, res);
    }));
    app.use(base, router);
  }
}

module.exports = { registerDurableQARoutes };
