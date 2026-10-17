// Compatibility stdin adapter for offline tooling; the service keeps one worker.
const fs = require('node:fs');
const { commitStore } = require('./generation-store');
try {
  const { file, value } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const next = commitStore(file, value);
  process.stdout.write(JSON.stringify({ ok: true, generation: next.generation }));
} catch (error) {
  const code = ['account_store_generation_conflict', 'account_store_locked'].includes(error.code)
    ? error.code : 'account_store_commit_failed';
  process.stdout.write(JSON.stringify({ ok: false, code })); process.exitCode = 1;
}
