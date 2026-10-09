'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const lockfile = require('proper-lockfile');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'indeterminate']);
const RETENTION_MS = 24 * 60 * 60 * 1000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fault = (code, statusCode = 503) => Object.assign(new Error(code), { code, statusCode });

// Publish only after rename + directory fsync. Never expose partially written records.
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
    maxTaskBytes = 2 * 1024 * 1024, maxEvents = 10000, onUnavailable = () => {} }) {
    this.directory = path.resolve(directory);
    this.now = now;
    this.maxTasks = maxTasks;
    this.maxReceipts = maxReceipts;
    this.maxBytes = maxBytes;
    this.maxTaskBytes = maxTaskBytes;
    this.maxEvents = maxEvents;
    this.onUnavailable = onUnavailable;
    this.tasks = new Map();
    this.bytes = new Map();
    this.available = false;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.directory, 0o700);
      // A process-lifetime lease, not a per-write lock. Compromise fails closed.
      this.release = lockfile.lockSync(this.directory, { realpath: true, stale: 30000, update: 5000,
        onCompromised: () => this.unavailable(), retries: 0 });
      for (const name of fs.readdirSync(this.directory)) {
        if (/^[a-f0-9-]{36}\.json\.[a-f0-9-]{36}\.tmp$/u.test(name)) {
          fs.unlinkSync(path.join(this.directory, name));
          continue;
        }
        if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
        const file = path.join(this.directory, name);
        if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > maxTaskBytes + 65536) throw fault('task_store_unavailable');
        const raw = fs.readFileSync(file, 'utf8');
        const task = JSON.parse(raw);
        if (task.version !== 1 || `${task.id}.json` !== name || !Array.isArray(task.events) ||
            !['queued', 'running', ...TERMINAL].includes(task.status) ||
            task.events.some((e, i) => e.id !== i + 1) || !task.input || typeof task.ownerKey !== 'string' ||
            !['ordinary', 'internal'].includes(task.scope) || !task.trace ||
            ![task.keyHash, task.requestKey, task.fingerprint].every(value => /^[a-f0-9]{64}$/u.test(value)) ||
            typeof task.input.conversationId !== 'string' || (!task.eventsExpired && typeof task.input.question !== 'string')) {
          throw fault('task_store_unavailable');
        }
        this.tasks.set(task.id, task);
        this.bytes.set(task.id, Buffer.byteLength(raw));
        if (this.tasks.size > maxReceipts || this.totalBytes() > maxBytes + maxTasks * 16384) throw fault('task_store_unavailable');
      }
      this.available = true;
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

  owned(id, ownerKey, scope) {
    this.ensure();
    this.prune();
    const task = this.tasks.get(id);
    if (!task || task.ownerKey !== ownerKey || task.scope !== scope) throw fault('task_not_found', 404);
    return task;
  }

  list(ownerKey, scope, requestKey, conversationId) {
    this.ensure();
    this.prune();
    return [...this.tasks.values()].filter(task => task.ownerKey === ownerKey && task.scope === scope &&
      (!requestKey || task.requestKey === requestKey) && (!conversationId || task.input.conversationId === conversationId))
      .sort((a, b) => b.createdAt - a.createdAt).map(task => this.publicTask(task));
  }

  find(ownerKey, scope, key, input) {
    this.ensure();
    this.prune();
    const keyHash = hash(key);
    const task = [...this.tasks.values()].find(t => t.ownerKey === ownerKey && t.scope === scope && t.keyHash === keyHash);
    if (task && task.fingerprint !== hash(JSON.stringify(input))) throw fault('idempotency_conflict', 409);
    return task;
  }

  create({ ownerKey, scope, key, input }) {
    const existing = this.find(ownerKey, scope, key, input);
    if (existing) return { task: existing, isNew: false };
    if (this.tasks.size >= this.maxReceipts || [...this.tasks.values()].filter(task => !task.eventsExpired).length >= this.maxTasks) throw fault('task_capacity', 429);
    const task = { version: 1, id: crypto.randomUUID(), ownerKey, scope, keyHash: hash(key),
      requestKey: /^[a-f0-9]{64}$/u.test(key) ? key : hash(key),
      fingerprint: hash(JSON.stringify(input)), input, status: 'queued', createdAt: this.now(), updatedAt: this.now(),
      trace: { receivedAt: this.now(), dispatchedAt: null, firstUpstreamEventAt: null, lastUpstreamActivityAt: null,
        terminalAt: null, terminalReason: null, subscriptions: 0, disconnects: 0, rotations: 0 }, events: [] };
    this.addEvent(task, 'task.status', { status: 'queued' });
    this.save(task);
    return { task, isNew: true };
  }

  addEvent(task, event, data) { task.events.push({ id: task.events.length + 1, event, data }); }
  update(id, mutate, reserve = false) {
    this.ensure();
    const task = structuredClone(this.tasks.get(id));
    if (!task) throw fault('task_not_found', 404);
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
      delete task.completion;
      this.addEvent(task, status === 'succeeded' ? 'done' : 'error', data);
      this.addEvent(task, 'task.status', { status });
    }, true);
  }

  save(task, reserve = false) {
    this.ensure();
    const size = Buffer.byteLength(JSON.stringify(task));
    if (size > this.maxTaskBytes + (reserve ? 16384 : 0) || task.events.length > this.maxEvents + (reserve ? 2 : 0) ||
        this.totalBytes() - (this.bytes.get(task.id) || 0) + size > this.maxBytes + (reserve ? this.maxTasks * 16384 : 0)) {
      throw fault('task_capacity', 429);
    }
    try { writePrivateJson(path.join(this.directory, `${task.id}.json`), task); }
    catch { this.unavailable(); throw fault('task_store_unavailable'); }
    this.tasks.set(task.id, task);
    this.bytes.set(task.id, size);
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

module.exports = { DurableQATaskStore, TERMINAL, RETENTION_MS, writePrivateJson, fault, hash };
