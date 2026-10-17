'use strict';
const knowledge = require('./knowledge-evidence');
const { SourceReader, fail } = require('./source-reader');
function resolveEvidence({ tasks, conversations, config, owner, applicationKey, query, reading = false }) {
  if (!knowledge.allowed(config, applicationKey)) throw fail('source_evidence_forbidden', 403);
  if (!query || typeof query !== 'object' || Array.isArray(query)
    || Object.keys(query).some(key => !(reading ? ['taskId', 'conversationId', 'citationKey', 'sourceRef', 'cursor'] : ['taskId', 'conversationId', 'citationKey']).includes(key))
    || Object.values(query).some(value => typeof value !== 'string')
    || !/^[a-zA-Z0-9-]{1,100}$/u.test(query.taskId || '') || !/^[a-zA-Z0-9-]{1,100}$/u.test(query.conversationId || '')
    || !/^(index|context):[^\s?&#]{1,128}$/u.test(query.citationKey || '')
    || (reading && !/^[a-f0-9]{64}$/u.test(query.sourceRef || ''))) throw fail('source_request_invalid', 400);
  if (!tasks?.available) throw fail('source_evidence_unavailable');
  const task = tasks.store.owned(query.taskId, owner, 'internal', applicationKey);
  if (task.input.conversationId !== query.conversationId || task.input.botContract) throw fail('source_not_found', 404);
  conversations.require(query.conversationId, owner);
  const scopeRef = knowledge.hash(String(config.webAgent?.sharedKnowledgeBaseId || ''));
  const evidence = task.eventsExpired ? conversations.getKnowledgeEvidence(query.conversationId, query.taskId, owner)
    : knowledge.fromEvents(task.events, scopeRef);
  if (evidence.scopeRef !== scopeRef) throw fail('source_not_found', 404);
  const citation = evidence.citations[query.citationKey];
  const materials = (citation?.sourceRefs || []).map(sourceRef => ({ sourceRef, ...evidence.materials[sourceRef] }));
  if (!reading) return { scopeRef, citation, materials };
  const material = materials.find(item => item.sourceRef === query.sourceRef);
  if (citation?.type !== 'knowledge' || citation.conflicted || !material || material.conflicted
    || (material.knowledgeBaseId && knowledge.hash(material.knowledgeBaseId) !== scopeRef)) throw fail('source_mapping_unresolved', 409);
  return { scopeRef, owner, applicationKey, taskId: query.taskId, citationKey: query.citationKey, sourceRef: query.sourceRef, material };
}
function registerSourceEvidenceRoutes(app, { config, tasks, conversations, internalAuth, getConversationOwnerKey, busy = () => false,
  reader = new SourceReader(config.sourceEvidence?.readerConfig) }) {
  app.locals.sourceReader = reader;
  const hits = new Map();
  const admit = owner => {
    const now = Date.now(), times = (hits.get(owner) || []).filter(time => time > now - 60000);
    if (times.length >= 60) throw fail('source_read_rate_limited', 429);
    if (!hits.has(owner) && hits.size >= 2000) hits.delete(hits.keys().next().value);
    times.push(now); hits.set(owner, times);
  };
  const respond = (res, error) => {
    const code = /^source_[a-z_]{1,50}$/u.test(error?.code || '') ? error.code
      : error?.statusCode === 404 ? 'source_not_found' : 'source_read_unavailable';
    if (!res.headersSent && !res.destroyed) res.status(error?.statusCode || 503).json({ error: code });
  };
  app.get('/internal/provider-a/source-evidence', internalAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const owner = getConversationOwnerKey(req, res);
      const { scopeRef, citation, materials } = resolveEvidence({ tasks, conversations, config, owner, applicationKey: req.applicationKey, query: req.query });
      admit(owner);
      res.json({ schemaVersion: 1, scopeRef, taskId: req.query.taskId, citationKey: req.query.citationKey,
        mappingStatus: !citation || !materials.length ? 'unresolved' : citation.conflicted || materials.some(item => item.conflicted
          || (item.knowledgeBaseId && knowledge.hash(item.knowledgeBaseId) !== scopeRef)) ? 'conflicted'
          : citation.type !== 'knowledge' ? 'unproved_source_type' : 'mapped',
        sourceType: citation?.type || 'unknown', displayNumbers: citation?.displayNumbers || [],
        materials: materials.map(material => ({ ...material, readState: citation?.type !== 'knowledge' || citation.conflicted || material.conflicted
          || (material.knowledgeBaseId && knowledge.hash(material.knowledgeBaseId) !== scopeRef) ? 'mapping_unresolved' : reader.state(material, scopeRef, req.applicationKey) })),
        ...reader.status(scopeRef, req.applicationKey), trustedInstructions: false });
    } catch (error) { respond(res, error); }
  });
  app.post('/internal/provider-a/source-evidence/read', internalAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const controller = new AbortController(), closed = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', closed);
    try {
      const owner = getConversationOwnerKey(req, res);
      const context = resolveEvidence({ tasks, conversations, config, owner, applicationKey: req.applicationKey, query: req.body, reading: true });
      admit(owner);
      if (req.body.cursor === undefined && busy()) throw fail('source_reader_busy', 429);
      const value = await reader.read(context, { cursor: req.body.cursor, signal: controller.signal });
      if (!res.destroyed) res.json(value);
    } catch (error) { respond(res, error); }
    finally { res.off('close', closed); }
  });
  return reader;
}
module.exports = { resolveEvidence, registerSourceEvidenceRoutes };
