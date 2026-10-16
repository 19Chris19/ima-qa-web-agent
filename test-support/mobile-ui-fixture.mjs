// Loopback-only browser fixture. Uses production HTML/CSS/renderers, with no
// account store, Provider transport, third-party fetches or real questions.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = resolve(root, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

export async function startMobileUiFixture(port = 0) {
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'GET' || pathname.startsWith('/api/')) { res.writeHead(405); res.end(); return; }
    if (pathname.startsWith('/destination/')) { res.setHeader('Content-Type', types['.html']); res.end('<!doctype html><title>Local test source</title><p>Local test source</p>'); return; }
    try {
      let file;
      if (pathname === '/__test/mobile-ui.js') file = resolve(root, 'test-support/mobile-ui-page.js');
      else if (pathname === '/vendor/marked.umd.js') file = resolve(root, 'node_modules/marked/lib/marked.umd.js');
      else if (pathname === '/vendor/purify.min.js') file = resolve(root, 'node_modules/dompurify/dist/purify.min.js');
      else {
        file = resolve(publicRoot, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
        if (!file.startsWith(`${publicRoot}/`)) throw Error('path');
      }
      let data = await readFile(file);
      if (extname(file) === '.html') {
        data = data.toString().replace(/<script\b[^>]*src="\/(?:client\.js|app\.js)"[^>]*><\/script>/gu, '')
          .replace('</body>', '<script src="/__test/mobile-ui.js" defer></script></body>');
      }
      res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      // All destinations and assets are local. A test can never submit to IMA.
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'");
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await startMobileUiFixture(Number(process.argv[2]) || 0);
  console.log(`Local synthetic mobile UI: ${fixture.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixture.close(); });
}
