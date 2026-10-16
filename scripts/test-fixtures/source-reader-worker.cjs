'use strict';
// Synthetic transport only: tests never open an external socket or load accounts.
const { parentPort } = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readOriginal } = require('../../src/source-reader-extract');
const response = (body, type = 'application/json') => {
  const res = new PassThrough(); res.statusCode = 200; res.headers = { 'content-type': type };
  queueMicrotask(() => res.end(body)); return res;
};
parentPort.on('message', async ({ id, payload }) => {
  if (payload.mediaId === 'synthetic-crash') { process.exit(2); return; }
  if (payload.mediaId === 'synthetic-delay') await new Promise(resolve => setTimeout(resolve, 2000));
  try {
    const transport = { lookup: async () => [{ address: '8.8.8.8', family: 4 }], requestImpl(url, options, cb) {
      const req = new EventEmitter(); req.end = () => cb(url.hostname === 'ima.qq.com'
        ? response(JSON.stringify({ code: 0, data: { media_id: payload.mediaId, url_info: { url: 'https://synthetic.example/material.txt', headers: {} } } }))
        : response('Synthetic original material\n'.repeat(700), 'text/plain'));
      return req;
    } };
    const value = await readOriginal(payload.reader, payload.mediaId, { transport, signal: AbortSignal.timeout(10000) });
    parentPort.postMessage({ id, value });
  } catch (error) { parentPort.postMessage({ id, error: /^source_[a-z_]+$/u.test(error.code || '') ? error.code : 'source_read_unavailable' }); }
});
