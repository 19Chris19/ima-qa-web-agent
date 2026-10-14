'use strict';
// Synthetic local disk benchmark. Never reads runtime/env/accounts or calls IMA.
// Usage: node --expose-gc scripts/benchmark-task-journal.cjs [baseline-git-ref]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const root = path.resolve(__dirname, '..');
const baseline = process.argv[2] || 'ab67537461de7b4d92a08522d8be372f81a21049';
const modes = ['baseline-normal', 'jsonl-normal', 'jsonl-rich'];
const percentile = values => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] || 0;

async function run(mode) {
  let Store = require('../src/durable-qa-store').DurableQATaskStore;
  if (mode.startsWith('baseline')) {
    // Compile the trusted repository revision with its original sibling modules.
    const source = execFileSync('git', ['show', `${baseline}:src/durable-qa-store.js`], { cwd: root, encoding: 'utf8' });
    const filename = path.join(root, 'src', 'synthetic-baseline-store.js');
    const module = new Module(filename, moduleParent()); module.filename = filename;
    module.paths = Module._nodeModulePaths(path.dirname(filename)); module._compile(source, filename);
    Store = module.exports.DurableQATaskStore;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-journal-benchmark-'));
  const latencies = [], first = [], intervals = [], lags = [];
  let written = 0, calls = 0, physical = 0, logical = 0, peakRss = process.memoryUsage().rss;
  const write = fs.writeFileSync, cpu = process.cpuUsage(), started = performance.now();
  fs.writeFileSync = function(file, data, ...args) {
    const value = write.call(this, file, data, ...args);
    written += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data)); calls++; return value;
  };
  try {
    for (let round = 0; round < 30; round++) {
      const folder = path.join(directory, String(round));
      const store = new Store({ directory: folder });
      try {
        const { task } = store.create({ ownerKey: 'synthetic', scope: 'ordinary', key: 'synthetic',
          input: { conversationId: 'synthetic', question: 'synthetic' } });
        store.running(task.id);
        const rich = mode.endsWith('rich'), sources = [], citationMap = {};
        let previous = 0, seenText = false;
        const count = rich ? 155 : 30;
        for (let n = 0; n < count; n++) {
          const scheduled = performance.now(); await delay(2); lags.push(Math.max(0, performance.now() - scheduled - 2));
          const before = performance.now();
          if (n % (rich ? 4 : 5) === 0 && sources.length < (rich ? 33 : 6)) {
            const i = sources.length, page = i % 6;
            const source = { url: `https://example.org/${page}`, title: `Synthetic source ${page}`,
              snippet: `Excerpt ${page}: ` + '中文引用资料 '.repeat(rich ? 400 : 24) };
            sources.push(source); citationMap[`index:${i % 31 + 1}`] = { type: 'web', sources: [source] };
            store.append(task.id, 'sources', { sources: sources.slice(), citationMap: structuredClone(citationMap) });
          } else {
            store.append(task.id, 'delta', { text: 'Synthetic answer text.\n' });
            if (!seenText) { first.push(performance.now() - before); seenText = true; }
          }
          const after = performance.now(); latencies.push(after - before);
          if (previous) intervals.push(after - previous); previous = after;
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }
        store.finish(task.id, 'succeeded', { conversationId: 'synthetic' });
        logical = Buffer.byteLength(JSON.stringify(store.tasks.get(task.id)));
        physical = store.bytes.get(task.id);
      } finally { store.close(); fs.rmSync(folder, { recursive: true, force: true }); }
      global.gc?.();
    }
  } finally { fs.writeFileSync = write; fs.rmSync(directory, { recursive: true, force: true }); }
  const cpuTime = process.cpuUsage(cpu);
  return { mode, rounds: 30, elapsedMs: performance.now() - started,
    commitP95Ms: percentile(latencies), firstTextCommitP95Ms: percentile(first), eventIntervalP95Ms: percentile(intervals),
    timerLagP95Ms: percentile(lags), writtenBytes: written, writes: calls, lastTaskPhysicalBytes: physical,
    lastTaskLogicalBytes: logical, cpuMs: (cpuTime.user + cpuTime.system) / 1000, peakRssBytes: peakRss };
}
function moduleParent() { return module; }
if (process.argv[3]) run(process.argv[3]).then(result => process.stdout.write(JSON.stringify(result))).catch(() => { process.stderr.write('synthetic benchmark failed\n'); process.exitCode = 1; });
else {
  const results = modes.map(mode => JSON.parse(execFileSync(process.execPath, ['--expose-gc', __filename, baseline, mode], { cwd: root, encoding: 'utf8' })));
  process.stdout.write(JSON.stringify({ schemaVersion: 1, node: process.version, platform: process.platform, arch: process.arch,
    baseline, syntheticOnly: true, note: 'Synthetic local fsync timing; not IMA/network/model or browser latency. RSS is whole child process.', results }, null, 2) + '\n');
}
