'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const lockfile = require('proper-lockfile');
const { validApplicationKey } = require('./application-identity');
const { pairReceipt, validPairReceipt } = require('./bot-pair-routing');
const jsonl = require('./durable-qa-jsonl');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'indeterminate']);
const RETENTION_MS = 24 * 60 * 60 * 1000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fault = (code, statusCode = 503) => Object.assign(new Error(code), { code, statusCode });
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

// Atomic checkpoints/history files. JSONL appends separately fsync before publish.
function writePrivateJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

class DurableQATaskStore {
  constructor({ directory, now = Date.now, maxTasks = 500, maxReceipts = 10000, maxBytes = 128 * 1024 * 1024,
    maxTaskBytes = 2 * 1024 * 1024, maxEvents = 10000, maxTaskReplayBytes = 16 * 1024 * 1024,
    maxReplayBytes = 128 * 1024 * 1024, maxUpstreamBytes = 16 * 1024 * 1024, maxUpstreamEvents = 100000, onUnavailable = () => {} }) {
    this.directory = path.resolve(directory);
    this.now = now;
    this.maxTasks = maxTasks;
    this.maxReceipts = maxReceipts;
    this.maxBytes = maxBytes;
    this.maxTaskBytes = maxTaskBytes;
    this.maxEvents = maxEvents;
    this.maxTaskReplayBytes = maxTaskReplayBytes;
    this.maxReplayBytes = maxReplayBytes;
    this.maxUpstreamBytes = maxUpstreamBytes;
    this.maxUpstreamEvents = maxUpstreamEvents;
    this.onUnavailable = onUnavailable;
    this.tasks = new Map();
    this.bytes = new Map();
    this.states = new Map();
    this.replayBytes = new Map();
    this.eventBytes = new WeakMap();
    this.capacityReasons = new Map();
    this.metrics = { appendBytes: 0, checkpointBytes: 0, appends: 0, checkpoints: 0 };
    this.available = false;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.directory, 0o700);
      // A process-lifetime lease, not a per-write lock. Compromise fails closed.
      this.release = lockfile.lockSync(this.directory, { realpath: true, stale: 30000, update: 5000,
        onCompromised: () => this.unavailable(), retries: 0 });
      for (const name of fs.readdirSync(this.directory)) {
        if (/^[a-f0-9-]{36}\.jsonl?\.[a-f0-9-]{36}\.tmp$/u.test(name)) {
          fs.unlinkSync(path.join(this.directory, name));
          continue;
        }
        if (/^[a-f0-9-]{36}\.jsonl$/u.test(name) && !fs.existsSync(path.join(this.directory, name.slice(0, -1)))) {
          throw fault('task_store_unavailable'); // Never discard an orphan execution journal.
        }
        if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
        const file = path.join(this.directory, name);
        if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > maxTaskBytes + 65536) throw fault('task_store_unavailable');
        const { task, state } = jsonl.loadTaskFile(file, { maxFileBytes: maxTaskBytes + 65536,
          maxReplayBytes: maxTaskReplayBytes + 16384, repairTail: true });
        if (task.version !== 1 || `${task.id}.json` !== name || !Array.isArray(task.events) ||
            !['queued', 'running', ...TERMINAL].includes(task.status) ||
            task.events.some((e, i) => e.id !== i + 1) || !task.input || typeof task.ownerKey !== 'string' ||
            !['ordinary', 'internal'].includes(task.scope) || !task.trace ||
            (task.applicationKey !== undefined && !validApplicationKey(task.applicationKey)) ||
            (task.pairReceipt !== undefined && !validPairReceipt(task.pairReceipt)) ||
            ![task.keyHash, task.requestKey, task.fingerprint].every(value => /^[a-f0-9]{64}$/u.test(value)) ||
            typeof task.input.conversationId !== 'string' || (!task.eventsExpired && typeof task.input.question !== 'string')) {
          throw fault('task_store_unavailable');
        }
        task.events.forEach(freeze);
        this.tasks.set(task.id, task); this.states.set(task.id, state);
        this.bytes.set(task.id, state.checkpointBytes + state.logBytes);
        const replay = this.measureReplay(task);
        if (replay > maxTaskReplayBytes + 16384 || task.events.length > maxEvents + 2) throw fault('task_store_unavailable');
        this.replayBytes.set(task.id, replay);
        if (this.tasks.size > maxReceipts || this.totalBytes() > maxBytes + maxTasks * 16384
          || this.totalReplayBytes() > maxReplayBytes + maxTasks * 16384) throw fault('task_store_unavailable');
      }
      this.available = true;
      // Legacy receipts keep their original owner/key/status; migration cannot dispatch work.
      for (const task of this.tasks.values()) {
        if (task.applicationKey === undefined || (!task.pairReceipt && task.input.botContract?.parallelPairRef)) {
          this.update(task.id, current => { current.applicationKey ??= current.scope; }, true);
        }
      }
      this.prune();
    } catch {
      this.release?.();
      this.release = null;
      throw fault('task_store_unavailable');
    }
  }

  ensure() { if (!this.available) throw fault('task_store_unavailable'); }
  unavailable() { this.available = false; this.onUnavailable(); }
  totalBytes() { return [...this.bytes.values()].reduce((a, b) => a + b, 0); }
  totalReplayBytes() { return [...this.replayBytes.values()].reduce((a, b) => a + b, 0); }
  measureReplay(task) {
    let bytes = Buffer.byteLength(JSON.stringify(jsonl.header(task)));
    for (const event of task.events) {
      if (!this.eventBytes.has(event)) this.eventBytes.set(event, Buffer.byteLength(JSON.stringify(event)));
      bytes += this.eventBytes.get(event);
    }
    return bytes;
  }
  capacity(id, kind) {
    this.capacityReasons.set(id, kind);
    return Object.assign(fault('task_capacity', 429), { capacityKind: kind });
  }
  readPersisted(id) { return jsonl.readTaskRecord(path.join(this.directory, `${id}.json`), {
    maxFileBytes: this.maxTaskBytes + 65536, maxReplayBytes: this.maxTaskReplayBytes + 16384 }); }
  publicTask(task) {
    return { id: task.id, conversationId: task.input.conversationId, status: task.status,
      lastEventId: task.lastEventId ?? task.events.length, requestKey: task.requestKey,
      ...(typeof task.input.question === 'string' ? { question: task.input.question,
        sourceIntent: task.input.source_intent === 'web_requested' ? 'web' : 'knowledge' } : {}),
      eventsExpired: Boolean(task.eventsExpired),
      ...(task.status === 'succeeded' ? { history: { conversationId: task.input.conversationId, taskId: task.id } } : {}),
      trace: structuredClone(task.trace),
      createdAt: task.createdAt, updatedAt: task.updatedAt, expiresAt: task.expiresAt || null };
  }

  owned(id, ownerKey, scope, applicationKey = scope) {
    this.ensure();
    this.prune();
    const task = this.tasks.get(id);
    if (!task || task.ownerKey !== ownerKey || task.scope !== scope || task.applicationKey !== applicationKey) throw fault('task_not_found', 404);
    return task;
  }

  list(ownerKey, scope, requestKey, conversationId, applicationKey = scope) {
    this.ensure();
    this.prune();
    return [...this.tasks.values()].filter(task => task.ownerKey === ownerKey && task.scope === scope && task.applicationKey === applicationKey &&
      (!requestKey || task.requestKey === requestKey) && (!conversationId || task.input.conversationId === conversationId))
      .sort((a, b) => b.createdAt - a.createdAt).map(task => this.publicTask(task));
  }

  find(ownerKey, scope, key, input, applicationKey = scope) {
    this.ensure();
    this.prune();
    const keyHash = hash(key);
    const task = [...this.tasks.values()].find(t => t.ownerKey === ownerKey && t.scope === scope && t.applicationKey === applicationKey && t.keyHash === keyHash);
    if (task && task.fingerprint !== hash(JSON.stringify(input))) throw fault('idempotency_conflict', 409);
    return task;
  }

  create({ ownerKey, scope, key, input, applicationKey = scope }) {
    if (!validApplicationKey(applicationKey)) throw fault('invalid_application_identity', 400);
    const existing = this.find(ownerKey, scope, key, input, applicationKey);
    if (existing) return { task: existing, isNew: false };
    if (this.tasks.size >= this.maxReceipts || [...this.tasks.values()].filter(task => !task.eventsExpired).length >= this.maxTasks) throw this.capacity('admission', 'task_receipts');
    const task = { version: 1, id: crypto.randomUUID(), ownerKey, scope, applicationKey, keyHash: hash(key),
      requestKey: /^[a-f0-9]{64}$/u.test(key) ? key : hash(key),
      fingerprint: hash(JSON.stringify(input)), input, status: 'queued', createdAt: this.now(), updatedAt: this.now(),
      trace: { receivedAt: this.now(), dispatchedAt: null, firstUpstreamEventAt: null, lastUpstreamActivityAt: null,
        lastUpstreamEventAt: null, rawUpstreamBytes: 0, rawUpstreamChunks: 0,
        terminalAt: null, terminalReason: null, subscriptions: 0, disconnects: 0, rotations: 0 }, events: [] };
    this.addEvent(task, 'task.status', { status: 'queued' });
    this.save(task);
    return { task, isNew: true };
  }

  addEvent(task, event, data) { task.events.push(freeze({ id: task.events.length + 1, event, data: structuredClone(data) })); }
  update(id, mutate, reserve = false) {
    this.ensure();
    const previous = this.tasks.get(id);
    if (!previous) throw fault('task_not_found', 404);
    // Published events are immutable. Copy the mutable header and event pointers,
    // not every cumulative source list on every answer token batch.
    const task = { ...structuredClone(jsonl.header(previous)), events: previous.events.slice() };
    mutate(task);
    task.updatedAt = this.now();
    this.save(task, reserve);
    return task;
  }

  append(id, event, data) {
    return this.update(id, task => {
      if (TERMINAL.has(task.status)) throw fault('task_terminal', 409);
      this.addEvent(task, event, data);
    });
  }

  running(id) {
    return this.update(id, task => {
      if (task.status !== 'queued') throw fault('task_terminal', 409);
      task.status = 'running';
      task.trace.dispatchedAt = this.now();
      this.addEvent(task, 'task.status', { status: 'running' });
    });
  }

  journal(id, completion) { return this.update(id, task => { task.completion = completion; }); }

  finish(id, status, data) {
    return this.update(id, task => {
      if (TERMINAL.has(task.status)) return;
      task.status = status;
      task.expiresAt = this.now() + RETENTION_MS;
      task.trace.terminalAt = this.now();
      task.trace.terminalReason = status === 'succeeded' ? 'completed' : data.failureReason || status;
      if (this.capacityReasons.has(id)) task.trace.capacityKind = this.capacityReasons.get(id);
      delete task.completion;
      this.addEvent(task, status === 'succeeded' ? 'done' : 'error', data);
      this.addEvent(task, 'task.status', { status });
    }, true);
  }

  save(task, reserve = false) {
    this.ensure();
    const pair = pairReceipt(task);
    if (pair) {
      const accountId = task.upstreamBinding?.accountId || task.completion?.upstream?.accountId || pair.accountId;
      task.pairReceipt = { ...pair, ...(accountId ? { accountId } : {}) };
      if (!validPairReceipt(task.pairReceipt)) throw fault('task_store_unavailable');
    }
    const replay = this.measureReplay(task), allowance = reserve ? 16384 : 0;
    if (task.events.length > this.maxEvents + (reserve ? 2 : 0)) throw this.capacity(task.id, 'task_events');
    if (replay > this.maxTaskReplayBytes + allowance) throw this.capacity(task.id, 'task_replay_bytes');
    if (this.totalReplayBytes() - (this.replayBytes.get(task.id) || 0) + replay > this.maxReplayBytes + (reserve ? this.maxTasks * 16384 : 0)) throw this.capacity(task.id, 'store_replay_bytes');
    const previous = this.tasks.get(task.id), state = this.states.get(task.id);
    let next = previous && state && !state.legacy ? jsonl.makeTransaction(task, previous, state) : null;
    const exceeds = candidate => candidate.checkpointBytes + candidate.logBytes > this.maxTaskBytes + allowance
      || this.totalBytes() - (this.bytes.get(task.id) || 0) + candidate.checkpointBytes + candidate.logBytes > this.maxBytes + (reserve ? this.maxTasks * 16384 : 0);
    // Pressure compaction removes obsolete header updates, retaining every event
    // and cursor. Pruning also removes expired dictionary strings from disk.
    if (!next || state?.needsCompaction || exceeds(next) || task.events.length < (previous?.events.length || 0)) next = jsonl.makeCheckpoint(task);
    if (exceeds(next)) throw this.capacity(task.id, next.checkpointBytes + next.logBytes > this.maxTaskBytes + allowance ? 'task_record_bytes' : 'store_record_bytes');
    const file = path.join(this.directory, `${task.id}.json`);
    try {
      if (next.record) {
        if (state?.legacy) jsonl.backupLegacy(file);
        writePrivateJson(file, next.record); jsonl.clearLog(file);
        this.metrics.checkpointBytes += next.checkpointBytes; this.metrics.checkpoints++;
      } else {
        jsonl.appendTransaction(file, state, next);
        this.metrics.appendBytes += next.bytes.length; this.metrics.appends++;
      }
    } catch { this.unavailable(); throw fault('task_store_unavailable'); }
    delete next.record; delete next.bytes;
    this.tasks.set(task.id, task); this.states.set(task.id, next);
    this.bytes.set(task.id, next.checkpointBytes + next.logBytes); this.replayBytes.set(task.id, replay);
  }

  prune() {
    this.ensure();
    for (const [id, task] of this.tasks) {
      if (!TERMINAL.has(task.status) || task.eventsExpired || task.expiresAt > this.now()) continue;
      this.update(id, receipt => {
        receipt.lastEventId = receipt.events.length;
        receipt.events = [];
        receipt.eventsExpired = true;
        receipt.input = { conversationId: receipt.input.conversationId };
      }, true);
    }
  }

  close() { this.available = false; this.release?.(); this.release = null; }
}

module.exports = { DurableQATaskStore, TERMINAL, RETENTION_MS, writePrivateJson, fault, hash, readTaskRecord: jsonl.readTaskRecord };
