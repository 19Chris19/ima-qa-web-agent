'use strict';
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const readerConfig = require('./source-reader-config');
const { hash } = require('./knowledge-evidence');
const fail = (code, statusCode = 503) => Object.assign(new Error(code), { code, statusCode });
const BUDGET = Object.freeze({ timeoutMs: 10000, pageCharacters: 8000, newReadsPerMinute: 6,
  cacheBytes: 8 * 1024 * 1024, snapshots: 16, retentionMs: 5 * 60000 });
class SourceReader {
  constructor(config, { workerPath = path.join(__dirname, 'source-reader-worker.js'), timeoutMs = BUDGET.timeoutMs, idleMs = 60000, now = Date.now } = {}) {
    this.config = readerConfig.validate(config); this.workerPath = workerPath; this.timeoutMs = Math.min(timeoutMs, BUDGET.timeoutMs);
    this.idleMs = idleMs; this.snapshots = new Map(); this.cacheBytes = 0; this.metrics = { reads: 0, rejected: 0, workerFailures: 0 };
    this.now = now; this.admissions = [];
  }
  binding(scope, applicationKey) {
    const app = applicationKey?.startsWith('application:') ? applicationKey.slice(12) : '';
    return this.config.readers.find(reader => reader.scopeRef === scope && reader.applications.includes(app));
  }
  status(scope, applicationKey) {
    const reader = this.binding(scope, applicationKey);
    return { readConfigured: Boolean(reader), permissionCheck: 'per_new_read', pdfEnabled: this.config.pdfEnabled,
      ...(reader ? { identityPolicy: reader.identity.mode } : {}) };
  }
  state(material, scope, applicationKey) {
    const reader = this.binding(scope, applicationKey);
    if (!reader) return 'not_configured';
    return readerConfig.materialId(reader, material) ? 'configured_not_read' : 'identity_unverified';
  }
  run(payload, signal) {
    if (this.closed) return Promise.reject(fail('source_reader_closed'));
    if (this.pending || this.stopping) { this.metrics.rejected++; return Promise.reject(fail('source_reader_busy', 429)); }
    if (signal?.aborted) return Promise.reject(fail('source_read_cancelled', 499));
    clearTimeout(this.idleTimer);
    if (!this.worker) {
      const worker = new Worker(this.workerPath, { resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
      this.worker = worker; worker.unref();
      worker.on('message', message => {
        const pending = this.pending;
        if (worker !== this.worker || !pending || message.id !== pending.id) return;
        pending.finish(message.error ? fail(message.error) : null, message.value);
      });
      const failed = () => {
        if (worker !== this.worker) return;
        this.worker = null; this.metrics.workerFailures++;
        this.terminate(worker);
        this.pending?.finish(fail('source_reader_failed'));
      };
      worker.on('error', failed); worker.on('exit', failed);
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID(), worker = this.worker;
      const stop = error => { if (worker === this.worker) this.worker = null; this.terminate(worker); finish(error); };
      const abort = () => stop(fail('source_read_cancelled', 499));
      const timer = setTimeout(() => stop(fail('source_read_timeout', 504)), this.timeoutMs);
      const finish = (error, value) => {
        if (this.pending?.id !== id) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending = null;
        if (this.worker) { this.idleTimer = setTimeout(() => { const idle = this.worker; this.worker = null; this.terminate(idle); }, this.idleMs); this.idleTimer.unref(); }
        if (error) reject(error); else resolve(value);
      };
      this.pending = { id, finish }; signal?.addEventListener('abort', abort, { once: true });
      try { worker.postMessage({ id, payload }); } catch { stop(fail('source_reader_failed')); }
      if (signal?.aborted) abort();
    });
  }
  terminate(worker) {
    if (!worker) return;
    const stopping = worker.terminate().catch(() => {});
    this.stopping = stopping;
    void stopping.finally(() => { if (this.stopping === stopping) this.stopping = null; });
  }
  prune(now = this.now()) {
    for (const [id, item] of this.snapshots) if (item.expiresAt <= now) this.remove(id);
  }
  remove(id) { const item = this.snapshots.get(id); if (item) { this.cacheBytes -= item.bytes; this.snapshots.delete(id); } }
  async read(context, { cursor, signal } = {}) {
    const reader = this.binding(context.scopeRef, context.applicationKey);
    if (!reader) throw fail('source_read_not_configured', 409);
    const mediaId = readerConfig.materialId(reader, context.material);
    if (!mediaId) throw fail('source_identity_unverified', 409);
    const binding = hash(JSON.stringify([context.owner, context.applicationKey, context.taskId, context.citationKey, context.sourceRef, readerConfig.fingerprint(reader)]));
    this.prune(); let snapshot, offset = 0;
    if (cursor !== undefined) {
      let parsed;
      try {
        if (typeof cursor !== 'string' || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error();
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (Object.keys(parsed).sort().join(',') !== 'offset,readId' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error();
      } catch { throw fail('source_cursor_invalid', 400); }
      snapshot = this.snapshots.get(parsed.readId); offset = parsed.offset;
      if (!snapshot || snapshot.binding !== binding || offset > snapshot.value.text.length) throw fail('source_read_expired', 410);
    } else {
      if (this.pending || this.stopping) throw fail('source_reader_busy', 429);
      this.admissions = this.admissions.filter(time => time > this.now() - 60000);
      if (this.admissions.length >= BUDGET.newReadsPerMinute) throw fail('source_read_rate_limited', 429);
      this.admissions.push(this.now());
      const value = await this.run({ kind: 'read', reader: { clientId: reader.clientId, apiKey: reader.apiKey }, mediaId, pdfEnabled: this.config.pdfEnabled }, signal);
      if (signal?.aborted) throw fail('source_read_cancelled', 499);
      if (!value || typeof value.text !== 'string' || value.text.length > 128000 || value.sha256 !== hash(value.text)
        || typeof value.contentComplete !== 'boolean' || typeof value.extractionTruncated !== 'boolean') throw fail('source_reader_failed');
      const keys = ['text', 'sha256', 'rawSha256', 'format', 'contentComplete', 'extractionTruncated', 'extractionScope', 'extractedCharacters'];
      const safeValue = Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
      const bytes = Buffer.byteLength(value.text), readId = randomUUID();
      snapshot = { readId, value: safeValue, binding, bytes, readAt: new Date(this.now()).toISOString(), expiresAt: this.now() + BUDGET.retentionMs };
      while (this.snapshots.size >= BUDGET.snapshots || this.cacheBytes + bytes > BUDGET.cacheBytes) this.remove(this.snapshots.keys().next().value);
      this.snapshots.set(readId, snapshot); this.cacheBytes += bytes; this.metrics.reads++;
    }
    let end = Math.min(snapshot.value.text.length, offset + BUDGET.pageCharacters);
    if (end < snapshot.value.text.length && /[\uD800-\uDBFF]/u.test(snapshot.value.text[end - 1]) && /[\uDC00-\uDFFF]/u.test(snapshot.value.text[end])) end--;
    const nextCursor = end < snapshot.value.text.length ? Buffer.from(JSON.stringify({ readId: snapshot.readId, offset: end })).toString('base64url') : null;
    const { text, ...metadata } = snapshot.value;
    return { schemaVersion: 1, ...metadata, scopeRef: context.scopeRef, readerId: reader.id, identityPolicy: reader.identity.mode,
      taskId: context.taskId, citationKey: context.citationKey, sourceRef: context.sourceRef,
      materialId: context.material.materialId, idNamespace: context.material.idNamespace, readId: snapshot.readId, readAt: snapshot.readAt,
      content: text.slice(offset, end), offset, nextCursor, complete: metadata.contentComplete === true && nextCursor === null,
      trustedInstructions: false, snapshotAtAnswerTime: false };
  }
  close() {
    this.closed = true; this.pending?.finish(fail('source_read_cancelled', 499)); clearTimeout(this.idleTimer);
    const worker = this.worker; this.worker = null; this.terminate(worker); this.snapshots.clear(); this.cacheBytes = 0;
    return this.stopping;
  }
}
module.exports = { SourceReader, BUDGET, fail };
