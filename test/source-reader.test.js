'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { gzipSync } = require('node:zlib');
const { performance } = require('node:perf_hooks');
const network = require('../src/source-reader-network');
const configs = require('../src/source-reader-config');
const { SourceReader, BUDGET } = require('../src/source-reader');
const { extract, bounded, readOriginal } = require('../src/source-reader-extract');
const knowledge = require('../src/knowledge-evidence');
const { fixture, reference, normalize, scope } = require('../scripts/test-fixtures/source-evidence-app.cjs');
const workerPath = path.join(__dirname, '../scripts/test-fixtures/source-reader-worker.cjs');
const configuration = () => ({ schemaVersion: 1, readers: [{ id: 'synthetic-reader', scopeRef: scope, applications: ['agent-a', 'agent-b'],
  clientId: 'synthetic-openapi-client', apiKey: 'synthetic-openapi-key', idNamespace: 'ima_web_media',
  identity: { mode: 'explicit_bindings', bindings: { 'synthetic-media-a': 'synthetic-api-a', 'synthetic-media-b': 'synthetic-api-b' } } }] });
function stream(status, body, headers = {}) {
  const response = new PassThrough(); response.statusCode = status; response.headers = headers;
  queueMicrotask(() => response.end(body)); return response;
}
function transport(handler) {
  const calls = [];
  return { calls, lookup: async () => [{ address: '8.8.8.8', family: 4 }], requestImpl(url, options, cb) {
    calls.push({ url: url.href, ...options });
    const req = new EventEmitter(); req.end = body => cb(handler(url, options, body)); return req;
  } };
}
const json = data => stream(200, JSON.stringify({ code: 0, data }), { 'content-type': 'application/json' });

test('reader configuration is private, opt-in, scope-bound and requires explicit ID policy', t => {
  const config = configs.validate(configuration());
  assert.throws(() => configs.validate({ ...configuration(), pdfEnabled: true }), { code: 'invalid_source_reader_config' });
  assert.equal(configs.materialId(config.readers[0], { idNamespace: 'ima_web_media', materialId: 'synthetic-media-a' }), 'synthetic-api-a');
  assert.equal(configs.materialId(config.readers[0], { idNamespace: 'other', materialId: 'synthetic-media-a' }), '');
  assert.equal(configs.materialId(config.readers[0], { idNamespace: 'ima_web_media', materialId: 'not-bound' }), '');
  const raw = configuration(); raw.readers[0].identity = { mode: 'verified_passthrough' };
  assert.throws(() => configs.validate(raw));
  raw.readers[0].identity.verificationReference = 'synthetic-acceptance-record';
  assert.equal(configs.materialId(configs.validate(raw).readers[0], { idNamespace: 'ima_web_media', materialId: 'native-id' }), 'native-id');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-config-test-')), file = path.join(dir, 'reader.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify(configuration()), { mode: 0o600 });
  assert.equal(configs.fromFile(file).readers.length, 1);
  fs.chmodSync(file, 0o644);
  assert.throws(() => configs.fromFile(file), error => !error.message.includes('synthetic-openapi-key'));
  fs.chmodSync(file, 0o600); fs.symlinkSync(file, path.join(dir, 'linked.json'));
  assert.throws(() => configs.fromFile(path.join(dir, 'linked.json')));
  fs.chmodSync(dir, 0o755); assert.throws(() => configs.fromFile(file));
  const disabled = new SourceReader(); t.after(() => disabled.close());
  assert.equal(disabled.status(scope, 'application:agent-a').readConfigured, false);
  assert.equal(disabled.worker, undefined);
});

test('notes read the exact returned note ID; files use the exact authorized URL without forwarding service credentials', async () => {
  const reader = configuration().readers[0];
  const noteTransport = transport(url => url.pathname.endsWith('get_media_info') ? json({ media_id: 'api-id', notebook_ext_info: { notebook_id: '123456' } }) : json({ content: 'Synthetic note 原文' }));
  const note = await readOriginal(reader, 'api-id', { transport: noteTransport, signal: AbortSignal.timeout(1000) });
  assert.equal(note.text, 'Synthetic note 原文'); assert.equal(note.contentComplete, true);
  assert.equal(noteTransport.calls.length, 2);
  for (const call of noteTransport.calls) {
    assert.equal(new URL(call.url).hostname, 'ima.qq.com'); assert.equal(call.headers['ima-openapi-apikey'], reader.apiKey);
    assert.equal(call.headers.cookie, undefined); assert.equal(call.headers.authorization, undefined);
  }
  const fileTransport = transport(url => url.hostname === 'ima.qq.com'
    ? json({ media_id: 'api-id', url_info: { url: 'https://synthetic.example/doc?signature=PRIVATE-SIGNED-URL', headers: {} } })
    : stream(200, 'Synthetic markdown 中文', { 'content-type': 'text/markdown' }));
  const file = await readOriginal(reader, 'api-id', { transport: fileTransport });
  assert.equal(file.format, 'markdown');
  assert.equal(fileTransport.calls[1].headers['ima-openapi-apikey'], undefined);
  assert.equal(fileTransport.calls[1].headers['ima-openapi-clientid'], undefined);
  assert.doesNotMatch(JSON.stringify(file), /PRIVATE-SIGNED-URL|synthetic-openapi/);
  await assert.rejects(readOriginal(reader, 'expected-id', { transport: transport(() => json({ media_id: 'different-id' })) }), { code: 'source_identity_mismatch' });
  await assert.rejects(readOriginal(reader, 'api-id', { transport: transport(() => json({ notebook_ext_info: { notebook_id: Number.MAX_SAFE_INTEGER + 1 } })) }),
    { code: 'source_upstream_invalid' });
});

test('downloads pin public addresses, reject tailnet/private redirects and do not forward cookies/auth headers', async () => {
  for (const url of ['file:///tmp/private', 'http://127.1/doc', 'https://user:pass@example.org/doc', 'https://site.local/doc', 'https://example.org:8443/doc', 'https://ima.qq.com/doc']) {
    await assert.rejects(network.download(url, {}, { transport: transport(() => assert.fail('must not connect')) }));
  }
  const targets = ['127.0.0.1', '10.0.0.1', '100.100.100.100', '::1', 'fd7a:115c:a1e0::1'];
  for (const address of targets) {
    const fake = transport(() => assert.fail('must not connect')); fake.lookup = async () => [{ address, family: address.includes(':') ? 6 : 4 }];
    await assert.rejects(network.download('https://synthetic.example/doc', {}, { transport: fake }));
    assert.equal(fake.calls.length, 0);
  }
  const rebound = transport(() => assert.fail('must not connect'));
  rebound.lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '192.168.1.1', family: 4 }];
  await assert.rejects(network.download('https://synthetic.example/doc', {}, { transport: rebound }));
  const redirect = transport(() => stream(302, '', { location: 'https://private.example/doc' }));
  redirect.lookup = async host => [{ address: host === 'private.example' ? '100.100.100.100' : '8.8.8.8', family: 4 }];
  await assert.rejects(network.download('https://synthetic.example/doc', {}, { transport: redirect })); assert.equal(redirect.calls.length, 1);
  const follow = transport(url => url.hostname === 'synthetic.example' ? stream(302, '', { location: 'https://other.example/doc' }) : stream(200, 'text', { 'content-type': 'text/plain' }));
  await network.download('https://synthetic.example/doc', { 'x-cos-security-token': 'synthetic-cos' }, { transport: follow });
  assert.equal(follow.calls[0].headers['x-cos-security-token'], 'synthetic-cos'); assert.equal(follow.calls[1].headers['x-cos-security-token'], undefined);
  for (const headers of [{ Cookie: 'PRIVATE' }, { Authorization: 'PRIVATE' }, { 'x-ima-cookie': 'PRIVATE' }])
    await assert.rejects(network.download('https://synthetic.example/doc', headers), { code: 'source_download_headers_unsupported' });
  const apiRedirect = transport(() => stream(302, '', { location: 'https://other.example' }));
  await assert.rejects(network.api(configuration().readers[0], '/openapi/wiki/v1/get_media_info', {}, { transport: apiRedirect }));
  assert.equal(apiRedirect.calls.length, 1);
});

test('streaming byte limits reject unknown-size files and compression expansion, not only Content-Length', async () => {
  const large = Buffer.alloc(network.LIMIT + 1, 65);
  const chunked = transport(() => stream(200, large, { 'content-type': 'text/plain' }));
  await assert.rejects(network.download('https://synthetic.example/doc', {}, { transport: chunked }), { code: 'too_large' });
  const compressed = transport(() => stream(200, gzipSync(large), { 'content-type': 'text/plain', 'content-encoding': 'gzip' }));
  await assert.rejects(network.download('https://synthetic.example/doc', {}, { transport: compressed }), { code: 'too_large' });
  const permission = transport(() => stream(200, JSON.stringify({ code: 110030, msg: 'PRIVATE-ERROR' })));
  await assert.rejects(network.api(configuration().readers[0], '/openapi/wiki/v1/get_media_info', {}, { transport: permission }), error => error.code === 'source_access_denied' && !error.message.includes('PRIVATE'));
});

test('bounded extractors use text only, reject unsupported/binary formats and label partial originals', async () => {
  const html = await extract(Buffer.from('<head><title>Ignore</title></head><body><p>Actual 原文</p><script>PRIVATE script instruction</script></body>'), 'text/html');
  assert.match(html.text, /Actual 原文/); assert.doesNotMatch(html.text, /PRIVATE|Ignore/);
  assert.equal(html.contentComplete, true);
  const partial = bounded('a'.repeat(128001), 'note'); assert.equal(partial.contentComplete, false); assert.equal(partial.extractionTruncated, true);
  for (const [bytes, type] of [[Buffer.from('binary'), 'application/zip'], [Buffer.from('%PDF-1.7'), 'application/pdf'], [Buffer.from([255, 0]), 'text/plain']])
    await assert.rejects(extract(bytes, type));
  const pdf = transport(() => stream(200, require('../scripts/test-fixtures/source-reader-pdf.cjs')(), { 'content-type': 'application/pdf' }));
  await assert.rejects(network.download('https://synthetic.example/file.pdf', {}, { transport: pdf }), { code: 'source_format_unsupported' });
});

test('actual production worker extracts without a browser, reuses one worker and exits when idle', async t => {
  const reader = new SourceReader(undefined, { idleMs: 30 }); t.after(() => reader.close());
  const first = await reader.run({ kind: 'extract', bytes: Buffer.from('原文'), type: 'text/plain' });
  assert.equal(first.text, '原文'); const worker = reader.worker;
  await reader.run({ kind: 'extract', bytes: Buffer.from('<body>text</body>'), type: 'text/html' });
  assert.equal(reader.worker, worker);
  await new Promise(resolve => setTimeout(resolve, 70)); assert.equal(reader.worker, null);
});

test('single worker rejects backlog, enforces deadline, handles crash and cancellation without late results', async t => {
  const reader = new SourceReader(configuration(), { workerPath, timeoutMs: 200 }); t.after(() => reader.close());
  const pending = reader.run({ mediaId: 'synthetic-delay', reader: {} });
  await assert.rejects(reader.run({ mediaId: 'a' }), { code: 'source_reader_busy' });
  const started = performance.now(); await assert.rejects(pending, { code: 'source_read_timeout' });
  assert.ok(performance.now() - started < 600); assert.equal(reader.pending, null);
  await reader.stopping;
  reader.timeoutMs = 1000;
  await assert.rejects(reader.run({ mediaId: 'synthetic-crash' }), { code: 'source_reader_failed' });
  await reader.stopping;
  const aborted = new AbortController(); const work = reader.run({ mediaId: 'synthetic-delay' }, aborted.signal); aborted.abort();
  await assert.rejects(work, { code: 'source_read_cancelled' });
  await reader.stopping;
  assert.equal(reader.snapshots.size, 0);
  const recovered = await reader.run({ mediaId: 'a', reader: {} }); assert.match(recovered.text, /Synthetic original material/);
});

test('HTTP read routes enforce ownership before snapshots; exact citation, immutable pagination and cached revocation work', async t => {
  const reader = new SourceReader(configuration(), { workerPath });
  const f = await fixture(t, { app: { sourceReader: reader } }), taskId = await f.submit();
  const query = { taskId, conversationId: f.conversationId, citationKey: 'index:42' };
  const info = await (await f.request('/internal/provider-a/source-evidence?' + new URLSearchParams(query))).json();
  assert.equal(info.mappingStatus, 'mapped'); assert.deepEqual(info.displayNumbers, ['7']);
  assert.equal(info.materials[0].readState, 'configured_not_read');
  const body = { ...query, sourceRef: info.materials[0].sourceRef };
  const read = (data = body, token, owner) => f.request('/internal/provider-a/source-evidence/read', { method: 'POST', body: JSON.stringify(data) }, token, owner);
  assert.equal((await read({ ...body, url: 'https://example.org' })).status, 400);
  assert.equal((await read(body, 'synthetic-b-service')).status, 404);
  assert.equal((await read(body, undefined, 'other-visitor')).status, 404);
  assert.equal((await read(body, 'synthetic-a')).status, 401);
  assert.equal((await read(body, 'synthetic-legacy-service')).status, 403);
  assert.equal((await read({ ...body, citationKey: 'index:9' })).status, 409);
  assert.equal(reader.worker, undefined);
  const first = await (await read()).json(); assert.equal(first.offset, 0); assert.equal(first.content.length, BUDGET.pageCharacters);
  assert.equal(first.complete, false); assert.equal(first.snapshotAtAnswerTime, false);
  const second = await (await read({ ...body, cursor: first.nextCursor })).json();
  assert.equal(second.readId, first.readId); assert.equal(second.sha256, first.sha256); assert.equal(second.readAt, first.readAt);
  assert.equal(reader.metrics.reads, 1, 'paging never re-reads upstream');
  assert.doesNotMatch(JSON.stringify(first), /synthetic-openapi-key|url_info|download_url|synthetic-api-a/);
  f.config.sourceEvidence.applications = [];
  assert.equal((await read({ ...body, cursor: first.nextCursor })).status, 403);
  f.config.sourceEvidence.applications = ['agent-a']; reader.config.readers[0].apiKey = 'rotated-synthetic-key';
  assert.equal((await read({ ...body, cursor: first.nextCursor })).status, 410);
  assert.equal(f.calls(), 1);
});

test('unknown/missing material identity and disabled readers never access an original', async t => {
  const f = await fixture(t, { stream: async function* () {
    yield normalize({ eventName: 'CONTEXT_REFERENCES', data: { 0: [{ media_id: 'synthetic-media-a' }] } });
    yield { type: 'delta', text: 'Answer[22](@context-ref?id=0)' }; yield { type: 'done' };
  } });
  const taskId = await f.submit(), query = { taskId, conversationId: f.conversationId, citationKey: 'context:0' };
  const info = await (await f.request('/internal/provider-a/source-evidence?' + new URLSearchParams(query))).json();
  assert.equal(info.mappingStatus, 'unproved_source_type'); assert.equal(info.readConfigured, false);
  const response = await f.request('/internal/provider-a/source-evidence/read', { method: 'POST', body: JSON.stringify({ ...query, sourceRef: info.materials[0].sourceRef }) });
  assert.equal(response.status, 409); assert.equal(f.app.locals.sourceReader.worker, undefined);
});

test('request floods never form a worker backlog and retained snapshots stay bounded', async t => {
  let now = Date.now();
  const reader = new SourceReader(configuration(), { workerPath, now: () => now });
  const f = await fixture(t, { app: { sourceReader: reader } }), taskId = await f.submit();
  const query = { taskId, conversationId: f.conversationId, citationKey: 'index:42', sourceRef: knowledge.sourceRef(scope, 'ima_web_media', 'synthetic-media-a') };
  const statuses = await Promise.all(Array.from({ length: 80 }, async () => {
    const response = await f.request('/internal/provider-a/source-evidence/read', { method: 'POST', body: JSON.stringify(query) });
    await response.arrayBuffer(); return response.status;
  }));
  assert.ok(statuses.every(status => status === 200 || status === 429));
  assert.ok(statuses.includes(429)); assert.equal(reader.pending, null); assert.ok(reader.metrics.reads < 10);
  const context = { ...query, scopeRef: scope, owner: 'synthetic-owner', applicationKey: 'application:agent-a',
    material: { idNamespace: 'ima_web_media', materialId: 'synthetic-media-a' } };
  now += 60000;
  const first = await reader.read(context);
  for (let n = 0; n < BUDGET.snapshots; n++) { now += 10000; await reader.read(context); }
  assert.ok(reader.snapshots.size <= BUDGET.snapshots); assert.ok(reader.cacheBytes <= BUDGET.cacheBytes);
  await assert.rejects(reader.read(context, { cursor: first.nextCursor }), { code: 'source_read_expired' });
  reader.prune(now + BUDGET.retentionMs + 1); assert.equal(reader.snapshots.size, 0);
});

test('all applications share the rolling new-original budget; paging does not consume it', async t => {
  const reader = new SourceReader(configuration(), { workerPath }); t.after(() => reader.close());
  const context = { scopeRef: scope, owner: 'owner', applicationKey: 'application:agent-a', taskId: 'task', citationKey: 'index:42',
    sourceRef: knowledge.sourceRef(scope, 'ima_web_media', 'synthetic-media-a'), material: { idNamespace: 'ima_web_media', materialId: 'synthetic-media-a' } };
  const first = await reader.read(context);
  for (let n = 1; n < BUDGET.newReadsPerMinute; n++) await reader.read(context);
  await assert.rejects(reader.read({ ...context, owner: 'other', applicationKey: 'application:agent-b' }), { code: 'source_read_rate_limited' });
  assert.ok((await reader.read(context, { cursor: first.nextCursor })).content.length > 0);
});

test('a stalled original read cannot block Provider health or an independent synthetic answer stream', async t => {
  const config = configuration(); config.readers[0].identity.bindings['synthetic-media-a'] = 'synthetic-delay';
  const reader = new SourceReader(config, { workerPath, timeoutMs: 700 });
  const f = await fixture(t, { app: { sourceReader: reader }, stream: async function* () {
    yield normalize(reference('42', { type: 2, media_id: 'synthetic-media-a' }));
    for (let n = 0; n < 5; n++) { yield { type: 'delta', text: 'Synthetic delta ' + n + '[7](@index-ref?id=42)' }; await new Promise(resolve => setTimeout(resolve, 12)); }
    yield { type: 'done' };
  } });
  const taskId = await f.submit(), query = { taskId, conversationId: f.conversationId, citationKey: 'index:42',
    sourceRef: knowledge.sourceRef(scope, 'ima_web_media', 'synthetic-media-a') };
  const reading = f.request('/internal/provider-a/source-evidence/read', { method: 'POST', body: JSON.stringify(query) });
  for (let n = 0; n < 100 && !reader.pending; n++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(reader.pending);
  const health = [];
  for (let n = 0; n < 10; n++) { const start = performance.now(); await (await f.request('/healthz')).text(); health.push(performance.now() - start); }
  assert.ok(Math.max(...health) < 250);
  const created = await (await f.request('/internal/provider-a/tasks', { method: 'POST', headers: { 'Idempotency-Key': 'independent-synthetic-stream' },
    body: JSON.stringify({ conversationId: f.conversationId, question: 'Second synthetic question', retrieval_policy: 'knowledge_agent', knowledge_scope_ref: scope }) })).json();
  const replay = await (await f.request('/internal/provider-a/tasks/' + created.task.id + '/events')).text();
  assert.match(replay, /event: delta/); assert.equal((replay.match(/event: done/g) || []).length, 1);
  assert.equal((await reading).status, 504); assert.equal(reader.snapshots.size, 0);
  assert.equal(f.calls(), 2, 'only the two deliberately synthetic asks');
});
