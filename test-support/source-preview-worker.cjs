// Synthetic worker transport: no sockets, account pool or remote website.
const { startWorker } = require('../src/source-preview-worker');
const { setTimeout: delay } = require('node:timers/promises');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=', 'base64');
startWorker({ async fetchImpl(url, { permit, signal }) {
  if (!await permit()) throw Object.assign(new Error('budget'), { code: 'budget' });
  await delay(url.includes('slow') ? 4000 : 30, undefined, { signal });
  if (!await permit()) throw Object.assign(new Error('budget'), { code: 'budget' });
  return { bytes: image, type: 'image/png' };
} });
