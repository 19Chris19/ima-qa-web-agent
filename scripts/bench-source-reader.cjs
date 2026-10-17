'use strict';
// Fixed synthetic SSE and production read/extract logic with synthetic HTTP.
// Never loads the account store, starts a Provider pool, or contacts IMA/websites.
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { SourceReader } = require('../src/source-reader');
const { hash } = require('../src/knowledge-evidence');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const scope = hash('synthetic-kb');
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] || 0;
async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.end('{"ok":true}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); let n = 0;
    const timer = setInterval(() => { res.write('data: synthetic-' + n++ + '\n\n'); if (n === 8) { clearInterval(timer); res.end(); } }, 5);
    res.on('close', () => clearInterval(timer));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const config = mediaId => ({ schemaVersion: 1, readers: [{ id: 'synthetic', applications: ['agent'], scopeRef: scope,
    clientId: 'synthetic', apiKey: 'synthetic', idNamespace: 'ima_web_media', identity: { mode: 'explicit_bindings', bindings: { native: mediaId } } }] });
  const workerPath = path.join(__dirname, 'test-fixtures/source-reader-worker.cjs');
  let budgetClock = Date.now();
  const normal = new SourceReader(config('synthetic-media'), { workerPath, now: () => budgetClock });
  const timeout = new SourceReader(config('synthetic-delay'), { workerPath, timeoutMs: 25, now: () => budgetClock });
  const context = { applicationKey: 'application:agent', owner: 'synthetic-owner', taskId: 'synthetic-task', citationKey: 'index:42',
    sourceRef: hash('synthetic-ref'), scopeRef: scope, material: { idNamespace: 'ima_web_media', materialId: 'native' } };
  let cachedCursor;
  const results = {}, rounds = 30, originRss = process.memoryUsage().rss;
  try {
    for (let n = 0; n < 5; n++) { await (await fetch(base + '/healthz')).text(); await (await fetch(base + '/stream')).text(); }
    for (const mode of ['disabled', 'cold_read', 'cached_page', 'timeout']) {
      if (mode === 'timeout') await normal.close();
      if (mode === 'cached_page') { budgetClock += 10000; cachedCursor = (await normal.read(context)).nextCursor; }
      const first = [], intervals = [], health = [], loop = monitorEventLoopDelay({ resolution: 1 });
      const cpu = process.cpuUsage(), usage = process.resourceUsage(); let rss = process.memoryUsage().rss;
      const sample = setInterval(() => { rss = Math.max(rss, process.memoryUsage().rss); }, 2); loop.enable();
      for (let n = 0; n < rounds; n++) {
        if (['cold_read', 'timeout'].includes(mode)) budgetClock += 10000;
        const start = performance.now();
        const work = mode === 'cold_read' ? normal.read(context) : mode === 'cached_page' ? normal.read(context, { cursor: cachedCursor })
          : mode === 'timeout' ? timeout.read(context).catch(error => { if (error.code !== 'source_read_timeout') throw error; }) : Promise.resolve();
        const control = (async () => { const began = performance.now(); const response = await fetch(base + '/healthz'); await response.text(); health.push(performance.now() - began); })();
        const response = await fetch(base + '/stream'); const decoder = new TextDecoder(); let buffer = '', last;
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true }); let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            buffer = buffer.slice(end + 2); const now = performance.now();
            if (last === undefined) first.push(now - start); else intervals.push(now - last); last = now;
          }
        }
        await Promise.all([work, control]);
        if (mode === 'timeout') await timeout.stopping;
      }
      clearInterval(sample); loop.disable();
      const used = process.cpuUsage(cpu);
      results[mode] = { rounds, firstChunkP95Ms: quantile(first, .95), eventIntervalP95Ms: quantile(intervals, .95),
        healthP95Ms: quantile(health, .95), cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000,
        rssPeakBytes: rss, eventLoopP95Ms: loop.percentile(95) / 1e6,
        fileWriteOperations: process.resourceUsage().fsWrite - usage.fsWrite };
    }
  } finally { normal.close(); timeout.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const baseline = results.disabled, worst = Math.max(...Object.values(results).map(value => value.rssPeakBytes));
  const formatProbes = {};
  for (const kind of ['text_limit', 'pdf_probe']) {
    const { stdout } = await execFile(process.execPath, [path.join(__dirname, 'probe-source-reader-memory.cjs'), kind], { timeout: 15000 });
    formatProbes[kind] = JSON.parse(stdout);
  }
  const gates = { healthP95Under250Ms: Object.values(results).every(value => value.healthP95Ms <= 250),
    firstChunkRegressionUnder20Ms: Object.values(results).every(value => value.firstChunkP95Ms - baseline.firstChunkP95Ms <= 20),
    intervalRegressionUnder20Ms: Object.values(results).every(value => value.eventIntervalP95Ms - baseline.eventIntervalP95Ms <= 20),
    extraRssUnder64MiB: worst - Math.max(originRss, baseline.rssPeakBytes) <= 64 * 1024 * 1024 && formatProbes.text_limit.rssUnder64MiB,
    overBudgetPdfDisabled: new SourceReader().config.pdfEnabled === false };
  const report = { schemaVersion: 1, observedAt: new Date().toISOString(), node: process.version, kind: 'synthetic_sse_and_synthetic_transport',
    realUpstreamRequests: 0, realQuestions: 0, browserProcesses: 0, httpWarmupRounds: 5, budgetClockSynthetic: true,
    results, extraRssPeakBytes: Math.max(0, worst - baseline.rssPeakBytes),
    formatProbes, gates, passed: Object.values(gates).every(Boolean) };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.passed) process.exitCode = 1;
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: /^source_[a-z_]+$/u.test(error.code || '') ? error.code : 'synthetic_benchmark_failed' }) + '\n'); process.exitCode = 1; });
