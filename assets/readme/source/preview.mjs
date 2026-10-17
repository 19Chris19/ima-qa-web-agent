import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures = JSON.parse(await fs.readFile(new URL('synthetic-http.json', import.meta.url), 'utf8'));
const port = Number(process.argv[2] || 4981);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a loopback port from 1024 to 65535');
const built = await fs.stat(path.join(root, 'dist/public')).then(() => true, () => false);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const style = '*{box-sizing:border-box}body{margin:0;padding:32px 20px;background:#f6f8fa;color:#1f2328;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}article{max-width:940px;margin:auto;background:#fff;padding:32px;border:1px solid #d1d9e0;border-radius:6px}h1,h2{border-bottom:1px solid #d1d9e0;padding-bottom:10px;line-height:1.35}h1{font-size:32px}h2{font-size:24px;margin-top:32px}img{max-width:100%;height:auto}a{color:#0969da}pre{padding:16px;background:#f6f8fa;overflow:auto}code{font-size:14px}table{border-collapse:collapse;display:block;max-width:100%;overflow:auto}td,th{border:1px solid #d1d9e0;padding:8px 12px}blockquote{margin:16px 0;padding-left:16px;border-left:4px solid #d1d9e0;color:#59636e}li{margin:6px 0}@media(max-width:600px){body{padding:0}article{padding:18px;border:0}h1{font-size:26px}}@media(prefers-color-scheme:dark){body{background:#010409;color:#e6edf3}article{background:#0d1117;border-color:#30363d}h1,h2,td,th{border-color:#30363d}pre{background:#161b22}a{color:#58a6ff}blockquote{color:#9198a1;border-color:#30363d}}';
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
const server = http.createServer(async (req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) return json(res, { error: 'Synthetic preview: writes disabled' }, 405);
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (Object.hasOwn(fixtures.responses, pathname)) return json(res, fixtures.responses[pathname]);
    if (pathname.startsWith('/api/') || pathname === '/healthz') return json(res, { error: 'Unknown synthetic endpoint' }, 404);
    if (pathname === '/readme-preview') {
      const body = marked.parse(await fs.readFile(path.join(root, 'README.md'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>README preview</title><style>' + style + '</style><article>' + body + '</article></html>');
    }
    const prefix = pathname.startsWith('/assets/') ? '/assets' : pathname.startsWith('/public/') ? '/public' : '';
    const staticRoot = prefix ? path.join(root, prefix.slice(1)) : path.join(root, built ? 'dist/public' : 'public');
    const relative = prefix ? pathname.slice(prefix.length) : pathname === '/' ? '/index.html' : pathname;
    const file = path.resolve(staticRoot, '.' + relative);
    if (!file.startsWith(staticRoot + path.sep)) return json(res, { error: 'Forbidden' }, 403);
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { json(res, { error: 'Preview file unavailable' }, 404); }
});
server.listen(port, '127.0.0.1', () => console.log('Synthetic HTTP only: http://127.0.0.1:' + port + '/readme-preview'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
