const fs = require('node:fs');
const path = require('node:path');
const lockfile = require('proper-lockfile');

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const file = path.resolve(input.file);
  const value = input.value;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, JSON.stringify({ generation: 0 }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const release = await lockfile.lock(file, { stale: 10000, update: 2000, retries: { retries: 20, minTimeout: 25, maxTimeout: 100 } });
  try {
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    const generation = Number(disk.generation || 0);
    if (generation !== Number(value.generation || 0)) throw Object.assign(new Error(), { code: 'account_store_generation_conflict' });
    if (disk.generation === undefined) {
      const backup = `${file}.pre-generation-backup`;
      try { fs.writeFileSync(backup, JSON.stringify(disk), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const next = { ...value, generation: generation + 1 };
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, file);
      try { fs.chmodSync(file, 0o600); } catch {}
    } finally {
      try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    process.stdout.write(JSON.stringify({ ok: true, generation: next.generation }));
  } finally {
    await release();
  }
}

main().catch(error => {
  const code = ['account_store_generation_conflict', 'ELOCKED'].includes(error.code)
    ? error.code === 'ELOCKED' ? 'account_store_locked' : error.code
    : 'account_store_commit_failed';
  process.stdout.write(JSON.stringify({ ok: false, code }));
  process.exitCode = 1;
});
