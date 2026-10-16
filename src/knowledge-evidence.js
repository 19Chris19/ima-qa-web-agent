'use strict';

// Private provenance, deliberately independent of the public chat projection.
const { createHash } = require('node:crypto');
const chat = require('./chat-presentation');
const EVENT = 'knowledge_evidence';
const MAX = 100;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const safeKey = key => typeof key === 'string' && /^(index|context):[^\s?&#]{1,128}$/u.test(key)
  && !/(__proto__|constructor|prototype)/u.test(key);
const clean = (value, limit = 512) => typeof value === 'string' && value.length <= limit
  && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : '';
const hash = value => createHash('sha256').update(value).digest('hex');
const scopeRef = value => /^[a-f0-9]{64}$/u.test(value || '') ? value : '';
const sourceRef = (scope, namespace, id) => hash(JSON.stringify([scope, namespace, id]));
const empty = scope => ({ schemaVersion: 1, scopeRef: scopeRef(scope), materials: {}, citations: {} });
function positions(value) {
  if (value === undefined) return undefined;
  try {
    const raw = JSON.stringify(value);
    if (raw.length > 2048 || /token|cookie|credential|secret|password|__proto__|constructor|prototype/iu.test(raw)) return undefined;
    return JSON.parse(raw);
  } catch { return undefined; }
}

function normalize(value, catalog = {}) {
  const result = empty(value?.scopeRef);
  if (!object(value) || value.schemaVersion !== 1) return result;
  for (const [ref, item] of Object.entries(object(value.materials) ? value.materials : {}).slice(0, MAX)) {
    if (!object(item) || item.idNamespace !== 'ima_web_media') continue;
    const materialId = clean(item.materialId, 2048);
    if (!materialId || ref !== sourceRef(result.scopeRef, item.idNamespace, materialId)) continue;
    result.materials[ref] = { materialId, idNamespace: item.idNamespace,
      ...(clean(item.title) ? { title: clean(item.title) } : {}),
      ...(clean(item.knowledgeBaseId) ? { knowledgeBaseId: clean(item.knowledgeBaseId) } : {}),
      ...(Number.isSafeInteger(item.mediaType) ? { mediaType: item.mediaType } : {}),
      ...(item.conflicted === true ? { conflicted: true } : {}) };
  }
  for (const [key, entry] of Object.entries(object(value.citations) ? value.citations : {}).slice(0, MAX)) {
    if (!safeKey(key) || !object(entry)) continue;
    const type = ['knowledge', 'web', 'unknown'].includes(entry.type) ? entry.type : 'unknown';
    const refs = [...new Set(Array.isArray(entry.sourceRefs) ? entry.sourceRefs : [])]
      .filter(ref => own(result.materials, ref) || own(catalog, ref)).slice(0, 10);
    const numbers = [...new Set(Array.isArray(entry.displayNumbers) ? entry.displayNumbers : [])]
      .filter(n => typeof n === 'string' && /^\d{1,6}$/u.test(n)).slice(0, MAX);
    const location = positions(entry.upstreamPositions);
    result.citations[key] = { type, sourceRefs: type === 'web' ? [] : refs, displayNumbers: numbers,
      ...(location !== undefined ? { upstreamPositions: location, positionFormat: 'upstream_opaque' } : {}),
      ...(entry.conflicted === true ? { conflicted: true } : {}) };
  }
  return result;
}

function merge(previous, incoming) {
  const result = normalize(previous), next = normalize(incoming, result.materials);
  if (!result.scopeRef && !Object.keys(result.materials).length && !Object.keys(result.citations).length) result.scopeRef = next.scopeRef;
  if (result.scopeRef !== next.scopeRef) return result;
  for (const [ref, item] of Object.entries(next.materials)) {
    const old = result.materials[ref];
    if (!old && Object.keys(result.materials).length >= MAX) continue;
    result.materials[ref] = { ...old, ...item,
      ...((old?.conflicted || (old?.knowledgeBaseId && item.knowledgeBaseId && old.knowledgeBaseId !== item.knowledgeBaseId))
        ? { conflicted: true } : {}) };
  }
  for (const [key, entry] of Object.entries(next.citations)) {
    const old = result.citations[key];
    if (!old && Object.keys(result.citations).length >= MAX) continue;
    const conflicted = old?.conflicted || entry.conflicted || (old && old.type !== 'unknown' && entry.type !== 'unknown' && old.type !== entry.type);
    const type = conflicted ? 'unknown' : entry.type === 'unknown' && old ? old.type : entry.type;
    result.citations[key] = { type,
      sourceRefs: type === 'web' ? [] : [...new Set([...(old?.sourceRefs || []), ...entry.sourceRefs])].slice(0, 10),
      displayNumbers: [...new Set([...(old?.displayNumbers || []), ...entry.displayNumbers])].slice(0, MAX),
      ...(entry.upstreamPositions !== undefined || old?.upstreamPositions !== undefined
        ? { upstreamPositions: entry.upstreamPositions ?? old.upstreamPositions, positionFormat: 'upstream_opaque' } : {}),
      ...(conflicted ? { conflicted: true } : {}) };
  }
  return result;
}

// A bounded delta: unchanged titles/IDs are not copied on every source update.
function delta(previous, next) {
  const before = normalize(previous), after = normalize(next), result = empty(after.scopeRef);
  for (const [key, item] of Object.entries(after.materials))
    if (JSON.stringify(before.materials[key]) !== JSON.stringify(item)) result.materials[key] = item;
  for (const [key, item] of Object.entries(after.citations)) {
    if (JSON.stringify(before.citations[key]) === JSON.stringify(item)) continue;
    result.citations[key] = item;
  }
  return result;
}
const hasData = value => Object.keys(value?.materials || {}).length > 0 || Object.keys(value?.citations || {}).length > 0;

function withDisplayNumbers(value, answer) {
  const result = normalize(value), map = chat.withDisplayNumbers(result.citations, answer);
  for (const [key, entry] of Object.entries(result.citations)) entry.displayNumbers = map[key]?.displayNumbers || entry.displayNumbers;
  return result;
}
function fromEvents(events, scope) {
  let result = empty(scope);
  for (const event of events || []) if (event.event === EVENT) result = merge(result, event.data?.knowledgeEvidence);
  return result;
}
function allowed(config, applicationKey) {
  return typeof applicationKey === 'string' && applicationKey.startsWith('application:')
    && Array.isArray(config?.sourceEvidence?.applications)
    && config.sourceEvidence.applications.includes(applicationKey.slice(12));
}
function publicData(name, data) {
  if (name === EVENT) return null;
  const { knowledgeEvidence, ...rest } = data || {};
  return rest;
}
function publicSnapshot(value) {
  return { ...value, snapshot: value.snapshot ? { ...value.snapshot,
    events: (value.snapshot.events || []).filter(event => event.event !== EVENT)
      .map(event => ({ ...event, data: publicData(event.event, event.data) })) } : value.snapshot };
}
function agentSnapshot(value, knowledgeEvidence) {
  const evidence = normalize(knowledgeEvidence);
  return { ...value, knowledgeEvidence: evidence };
}

module.exports = { EVENT, MAX, empty, normalize, merge, delta, hasData, withDisplayNumbers, fromEvents,
  allowed, publicData, publicSnapshot, agentSnapshot, sourceRef, hash };
