// Pure JSON-input audit against the website's schema-v1 archive contract.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw code; };
const own = (value, key) => Object.hasOwn(value, key);
const maxBytes = 16 * 1024 * 1024;
const categories = new Set(['shape_invalid', 'metadata_unsupported', 'text_invalid', 'date_invalid',
  'intent_conflict', 'intent_invalid', 'evidence_invalid', 'turn_incomplete', 'source_invalid',
  'source_url_unsafe', 'id_invalid', 'owner_invalid', 'chronology_invalid', 'turns_invalid',
  'store_invalid', 'size_limit', 'duplicate_id', 'turn_limit', 'options_invalid',
  'evidence_conflict', 'conversation_active', 'l0_invalid']);
const nativeEvidence = { answerBasis: 'answer_basis', sourceCount: 'source_count',
  knowledgeSourceCount: 'knowledge_source_count', webSourceCount: 'web_source_count', sourceIntent: 'source_intent' };
const l0Fields = ['l0ContextCount', 'l0SourceCount', 'l0SnapshotCount', 'l0OmittedCount', 'l0TruncationReason'];

function fields(value, allowed, redacted, report) {
  if (!object(value)) fail('shape_invalid');
  for (const key of Object.keys(value)) {
    if (redacted.includes(key)) report.redactedFields++;
    else if (!allowed.includes(key)) fail('metadata_unsupported');
  }
}

function text(value, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail('text_invalid');
}

function timestamp(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) fail('date_invalid');
    return value;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) fail('date_invalid');
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction = '') => `.${fraction.padEnd(3, '0')}Z`);
  if (new Date(value).toISOString() !== canonical) fail('date_invalid');
  return Date.parse(value);
}

function evidence(value, report) {
  if (value === null) return;
  fields(value, ['source_intent', 'sourceIntent', 'answer_basis', 'source_count',
    'knowledge_source_count', 'web_source_count', 'complete', 'interrupted', 'timing', 'process'],
  ['credential'], report);
  if (own(value, 'sourceIntent') && own(value, 'source_intent') && value.sourceIntent !== value.source_intent) {
    fail('intent_conflict');
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'sourceIntent' || key === 'source_intent') {
      if (!['', 'web_requested'].includes(item)) fail('intent_invalid');
    } else if (key.endsWith('_count')) {
      if (!Number.isInteger(item) || item < 0 || item > 100) fail('evidence_invalid');
    } else if (key === 'answer_basis') {
      if (!['', 'knowledge', 'web', 'mixed', 'agent_general', 'provider_fallback'].includes(item)) fail('evidence_invalid');
    } else if (key === 'complete' || key === 'interrupted') {
      if (typeof item !== 'boolean') fail('evidence_invalid');
      if ((key === 'complete' && !item) || (key === 'interrupted' && item)) fail('turn_incomplete');
    } else if (key === 'timing') {
      fields(item, ['elapsed_ms', 'queue_wait_ms'], [], report);
      if (Object.values(item).some(n => !Number.isFinite(n) || n < 0 || n > 86400000)) fail('evidence_invalid');
    } else if (key === 'process') {
      if (!Array.isArray(item) || item.length > 100) fail('evidence_invalid');
      for (const step of item) {
        fields(step, ['kind', 'text'], [], report);
        text(step.kind, 40); text(step.text, 4000);
      }
    }
  }
}

function source(value, report, options) {
  const allowed = ['index', 'title', 'url', 'snippet', 'type', 'sourceType'];
  fields(value, allowed, ['cookie', 'accountId'], report);
  if (!allowed.some(key => own(value, key))) fail('source_invalid');
  for (const key of allowed.filter(key => own(value, key))) {
    const item = value[key];
    if (key === 'index') {
      if (!Number.isInteger(item) || item < 1 || item > 100) fail('source_invalid');
    } else if (key === 'sourceType') {
      if (![0, 1, 2].includes(item)) fail('source_invalid');
    } else if (key === 'type' && typeof item === 'number') {
      if (!Number.isSafeInteger(item)) fail('source_invalid');
    } else {
      text(item, key === 'snippet' ? 8000 : 2000, ['title', 'snippet'].includes(key));
      if (key === 'url') {
        if (options.omitSourceUrls) continue;
        let url;
        try { url = new URL(item); } catch { fail('source_url_unsafe'); }
        // No guessing which query/fragment parameters carry credentials.
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
          || url.search || url.hash) fail('source_url_unsafe');
      }
    }
  }
  const result = { ...value };
  if (options.omitSourceUrls && own(result, 'url')) {
    delete result.url;
    // Removing a URL cannot silently turn a retained source into nothing.
    if (!allowed.some(key => key !== 'url' && own(result, key))) fail('source_invalid');
    report.removedSourceUrls++;
  }
  return result;
}

function turnEvidence(turn, report) {
  if (own(turn, 'evidence')) evidence(turn.evidence, report);
  const merged = { ...(turn.evidence || {}) };
  let mapped = 0;
  for (const [flat, canonical] of Object.entries(nativeEvidence)) {
    if (!own(turn, flat)) continue;
    const value = turn[flat];
    if ((own(merged, canonical) && merged[canonical] !== value)
      || (flat === 'sourceIntent' && own(merged, 'sourceIntent') && merged.sourceIntent !== value)) fail('evidence_conflict');
    merged[canonical] = value;
    mapped++;
  }
  // Validate without normalization: no coerced counts or inferred basis/intent.
  if (mapped) {
    evidence(merged, { redactedFields: 0 });
    report.mappedEvidenceFields += mapped;
    return merged;
  }
  return turn.evidence;
}

function conversation(row, report, options) {
  fields(row, ['id', 'ownerKey', 'title', 'mode', 'createdAt', 'updatedAt', 'expiresAt', 'turns', 'activeRequest'], ['upstream'], report);
  if (own(row, 'activeRequest')) {
    if (row.activeRequest !== false) fail('conversation_active');
    report.redactedFields++;
  }
  if (own(row, 'upstream')) report.excludedUpstreamFields++;
  if (typeof row.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(row.id)) fail('id_invalid');
  if (typeof row.ownerKey !== 'string'
    || !/^(?:demo:)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.ownerKey)) fail('owner_invalid');
  if (own(row, 'title')) text(row.title, 500, true);
  if (own(row, 'mode')) text(row.mode, 80);
  const created = timestamp(row.createdAt), updated = timestamp(row.updatedAt), expires = timestamp(row.expiresAt);
  if (created > updated || updated > expires) fail('chronology_invalid');
  if (!Array.isArray(row.turns) || row.turns.length > 1000) fail('turns_invalid');
  let previous = created;
  const turns = [];
  for (const turn of row.turns) {
    fields(turn, ['question', 'answer', 'createdAt', 'sources', 'searchSummary', 'evidence', ...Object.keys(nativeEvidence)],
      ['turnRef', 'cookie', ...l0Fields], report);
    for (const key of l0Fields.filter(key => own(turn, key))) {
      const value = turn[key];
      if (key === 'l0TruncationReason') {
        if (!['none', 'payload_bytes', 'safety_count', 'prompt_budget'].includes(value)) fail('l0_invalid');
      } else if (!Number.isInteger(value) || value < 0
        || value > (['l0ContextCount', 'l0SnapshotCount'].includes(key) ? 256 : 1000000)) fail('l0_invalid');
      report.excludedL0Fields++;
    }
    text(turn.question, 2000); text(turn.answer, 200000);
    const at = timestamp(turn.createdAt);
    if (at < previous || at > updated) fail('chronology_invalid');
    previous = at;
    let sources;
    if (own(turn, 'sources')) {
      if (!Array.isArray(turn.sources) || turn.sources.length > 100) fail('source_invalid');
      sources = turn.sources.map(item => source(item, report, options));
    }
    if (own(turn, 'searchSummary') && turn.searchSummary !== null) text(turn.searchSummary, 16000, true);
    const result = { ...turn, sources, evidence: turnEvidence(turn, report) };
    turns.push(result);
  }
  return { ...row, turns };
}

function adaptHistoryInput(store, options = {}) {
  const report = { ready: false, conversations: 0, turns: 0, validConversations: 0,
    emptyShells: 0, invalidConversations: 0, redactedFields: 0,
    excludedEmptyShells: 0, removedSourceUrls: 0, excludedUpstreamFields: 0,
    excludedL0Fields: 0, mappedEvidenceFields: 0, reasons: {} };
  const issue = code => {
    const category = categories.has(code) ? code : 'shape_invalid';
    report.reasons[category] = (report.reasons[category] || 0) + 1;
  };
  try {
    if (!object(options) || Object.entries(options).some(([key, value]) =>
      !['excludeEmptyShells', 'omitSourceUrls'].includes(key) || typeof value !== 'boolean')) fail('options_invalid');
    fields(store, ['version', 'updatedAt', 'conversations'], ['providerRequests'], report);
    if (!Array.isArray(store.conversations) || store.conversations.length > 5000) fail('store_invalid');
    if (own(store, 'version') && ![1, 2].includes(store.version)) fail('store_invalid');
    if (own(store, 'updatedAt')) timestamp(store.updatedAt);
    // Conservative raw-input cap also bounds private fields before projection.
    if (Buffer.byteLength(JSON.stringify(store)) > maxBytes) fail('size_limit');
  } catch (code) {
    issue(typeof code === 'string' ? code : 'store_invalid');
    return { report, conversations: null };
  }
  report.conversations = store.conversations.length;
  const ids = new Set();
  const conversations = [];
  for (const row of store.conversations) {
    if (Array.isArray(row?.turns)) report.turns += row.turns.length;
    try {
      if (typeof row?.id === 'string') {
        if (ids.has(row.id)) fail('duplicate_id');
        ids.add(row.id);
      }
      const adapted = conversation(row, report, options);
      if (row.turns.length === 0) {
        report.emptyShells++;
        if (options.excludeEmptyShells) report.excludedEmptyShells++;
      } else {
        report.validConversations++;
        conversations.push(adapted);
      }
    } catch (code) {
      report.invalidConversations++;
      issue(typeof code === 'string' ? code : 'shape_invalid');
    }
  }
  if (report.turns > 50000) issue('turn_limit');
  report.ready = report.emptyShells === report.excludedEmptyShells && Object.keys(report.reasons).length === 0;
  return { report, conversations: report.ready ? conversations : null };
}

function auditHistoryInput(store, options = {}) {
  return adaptHistoryInput(store, options).report;
}

module.exports = { auditHistoryInput, adaptHistoryInput };
