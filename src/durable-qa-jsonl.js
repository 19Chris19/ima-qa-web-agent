'use strict';

// Disk representation only: HTTP/SSE event bodies and event IDs stay unchanged.
// Exact repeated strings are interned, including reference excerpts. Different
// excerpts for the same URL remain different strings and citation relationships.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FORMAT = 'durable-qa-jsonl-v2';
const corrupt = () => Object.assign(new Error('task_store_unavailable'), { code: 'task_store_unavailable', statusCode: 503 });
const checksum = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (target, key, value) => Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });

function dictionary(previous) {
  const values = previous ? previous.values.slice() : [];
  return { values, ids: new Map(values.map((value, id) => [value, id])) };
}
function pack(value, table) {
  const refs = [], strings = [];
  let nodes = 0;
  const visit = (item, trail, depth) => {
    if (++nodes > 250000 || depth > 64) throw corrupt();
    if (typeof item === 'string' && item.length >= 128 && Buffer.byteLength(item) >= 256) {
      let id = table.ids.get(item);
      if (id === undefined) { id = table.values.length; table.ids.set(item, id); table.values.push(item); strings.push([id, item]); }
      refs.push([trail, id]); return null;
    }
    if (Array.isArray(item)) return item.map((child, i) => visit(child === undefined ? null : child, [...trail, i], depth + 1));
    if (plain(item)) {
      const result = {};
      for (const key of Object.keys(item)) if (item[key] !== undefined) own(result, key, visit(item[key], [...trail, key], depth + 1));
      return result;
    }
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    throw corrupt();
  };
  return { data: visit(value, [], 0), strings, refs };
}
function unpack(value, table, maxExpandedBytes) {
  if (!plain(value) || !Array.isArray(value.strings) || !Array.isArray(value.refs) || value.refs.length > 200000) throw corrupt();
  for (const pair of value.strings) {
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== table.values.length || typeof pair[1] !== 'string'
      || table.ids.has(pair[1])) throw corrupt();
    table.ids.set(pair[1], pair[0]); table.values.push(pair[1]);
  }
  const data = value.data;
  let expandedBytes = Buffer.byteLength(JSON.stringify(data));
  const stringBytes = new Map();
  if (expandedBytes > maxExpandedBytes) throw corrupt();
  for (const pair of value.refs) {
    if (!Array.isArray(pair) || pair.length !== 2 || !Array.isArray(pair[0]) || !pair[0].length || pair[0].length > 64
      || !Number.isSafeInteger(pair[1]) || pair[1] < 0 || pair[1] >= table.values.length) throw corrupt();
    const trail = pair[0]; let current = data;
    if (trail.some(key => typeof key !== 'string' && (!Number.isSafeInteger(key) || key < 0))) throw corrupt();
    if (!stringBytes.has(pair[1])) stringBytes.set(pair[1], Buffer.byteLength(JSON.stringify(table.values[pair[1]])));
    expandedBytes += stringBytes.get(pair[1]) - 4; // Replace the encoded null.
    if (expandedBytes > maxExpandedBytes) throw corrupt();
    for (const key of trail.slice(0, -1)) {
      if ((!plain(current) && !Array.isArray(current)) || !Object.hasOwn(current, key)) throw corrupt();
      current = current[key];
    }
    const key = trail.at(-1);
    if ((!plain(current) && !Array.isArray(current)) || !Object.hasOwn(current, key) || current[key] !== null) throw corrupt();
    own(current, key, table.values[pair[1]]);
  }
  return data;
}
function seal(value) { return { ...value, checksum: checksum(value) }; }
function verify(value) {
  if (!plain(value) || typeof value.checksum !== 'string') throw corrupt();
  const { checksum: saved, ...body } = value;
  if (saved !== checksum(body)) throw corrupt();
  return body;
}
function encoded(value) { return Buffer.from(JSON.stringify(value)); }
function header(task) { const { events, ...rest } = task; return rest; }
function changes(before, after) {
  const set = {}, remove = [];
  for (const key of Object.keys(after)) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) own(set, key, after[key]);
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) remove.push(key);
  return { set, remove };
}
function makeCheckpoint(task) {
  const table = dictionary(), epoch = crypto.randomUUID();
  const record = seal({ version: 2, format: FORMAT, epoch, payload: pack(task, table) });
  return { table, epoch, seq: 0, checkpointBytes: encoded(record).length, logBytes: 0, record };
}
function makeTransaction(task, previous, state) {
  const prefix = task.events.length >= previous.events.length && previous.events.every((event, i) => task.events[i] === event);
  const resetEvents = !prefix;
  const body = { ...changes(header(previous), header(task)), events: resetEvents ? task.events : task.events.slice(previous.events.length),
    ...(resetEvents ? { resetEvents: true } : {}) };
  const table = dictionary(state.table);
  const record = seal({ version: 2, format: FORMAT, epoch: state.epoch, seq: state.seq + 1, payload: pack(body, table) });
  const bytes = Buffer.concat([encoded(record), Buffer.from('\n')]);
  return { ...state, table, seq: state.seq + 1, logBytes: state.logBytes + bytes.length, bytes };
}
function readRegular(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw corrupt();
  return fs.readFileSync(file);
}
function loadTaskFile(file, { maxFileBytes = 2 * 1024 * 1024 + 65536,
  maxReplayBytes = 16 * 1024 * 1024 + 16384, repairTail = false } = {}) {
  const raw = readRegular(file, maxFileBytes);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw corrupt(); }
  if (value.version === 1) return { task: value, state: { legacy: true, checkpointBytes: raw.length, logBytes: 0 } };
  const checkpoint = verify(value);
  if (checkpoint.version !== 2 || checkpoint.format !== FORMAT || !/^[a-f0-9-]{36}$/u.test(checkpoint.epoch || '')) throw corrupt();
  const table = dictionary(); let task = unpack(checkpoint.payload, table, maxReplayBytes), seq = 0;
  if (!plain(task) || !Array.isArray(task.events)) throw corrupt();
  let eventBytes = task.events.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
  const checkReplay = () => { if (eventBytes + Buffer.byteLength(JSON.stringify(header(task))) > maxReplayBytes) throw corrupt(); };
  checkReplay();
  const logFile = `${file}l`; let log = Buffer.alloc(0);
  try { log = readRegular(logFile, maxFileBytes); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // A crash may leave a short UTF-8/JSON suffix. Only newline-terminated,
  // checksummed transactions are committed. Complete corrupt lines fail closed.
  const complete = log.lastIndexOf(10) + 1;
  let offset = 0, stale = false;
  while (offset < complete) {
    const end = log.indexOf(10, offset); let record;
    try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(log.subarray(offset, end))); } catch { throw corrupt(); }
    offset = end + 1;
    const body = verify(record);
    if (body.version !== 2 || body.format !== FORMAT) throw corrupt();
    // A new checkpoint can be durable before the old log is cleared. Old epochs
    // are covered by that checkpoint and cannot overwrite its newer state.
    if (body.epoch !== checkpoint.epoch) { stale = true; continue; }
    if (body.seq !== seq + 1) throw corrupt();
    const change = unpack(body.payload, table, maxReplayBytes);
    if (!plain(change) || !plain(change.set) || !Array.isArray(change.remove) || !Array.isArray(change.events)
      || change.remove.some(key => typeof key !== 'string' || key === 'events') || Object.hasOwn(change.set, 'events')
      || (change.resetEvents !== undefined && typeof change.resetEvents !== 'boolean')) throw corrupt();
    for (const key of change.remove) delete task[key];
    for (const [key, item] of Object.entries(change.set)) own(task, key, item);
    if (change.resetEvents) { task.events = []; eventBytes = 0; }
    for (const event of change.events) { task.events.push(event); eventBytes += Buffer.byteLength(JSON.stringify(event)); }
    checkReplay(); seq = body.seq;
  }
  // Validate every committed transaction before repairing an uncommitted suffix.
  // A stale-only log can be reclaimed after an interrupted checkpoint commit.
  let logBytes = complete;
  if (repairTail && stale && seq === 0) { clearLog(file); logBytes = 0; stale = false; }
  else if (complete !== log.length && repairTail) {
    const fd = fs.openSync(logFile, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
    try { fs.ftruncateSync(fd, complete); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return { task, state: { table, epoch: checkpoint.epoch, seq, checkpointBytes: raw.length, logBytes,
    ...(stale ? { needsCompaction: true } : {}) } };
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function appendTransaction(file, state, transaction) {
  const logFile = `${file}l`, existed = fs.existsSync(logFile);
  let fd, attemptedWrite = false;
  try {
    fd = fs.openSync(logFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size !== state.logBytes) throw corrupt();
    attemptedWrite = true;
    fs.writeFileSync(fd, transaction.bytes); fs.fsyncSync(fd);
    if (!existed) syncDirectory(path.dirname(file));
  } catch (error) {
    if (fd !== undefined && attemptedWrite) { try { fs.ftruncateSync(fd, state.logBytes); fs.fsyncSync(fd); } catch { /* Store closes on uncertain durability. */ } }
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function clearLog(file) {
  const logFile = `${file}l`;
  // Rename an empty log instead of truncating in place. The checkpoint epoch
  // already makes a stale old log harmless if the process dies between files.
  const temporary = `${logFile}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, logFile); syncDirectory(path.dirname(file)); }
  finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function backupLegacy(file) {
  const directory = path.join(path.dirname(file), '.legacy-v1');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw corrupt();
  const backup = path.join(directory, path.basename(file));
  try { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return; }
  fs.chmodSync(backup, 0o600);
  const fd = fs.openSync(backup, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(directory);
}
function readTaskRecord(file, options) { return loadTaskFile(file, options).task; }
module.exports = { FORMAT, dictionary, makeCheckpoint, makeTransaction, loadTaskFile, appendTransaction,
  clearLog, backupLegacy, readTaskRecord, header };
