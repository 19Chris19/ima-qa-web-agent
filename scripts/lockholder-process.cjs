const lockfile = require('proper-lockfile');

(async () => {
  const file = process.argv[2];
  await lockfile.lock(file, { stale: 10000, update: 2000 });
  process.stdout.write('locked\n');
  setInterval(() => {}, 1000);
})().catch(() => { process.exitCode = 1; });
