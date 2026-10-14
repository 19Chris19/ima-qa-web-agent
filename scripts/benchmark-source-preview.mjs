// Isolated synthetic SSE only. No IMA, credentials, browsers or external requests.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { monitorEventLoopDelay } from 'node:perf_hooks';
const root = dirname(dirname(fileURLToPath(import.meta.url))), require = createRequire(import.meta.url);
const { SourcePreview } = require('../src/source-preview');
const percentile = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] || 0;
const mode = process.argv[2];
if (['baseline', 'warm', 'cold', 'timeout', 'flood'].includes(mode)) {
  const directory = await mkdtemp(join(tmpdir(), 'source-preview-benchmark-'));
  let clock = Date.now();
  const preview = new SourcePreview({ enabled: mode !== 'baseline', directory, now: () => clock,
    workerFile: join(root, 'test-support/benchmark-source-preview-worker.cjs') });
  const warm = 'https://fixture.example/warm';
  if (mode === 'warm') await preview.preview(warm);
  const first = [], gaps = [], work = [], cpu = process.cpuUsage(), usage = process.resourceUsage();
  let peak = process.memoryUsage().rss, heap = process.memoryUsage().heapUsed;
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const sampling = setInterval(() => { const memory = process.memoryUsage(); peak = Math.max(peak, memory.rss); heap = Math.max(heap, memory.heapUsed); }, 5);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let n = 0;
    const timer = setInterval(() => { res.write(`event: delta\ndata: {"text":"${++n}"}\n\n`); if (n === 12) { clearInterval(timer); res.end(); } }, 10);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (let trial = 0; trial < 30; trial++) {
      clock += 60001; const started = performance.now(); let last;
      const running = mode === 'baseline' ? [] : Array.from({ length: mode === 'flood' ? 100 : 1 }, (_, i) =>
        preview.preview(mode === 'warm' ? warm : `https://fixture.example/${mode}-${trial}-${i}`));
      work.push(...running);
      const response = await fetch(`http://127.0.0.1:${server.address().port}/sse`), reader = response.body.getReader();
      let pending = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        pending += new TextDecoder().decode(value);
        while (pending.includes('\n\n')) {
          pending = pending.slice(pending.indexOf('\n\n') + 2);
          const at = performance.now(); if (last === undefined) first.push(at - started); else gaps.push(at - last); last = at;
        }
      }
      if (mode !== 'timeout') await Promise.all(running);
    }
    await Promise.all(work);
    const bytes = (await Promise.all((await readdir(directory)).map(name => stat(join(directory, name))))).reduce((n, s) => n + s.size, 0);
    const spent = process.cpuUsage(cpu), end = process.resourceUsage();
    console.log(JSON.stringify({ mode, trials: 30, firstP95Ms: percentile(first), intervalP95Ms: percentile(gaps),
      peakRssBytes: peak, peakMainHeapBytes: heap, cpuMs: (spent.user + spent.system) / 1000,
      eventLoopP95Ms: loop.percentile(95) / 1e6, fsReadOps: end.fsRead - usage.fsRead,
      fsWriteOps: end.fsWrite - usage.fsWrite, cacheBytes: bytes, ...preview.metrics }));
  } finally { clearInterval(sampling); loop.disable(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await preview.close(); await rm(directory, { recursive: true, force: true }); }
} else {
  const scenarios = [];
  for (const scenario of ['baseline', 'warm', 'cold', 'timeout', 'flood']) {
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), scenario], { maxBuffer: 1024 * 1024 });
    scenarios.push(JSON.parse(stdout));
  }
  const baseline = scenarios[0];
  const results = scenarios.map(row => ({ ...row, firstRegressionMs: row.firstP95Ms - baseline.firstP95Ms,
    intervalRegressionMs: row.intervalP95Ms - baseline.intervalP95Ms,
    extraRssBytes: Math.max(0, row.peakRssBytes - baseline.peakRssBytes) }));
  const report = { syntheticOnly: true, node: process.version,
    transport: 'synthetic anonymous HTTP responses through real head parser, worker, disk cache and local SSE; no external requests',
    admissionClock: 'accelerated between trials; rolling limits independently verified with fixed clocks in tests',
    note: 'RSS sampled every 5ms; CPU includes worker threads; fs operation counts may be unavailable on macOS. Not a real-IMA or network-latency benchmark.',
    passed: results.every(r => r.firstRegressionMs <= 20 && r.intervalRegressionMs <= 20 && r.extraRssBytes <= 64 * 1024 * 1024)
      && results.find(r => r.mode === 'warm').http === 2,
    results };
  const output = process.argv.indexOf('--output'); if (output >= 0) await writeFile(process.argv[output + 1], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2)); if (!report.passed) process.exitCode = 1;
}
