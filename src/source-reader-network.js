'use strict';
const http = require('node:http');
const https = require('node:https');
const { publicIp, pinnedAddress, readBody } = require('./source-preview-network');
const fail = code => Object.assign(new Error(code), { code });
const LIMIT = 5 * 1024 * 1024;
function downloadUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw fail('source_unsafe_target');
  let url;
  try { url = new URL(value); } catch { throw fail('source_unsafe_target'); }
  const host = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !host || /(^|\.)(localhost|local|internal|home|lan)$/u.test(host)
    || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) || /(^|\.)ima\.qq\.com$/u.test(host)) throw fail('source_unsafe_target');
  // Signed download addresses are allowed only over HTTPS, never in cleartext.
  if (url.protocol === 'http:' && url.search) throw fail('source_unsafe_target');
  url.hash = ''; return url;
}
function downloadHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw fail('source_download_headers_unsupported');
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!['x-cos-security-token'].includes(key.toLowerCase()) || typeof value !== 'string' || value.length > 4096
      || /[\r\n\u0000]/u.test(value)) throw fail('source_download_headers_unsupported');
    result[key.toLowerCase()] = value;
  }
  return result;
}
async function request(url, { signal, method = 'GET', headers = {}, body, limit = LIMIT, lookup, requestImpl,
  allowRedirects = false, acceptTypes } = {}) {
  const original = url.origin;
  for (let redirects = 0; ; redirects++) {
    signal?.throwIfAborted();
    const address = await pinnedAddress(url, lookup, signal); signal?.throwIfAborted();
    const response = await new Promise((resolve, reject) => {
      const transport = requestImpl || ((target, options, callback) => (target.protocol === 'https:' ? https : http).request(target, options, callback));
      const req = transport(url, { method, signal, agent: false, maxHeaderSize: 16 * 1024, family: address.family,
        lookup(_host, options, cb) { cb(null, options.all ? [address] : address.address, address.family); },
        headers: { Accept: '*/*', 'Accept-Encoding': 'gzip,deflate,br', 'User-Agent': 'ProviderA-SourceReader/1.0',
          ...(url.origin === original ? headers : {}) } }, resolve);
      req.once('socket', socket => socket.once('connect', () => {
        if (!publicIp(socket.remoteAddress)) req.destroy(fail('source_unsafe_target'));
      }));
      req.once('error', reject); req.end(body);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (!allowRedirects || redirects >= 2 || !response.headers.location) throw fail('source_redirect_rejected');
      const next = downloadUrl(new URL(response.headers.location, url).href);
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw fail('source_redirect_rejected');
      url = next; continue;
    }
    if (response.statusCode !== 200) { response.destroy(); throw fail('source_upstream_rejected'); }
    const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (acceptTypes && !acceptTypes.includes(type)) { response.destroy(); throw fail('source_format_unsupported'); }
    const bytes = await readBody(response, limit, false, signal);
    return { bytes, type };
  }
}
async function api(reader, endpoint, body, { signal, transport = {}, limit = 256 * 1024 } = {}) {
  // Only fixed IMA OpenAPI endpoints receive these credentials. No redirects.
  if (!['/openapi/wiki/v1/get_media_info', '/openapi/note/v1/get_doc_content'].includes(endpoint)) throw fail('source_upstream_rejected');
  const result = await request(new URL('https://ima.qq.com' + endpoint), { ...transport, signal, method: 'POST', limit,
    headers: { 'Content-Type': 'application/json', 'ima-openapi-clientid': reader.clientId, 'ima-openapi-apikey': reader.apiKey }, body: JSON.stringify(body) });
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)); } catch { throw fail('source_upstream_invalid'); }
  if (!value || value.code !== 0) throw fail(value?.code === 110030 ? 'source_access_denied'
    : value?.code === 20004 ? 'source_reader_auth_required' : 'source_upstream_rejected');
  if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw fail('source_upstream_invalid');
  return value.data;
}
async function download(value, headers, { signal, transport = {}, pdfEnabled = false } = {}) {
  const url = downloadUrl(value), safeHeaders = downloadHeaders(headers);
  if (Object.keys(safeHeaders).length && url.protocol !== 'https:') throw fail('source_unsafe_target');
  return request(url, { ...transport, headers: safeHeaders, signal, allowRedirects: true,
    acceptTypes: ['text/plain', 'text/markdown', 'text/x-markdown', 'text/html', 'application/xhtml+xml', ...(pdfEnabled ? ['application/pdf'] : [])] });
}
module.exports = { LIMIT, downloadUrl, downloadHeaders, request, api, download, fail };
