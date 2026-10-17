'use strict';

// Pure, credential-free contract. The standalone client ships the same bytes.
// This describes observed evidence, never whether the upstream ran a search.
const BASES = new Set(['knowledge', 'web', 'mixed', 'agent_general', 'provider_fallback']);
const own = (v, k) => Object.prototype.hasOwnProperty.call(v || {}, k);
function count(v) {
  if (typeof v === 'string' && /^\d{1,3}$/u.test(v)) v = Number(v);
  return Number.isSafeInteger(v) && v >= 0 && v <= 100 ? v : null;
}
function alias(value, snake, camel, parse = v => v) {
  const a = own(value, snake), b = own(value, camel);
  if (!a && !b) return { present: false };
  const first = parse(a ? value[snake] : value[camel]);
  return { present: true, value: first,
    invalid: first === null || (a && b && first !== parse(value[camel])) };
}
function publicWebUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
      && !/(^|\.)(ima\.qq\.com|ima\.tencent\.com)$/iu.test(u.hostname)
      && ![...u.searchParams.keys()].some(k => /token|secret|credential|password|signature|authorization|api.?key/iu.test(k));
  } catch { return false; }
}
function inspectWebEvidence({ done, citationMap = {}, terminal = false } = {}) {
  const unknown = () => ({ webEvidence: false, webEvidenceStatus: 'unverified' });
  if (done !== undefined && (!done || typeof done !== 'object' || Array.isArray(done))) return unknown();
  const total = alias(done, 'source_count', 'sourceCount', count);
  const kb = alias(done, 'knowledge_source_count', 'knowledgeSourceCount', count);
  const web = alias(done, 'web_source_count', 'webSourceCount', count);
  const basis = alias(done, 'answer_basis', 'answerBasis', v => BASES.has(v) ? v : null);
  if ([total, kb, web, basis].some(x => x.invalid)
      || (total.present && kb.present && kb.value > total.value)
      || (total.present && web.present && web.value > total.value)
      || (total.present && kb.present && web.present && kb.value + web.value > total.value)
      || (basis.value === 'web' && web.present && web.value === 0)
      || (basis.value === 'mixed' && ((web.present && web.value === 0) || (kb.present && kb.value === 0)))
      || (basis.value === 'knowledge' && ((kb.present && kb.value === 0) || (web.present && web.value > 0)))
      || (['agent_general', 'provider_fallback'].includes(basis.value) && total.present && total.value !== 0)) return unknown();
  let mappedWeb = false;
  if (citationMap && typeof citationMap === 'object' && !Array.isArray(citationMap)) {
    mappedWeb = Object.entries(citationMap).slice(0, 100).some(([key, entry]) =>
      /^(index|context):[^\s?&#]{1,128}$/u.test(key) && entry?.type === 'web' && entry.conflicted !== true
      && Array.isArray(entry.sources) && entry.sources.slice(0, 10).some(x => publicWebUrl(x?.url)));
  }
  if (mappedWeb && web.present && web.value === 0) return unknown();
  if (mappedWeb || (web.present && web.value > 0)) return { webEvidence: true, webEvidenceStatus: 'verified' };
  return terminal && web.present && web.value === 0
    ? { webEvidence: false, webEvidenceStatus: 'not_observed' } : unknown();
}

module.exports = { inspectWebEvidence };
