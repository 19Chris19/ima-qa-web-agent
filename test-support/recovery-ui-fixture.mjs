// Loopback demonstration of the actual page controllers. Every task and answer
// below is synthetic. No Provider account store or upstream transport is loaded.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = resolve(root, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };

export async function startRecoveryUiFixture(port = 0) {
  const website = JSON.parse(await readFile(resolve(root, 'package.json'))).name === 'explorer-ai-qa-demo';
  const conversationId = 'synthetic-recovery-conversation';
  const recent = Date.now() - 6000;
  const failedQuestion = '【本地合成演示，不连接真实服务】这条问题用于检查失败后重试。';
  const oldQuestion = '【本地合成演示】检查悬浮输入框和阅读位置。';
  const oldAnswer = '# 本地交互演示\n\n这是合成资料，不会调用真实账号或 IMA。\n\n'
    + Array.from({ length: 14 }, (_, i) => `## 阅读段落 ${i + 1}\n\n向上阅读时，新文字不会把你拉回底部；向下箭头仅在下方仍有较多内容时出现。输入框保持已经确认的高度，周围可以继续阅读与滚动。\n\n`).join('');
  const history = [{ role: 'user', content: oldQuestion }, { role: 'assistant', content: oldAnswer, complete: true, taskId: 'synthetic-complete' }];
  const tasks = new Map([
    ['synthetic-failed', { task: { id: 'synthetic-failed', conversationId, question: failedQuestion, sourceIntent: 'web', status: 'failed', createdAt: recent, trace: { receivedAt: recent, dispatchedAt: recent + 500, terminalAt: recent + 5800 } },
      events: [{ id: 1, event: 'task.status', data: { status: 'running' } }, { id: 2, event: 'error', data: { failureReason: 'upstream_failed' } }, { id: 3, event: 'task.status', data: { status: 'failed' } }], clients: new Set() }],
    ['synthetic-complete', { task: { id: 'synthetic-complete', conversationId, question: oldQuestion, sourceIntent: 'knowledge', status: 'succeeded', createdAt: recent - 20000 }, events: [], clients: new Set() }],
  ]);
  let submissions = 0;
  const receipts = new Map(), timers = new Set();
  const meta = row => ({ ...row.task, lastEventId: row.events.length });
  const emit = (row, event, data) => {
    const item = { id: row.events.length + 1, event, data }; row.events.push(item);
    for (const client of row.clients) client.write(`id: ${item.id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
  const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'); const pathname = url.pathname;
      const api = pathname.replace(/^\/api\/qa\//, '/api/');
      if (pathname === '/__test/state') return json(res, { synthetic: true, submissions, realProviderCalls: 0 });
      if (pathname === '/__test/bootstrap.js') {
        res.setHeader('Content-Type', types['.js']);
        return res.end(`window.recoveryFixtureReady=true;localStorage.setItem('ima-qa-conversation-id', ${JSON.stringify(conversationId)});sessionStorage.setItem('qa-native-conversation-id', ${JSON.stringify(conversationId)});document.querySelector('textarea').value='保留这份草稿';`);
      }
      if (pathname === '/healthz') return json(res, { provider: 'ima-web-agent', model: 'synthetic' });
      if (api === '/api/health') return json(res, { connected: true, configured: true, authenticated: true, contractSupported: true, durableTasksSupported: true, ready: true, capacity: 1, webIntentSupported: true });
      if (api === '/api/capabilities') return json(res, { features: { durable_qa_tasks_v1: true } });
      if (pathname === '/questions.json') return json(res, Array.from({ length: 50 }, (_, i) => ({ id: `q${i}`, zh: `本地合成问题 ${i}`, en: `Local synthetic question ${i}` })));
      if (api.startsWith('/api/queue')) return json(res, { queue: [] });
      if (api === '/api/archive/conversations') return json(res, { conversations: [] });
      if (api === '/api/conversations') return json(res, req.method === 'POST' ? { conversation: { conversationId } } : { conversations: [{ conversationId, title: '本地合成演示 · 不连接真实服务' }] });
      if (api === `/api/conversations/${conversationId}`) return json(res, { conversation: { conversationId }, messages: history });
      if (api === '/api/tasks' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 10000) return json(res, {}, 413); }
        const input = JSON.parse(body); const identity = input.requestId || req.headers['idempotency-key'];
        if (!identity || input.conversationId !== conversationId || typeof input.question !== 'string') return json(res, {}, 400);
        if (receipts.has(identity)) return json(res, { task: meta(receipts.get(identity)) }, 202);
        const id = `synthetic-retry-${++submissions}`;
        const row = { task: { id, conversationId, question: input.question, sourceIntent: input.sourceIntent || 'knowledge', status: 'running', createdAt: Date.now(), requestId: input.requestId }, events: [], clients: new Set() };
        tasks.set(id, row); receipts.set(identity, row); emit(row, 'task.status', { status: 'running' });
        const parts = ['这是一条本地合成回答。\n\n', '重试前已经核对原任务状态，', '本次只创建一个新请求。', '\n\n你的草稿仍保留在输入框内。', '\n\n可以向上滚动检查悬浮输入框，', '再点击向下箭头回到最新。'];
        parts.forEach((text, i) => later(() => { if (row.task.status === 'running') emit(row, 'delta', { text }); }, 250 + i * 180));
        later(() => {
          if (row.task.status !== 'running') return;
          row.task.status = 'succeeded';
          emit(row, 'done', { conversationId, sourceCount: 0, timing: { elapsed_ms: 1500 } }); emit(row, 'task.status', { status: 'succeeded' });
          history.push({ role: 'user', content: input.question }, { role: 'assistant', content: parts.join(''), complete: true, taskId: id });
          for (const client of row.clients) client.end(); row.clients.clear();
        }, 1500);
        return json(res, { task: meta(row) }, 202);
      }
      if (api === '/api/tasks') return json(res, { tasks: [...tasks.values()].reverse().sort((a, b) => b.task.createdAt - a.task.createdAt).map(meta) });
      const taskPath = /^\/api\/tasks\/([^/]+)(\/events)?$/.exec(api);
      if (taskPath) {
        const row = tasks.get(taskPath[1]); if (!row) return json(res, {}, 404);
        if (req.method === 'DELETE' && row.task.status === 'running') {
          row.task.status = 'cancelled'; emit(row, 'error', { failureReason: 'cancelled' }); emit(row, 'task.status', { status: 'cancelled' });
          for (const client of row.clients) client.end(); row.clients.clear();
        }
        if (!taskPath[2]) return json(res, { task: meta(row), snapshot: { events: row.events } });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        for (const item of row.events.filter(item => item.id > Number(url.searchParams.get('after') || 0))) res.write(`id: ${item.id}\nevent: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
        if (row.task.status !== 'running') return res.end();
        row.clients.add(res); res.on('close', () => row.clients.delete(res)); return;
      }
      if (pathname.startsWith('/api/') || req.method !== 'GET') return json(res, {}, 404);
      let file;
      if (pathname === '/vendor/marked.umd.js') file = resolve(root, 'node_modules/marked/lib/marked.umd.js');
      else if (pathname === '/vendor/purify.min.js') file = resolve(root, 'node_modules/dompurify/dist/purify.min.js');
      else if (website && ['/question-rotation.mjs', '/source-evidence.mjs'].includes(pathname)) file = resolve(root, `.${pathname}`);
      else file = resolve(publicRoot, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
      if (!file.startsWith(publicRoot + '/') && !['/vendor/marked.umd.js', '/vendor/purify.min.js', '/question-rotation.mjs', '/source-evidence.mjs'].includes(pathname)) return json(res, {}, 404);
      let data = await readFile(file);
      if (extname(file) === '.html') data = data.toString().replace('<script', '<script src="/__test/bootstrap.js" defer></script><script');
      res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'");
      res.end(data);
    } catch { if (!res.headersSent) json(res, {}, 404); else res.end(); }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); server.close(resolve); }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await startRecoveryUiFixture(Number(process.argv[2]) || 0);
  console.log(`Synthetic recovery UI (no real Provider calls): ${fixture.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void fixture.close());
}
