'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/ima-web-native/wire.json');
const { IMAWebProtocolClient, IMA_WEB_PROTOCOL_PATHS: paths, parseModelCatalog,
  buildLibraryListRequest, buildLibraryPageRequest, buildMaterialListRequest } = require('../src/ima-web-protocol-client');
const headers = { 'x-ima-cookie': 'synthetic-cookie', 'x-ima-bkn': 'synthetic-bkn', extension_version: '5.11.2' };
const deviceInfo = fixture.qa.quick.request.device_info;
const clone = v => structuredClone(v);
const stream = () => new Response('event: MESSAGE\ndata: {"Text":"Scrubbed answer"}\n\nevent: COMPLETED\ndata: {"Code":0}\n\n', { headers: { 'content-type': 'text/event-stream' } });
function client(fetchImpl, options = {}) { return new IMAWebProtocolClient({ headers, deviceInfo, fetchImpl, ...options }); }
function backend({ calls = [], response } = {}) {
  return async (url, options) => {
    const path = new URL(url).pathname, body = JSON.parse(options.body); calls.push({ path, body, options });
    if (response) { const r = await response(path, body, options); if (r) return r; }
    if (path === paths.models) return Response.json(fixture.models.response);
    if (path === paths.libraries) return Response.json(fixture.libraryList.response);
    if (path === paths.libraryPage) return Response.json(fixture.libraryPage.response);
    if (path === paths.materials) return Response.json(fixture.materials.response);
    if (path === paths.session) return Response.json({ code: 0, session_id: 'SCRUBBED_SESSION_ID',
      session_info: { id: 'SCRUBBED_SESSION_ID', knowledge_base_info_with_folder: { knowledge_base_id: body.relatedUrl } } });
    if (path === paths.qa) return stream();
    throw Error('Unexpected request');
  };
}

test('native read builders match independently scrubbed browser requests', () => {
  assert.deepEqual(buildLibraryListRequest([1002]), fixture.libraryList.request);
  assert.deepEqual(buildLibraryPageRequest({ knowledgeBaseId: 'SCRUBBED_KB', version: 'SCRUBBED_VERSION' }), fixture.libraryPage.request);
  assert.deepEqual(buildMaterialListRequest({ knowledgeBaseId: 'SCRUBBED_KB', folderId: 'SCRUBBED_FOLDER' }), fixture.materials.request);
  for (const invalid of [[1002, 1002], [9999], [{ type: 1002, limit: 0 }], [{ type: 1002, limit: 51 }]]) assert.throws(() => buildLibraryListRequest(invalid));
});
test('model identities and quick/deep wire fields survive catalog reordering', async () => {
  const catalog = parseModelCatalog(fixture.models.response), reversed = clone(fixture.models.response); reversed.models.reverse();
  const after = parseModelCatalog(reversed);
  assert.equal(catalog.models[0].modelRef, after.models.at(-1).modelRef);
  for (const mode of ['quick', 'deep']) {
    const c = client(backend()), seen = await c.getModels();
    const session = await c.createKnowledgeSession({ knowledgeBaseId: 'SCRUBBED_KB', modelRef: seen.models[0].modelRef, mode });
    assert.deepEqual(c.buildQuestion({ session, question: 'Scrubbed question', clientId: 'SCRUBBED_CLIENT_ID' }), fixture.qa[mode].request);
  }
});
test('advertised models beyond the legacy range require an exact returned model reference', async () => {
  const c = client(backend()), catalog = await c.getModels();
  const advertised = catalog.models.find(m => m.base.model_type === 1001);
  assert.equal(c.selectModel({ modelRef: advertised.modelRef, mode: 'quick' }).modelInfo.model_type, 1001);
  assert.throws(() => c.selectModel({ modelType: 1001, mode: 'quick' }), { code: 'ima_web_model_unavailable' });
  assert.ok(Object.isFrozen(catalog.models[0].modes.quick));
});
test('invalid or conflicted catalogs cannot authorize mode selection; stale receipts block new sessions', async () => {
  for (const mutate of [x => x.models[0].sub_model_types['0'] = 99, x => x.models[0].sub_model_infos = {},
    x => x.models[0].model_type = '3', x => x.models.push(clone(x.models[0]))]) {
    const changed = clone(fixture.models.response); mutate(changed); assert.throws(() => parseModelCatalog(changed));
  }
  let now = 0; const c = client(backend(), { now: () => now }), catalog = await c.getModels(); now = 300001;
  assert.throws(() => c.selectModel({ modelRef: catalog.models[0].modelRef, mode: 'quick' }), { code: 'ima_web_models_stale' });
});
test('library and material reads preserve explicit scope/cursors and omit download or private fields', async () => {
  const calls = [], payload = clone(fixture.materials.response);
  payload.knowledge_list[0].raw_file_url = 'https://example.invalid/private'; payload.knowledge_list[0].password = 'synthetic-private';
  const c = client(backend({ calls, response: path => path === paths.materials ? Response.json(payload) : null }));
  assert.equal((await c.listKnowledgeBases({ groups: [1002] })).groups[0].libraries[0].id, 'SCRUBBED_KB');
  assert.equal((await c.getLibraryPage({ knowledgeBaseId: 'SCRUBBED_KB' })).library.id, 'SCRUBBED_KB');
  const result = await c.listMaterials({ knowledgeBaseId: 'SCRUBBED_KB', folderId: 'SCRUBBED_FOLDER', cursor: 'SCRUBBED_CURSOR', version: 'SCRUBBED_VERSION' });
  assert.equal(result.nextCursor, 'SCRUBBED_CURSOR_NEXT');
  assert.equal(calls.at(-1).body.cursor, 'SCRUBBED_CURSOR');
  assert.doesNotMatch(JSON.stringify(result), /raw_file_url|password|synthetic-private|example.invalid/);
  assert.ok(calls.every(x => x.options.redirect === 'error'));
});
test('wrong library/folder identities and incomplete pagination are rejected', async () => {
  for (const mutate of [x => x.knowledge_base_info.id = 'SCRUBBED_OTHER', x => x.current_path.at(-1).folder_id = 'SCRUBBED_OTHER',
    x => { x.is_end = false; x.next_cursor = ''; }]) {
    const payload = clone(fixture.materials.response); mutate(payload);
    const c = client(backend({ response: p => p === paths.materials ? Response.json(payload) : null }));
    await assert.rejects(c.listMaterials({ knowledgeBaseId: 'SCRUBBED_KB', folderId: 'SCRUBBED_FOLDER' }));
  }
});
test('streaming uses a server-bound session and pinned model; forged leases and repeated dispatch are refused', async () => {
  const calls = [], c = client(backend({ calls })), catalog = await c.getModels();
  const session = await c.createKnowledgeSession({ knowledgeBaseId: 'SCRUBBED_KB', modelRef: catalog.models[0].modelRef, mode: 'deep' });
  assert.throws(() => c.buildQuestion({ session: { ...session }, question: 'Scrubbed question', clientId: 'SCRUBBED_CLIENT' }), { code: 'ima_web_session_unproved' });
  const events = []; for await (const e of c.streamAsk({ session, question: 'Scrubbed question', clientId: 'SCRUBBED_CLIENT' })) events.push(e);
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(calls.at(-1).body.model_info.model_type, 1);
  await assert.rejects(async () => { for await (const _ of c.streamAsk({ session, question: 'Scrubbed question', clientId: 'SCRUBBED_CLIENT' })) {} }, { code: 'ima_web_dispatch_already_attempted' });
  assert.equal(calls.filter(x => x.path === paths.qa).length, 1);
});
test('opaque device context preserves JSON control bytes without weakening header validation', async () => {
  const opaque = { ...deviceInfo, uskey: 'SCRUBBED_\u0001\u0000\n_DEVICE' };
  const c = client(backend(), { deviceInfo: opaque }), catalog = await c.getModels();
  const session = await c.createKnowledgeSession({ knowledgeBaseId: 'SCRUBBED_KB', modelRef: catalog.models[0].modelRef, mode: 'quick' });
  const body = c.buildQuestion({ session, question: 'Scrubbed question', clientId: 'SCRUBBED_CLIENT' });
  assert.equal(JSON.parse(JSON.stringify(body)).device_info.uskey, opaque.uskey);
  assert.throws(() => client(backend(), { headers: { ...headers, 'x-ima-cookie': 'synthetic\nheader' } }));
});
test('transport failures do not replay QA or leak upstream text; client serialization excludes authentication', async () => {
  const calls = [], c = client(backend({ calls, response: p => p === paths.qa ? Promise.reject(Error('synthetic-private')) : null }));
  const catalog = await c.getModels(), session = await c.createKnowledgeSession({ knowledgeBaseId: 'SCRUBBED_KB', modelRef: catalog.models[0].modelRef, mode: 'quick' });
  await assert.rejects(async () => { for await (const _ of c.streamAsk({ session, question: 'Scrubbed question', clientId: 'SCRUBBED_CLIENT' })) {} }, { code: 'ima_web_transport_failed' });
  await assert.rejects(async () => { for await (const _ of c.streamAsk({ session, question: 'Scrubbed question', clientId: 'SCRUBBED_CLIENT' })) {} }, { code: 'ima_web_dispatch_already_attempted' });
  assert.equal(calls.filter(x => x.path === paths.qa).length, 1); assert.equal(JSON.stringify(c), '{}');
});
test('concurrent requests have no queue, malformed/oversize responses release the client, and abort stays distinct from login', async () => {
  let release; const delayed = new Promise(r => { release = r; });
  const c = client(async () => { await delayed; return Response.json(fixture.models.response); });
  const pending = c.getModels(); await assert.rejects(c.getModels(), { code: 'ima_web_client_busy' }); release(); await pending;
  for (const [response, code] of [[() => new Response('x'.repeat(2 * 1024 * 1024 + 1)), 'ima_web_response_too_large'],
    [() => new Response(new Uint8Array([0xff])), 'ima_web_response_invalid'],
    [() => new Response('synthetic-private', { status: 403 }), 'ima_web_auth_denied']]) {
    let fail = true; const x = client(() => fail ? response() : Response.json(fixture.models.response));
    await assert.rejects(x.getModels(), { code }); fail = false; assert.equal((await x.getModels()).models.length, 4);
  }
  const controller = new AbortController(); controller.abort();
  const x = client(async (_, options) => { options.signal.throwIfAborted(); });
  await assert.rejects(x.getModels({ signal: controller.signal }), { code: 'ima_web_request_interrupted' });
});
