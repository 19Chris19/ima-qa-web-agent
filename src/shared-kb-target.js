const { parse } = require('parse5');

const MAX_BYTES = 1_048_576;
const PREFIX = 'window.__remixContext.streamController.enqueue(';
function failure(code) { return Object.assign(new Error(code), { code }); }
function parseShareUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw failure('official_share_url_required'); }
  const shareId = url.searchParams.get('shareId');
  if (url.protocol !== 'https:' || url.hostname !== 'ima.qq.com' || url.port
    || url.username || url.password || !['/wiki', '/wiki/'].includes(url.pathname)
    || !/^[a-f0-9]{64}$/i.test(shareId || '') || url.searchParams.getAll('shareId').length !== 1) {
    throw failure('official_share_url_required');
  }
  return { url: `https://ima.qq.com/wiki/?shareId=${shareId}`, shareId };
}
function parseShareHtml(html, input) {
  const { url, shareId } = parseShareUrl(input);
  if (Buffer.byteLength(html) > MAX_BYTES) throw failure('share_too_large');
  const scripts = [];
  function visit(node) {
    if (node.tagName === 'script') scripts.push((node.childNodes || []).map(n => n.value || '').join('').trim());
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parse(html));
  // Read a JSON string in the known Remix transport; never evaluate the script.
  for (const script of scripts) {
    if (!script.startsWith(PREFIX) || !script.endsWith(');')) continue;
    try {
      const encoded = JSON.parse(script.slice(PREFIX.length, -2));
      if (typeof encoded !== 'string') continue;
      const graph = JSON.parse(encoded);
      if (!Array.isArray(graph) || graph.length > 20000) continue;
      const field = (reference, key) => {
        const object = graph[reference];
        if (!object || Array.isArray(object) || typeof object !== 'object') return undefined;
        const entry = Object.entries(object).find(([index]) => /^_\d+$/.test(index)
          && graph[Number(index.slice(1))] === key);
        return entry?.[1];
      };
      const init = field(field(field(0, 'loaderData'), 'routes/_index'), 'initData');
      const info = field(init, 'knowledgeBaseInfo');
      const id = graph[field(info, 'id')];
      if (graph[field(init, 'shareId')] !== shareId || typeof id !== 'string' || !/^\d{1,30}$/.test(id)) continue;
      const permissions = field(info, 'userPermissionInfo');
      const role = graph[field(permissions, 'roleType')];
      const applying = graph[field(permissions, 'isInApplyList')] === true;
      const name = graph[field(field(info, 'basicInfo'), 'title')];
      return { shareUrl: url, knowledgeBaseId: id,
        name: typeof name === 'string' ? name.slice(0, 160) : '',
        membership: [100, 1000, 9000, 10000].includes(role) ? 'joined'
          : applying ? 'awaiting_approval' : role === 0 ? 'not_joined' : 'unknown' };
    } catch { /* Another transport chunk is not the target metadata. */ }
  }
  throw failure('share_metadata_unverified');
}
async function resolveSharedTarget(input, options = {}) {
  const { url } = parseShareUrl(input);
  const response = await (options.fetchImpl || fetch)(url, { redirect: 'manual',
    headers: options.cookie ? { cookie: options.cookie } : {},
    signal: options.signal || AbortSignal.timeout(15000) });
  if (!response.ok || (response.url && response.url !== url)) throw failure('share_unavailable');
  const reader = response.body?.getReader();
  const chunks = []; let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw failure('share_too_large');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  const target = parseShareHtml(Buffer.concat(chunks).toString('utf8'), url);
  if (options.expectedId && target.knowledgeBaseId !== String(options.expectedId)) throw failure('knowledge_base_mismatch');
  return target;
}
module.exports = { parseShareUrl, parseShareHtml, resolveSharedTarget };
