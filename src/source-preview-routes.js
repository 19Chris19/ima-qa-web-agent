'use strict';
const express = require('express');
const chat = require('./chat-presentation');
const { SourcePreview } = require('./source-preview');
const { sourceId } = chat;
function resolveSource({ tasks, conversations, owner, scope, applicationKey, query }) {
  const { conversationId, taskId, citationKey, sourceId: id } = query;
  if (Object.keys(query).length !== 4 || !/^[a-zA-Z0-9-]{1,100}$/u.test(conversationId || '')
    || !/^[a-zA-Z0-9-]{1,100}$/u.test(taskId || '') || !/^(index|context|ref|para):[^\s?&#]{1,128}$/u.test(citationKey || '')
    || !/^[a-f0-9]{64}$/u.test(id || '') || Object.values(query).some(v => typeof v !== 'string')) throw new Error('not_found');
  const conversation = conversations.require(conversationId, owner);
  let map = {};
  if (tasks?.store?.tasks?.has(taskId)) {
    const task = tasks.store.owned(taskId, owner, scope, applicationKey);
    if (task.input.conversationId !== conversationId || task.input.botContract) throw new Error('not_found');
    for (const event of task.events || []) if (['sources', 'done'].includes(event.event)) map = chat.mergeCitations(map, event.data?.citationMap);
  }
  const turn = conversation.turns.find(t => t.taskId === taskId);
  if (turn) map = chat.mergeCitations(map, turn.citationMap);
  const entry = map[citationKey];
  const source = entry?.type === 'web' && entry.sources?.find(s => sourceId(s.url) === id);
  if (!source) throw new Error('not_found');
  return source.url;
}
function registerSourcePreviewRoutes(app, { config, tasks, conversations, ordinaryAuth, internalAuth, getConversationOwnerKey, busy,
  preview = new SourcePreview({ ...config.sourcePreview, busy }) }) {
  app.locals.sourcePreview = preview;
  const readers = new Map();
  const admit = (owner, image) => {
    const now = Date.now(), key = `${image ? 'image' : 'meta'}:${owner}`;
    const times = (readers.get(key) || []).filter(t => t > now - 60000);
    if (times.length >= 60) return false;
    if (!readers.has(key) && readers.size >= 2000) readers.delete(readers.keys().next().value);
    times.push(now); readers.delete(key); readers.set(key, times); return true;
  };
  for (const [base, scope, auth] of [['/api/source-preview', 'ordinary', ordinaryAuth], ['/internal/provider-a/source-preview', 'internal', internalAuth]]) {
    const router = express.Router();
    router.use(auth, (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    for (const image of [false, true]) router.get(image ? '/image' : '/', async (req, res) => {
      const controller = new AbortController();
      const closed = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', closed);
      try {
        const owner = getConversationOwnerKey(req, res);
        // Ownership is checked even on cache hits, before entering the cache worker.
        const url = resolveSource({ tasks, conversations, owner, scope, applicationKey: req.applicationKey || scope, query: req.query });
        if (!admit(owner, image)) {
          if (image) { res.status(429).json({ error: 'preview_unavailable' }); return; }
          res.json({ status: 'text_only', reason: 'busy' }); return;
        }
        if (image) {
          const result = await preview.image(url);
          if (!result) { res.status(404).json({ error: 'preview_unavailable' }); return; }
          res.setHeader('Content-Type', result.type); res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Length', result.bytes.length); res.end(Buffer.from(result.bytes));
        } else {
          const result = await preview.preview(url, controller.signal);
          if (!res.destroyed) res.json({ ...result, ...(result.status === 'ready' ? { imagePath: `${base}/image?${new URLSearchParams(req.query)}`, imageKind: 'cover' } : {}) });
        }
      } catch { if (!res.headersSent && !res.destroyed) res.status(404).json({ error: 'preview_unavailable' }); }
      finally { res.off('close', closed); }
    });
    app.use(base, router);
  }
  return preview;
}
module.exports = { resolveSource, registerSourcePreviewRoutes };
