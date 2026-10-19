'use strict';
// Scheduler-only, offline measurement. Never starts a server or loads env/state.
const { performance } = require('node:perf_hooks');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const elastic = process.argv.includes('--elastic');
const rounds = 30;
const tick = () => new Promise(resolve => setImmediate(resolve));
const p95 = values => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
async function main() {
  if (!global.gc) throw new Error('Run with --expose-gc');
  global.gc(); const initial = process.memoryUsage();
  let peakRSS = initial.rss, peakHeap = initial.heapUsed, writes = 0, calls = 0, maxActive = 0;
  const durations = []; const cpu = process.cpuUsage();
  for (let round = 0; round < rounds; round++) {
    let now = 1000, release;
    const hold = new Promise(resolve => { release = resolve; });
    const pool = new IMAWebAgentPool({ accounts: Array.from({ length: 5 }, (_, i) => ({ id: `mock-${i}`, maxConcurrent: 20, principalFingerprint: 'a'.repeat(64), modelId: 'mock-model', modelType: 3 })),
      elasticScheduling: { enabled: elastic, initialConcurrent: 20, accountLimits: Array.from({ length: 5 }, (_, i) => ({ accountId: `mock-${i}`, principalFingerprint: 'a'.repeat(64), mode: 'classic_knowledge', modelId: 'mock-model', modelType: 3, initialConcurrent: 20, validatedMaxConcurrent: 20 })) } }, {
      now: () => now, onAccountStateChange: () => { writes++; },
      clientFactory: () => ({ async *streamAsk() {
        calls++; await hold;
        for (let delta = 0; delta < 10; delta++) { yield { type: 'delta', text: 'fixture' }; await tick(); }
        yield { type: 'done' };
      } }),
    });
    const started = performance.now(); const jobs = [];
    for (let wave = 0; wave < 20; wave++) {
      for (let account = 0; account < 5; account++) {
        const options = { accountId: `mock-${account}`, sessionId: `mock-session-${wave}` };
        const lease = pool.tryAcquireSlot(options);
        if (!lease) throw new Error('mock admission failed');
        jobs.push((async () => { for await (const event of pool.streamAsk({ ...options, accountLease: lease.value })) void event; })());
      }
      now += 3000; await tick();
    }
    maxActive = Math.max(maxActive, pool.stats().activeRequests);
    const sample = process.memoryUsage(); peakRSS = Math.max(peakRSS, sample.rss); peakHeap = Math.max(peakHeap, sample.heapUsed);
    release(); await Promise.all(jobs);
    durations.push(performance.now() - started);
    if (pool.stats().activeRequests || pool.activeSessions.size || pool.slotWaiters || pool.cancelSlotWaiters.size) throw new Error('retained active work');
    pool.closeScheduling(); global.gc();
  }
  const usedCPU = process.cpuUsage(cpu); global.gc();
  console.log(JSON.stringify({ scope: 'offline scheduler-only; virtual start clock; not IMA or full-service performance',
    node: process.version, elastic, rounds, tasks: calls, maxActive, simulatedStateNotifications: writes,
    roundP95Ms: p95(durations), extraPeakRSSMiB: (peakRSS - initial.rss) / 1048576,
    extraPeakHeapMiB: (peakHeap - initial.heapUsed) / 1048576,
    retainedHeapDeltaMiB: (process.memoryUsage().heapUsed - initial.heapUsed) / 1048576,
    cpuUserMs: usedCPU.user / 1000, cpuSystemMs: usedCPU.system / 1000,
    realRequests: 0, productionChanged: false }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
