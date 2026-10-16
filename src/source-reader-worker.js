'use strict';
const { parentPort } = require('node:worker_threads');
const { readOriginal, extract } = require('./source-reader-extract');
const SAFE = new Set(['source_unsafe_target', 'source_redirect_rejected', 'source_upstream_rejected', 'source_upstream_invalid',
  'source_access_denied', 'source_reader_auth_required', 'source_original_unavailable', 'source_content_invalid',
  'source_content_too_complex', 'source_too_large', 'source_format_unsupported', 'source_identity_mismatch', 'source_download_headers_unsupported']);
function safeError(error) {
  if (error?.code === 'too_large') return 'source_too_large';
  if (error?.code === 'unsafe_address') return 'source_unsafe_target';
  return SAFE.has(error?.code) ? error.code : 'source_read_unavailable';
}
if (parentPort) parentPort.on('message', async ({ id, payload }) => {
  try {
    const signal = AbortSignal.timeout(10000);
    // extract is an IPC-only test seam; HTTP routes never accept operation names/bytes.
    const value = payload.kind === 'extract' ? await extract(payload.bytes, payload.type, payload)
      : await readOriginal(payload.reader, payload.mediaId, { signal, pdfEnabled: payload.pdfEnabled });
    parentPort.postMessage({ id, value });
  } catch (error) { parentPort.postMessage({ id, error: safeError(error) }); }
});
module.exports = { safeError };
