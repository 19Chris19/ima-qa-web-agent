// Isolated synthetic HTTP harness. Never loads deployment config or real accounts.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { AsyncAccountDirectory } = require('../../src/async-account-directory');
const { WebAgentAccountDirectory } = require('../../src/web-agent-account-directory');
const legacy = require('./persistence-v060/generation-store.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const scenario = process.argv[2];
  if (!['baseline', 'async', 'slow'].includes(scenario)) throw Error('invalid_synthetic_scenario');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-persistence-benchmark-'));
  fs.chmodSync(root, 0o700);
  const options = { storePath: path.join(root, 'accounts.json'), keyPath: path.join(root, 'key'), keyMaterial: 'synthetic-benchmark-key' };
  const initial = new WebAgentAccountDirectory(options);
  for (let i = 0; i < 5; i++) initial.addCapturedAccount({ id: `synthetic-${i}`, name: `synthetic-${i}`,
    knowledgeBaseId: '123', headers: { 'x-ima-cookie': `IMA-UID=synthetic-${i}; IMA-TOKEN=${'x'.repeat(7800)}; IMA-REFRESH-TOKEN=fake` } });
  const rssBeforeWorker = process.memoryUsage().rss;
  let directory;
  if (scenario !== 'baseline') directory = await new AsyncAccountDirectory({ ...options,
    ...(scenario === 'slow' ? { workerFactory: (entry, workerOptions) => new Worker(path.join(__dirname, 'account-persistence-fault-worker.cjs'), {
      workerData: { ...workerOptions.workerData, entry, fault: 'slow', faultMethod: 'recordEvent', delayMs: 20000 },
    }) } : {}),
  }).initialize();
  let store = initial.load(), legacyCommits = 0, peakRss = process.memoryUsage().rss;
  const generationBefore = JSON.parse(fs.readFileSync(options.storePath)).generation;
  const records = [];
  const cpuBefore = process.cpuUsage(), ioBefore = process.resourceUsage();
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
  let workerReady = false;
  const persist = () => {
    if (scenario === 'baseline') { store = legacy.commitStore(options.storePath, store); legacyCommits++; }
    else {
      const pending = directory.recordEvent('synthetic-0', 'synthetic', 'synthetic').then(() => true, () => false);
      records.push(pending);
    }
  };
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.end(JSON.stringify({ ok: true, persistenceReady: directory?.persistenceReady ?? true })); return; }
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
      persist();
      let index = 0;
      const timer = setInterval(() => {
        if (index === 4) persist();
        res.write(`data: ${JSON.stringify({ index, at: performance.now() })}\n\n`);
        if (++index === 8) { clearInterval(timer); res.end(); }
      }, 10);
      return;
    }
    if (req.url === '/finish') {
      await Promise.all(records);
      clearInterval(sampler); loop.disable();
      const cpu = process.cpuUsage(cpuBefore), io = process.resourceUsage();
      const result = { scenario, payloadBytes: fs.statSync(options.storePath).size,
        nodeCpuMs: (cpu.user + cpu.system) / 1000, peakRssMiB: peakRss / 1048576,
        extraRssMiB: (peakRss - rssBeforeWorker) / 1048576,
        eventLoopP95Ms: loop.percentile(95) / 1e6, eventLoopMaxMs: loop.max / 1e6,
        fsWriteUnits: io.fsWrite - ioBefore.fsWrite,
        canonicalCommits: JSON.parse(fs.readFileSync(options.storePath)).generation - generationBefore,
        spawnedCommitProcesses: legacyCommits,
        persistenceReady: directory?.persistenceReady ?? true,
        acknowledgedWrites: scenario === 'baseline' ? legacyCommits : records.length ? (await Promise.all(records)).filter(Boolean).length : 0 };
      res.end(JSON.stringify(result));
      return;
    }
    if (req.url === '/shutdown') {
      res.end('{}');
      await directory?.close({ mirrorStatistics: false });
      server.close(); fs.rmSync(root, { recursive: true, force: true });
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
})().catch(() => { console.error('synthetic_benchmark_failed'); process.exit(1); });
