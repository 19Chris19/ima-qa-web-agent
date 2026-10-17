'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fail = code => { throw new Error(code); };
const stableId = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u;
const DISCOVERY = new Set(['repository', 'public_script_candidate', 'not_observed']);
const SYNTHETIC = new Set(['covered_by_tests', 'external_candidate_tests', 'not_run']);
const REAL = new Set(['historical_scoped', 'pending']);
const RELEASE = new Set(['published', 'unpublished']);
const EFFECT = new Set(['read', 'write', 'generation', 'authentication']);
const relativeFile = p => typeof p === 'string' && !path.isAbsolute(p) && !p.split(/[\\/]/u).includes('..');
const repositoryFile = (root, p) => relativeFile(p) && fs.lstatSync(path.join(root, p)).isFile()
  && fs.realpathSync(path.join(root, p)).startsWith(fs.realpathSync(root) + path.sep);
function publicEvidenceReference(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
      && ((u.hostname === 'github.com' && u.pathname.startsWith('/19Chris19/ima-qa-web-agent/'))
        || (u.hostname === 'fe-static.ima.myqcloud.com' && /^\/ima\/assets\/chat\/assets\/[A-Za-z0-9_.-]+\.js$/u.test(u.pathname)));
  } catch { return false; }
}

function validateCatalog(catalog, root) {
  if (catalog?.schemaVersion !== 1 || catalog.upstream !== 'ima' || !Array.isArray(catalog.capabilities)
      || !Array.isArray(catalog.evidence)) fail('contract_catalog_invalid');
  const evidence = new Map();
  for (const e of catalog.evidence) {
    if (!stableId.test(e.id) || evidence.has(e.id) || !['repository','historical_acceptance','candidate_pr','public_script'].includes(e.kind)
      || !publicEvidenceReference(e.reference) || !e.limitations) fail('contract_evidence_invalid');
    if (e.file && !repositoryFile(root, e.file)) fail('contract_evidence_file_missing');
    evidence.set(e.id, e);
  }
  const ids = new Set();
  for (const c of catalog.capabilities) {
    if (!stableId.test(c.id) || ids.has(c.id) || !c.family || !c.operation || !EFFECT.has(c.effect)) fail('contract_capability_invalid');
    ids.add(c.id);
    if (!DISCOVERY.has(c.validation?.discovery) || !SYNTHETIC.has(c.validation?.synthetic)
      || !REAL.has(c.validation?.real) || !RELEASE.has(c.validation?.release)) fail('contract_validation_invalid');
    if (typeof c.runtimeImplemented !== 'boolean' || !c.request || !c.response || !c.auth || !c.identity
      || !c.completion || !c.retry || !Array.isArray(c.unknowns) || !c.nextVerification) fail('contract_detail_missing');
    if (!Array.isArray(c.evidenceRefs) || c.evidenceRefs.some(id => !evidence.has(id))) fail('contract_evidence_reference_missing');
    if (c.runtimeImplemented && (!c.implementation || c.validation.discovery !== 'repository'
      || c.validation.synthetic !== 'covered_by_tests')) fail('contract_runtime_unproved');
    if (!c.runtimeImplemented && c.validation.release === 'published') fail('contract_candidate_published');
    if (c.validation.real === 'historical_scoped' && !c.evidenceRefs.some(id => evidence.get(id).kind === 'historical_acceptance')) fail('contract_real_unproved');
    if ((!c.request.path || !c.response.shape) && !c.unknowns.length) fail('contract_unknowns_hidden');
    if (c.request.path && (!/^\/(cgi-bin|openapi)\/[A-Za-z0-9_/-]{1,200}$/u.test(c.request.path)
      || !['GET','POST'].includes(c.request.method))) fail('contract_request_path_invalid');
    if (c.request.fixture && !repositoryFile(root, c.request.fixture)) fail('contract_fixture_missing');
    if (c.variants !== undefined) {
      if (!Array.isArray(c.variants) || c.variants.length > 16) fail('contract_variants_invalid');
      const variants = new Set();
      for (const v of c.variants) {
        if (!stableId.test(v.id) || variants.has(v.id) || v.runtimeImplemented !== false || v.callableFromCatalog !== false
          || typeof v.auth !== 'string' || !v.auth || !Array.isArray(v.unknowns) || !v.nextVerification
          || !DISCOVERY.has(v.validation?.discovery) || !SYNTHETIC.has(v.validation?.synthetic)
          || !REAL.has(v.validation?.real) || v.validation.release !== 'unpublished'
          || !['GET', 'POST'].includes(v.request?.method)
          || !/^\/(cgi-bin|openapi)\/[A-Za-z0-9_/-]{1,200}$/u.test(v.request?.path || '')
          || !Array.isArray(v.evidenceRefs) || v.evidenceRefs.some(id => !evidence.has(id))) fail('contract_variants_invalid');
        if (v.validation.real === 'historical_scoped' && !v.evidenceRefs.some(id => evidence.get(id).kind === 'historical_acceptance')) fail('contract_real_unproved');
        variants.add(v.id);
      }
    }
    if (c.implementation) {
      for (const p of [c.implementation.file, ...c.implementation.tests]) {
        if (!repositoryFile(root, p)) fail('contract_implementation_missing');
      }
      if (!c.implementation.tests.length || (c.implementation.symbol &&
        !fs.readFileSync(path.join(root, c.implementation.file), 'utf8').includes(c.implementation.symbol))) fail('contract_implementation_symbol_missing');
    }
    // This catalog has no execution path. A candidate never enables a feature.
    if (c.callableFromCatalog !== false) fail('contract_catalog_cannot_authorize');
  }
  const required = ['auth.login', 'auth.refresh', 'knowledge.scope', 'session.create', 'session.followup', 'qa.stream', 'qa.web_intent',
    'qa.process', 'qa.suggestions', 'citation.web', 'citation.knowledge', 'material.resolve', 'material.read', 'mode.quick', 'mode.deep',
    'model.list', 'model.select', ...['report','ppt','podcast'].flatMap(x => ['create','status','download','cancel'].map(y => `${x}.${y}`)),
    ...['read','write','delete'].map(x => `memory.${x}`), ...['get','list','create','update','delete'].map(x => `knowledge.${x}`),
    ...['list','upload','update','delete'].map(x => `material.${x}`)];
  if (required.some(id => !ids.has(id))) fail('contract_coverage_incomplete');
  return { schemaVersion: 1, capabilities: ids.size,
    runtimeImplemented: catalog.capabilities.filter(c => c.runtimeImplemented).length,
    pendingReal: catalog.capabilities.filter(c => c.validation.real === 'pending').length,
    executableFromCatalog: false };
}

function inspectPublicBundle(bytes, { sourceUrl, sampledAt } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 8 * 1024 * 1024) fail('bundle_size_invalid');
  let u; try { u = new URL(sourceUrl); } catch { fail('bundle_source_invalid'); }
  if (u.protocol !== 'https:' || u.hostname !== 'fe-static.ima.myqcloud.com' || u.username || u.password || u.search || u.hash
      || !/^\/ima\/assets\/chat\/assets\/[A-Za-z0-9_.-]+\.js$/u.test(u.pathname)) fail('bundle_source_invalid');
  if (!Number.isFinite(Date.parse(sampledAt))) fail('bundle_sample_time_invalid');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const routes = [...new Set(source.match(/\/(?:cgi-bin|openapi)\/[A-Za-z0-9_/-]{1,160}/gu) || [])].sort().slice(0, 200);
  // The current bundle injects service prefixes separately. Preserve suffixes
  // as candidates; do not concatenate unrelated strings into invented URLs.
  const methodSuffixes = [...new Set([...source.matchAll(/this\.urlPrefix,["'](\/[a-z][a-z0-9_]{0,100})["']/gu)]
    .map(match => match[1]))].sort().slice(0, 300);
  const prefixBindings = [...new Set([...source.matchAll(/toConstantValue\(["']([a-z][a-z0-9_]{1,100})["']\)/gu)]
    .map(match => match[1]))].sort().slice(0, 200);
  const features = ['podcast', 'ppt', 'report', 'memory', 'deepThink', 'webSearch', 'reference_indexes', 'context_references']
    .filter(word => source.includes(word));
  return { schemaVersion: 1, sourceUrl: u.href, sampledAt, bytes: bytes.byteLength,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), candidatePaths: routes, methodSuffixes,
    servicePrefixCandidates: prefixBindings,
    featureMentions: features, evidenceLevel: 'public_script_candidate', callable: false,
    limitations: 'Literal mentions only. No execution, request dispatch, authentication or runtime validation. Missing matches do not prove absence.' };
}

function checkScrubbedFixture(value) {
  const visit = (v, key = '') => {
    if (Array.isArray(v)) { v.forEach(x => visit(x, key)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/cookie|token|credential|secret|password|authorization/iu.test(k)) fail('fixture_credential_field');
        visit(x, k);
      }
      return;
    }
    if (typeof v !== 'string') return;
    if (/https?:\/\//iu.test(v)) {
      let u; try { u = new URL(v); } catch { fail('fixture_url_invalid'); }
      if (!/(^|\.)example\.(org|com|invalid)$/u.test(u.hostname) || u.username || u.password || u.search || u.hash) fail('fixture_real_url');
    }
    if (/^(question|answer|text|title|content|snippet|materialId|session_id|sessionId|client_id|clientId|knowledge_base_id|knowledgeBaseId|modelId)$/iu.test(key)
      && v && !/^(SCRUBBED_|Scrubbed\b)/u.test(v)) fail('fixture_unscrubbed_value');
    if (/\beyJ[A-Za-z0-9_-]{20,}\.|IMA-(?:TOKEN|REFRESH-TOKEN|UID)\s*=/u.test(v)) fail('fixture_credential_value');
  };
  visit(value); return true;
}
module.exports = { validateCatalog, inspectPublicBundle, checkScrubbedFixture };
