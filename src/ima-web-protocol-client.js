'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { buildIMAInitSessionBody, buildIMAQuestionBody, ANSWER_PROFILE_CLASSIC } = require('./ima-answer-profile');
const { parseIMAWebAgentStream } = require('./ima-upstream-protocol');
const { classifyIMAKnowledgeAgentSource } = require('./ima-knowledge-agent-contract');

const BASE = 'https://ima.qq.com';
const PATHS = Object.freeze({
  models: '/cgi-bin/model_manage/get_models',
  libraries: '/cgi-bin/knowledge_tab_reader/get_knowledge_base_list',
  libraryPage: '/cgi-bin/knowledge_tab_reader/get_knowledge_base_home_page',
  materials: '/cgi-bin/knowledge_tab_reader/get_knowledge_list',
  session: '/cgi-bin/session_logic/init_session',
  qa: '/cgi-bin/assistant/qa',
});
class IMAWebContractError extends Error {
  constructor(code, upstreamCode) { super(code); this.name = 'IMAWebContractError'; this.code = code; if (Number.isInteger(upstreamCode)) this.upstreamCode = upstreamCode; }
}
const fail = code => { throw new IMAWebContractError(code); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
function text(v, max = 512, empty = false) {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u001f\u007f]/u.test(v) || (!empty && !v.trim())) fail('ima_web_field_invalid');
  return v;
}
function integer(v, max = 65535) {
  if (!Number.isSafeInteger(v) || v < 0 || v > max) fail('ima_web_field_invalid');
  return v;
}
function freeze(v) { if (v && typeof v === 'object' && !Object.isFrozen(v)) { for (const x of Object.values(v)) freeze(x); Object.freeze(v); } return v; }
function boolean(v) { if (typeof v !== 'boolean') fail('ima_web_field_invalid'); return v; }
// Qimei uskey is an opaque JSON body string and can contain escaped control
// bytes. Do not normalize it as a URL, text label or HTTP header.
function deviceToken(v) { if (typeof v !== 'string' || !v.length || v.length > 4096) fail('ima_web_device_context_invalid'); return v; }
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');

function modelInfo(v) {
  if (!object(v)) fail('ima_web_model_invalid');
  return { model_id: text(v.model_id, 256), model_type: integer(v.model_type), enable_enhancement: boolean(v.enable_enhancement) };
}
function parseModelCatalog(payload) {
  if (!object(payload) || payload.code !== 0 || !Array.isArray(payload.models) || !payload.models.length || payload.models.length > 64) fail('ima_web_models_invalid');
  const models = payload.models.map(m => {
    const base = modelInfo(m), modes = {};
    if (!object(m.sub_model_infos) || !object(m.sub_model_types)) fail('ima_web_modes_missing');
    for (const [key, mode] of [['0', 'quick'], ['1', 'deep']]) {
      if (!Object.hasOwn(m.sub_model_infos, key)) continue;
      const value = modelInfo(m.sub_model_infos[key]);
      if (value.model_type !== m.sub_model_types[key]) fail('ima_web_modes_conflicted');
      modes[mode] = value;
    }
    if (!Object.keys(modes).length) fail('ima_web_modes_missing');
    return { modelRef: hash({ base, modes }), name: text(m.model_name, 256), isDefault: m.is_default === true, base, modes };
  });
  if (new Set(models.map(m => m.modelRef)).size !== models.length) fail('ima_web_models_conflicted');
  return freeze({ version: text(payload.version || '', 256, true), models, digest: hash(models) });
}
function buildLibraryListRequest(groups = [1001, 1002, 1004, 1005]) {
  if (!Array.isArray(groups) || !groups.length || groups.length > 4) fail('ima_web_groups_invalid');
  const params = groups.map(g => {
    const x = typeof g === 'number' ? { type: g } : g;
    if (!object(x) || ![1001, 1002, 1004, 1005].includes(x.type)) fail('ima_web_groups_invalid');
    return { type: x.type, cursor: text(x.cursor ?? '', 4096, true), limit: integer(x.limit ?? (x.type === 1005 ? 50 : 20), 50) };
  });
  if (params.some(x => !x.limit) || new Set(params.map(x => x.type)).size !== params.length) fail('ima_web_groups_invalid');
  return { params };
}
function buildLibraryPageRequest({ knowledgeBaseId, folderId = knowledgeBaseId, version = '' } = {}) {
  return { knowledge_base_id: text(knowledgeBaseId), knowledge_list_req: {
    knowledge_base_id: text(knowledgeBaseId), folder_id: text(folderId), sort_type: 9,
    need_default_cover: true, version: text(version, 256, true) } };
}
function buildMaterialListRequest({ knowledgeBaseId, folderId = knowledgeBaseId, cursor = '', version = '', limit = 50 } = {}) {
  const count = integer(limit, 50); if (!count) fail('ima_web_field_invalid');
  return { sort_type: 9, need_default_cover: true, knowledge_base_id: text(knowledgeBaseId), folder_id: text(folderId),
    cursor: text(cursor, 4096, true), limit: count, version: text(version, 256, true), ext_info: {} };
}
function projectLibrary(v) {
  if (!object(v) || !object(v.basic_info)) fail('ima_web_library_invalid');
  return { id: text(v.id), name: text(v.basic_info.name, 2000),
    permissions: { accessStatus: Number.isInteger(v.permission_info?.access_status) ? v.permission_info.access_status : null,
      contentForbidden: typeof v.permission_info?.forbid_member_access_content === 'boolean' ? v.permission_info.forbid_member_access_content : null,
      roleType: Number.isInteger(v.user_permission_info?.role_type) ? v.user_permission_info.role_type : null } };
}
function pagination(v) {
  const isEnd = boolean(v.is_end), nextCursor = text(v.next_cursor ?? '', 4096, true);
  if (!isEnd && !nextCursor) fail('ima_web_pagination_unproved');
  return { isEnd, nextCursor };
}
function projectMaterials(v, knowledgeBaseId, folderId = knowledgeBaseId) {
  if (!object(v) || !Array.isArray(v.knowledge_list) || v.knowledge_list.length > 100) fail('ima_web_materials_invalid');
  const library = projectLibrary(v.knowledge_base_info);
  if (library.id !== knowledgeBaseId) fail('ima_web_scope_mismatch');
  if (!Array.isArray(v.current_path) || !v.current_path.length || v.current_path.length > 64
    || v.current_path.at(-1)?.folder_id !== folderId) fail('ima_web_folder_scope_unproved');
  return freeze({ library, ...pagination(v), version: text(v.version || '', 256, true),
    path: (v.current_path || []).map(f => ({ id: text(f.folder_id), name: text(f.name || '', 2000, true), parentId: text(f.parent_folder_id || '', 512, true) })),
    materials: v.knowledge_list.map(m => ({ materialId: text(m.media_id), title: text(m.title || '', 2000, true), mediaType: integer(m.media_type),
      folderId: typeof m.folder_info?.folder_id === 'string' && m.folder_info.folder_id ? text(m.folder_info.folder_id) : null,
      accessStatus: Number.isInteger(m.access_status) ? m.access_status : null })) });
}
async function boundedJSON(response, signal) {
  const reader = response.body?.getReader(); if (!reader) fail('ima_web_response_missing');
  const chunks = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) { signal.throwIfAborted(); const item = await reader.read(); signal.throwIfAborted(); if (item.done) break;
      size += item.value.byteLength; if (size > 2 * 1024 * 1024) { void reader.cancel().catch(() => {}); fail('ima_web_response_too_large'); } chunks.push(Buffer.from(item.value)); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { fail('ima_web_response_invalid'); }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

// Trusted SDK only: this module does not register routes, advertise MCP tools,
// access an account directory, refresh credentials, or persist private results.
class IMAWebProtocolClient {
  #headers; #fetch; #now; #busy = false; #catalog = null; #catalogAt = 0; #sessions = new WeakMap(); #attempts = new WeakMap(); #device;
  constructor({ headers, deviceInfo, fetchImpl = fetch, now = Date.now } = {}) {
    if (!object(headers) || typeof fetchImpl !== 'function') fail('ima_web_auth_missing');
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    this.#headers = freeze({ 'x-ima-cookie': text(h['x-ima-cookie'], 32768), 'x-ima-bkn': text(h['x-ima-bkn'], 256),
      extension_version: text(h.extension_version, 64), from_browser_ima: '1', 'content-type': 'application/json', accept: '*/*', origin: BASE });
    this.#device = deviceInfo ? freeze({ uskey: deviceToken(deviceInfo.uskey), uskey_bus_infos_input: text(deviceInfo.uskey_bus_infos_input, 256) }) : null;
    this.#fetch = fetchImpl; this.#now = now;
  }
  #begin() { if (this.#busy) fail('ima_web_client_busy'); this.#busy = true; }
  async #post(path, body, signal, knowledgeBaseId) {
    let response;
    try { signal.throwIfAborted(); response = await this.#fetch(BASE + path, { method: 'POST', redirect: 'error', signal,
      headers: { ...this.#headers, referer: knowledgeBaseId ? `${BASE}/wikis?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}` : `${BASE}/` }, body: JSON.stringify(body) }); }
    catch { throw new IMAWebContractError(signal.aborted ? 'ima_web_request_interrupted' : 'ima_web_transport_failed'); }
    if (!response.ok) { void response.body?.cancel().catch(() => {}); fail([401, 403].includes(response.status) ? 'ima_web_auth_denied' : 'ima_web_http_failed'); }
    return response;
  }
  async #json(path, body, { signal, knowledgeBaseId } = {}) {
    this.#begin(); const deadline = AbortSignal.timeout(10000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const result = await boundedJSON(await this.#post(path, body, combined, knowledgeBaseId), combined);
      if (!object(result) || result.code !== 0) throw new IMAWebContractError('ima_web_upstream_rejected', result?.code);
      return result;
    } catch (error) { if (combined.aborted) throw new IMAWebContractError('ima_web_request_interrupted'); throw error; }
    finally { this.#busy = false; }
  }
  async getModels(options = {}) {
    if (this.#busy) fail('ima_web_client_busy');
    this.#catalog = null;
    const catalog = parseModelCatalog(await this.#json(PATHS.models, { scene: 0 }, options));
    this.#catalog = catalog; this.#catalogAt = this.#now(); return catalog;
  }
  selectModel({ modelRef, mode, webSearch = false } = {}) {
    if (!this.#catalog || this.#now() - this.#catalogAt > 300000) fail('ima_web_models_stale');
    if (!['quick', 'deep'].includes(mode)) fail('ima_web_mode_invalid');
    const model = this.#catalog.models.find(m => m.modelRef === modelRef), value = model?.modes[mode];
    if (!value) fail('ima_web_model_unavailable');
    boolean(webSearch); if (webSearch && value.enable_enhancement !== true) fail('ima_web_search_unavailable');
    return freeze({ modelRef, mode, catalogDigest: this.#catalog.digest,
      modelInfo: { ...value, enable_enhancement: webSearch } });
  }
  async listKnowledgeBases({ groups, signal } = {}) {
    const request = buildLibraryListRequest(groups), result = await this.#json(PATHS.libraries, request, { signal });
    if (!Array.isArray(result.results) || result.results.length !== request.params.length) fail('ima_web_groups_incomplete');
    const seen = new Set();
    return freeze({ groups: result.results.map(g => {
      if (!request.params.some(p => p.type === g.type) || seen.has(g.type) || !Array.isArray(g.knowledge_base_list) || g.knowledge_base_list.length > 100) fail('ima_web_groups_invalid'); seen.add(g.type);
      return { type: g.type, ...pagination(g), libraries: g.knowledge_base_list.map(projectLibrary) };
    }) });
  }
  async getLibraryPage({ knowledgeBaseId, folderId, version, signal } = {}) {
    const request = buildLibraryPageRequest({ knowledgeBaseId, folderId, version });
    const result = await this.#json(PATHS.libraryPage, request, { signal, knowledgeBaseId });
    return projectMaterials(result.list_rsp, knowledgeBaseId, request.knowledge_list_req.folder_id);
  }
  async listMaterials({ knowledgeBaseId, folderId, cursor, version, limit, signal } = {}) {
    const request = buildMaterialListRequest({ knowledgeBaseId, folderId, cursor, version, limit });
    return projectMaterials(await this.#json(PATHS.materials, request, { signal, knowledgeBaseId }), knowledgeBaseId, request.folder_id);
  }
  async createKnowledgeSession({ knowledgeBaseId, modelRef, mode, webSearch = false, signal } = {}) {
    if (!this.#device) fail('ima_web_device_context_missing');
    text(knowledgeBaseId); const selection = this.selectModel({ modelRef, mode, webSearch });
    const response = await this.#json(PATHS.session, buildIMAInitSessionBody(ANSWER_PROFILE_CLASSIC, knowledgeBaseId), { signal, knowledgeBaseId });
    const sessionId = text(response.session_id);
    if (response.session_info?.id !== sessionId || response.session_info?.knowledge_base_info_with_folder?.knowledge_base_id !== knowledgeBaseId) fail('ima_web_session_scope_unproved');
    const lease = freeze({ sessionId, knowledgeBaseId, modelRef, mode, catalogDigest: selection.catalogDigest });
    this.#sessions.set(lease, selection); this.#attempts.set(lease, new Set()); return lease;
  }
  buildQuestion({ session, question, clientId } = {}) {
    const selection = this.#sessions.get(session); if (!selection) fail('ima_web_session_unproved');
    if (typeof question !== 'string') fail('ima_web_field_invalid');
    const q = buildIMAQuestionBody(ANSWER_PROFILE_CLASSIC, { knowledgeBaseId: session.knowledgeBaseId,
      sessionId: session.sessionId, question, clientId: text(clientId, 128), modelId: selection.modelInfo.model_id, modelType: selection.modelInfo.model_type });
    q.model_info = { ...selection.modelInfo }; q.device_info = { ...this.#device }; return q;
  }
  async *streamAsk({ session, question, clientId = randomUUID(), signal } = {}) {
    const body = this.buildQuestion({ session, question, clientId }); this.#begin();
    const deadline = AbortSignal.timeout(180000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
      combined.throwIfAborted();
      const attempts = this.#attempts.get(session);
      if (attempts.has(clientId) || attempts.size >= 128) fail('ima_web_dispatch_already_attempted');
      attempts.add(clientId); // An uncertain POST must never be silently replayed.
      response = await this.#post(PATHS.qa, body, combined, session.knowledgeBaseId);
      const knowledgeScopeRef = createHash('sha256').update(session.knowledgeBaseId).digest('hex');
      let thinkingAnnounced = false, answerSeen = false, terminalEvent;
      for await (const event of parseIMAWebAgentStream(response, { knowledgeScopeRef, thinkingBlocks: 'phase_only_v1',
        sourceClassifier: (item, context = {}) => classifyIMAKnowledgeAgentSource(item, { expectedKnowledgeScopeRef: knowledgeScopeRef,
          sourceEventName: typeof context === 'string' ? context : context.sourceEventName || context.eventName || '' }).kind })) {
        if (event.type === 'thinking') {
          if (!thinkingAnnounced) { thinkingAnnounced = true; yield { type: 'process', stepId: 'chat:answer', phase: 'answer', status: 'running' }; }
          continue;
        }
        if (event.type === 'done') { terminalEvent = event; continue; }
        if (event.type === 'delta' && event.text) answerSeen = true;
        yield event;
      }
      if (!terminalEvent || !answerSeen) fail('ima_web_answer_missing');
      yield terminalEvent; // All allowed late metadata has been consumed.
    } finally { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); this.#busy = false; }
  }
}

module.exports = { IMAWebProtocolClient, IMAWebContractError, IMA_WEB_PROTOCOL_PATHS: PATHS,
  parseModelCatalog, buildLibraryListRequest, buildLibraryPageRequest, buildMaterialListRequest };
