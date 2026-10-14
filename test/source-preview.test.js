const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, stat, writeFile, readFile, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { gzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const network = require('../src/source-preview-network');
const { PreviewCache, BUDGET } = require('../src/source-preview-worker');
const { SourcePreview } = require('../src/source-preview');
const { resolveSource, registerSourcePreviewRoutes } = require('../src/source-preview-routes');
const chat = require('../src/chat-presentation');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=', 'base64');
const key = x => createHash('sha256').update(x).digest('hex');
async function directory(t) { const dir = await mkdtemp(path.join(tmpdir(), 'source-preview-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('rejects local, tailnet, reserved, mapped and transition addresses; pins DNS before HTTP', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.2', '100.100.100.100', '192.168.1.1', '169.254.169.254', '198.18.0.1', '203.0.113.5', '224.0.0.1', '::1', '::ffff:0808:0808', 'fd7a:115c:a1e0::1', '2001:db8::1', '2002:0808:0808::1']) assert.equal(network.publicIp(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(network.publicIp(ip), true, ip);
  for (const url of ['http://127.1/a', 'http://2130706433', 'http://[::1]', 'https://site.local/x', 'https://example.com:8443', 'https://a:b@example.com', 'https://example.com?token=secret', 'https://ima.qq.com/file', 'file:///etc/passwd']) assert.throws(() => network.publicUrl(url));
  let calls = 0;
  await assert.rejects(network.requestPublic('https://public.example', { permit: async () => { calls++; return true; }, lookup: async () => [{ address: '127.0.0.1', family: 4 }] }));
  assert.equal(calls, 0);
  await assert.rejects(network.pinnedAddress(new URL('https://public.example'), async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]));
});
test('head parsing selects declared share image only; ignores body images, scripts and unsafe URLs', () => {
  const head = html => network.coverFromHead(Buffer.from(html), 'https://example.com/page');
  assert.equal(head('<head><meta property="og:image" content="/cover.png"><script>fetch("/secret")</script></head><body><img src="/other.png">'), 'https://example.com/cover.png');
  assert.equal(head('<head></head><body><meta property="og:image" content="/body.png">'), '');
  assert.equal(head('<head><meta property="og:image" content="http://127.0.0.1/x"><meta name="twitter:image" content="/safe.png"></head>'), 'https://example.com/safe.png');
  assert.equal(network.imageType(image), 'image/png');
  assert.equal(network.imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), '');
  const bomb = Buffer.from(image); bomb.writeUInt32BE(0x7fffffff, 16); assert.equal(network.imageType(bomb), '');
});
test('bounded decoded reads stop at head and reject compressed inflation', async () => {
  const input = new PassThrough(); input.headers = { 'content-type': 'text/html', 'content-length': 9999999 };
  const reading = network.readBody(input, 256 * 1024, true);
  input.write('<head><meta property="og:image" content="/x.png"></head>');
  assert.match((await reading).toString(), /og:image/); assert.equal(input.destroyed, true);
  const compressed = new PassThrough(); compressed.headers = { 'content-encoding': 'gzip' };
  const inflated = network.readBody(compressed, 1024, false); compressed.end(gzipSync(Buffer.alloc(2048, 65)));
  await assert.rejects(inflated, /too_large/);
});
test('each redirect/image is revalidated; connections use the pinned IP and anonymous headers', async () => {
  const seen = []; let permits = 0;
  const response = (status, headers, body = '') => { const stream = new PassThrough(); stream.statusCode = status; stream.headers = headers; queueMicrotask(() => stream.end(body)); return stream; };
  const options = { signal: AbortSignal.timeout(1000), permit: async () => { permits++; return true; },
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl(url, init, callback) {
      seen.push({ url: url.href, headers: init.headers });
      init.lookup('ignored-host', { all: true }, (_error, addresses) => assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]));
      const req = new EventEmitter(); req.end = () => callback(url.pathname === '/start'
        ? response(302, { location: '/page' })
        : url.pathname === '/page' ? response(200, { 'content-type': 'text/html' }, '<head><meta property="og:image" content="/image.png"></head>')
          : response(200, { 'content-type': 'image/png' }, image)); return req;
    } };
  const result = await network.fetchCover('https://example.org/start', options);
  assert.equal(result.type, 'image/png'); assert.equal(permits, 3);
  for (const item of seen) { assert.equal(item.headers.Cookie, undefined); assert.equal(item.headers.Authorization, undefined); assert.equal(item.headers.Referer, undefined); }
  let contacts = 0;
  await assert.rejects(network.requestPublic('https://example.org', { ...options,
    requestImpl(_url, _init, cb) { contacts++; const req = new EventEmitter(); req.end = () => cb(response(302, { location: 'http://127.0.0.1/admin' })); return req; } }));
  assert.equal(contacts, 1);
  await assert.rejects(network.fetchCover('https://example.org', { ...options,
    requestImpl(_url, _init, cb) { contacts++; const req = new EventEmitter(); req.end = () => cb(response(200, { 'content-type': 'text/html' }, '<head><meta property="og:image" content="http://100.100.100.100/secret"></head>')); return req; } }));
  assert.equal(contacts, 2);
});
test('cache is private, validates bytes, survives reload, expires and evicts within budget', async t => {
  const dir = await directory(t), cache = new PreviewCache(dir, { ...BUDGET, entries: 2, bytes: 4096 });
  const now = Date.now();
  await cache.put(key('a'), { bytes: image, type: 'image/png' }, now + 10);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dir, `${key('a')}.img`))).mode & 0o777, 0o600);
  assert.equal((await cache.image(key('a'), now + 11)).type, 'image/png');
  await cache.put(key('b'), null, now + 20); await cache.lookup(key('a'), now + 30);
  await cache.put(key('c'), null, now + 40); assert.equal(await cache.lookup(key('b'), now + 41), null);
  const reloaded = new PreviewCache(dir); assert.equal((await reloaded.lookup(key('a'), now + 42))?.status, 'ready');
  await writeFile(path.join(dir, `${key('a')}.img`), 'corrupt'); assert.equal(await reloaded.image(key('a'), now + 42), null);
  assert.equal(await cache.lookup(key('c'), now + 40 + BUDGET.failureTtl), null);
});
test('default disabled has no worker; cold URLs are single-flight with global rolling budgets and no queue', async t => {
  const dir = await directory(t);
  const off = new SourcePreview({ directory: dir }); assert.equal((await off.preview('https://example.com')).reason, 'disabled'); assert.equal(off.worker, null);
  let now = Date.now(), busy = false;
  const preview = new SourcePreview({ enabled: true, directory: dir, now: () => now, busy: () => busy,
    workerFile: path.join(__dirname, '../test-support/source-preview-worker.cjs'), idleMs: 50 });
  t.after(() => preview.close());
  const same = await Promise.all(Array.from({ length: 10 }, () => preview.preview('https://example.org/one')));
  assert.ok(same.every(r => r.status === 'ready')); assert.equal(preview.metrics.jobs, 1); assert.equal(preview.metrics.http, 2);
  await preview.preview('https://example.org/one'); assert.equal(preview.metrics.http, 2);
  busy = true; assert.equal((await preview.preview('https://example.org/two')).reason, 'busy');
  assert.equal((await preview.preview('https://example.org/one')).status, 'ready'); busy = false;
  await writeFile(path.join(dir, 'disabled'), ''); assert.equal((await preview.preview('https://example.org/two')).reason, 'busy'); await rm(path.join(dir, 'disabled'));
  for (let i = 2; i <= 6; i++) assert.equal((await preview.preview(`https://example.org/${i}`)).status, 'ready');
  assert.equal(preview.metrics.http, 12); assert.equal((await preview.preview('https://example.org/seven')).reason, 'busy');
  now += 60001; assert.equal((await preview.preview('https://example.org/seven')).status, 'ready');
  const flood = await Promise.all(Array.from({ length: 20 }, (_, i) => preview.preview(`https://example.org/flood-${i}`)));
  assert.ok(flood.filter(r => r.status === 'ready').length <= 1); assert.ok(preview.urls.length <= 6); assert.ok(preview.requests.length <= 12); assert.equal(preview.active, null);
  assert.equal((await preview.image('https://example.org/one')).type, 'image/png');
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(preview.worker, null);
  await preview.close();
});
test('timeout and client cancellation shed work without stopping QA or making failure cache entries', async t => {
  const dir = await directory(t), preview = new SourcePreview({ enabled: true, directory: dir,
    workerFile: path.join(__dirname, '../test-support/source-preview-worker.cjs') }); t.after(() => preview.close());
  const controller = new AbortController(), attempt = preview.preview('https://example.org/slow', controller.signal);
  setTimeout(() => controller.abort(), 100);
  assert.equal((await attempt).reason, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(preview.active, null);
  assert.equal((await preview.preview('https://example.org/good')).status, 'ready');
  const start = performance.now(); assert.equal((await preview.preview('https://example.org/slow')).status, 'text_only');
  assert.ok(performance.now() - start < 3300);
  await preview.close();
});
test('source resolution checks task scope/application and owner, uses exact keys, and supports expired task history', () => {
  const url = 'https://example.org/a', turn = { taskId: 'task-a', citationMap: { 'index:42': { type: 'web', sources: [{ url }] }, 'index:5': { type: 'knowledge' } } };
  const conversations = { require(id, owner) { if (id !== 'conv-a' || owner !== 'alice') throw Error(); return { turns: [turn] }; } };
  const query = { conversationId: 'conv-a', taskId: 'task-a', citationKey: 'index:42', sourceId: chat.sourceId(url) };
  const options = { conversations, owner: 'alice', scope: 'ordinary', applicationKey: 'app', query };
  assert.equal(resolveSource(options), url);
  for (const change of [{ owner: 'bob' }, { query: { ...query, citationKey: 'index:7' } }, { query: { ...query, citationKey: 'index:5' } }, { query: { ...query, url } }]) assert.throws(() => resolveSource({ ...options, ...change }));
  const tasks = { store: { tasks: new Map([['task-a', {}]]), owned() { throw Error('wrong scope'); } } };
  assert.throws(() => resolveSource({ ...options, tasks }));
  const projected = chat.projectData('sources', { citationMap: turn.citationMap });
  assert.equal(projected.citationMap['index:42'].sources[0].sourceId, query.sourceId);
  assert.equal(chat.metadata(turn).citationMap['index:42'].sources[0].sourceId, undefined, 'raw metadata unchanged');
});
test('worker startup failure falls back, can recover on a later request and never inherits service environment', async t => {
  const dir = await directory(t), workerFile = path.join(dir, 'isolated.cjs');
  const preview = new SourcePreview({ enabled: true, directory: dir, workerFile: path.join(dir, 'missing.cjs') });
  t.after(() => preview.close());
  assert.equal((await preview.preview('https://example.org/a')).status, 'text_only'); assert.ok(preview.metrics.errors >= 1);
  await writeFile(workerFile, "const {parentPort}=require('node:worker_threads');parentPort.on('message',m=>parentPort.postMessage({id:m.id,result:{envKeys:Object.keys(process.env)}}));");
  preview.workerFile = workerFile;
  assert.deepEqual((await preview.workerRpc('lookup', { key: key('a') })).envKeys, []);
  await preview.close();
});
test('preview HTTP routes authorize before cache reads and serve only bounded image responses', async t => {
  const express = require('express'), app = express(); let reads = 0;
  const url = 'https://example.org/a';
  const conversations = { require(id, owner) { if (id !== 'conv' || owner !== 'alice') throw Error(); return { turns: [{ taskId: 'task', citationMap: { 'index:42': { type: 'web', sources: [{ url }] } } }] }; } };
  const auth = (req, res, next) => { req.applicationKey = 'app'; next(); };
  registerSourcePreviewRoutes(app, { config: {}, conversations, ordinaryAuth: auth, internalAuth: auth, getConversationOwnerKey: req => req.get('x-owner'),
    preview: { async preview() { reads++; return { status: 'ready' }; }, async image() { reads++; return { type: 'image/png', bytes: image }; } } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/source-preview`, params = new URLSearchParams({ conversationId: 'conv', taskId: 'task', citationKey: 'index:42', sourceId: chat.sourceId(url) });
  const denied = await fetch(`${base}?${params}`, { headers: { 'x-owner': 'bob' } }); assert.equal(denied.status, 404); assert.equal(reads, 0);
  const meta = await fetch(`${base}?${params}`, { headers: { 'x-owner': 'alice' } }); assert.equal((await meta.json()).imageKind, 'cover');
  const png = await fetch(`${base}/image?${params}`, { headers: { 'x-owner': 'alice' } }); assert.equal(png.headers.get('content-type'), 'image/png'); assert.equal((await png.arrayBuffer()).byteLength, image.length); assert.equal(png.headers.get('cache-control'), 'no-store');
});
