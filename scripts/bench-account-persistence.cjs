const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const p95 = rows => [...rows].sort((a, b) => a - b)[Math.max(0, Math.ceil(rows.length * .95) - 1)];

async function run(scenario) {
  const child = spawn(process.execPath, [path.join(__dirname, 'test-fixtures/persistence-bench-server.cjs'), scenario], { stdio: ['ignore', 'pipe', 'pipe'] });
  let address, finished = false;
  try {
    address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('synthetic_start_timeout')), 10000);
      child.stdout.once('data', chunk => { clearTimeout(timer); try { resolve(JSON.parse(chunk.toString()).port); } catch { reject(Error('synthetic_start_failed')); } });
      child.once('exit', () => { clearTimeout(timer); reject(Error('synthetic_start_failed')); });
    });
    const base = `http://127.0.0.1:${address}`, first = [], gaps = [], health = [];
    let healthFailures = 0;
    const monitor = (async () => {
      while (!finished) {
        const start = performance.now();
        try { const response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) }); await response.arrayBuffer(); if (!response.ok) healthFailures++; }
        catch { healthFailures++; }
        health.push(performance.now() - start); await delay(20);
      }
    })();
    for (let i = 0; i < 30; i++) {
      const start = performance.now(), response = await fetch(base + '/stream');
      let buffered = '', observed = false, last;
      for await (const chunk of response.body) {
        buffered += Buffer.from(chunk).toString();
        let at;
        while ((at = buffered.indexOf('\n\n')) >= 0) {
          const frame = buffered.slice(0, at); buffered = buffered.slice(at + 2);
          const value = JSON.parse(frame.replace(/^data: /, ''));
          if (!observed) { first.push(performance.now() - start); observed = true; }
          if (last !== undefined) gaps.push(value.at - last); last = value.at;
        }
      }
    }
    const result = await (await fetch(base + '/finish', { signal: AbortSignal.timeout(30000) })).json();
    finished = true; await monitor;
    await (await fetch(base + '/shutdown')).arrayBuffer();
    if (child.exitCode === null) await once(child, 'exit');
    return { ...result, rounds: 30, firstDeltaP95Ms: p95(first), eventGapP95Ms: p95(gaps),
      healthP95Ms: p95(health), healthMaxMs: Math.max(...health), healthRequests: health.length, healthFailures };
  } finally { finished = true; if (child.exitCode === null) child.kill(); }
}
(async () => {
  const cases = [];
  for (const name of ['baseline', 'async', 'slow']) cases.push(await run(name));
  const [baseline, normal, slow] = cases;
  const gates = { health: cases.every(row => row.healthFailures === 0) && normal.healthP95Ms <= 250 && slow.healthP95Ms <= 250,
    firstDelta: normal.firstDeltaP95Ms - baseline.firstDeltaP95Ms <= 20 && slow.firstDeltaP95Ms - baseline.firstDeltaP95Ms <= 20,
    streamGap: normal.eventGapP95Ms - baseline.eventGapP95Ms <= 20 && slow.eventGapP95Ms - baseline.eventGapP95Ms <= 20,
    rss: normal.extraRssMiB <= 64 && slow.extraRssMiB <= 64, noCommitChildren: normal.spawnedCommitProcesses === 0 && slow.spawnedCommitProcesses === 0 };
  const report = { schemaVersion: 1, synthetic: true, realIMA: false, productionChanged: false,
    node: process.version, generatedAt: new Date().toISOString(), slowFsyncMs: 20000, cases, gates,
    limitations: ['Synthetic fixed streams on loopback; not an IMA response-time guarantee.',
      'CPU and RSS are Node process totals including worker threads; legacy child CPU/RSS is excluded.',
      'fsWriteUnits are OS counters, not physical SSD byte counts. No 3DGS load was generated.'] };
  const output = process.argv[2]; if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (Object.values(gates).some(value => !value)) process.exitCode = 1;
})().catch(() => { console.error('synthetic_benchmark_failed'); process.exitCode = 1; });
