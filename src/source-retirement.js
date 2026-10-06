const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code });
const encode = value => JSON.stringify(value, null, 2) + '\n';
const markerPath = store => `${fs.realpathSync(store)}.retirement.json`;

function readRetirement(store) {
  const file = markerPath(store);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw fail('transfer_retirement_invalid');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const validHash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
    if (value.version !== 1 || !validHash(value.transaction) ||
        !Array.isArray(value.completed) || value.completed.length > 1000 || !value.completed.every(validHash) ||
        !['sealed', 'applied', 'rolling_back', 'rolled_back'].includes(value.phase) ||
        value.state !== (value.phase === 'rolled_back' ? 'released' : 'retired') ||
        (value.phase === 'rolling_back' && (!validHash(value.before) || !validHash(value.after)))) {
      throw fail('transfer_retirement_invalid');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fail('transfer_retirement_invalid');
  }
}

function durableWrite(file, raw) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function assertNotRetired(store) {
  // A new store has no retirement marker yet; use its canonical parent.
  if (!fs.existsSync(store)) {
    const file = path.join(fs.realpathSync(path.dirname(store)), `${path.basename(store)}.retirement.json`);
    try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; }
    throw fail('account_store_retired');
  }
  const marker = readRetirement(store);
  if (marker && marker.state !== 'released') throw fail('account_store_retired');
}

module.exports = { readRetirement, markerPath, durableWrite, assertNotRetired, encode };
