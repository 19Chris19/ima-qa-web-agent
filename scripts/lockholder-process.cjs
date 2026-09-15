const lockfile = require('proper-lockfile');

(async () => {
  const file = process.argv[2];
  const release = await lockfile.lock(file, { stale: 10000, update: 2000 });
  process.stdout.write('locked\n');
  await new Promise(() => {});
  await release();
})().catch(() => { process.exitCode = 1; });
