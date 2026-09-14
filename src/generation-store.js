const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function conflict(code = 'account_store_generation_conflict') {
  return Object.assign(new Error(code === 'account_store_locked' ? '账号库正在更新，请稍后重试' : '账号状态已变化，请刷新后重试'), { code, statusCode: 409 });
}

function commitStore(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize reclamation so two contenders cannot unlink a newly acquired lock.
    let reaper;
    try {
      reaper = fs.openSync(`${lock}.reaper`, 'wx', 0o600);
      const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (probe) { if (probe.code === 'ESRCH') fs.unlinkSync(lock); }
      }
    } catch {} finally {
      if (reaper !== undefined) {
        fs.closeSync(reaper);
        fs.unlinkSync(`${lock}.reaper`);
      }
    }
    throw conflict('account_store_locked');
  }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    const disk = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    if (Number(disk?.generation || 0) !== Number(value.generation || 0)) throw conflict();
    if (disk && disk.generation === undefined) {
      const backup = `${file}.pre-generation-backup`;
      try { fs.writeFileSync(backup, JSON.stringify(disk), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const next = { ...value, generation: Number(value.generation || 0) + 1 };
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
    return next;
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
    try { fs.unlinkSync(temp); } catch {}
  }
}
module.exports = { commitStore, conflict };
