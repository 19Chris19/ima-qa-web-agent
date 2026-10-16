'use strict';
const { createHash } = require('node:crypto');
const { parse } = require('parse5');
const network = require('./source-reader-network');
const MAX_CHARACTERS = 128000;
const sha = value => createHash('sha256').update(value).digest('hex');
function bounded(text, format, complete = true) {
  if (typeof text !== 'string' || /\u0000/u.test(text)) throw network.fail('source_content_invalid');
  const truncated = text.length > MAX_CHARACTERS;
  let content = text.slice(0, MAX_CHARACTERS);
  if (truncated && /[\uD800-\uDBFF]/u.test(content.at(-1))) content = content.slice(0, -1);
  return { text: content, format, contentComplete: complete && !truncated, extractionTruncated: truncated || !complete,
    sha256: sha(content), extractedCharacters: content.length };
}
function htmlText(html) {
  const document = parse(html), pending = [document], parts = [];
  let nodes = 0, characters = 0;
  while (pending.length) {
    const node = pending.pop();
    if (++nodes > 100000) throw network.fail('source_content_too_complex');
    if (['script', 'style', 'template', 'head', 'noscript', 'iframe'].includes(node.tagName)) continue;
    if (node.nodeName === '#text') { parts.push(node.value); characters += node.value.length; }
    else if (['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'section'].includes(node.tagName)) { parts.push('\n'); characters++; }
    if (characters > MAX_CHARACTERS) { parts.push(' '.repeat(1)); break; }
    const children = node.childNodes || [];
    for (let n = children.length - 1; n >= 0; n--) pending.push(children[n]);
  }
  return { text: parts.join(''), complete: !pending.length };
}
async function extract(bytes, type, { pdfEnabled = false } = {}) {
  bytes = Buffer.from(bytes);
  if (bytes.length > network.LIMIT) throw network.fail('source_too_large');
  if (type === 'application/pdf') {
    if (!pdfEnabled) throw network.fail('source_format_unsupported');
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw network.fail('source_content_invalid');
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false,
      useSystemFonts: false, disableFontFace: true, disableAutoFetch: true, useWorkerFetch: false });
    try {
      const result = await parser.getText({ partial: [1, 2, 3, 4, 5] });
      return { ...bounded(result.text, 'pdf', Number.isSafeInteger(result.total) && result.total <= 5),
        extractionScope: 'first_five_pdf_pages', rawSha256: sha(bytes) };
    } finally { await parser.destroy(); }
  }
  if (!['text/plain', 'text/markdown', 'text/x-markdown', 'text/html', 'application/xhtml+xml'].includes(type))
    throw network.fail('source_format_unsupported');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw network.fail('source_content_invalid'); }
  if (['text/html', 'application/xhtml+xml'].includes(type)) {
    const content = htmlText(text);
    return { ...bounded(content.text, 'html', content.complete), extractionScope: 'html_text', rawSha256: sha(bytes) };
  }
  return { ...bounded(text, /markdown/u.test(type) ? 'markdown' : 'text'), extractionScope: 'file_text', rawSha256: sha(bytes) };
}
async function readOriginal(reader, mediaId, options = {}) {
  const info = await network.api(reader, '/openapi/wiki/v1/get_media_info', { media_id: mediaId }, options);
  if (info.media_id !== undefined && info.media_id !== mediaId) throw network.fail('source_identity_mismatch');
  const noteId = info.notebook_ext_info?.notebook_id;
  if (noteId !== undefined) {
    if (!['string', 'number'].includes(typeof noteId) || (typeof noteId === 'number' && !Number.isSafeInteger(noteId))
      || !/^\d{1,40}$/u.test(String(noteId))) throw network.fail('source_upstream_invalid');
    const note = await network.api(reader, '/openapi/note/v1/get_doc_content', { note_id: String(noteId), target_content_format: 0 },
      { ...options, limit: network.LIMIT });
    if (typeof note.content !== 'string') throw network.fail('source_upstream_invalid');
    return { ...bounded(note.content, 'note'), extractionScope: 'note_plain_text' };
  }
  if (!info.url_info || typeof info.url_info.url !== 'string') throw network.fail('source_original_unavailable');
  const downloaded = await network.download(info.url_info.url, info.url_info.headers || {}, options);
  return extract(downloaded.bytes, downloaded.type, options);
}
module.exports = { MAX_CHARACTERS, extract, bounded, readOriginal };
