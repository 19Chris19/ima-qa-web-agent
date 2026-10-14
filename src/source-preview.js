'use strict';
const { Worker } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { publicUrl, LIMITS } = require('./source-preview-network');
const textOnly = reason => ({ status: 'text_only', reason });
class SourcePreview {
  constructor({ enabled = false, directory, busy = () => false, now = Date.now,
    workerFile = path.join(__dirname, 'source-preview-worker.js'), idleMs = 60000 } = {}) {
    this.enabled = enabled; this.directory = directory; this.busy = busy; this.now = now;
    this.workerFile = workerFile; this.idleMs = idleMs;
    this.pending = new Map(); this.nextId = 0; this.active = null; this.worker = null; this.idle = null;
    this.urls = []; this.requests = []; this.imageReaders = 0;
    this.metrics = { jobs: 0, http: 0, hits: 0, shed: 0, errors: 0, maxRpcPending: 0, fetchBacklog: 0 };
  }
  workerRpc(op, data = {}, timeout = 3500) {
    if (this.closed || this.pending.size >= 32) { this.metrics.shed++; return Promise.reject(new Error('preview_unavailable')); }
    clearTimeout(this.idle);
    if (!this.worker) {
      const worker = this.worker = new Worker(this.workerFile, { workerData: { directory: this.directory }, env: {}, execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 } });
      worker.unref();
      worker.on('message', message => {
        if (message.op === 'permit') {
          this.trim(); const allowed = this.active?.id === message.id && !this.busy() && this.requests.length < 12;
          if (allowed) { this.requests.push(this.now()); this.metrics.http++; }
          worker.postMessage({ op: 'permit-result', permitId: message.permitId, allowed }); return;
        }
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
        this.scheduleIdle();
      });
      const fail = () => {
        if (this.worker !== worker) return;
        this.worker = null; this.metrics.errors++;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('preview_unavailable')); }
        this.pending.clear();
      };
      worker.once('error', fail); worker.once('exit', fail);
      worker.unref();
    }
    const id = ++this.nextId;
    return Object.assign(new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.worker?.postMessage({ op: 'cancel', id, reason: 'timeout' }); reject(new Error('preview_timeout')); this.scheduleIdle(); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.metrics.maxRpcPending = Math.max(this.metrics.maxRpcPending, this.pending.size);
      this.worker.postMessage({ id, op, ...data });
    }), { id });
  }
  scheduleIdle() {
    if (this.pending.size || this.active) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { const worker = this.worker; this.worker = null; void worker?.terminate(); }, this.idleMs);
    this.idle.unref();
  }
  trim() { const cutoff = this.now() - 60000; this.urls = this.urls.filter(t => t > cutoff); this.requests = this.requests.filter(t => t > cutoff); }
  async disabled() {
    try { await fs.lstat(path.join(this.directory, 'disabled')); return true; }
    catch (error) { return error.code !== 'ENOENT'; }
  }
  key(url) { return createHash('sha256').update(publicUrl(url).href).digest('hex'); }
  async preview(url, signal) {
    if (!this.enabled || !this.directory || this.closed) return textOnly('disabled');
    let key; try { key = this.key(url); } catch { return textOnly('unavailable'); }
    const deadline = performance.now() + LIMITS.timeout;
    try {
      const cached = await this.workerRpc('lookup', { key }, LIMITS.timeout);
      if (signal?.aborted) return textOnly('cancelled');
      if (cached) { this.metrics.hits++; return { status: cached.status }; }
      if (this.active?.key === key) return this.join(this.active, signal);
      this.trim();
      if (this.active || this.busy() || this.urls.length >= 6 || this.requests.length >= 12 || await this.disabled()) {
        this.metrics.shed++; return textOnly('busy');
      }
      // Recheck after the asynchronous disable-file read: no implicit backlog.
      if (this.active) return this.active.key === key ? this.join(this.active, signal) : textOnly('busy');
      this.urls.push(this.now()); this.metrics.jobs++;
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) return textOnly('unavailable');
      const rpc = this.workerRpc('fetch', { key, url }, remaining);
      const job = this.active = { key, id: rpc.id, waiters: 0, promise: rpc.then(result => ({ status: result?.status || 'text_only' }), () => textOnly('unavailable')) };
      job.promise = job.promise.finally(() => { if (this.active === job) this.active = null; this.scheduleIdle(); });
      return this.join(job, signal);
    } catch { return textOnly('unavailable'); }
  }
  join(job, signal) {
    job.waiters++;
    return new Promise(resolve => {
      let settled = false;
      const finish = result => {
        if (settled) return; settled = true; signal?.removeEventListener('abort', abort);
        if (--job.waiters === 0 && this.active === job) this.worker?.postMessage({ op: 'cancel', id: job.id });
        resolve(result);
      };
      const abort = () => finish(textOnly('cancelled'));
      job.promise.then(finish); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  async image(url) {
    if (!this.enabled || this.closed || this.imageReaders >= 8) return null;
    this.imageReaders++;
    try { const key = this.key(url); return await this.workerRpc('image', { key }); }
    catch { return null; } finally { this.imageReaders--; }
  }
  async close() {
    this.closed = true; clearTimeout(this.idle);
    const worker = this.worker;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('preview_closed')); }
    this.pending.clear(); this.worker = null; await worker?.terminate();
  }
}
module.exports = { SourcePreview };
