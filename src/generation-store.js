// Synchronous core for workers/offline tools. HTTP uses AsyncAccountDirectory.
const fs = require('node:fs');
const crypto = require('node:crypto');
const lockfile = require('proper-lockfile');
const path = require('node:path');

function conflict(code = 'account_store_generation_conflict') {
  return Object.assign(new Error(code === 'account_store_locked' ? '账号库正在更新，请稍后重试' : '账号状态已变化，请刷新后重试'), { code, statusCode: 409 });
}

function atomicPrivateWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('unsafe_store_file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const parent = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function commitStore(file, value) {
  file = path.resolve(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, JSON.stringify({ generation: 0 }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  let release;
  try {
    release = lockfile.lockSync(file, { stale: 10000, update: 2000, retries: 0 });
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    const generation = Number(disk.generation || 0);
    if (generation !== Number(value.generation || 0)) throw conflict();
    if (disk.generation === undefined) {
      try { fs.writeFileSync(`${file}.pre-generation-backup`, JSON.stringify(disk), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const next = { ...value, generation: generation + 1 };
    atomicPrivateWrite(file, JSON.stringify(next, null, 2));
    return next;
  } catch (error) {
    if (error.code === 'ELOCKED') throw conflict('account_store_locked');
    if (error.code === 'account_store_generation_conflict') throw error;
    throw Object.assign(new Error('账号库写入未完成'), { code: 'account_store_commit_failed', statusCode: 503 });
  } finally { release?.(); }
}

async function atomicPrivateWriteAsync(file, text) {
  const io = fs.promises;
  await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { const stat = await io.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('unsafe_store_file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await io.open(temp, 'wx', 0o600);
    await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
    await io.rename(temp, file);
    const parent = await io.open(path.dirname(file), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await handle?.close();
    await io.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function commitStoreAsync(file, value) {
  // Keep the worker's lock heartbeat runnable even while filesystem I/O waits.
  let release;
  try {
    release = await lockfile.lock(file, { stale: 10000, update: 2000, retries: { retries: 20, minTimeout: 25, maxTimeout: 100 } });
    const disk = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    const generation = Number(disk.generation || 0);
    if (generation !== Number(value.generation || 0)) throw conflict();
    if (disk.generation === undefined) {
      await fs.promises.writeFile(`${file}.pre-generation-backup`, JSON.stringify(disk), { flag: 'wx', mode: 0o600 })
        .catch(error => { if (error.code !== 'EEXIST') throw error; });
    }
    const next = { ...value, generation: generation + 1 };
    await atomicPrivateWriteAsync(file, JSON.stringify(next, null, 2)); return next;
  } catch (error) {
    if (error.code === 'ELOCKED') throw conflict('account_store_locked');
    if (error.code === 'account_store_generation_conflict') throw error;
    throw Object.assign(new Error('账号库写入未完成'), { code: 'account_store_commit_failed', statusCode: 503 });
  } finally { await release?.(); }
}

async function reconfirmStoreAsync(file, receipt) {
  const release = await lockfile.lock(file, { stale: 10000, update: 2000, retries: 0 });
  try {
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let value, actual;
    try {
      value = JSON.parse(await handle.readFile('utf8'));
      actual = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
      if (!receipt || ![receipt.before, receipt.after].includes(actual)) throw Object.assign(new Error('commit_outcome_unknown'), { code: 'commit_outcome_unknown' });
      await handle.sync();
    } finally { await handle.close(); }
    const parent = await fs.promises.open(path.dirname(file), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
    return { value, outcome: actual === receipt.after ? 'committed' : 'not_committed' };
  } finally { await release(); }
}

module.exports = { commitStore, commitStoreAsync, conflict, atomicPrivateWrite, atomicPrivateWriteAsync, reconfirmStoreAsync };
