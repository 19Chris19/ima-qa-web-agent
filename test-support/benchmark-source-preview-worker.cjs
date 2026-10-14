const { startWorker } = require('../src/source-preview-worker');
const { fetchCover } = require('../src/source-preview-network');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { crc32 } = require('node:zlib');
// Valid PNG with a large ancillary text chunk: realistic byte/IO pressure, no image decoding.
const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6ioAAAAASUVORK5CYII=', 'base64');
const chunk = Buffer.concat([Buffer.from('tEXt'), Buffer.from('Synthetic\0' + 'x'.repeat(380 * 1024))]);
const size = Buffer.alloc(4); size.writeUInt32BE(chunk.length - 4);
const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(chunk));
const image = Buffer.concat([tiny.subarray(0, -12), size, chunk, crc, tiny.subarray(-12)]);
const head = Buffer.from('<head>' + '<meta name="synthetic" content="bounded fixture">'.repeat(400) + '<meta property="og:image" content="https://fixture.example/cover.png"></head>');
startWorker({ fetchImpl(url, options) {
  return fetchCover(url, { ...options, lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl(target, init, callback) {
      const request = new EventEmitter();
      request.end = () => {
        const timer = setTimeout(() => {
          if (init.signal.aborted) return;
          if (url.includes('/timeout')) return;
          const response = new PassThrough(); response.statusCode = 200;
          response.headers = { 'content-type': target.pathname.endsWith('.png') ? 'image/png' : 'text/html' };
          callback(response); response.end(target.pathname.endsWith('.png') ? image : head);
        }, 15);
        init.signal.addEventListener('abort', () => { clearTimeout(timer); request.emit('error', Object.assign(new Error('cancelled'), { code: 'cancelled' })); }, { once: true });
      };
      return request;
    },
  });
} });
