'use strict';

// Anonymous, pinned public HTTP only. Never use the account/browser transport.
const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const zlib = require('node:zlib');
const { parse } = require('parse5');
const { webUrl } = require('./chat-presentation');

const LIMITS = Object.freeze({ html: 256 * 1024, image: 512 * 1024, timeout: 3000, redirects: 2 });
const failure = code => Object.assign(new Error(code), { code });
function publicIp(address) {
  if (net.isIP(address) === 4) {
    const n = address.split('.').reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0);
    return ![
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 3],
    ].some(([ip, bits]) => {
      const base = ip.split('.').reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0);
      return (n >>> (32 - bits)) === (base >>> (32 - bits));
    });
  }
  if (net.isIP(address) !== 6 || address.includes('%') || address.includes('.')) return false;
  // Only global unicast; also reject transition, documentation and special ranges.
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (words.length !== 8) return false;
  const a = parseInt(words[0], 16), b = parseInt(words[1], 16);
  return a >= 0x2000 && a < 0x4000 && a !== 0x2002 && a !== 0x3fff
    && !(a === 0x2001 && (b <= 0x01ff || b === 0x0db8));
}
function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || !webUrl(value)) throw failure('unsafe_url');
  const url = new URL(value); url.hash = '';
  const host = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
  if (!host || [...url.searchParams.keys()].some(key => /session|ticket|auth|access[_-]?key|^sig$|^key$/iu.test(key))
    || /(^|\.)(localhost|local|internal|home|lan)$/u.test(host)
    || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80'))
    || (net.isIP(host) && !publicIp(host))) throw failure('unsafe_url');
  return url;
}
async function resolveAddresses(host, { signal } = {}) {
  const resolver = new dns.Resolver({ timeout: 1000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    signal?.throwIfAborted();
    if (results.some(r => r.status === 'rejected' && !['ENODATA', 'ENOTFOUND'].includes(r.reason.code))) throw failure('dns_unavailable');
    return results.flatMap((r, i) => r.status === 'fulfilled' ? r.value.map(address => ({ address, family: i ? 6 : 4 })) : []);
  } finally { signal?.removeEventListener('abort', cancel); }
}
async function pinnedAddress(url, lookup = resolveAddresses, signal) {
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  const entries = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true, verbatim: true, signal });
  if (!entries.length || entries.length > 64 || entries.some(entry => !publicIp(entry.address))) throw failure('unsafe_address');
  return entries[0];
}
function imageType(buffer) {
  if (buffer.length >= 45 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && buffer.readUInt32BE(8) === 13 && buffer.toString('ascii', 12, 16) === 'IHDR'
    && buffer.toString('ascii', buffer.length - 8, buffer.length - 4) === 'IEND') {
    const w = buffer.readUInt32BE(16), h = buffer.readUInt32BE(20);
    return w > 0 && h > 0 && w <= 8192 && h <= 8192 && w * h <= 32_000_000 ? 'image/png' : '';
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'
    && buffer.readUInt32LE(4) + 8 === buffer.length) {
    const kind = buffer.toString('ascii', 12, 16); let w = 0, h = 0;
    if (kind === 'VP8X' && buffer.length >= 30) { w = 1 + buffer.readUIntLE(24, 3); h = 1 + buffer.readUIntLE(27, 3); }
    if (kind === 'VP8 ' && buffer.length >= 30 && buffer.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) { w = buffer.readUInt16LE(26) & 16383; h = buffer.readUInt16LE(28) & 16383; }
    if (kind === 'VP8L' && buffer.length >= 25 && buffer[20] === 47) { const n = buffer.readUInt32LE(21); w = (n & 16383) + 1; h = ((n >>> 14) & 16383) + 1; }
    return w && h && w <= 8192 && h <= 8192 && w * h <= 32_000_000 ? 'image/webp' : '';
  }
  if (buffer[0] === 255 && buffer[1] === 216 && buffer.at(-2) === 255 && buffer.at(-1) === 217) {
    let p = 2;
    while (p + 4 < buffer.length) {
      if (buffer[p++] !== 255) return '';
      while (buffer[p] === 255) p++;
      const tag = buffer[p++];
      if (tag === 217 || tag === 218) break;
      const length = buffer.readUInt16BE(p);
      if (length < 2 || p + length > buffer.length) return '';
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(tag) && length >= 8) {
        const h = buffer.readUInt16BE(p + 3), w = buffer.readUInt16BE(p + 5);
        return w && h && w <= 8192 && h <= 8192 && w * h <= 32_000_000 ? 'image/jpeg' : '';
      }
      p += length;
    }
  }
  return '';
}
function readBody(response, limit, head, signal) {
  return new Promise((resolve, reject) => {
    let wire = 0, decoded = 0, done = false;
    const chunks = [];
    const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
    const decoder = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'br' ? zlib.createBrotliDecompress()
      : encoding === 'deflate' ? zlib.createInflate() : encoding === 'identity' ? response : null;
    const finish = (error, bytes) => {
      if (done) return; done = true;
      signal?.removeEventListener('abort', abort);
      if (decoder !== response) decoder?.destroy(); response.destroy();
      if (error) reject(error); else resolve(bytes);
    };
    const abort = () => finish(failure('cancelled'));
    if (!decoder) { finish(failure('unsupported_encoding')); return; }
    if (!head && Number(response.headers['content-length']) > limit) { finish(failure('too_large')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    response.on('error', error => finish(error));
    response.on('aborted', () => finish(failure('truncated')));
    response.on('data', chunk => { wire += chunk.length; if (wire > limit) finish(failure('too_large')); });
    decoder.on('error', error => finish(error));
    decoder.on('data', chunk => {
      if (done) return;
      decoded += chunk.length;
      if (decoded > limit) { finish(failure('too_large')); return; }
      chunks.push(chunk);
      if (head) {
        const bytes = Buffer.concat(chunks);
        const match = /<\/head\s*>|<body(?:\s|>)/iu.exec(bytes.toString('utf8'));
        if (match) finish(null, bytes.subarray(0, Buffer.byteLength(bytes.toString('utf8').slice(0, match.index + match[0].length))));
      }
    });
    decoder.on('end', () => finish(null, Buffer.concat(chunks)));
    if (decoder !== response) response.pipe(decoder);
    if (signal?.aborted) abort();
  });
}
async function requestPublic(value, { signal, permit, image = false, lookup = resolveAddresses,
  requestImpl = (url, options, cb) => (url.protocol === 'https:' ? https : http).request(url, options, cb) } = {}) {
  let url = publicUrl(value);
  for (let redirects = 0; ; redirects++) {
    signal?.throwIfAborted();
    const address = await pinnedAddress(url, lookup, signal); signal?.throwIfAborted();
    if (!await permit()) throw failure('budget');
    const response = await new Promise((resolve, reject) => {
      const req = requestImpl(url, {
        method: 'GET', agent: false, signal, maxHeaderSize: 16 * 1024,
        lookup(_host, options, callback) { callback(null, options.all ? [address] : address.address, address.family); },
        family: address.family,
        headers: { Accept: image ? 'image/png,image/jpeg,image/webp' : 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'gzip,deflate,br', 'User-Agent': 'ProviderA-SourcePreview/1.0' },
      }, resolve);
      req.once('socket', socket => socket.once('connect', () => {
        if (!publicIp(socket.remoteAddress)) req.destroy(failure('unsafe_address'));
      }));
      req.once('error', reject); req.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (redirects >= LIMITS.redirects || !response.headers.location) throw failure('redirect_limit');
      const next = publicUrl(new URL(response.headers.location, url).href);
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw failure('unsafe_redirect');
      url = next; continue;
    }
    if (response.statusCode !== 200) { response.destroy(); throw failure('http_error'); }
    const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!(image ? ['image/png', 'image/jpeg', 'image/webp'] : ['text/html', 'application/xhtml+xml']).includes(type)) {
      response.destroy(); throw failure('invalid_type');
    }
    const bytes = await readBody(response, image ? LIMITS.image : LIMITS.html, !image, signal);
    if (image && imageType(bytes) !== type) throw failure('invalid_image');
    return { bytes, type, url: url.href };
  }
}
function coverFromHead(bytes, pageUrl) {
  const document = parse(bytes.toString('utf8'));
  const html = document.childNodes.find(n => n.tagName === 'html');
  const head = html?.childNodes.find(n => n.tagName === 'head');
  const values = new Map();
  for (const node of head?.childNodes || []) {
    if (node.tagName !== 'meta') continue;
    const attrs = Object.fromEntries(node.attrs.map(a => [a.name, a.value]));
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].includes(key) && attrs.content && !values.has(key)) values.set(key, attrs.content);
  }
  for (const key of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    try { if (values.has(key)) return publicUrl(new URL(values.get(key), pageUrl).href).href; } catch {}
  }
  return '';
}
async function fetchCover(url, { signal, permit, ...transport } = {}) {
  const page = await requestPublic(url, { signal, permit, ...transport });
  const image = coverFromHead(page.bytes, page.url);
  if (!image) throw failure('no_image');
  return requestPublic(image, { signal, permit, image: true, ...transport });
}
module.exports = { LIMITS, publicIp, publicUrl, pinnedAddress, imageType, readBody, requestPublic, coverFromHead, fetchCover, failure };
