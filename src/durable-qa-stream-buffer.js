'use strict';

const { TERMINAL, fault } = require('./durable-qa-store');

// Batch only unpublished text and diagnostic counters. Every published event still
// passes through the store's fsync commit boundary before publication.
class DurableQAStreamBuffer {
  constructor({ store, id, publish, onError, deltaMs = 50, traceMs = 1000, maxDeltaBytes = 8192 }) {
    this.store = store;
    this.id = id;
    this.publish = publish;
    this.onError = onError;
    this.deltaMs = deltaMs;
    this.traceMs = traceMs;
    this.maxDeltaBytes = maxDeltaBytes;
    this.trace = {};
    this.text = '';
    this.textBytes = 0;
    this.seenDelta = false;
    this.lastDeltaFlush = 0;
    this.closed = false;
  }

  timer(key, ms) {
    if (this[key] || this.closed) return;
    this[key] = setTimeout(() => {
      this[key] = null;
      try { this.flush(); } catch (error) { this.onError(error); }
    }, ms);
    this[key].unref();
  }

  activity(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || this.closed) return;
    this.trace.firstUpstreamActivityAt ??= this.store.now();
    this.trace.lastUpstreamActivityAt = this.store.now();
    this.trace.rawUpstreamBytes = Math.min(Number.MAX_SAFE_INTEGER, (this.trace.rawUpstreamBytes || 0) + bytes);
    this.trace.rawUpstreamChunks = Math.min(Number.MAX_SAFE_INTEGER, (this.trace.rawUpstreamChunks || 0) + 1);
    this.timer('traceTimer', this.traceMs);
  }

  upstream(event) {
    if (this.closed) return;
    const current = this.store.tasks.get(this.id);
    if (current.trace.dispatchedAt === null) throw fault('task_dispatch_marker_missing');
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if ((current.trace.upstreamBytes || 0) + (this.trace.upstreamBytes || 0) + bytes > this.store.maxUpstreamBytes ||
        (current.trace.upstreamEvents || 0) + (this.trace.upstreamEvents || 0) + 1 > this.store.maxUpstreamEvents) {
      throw this.store.capacity(this.id, 'upstream_stream');
    }
    const now = this.store.now();
    this.trace.firstUpstreamEventAt ??= now;
    this.trace.lastUpstreamEventAt = now;
    this.trace.upstreamBytes = (this.trace.upstreamBytes || 0) + bytes;
    this.trace.upstreamEvents = (this.trace.upstreamEvents || 0) + 1;
    this.timer('traceTimer', this.traceMs);
  }

  append(event, data) {
    if (this.closed) return;
    const hasRequestId = Object.hasOwn(data, 'requestId');
    if (event !== 'delta' || typeof data.text !== 'string' ||
        Object.keys(data).some(key => !['text', 'requestId'].includes(key)) ||
        (hasRequestId && typeof data.requestId !== 'string')) {
      this.flush({ event, data });
      return;
    }
    if (!data.text) { this.flush({ event, data }); return; }
    // Provider response deltas include the request ID. Keep it unchanged, and
    // never merge text belonging to a different metadata envelope.
    if (this.text && (this.hasRequestId !== hasRequestId || this.requestId !== data.requestId)) this.flush();
    this.hasRequestId = hasRequestId;
    this.requestId = data.requestId;
    this.trace.firstAnswerDeltaAt ??= this.store.now();
    this.text += data.text;
    this.textBytes += Buffer.byteLength(data.text);
    const elapsed = this.store.now() - this.lastDeltaFlush;
    if (!this.seenDelta || elapsed >= this.deltaMs || this.textBytes >= this.maxDeltaBytes) {
      this.seenDelta = true;
      this.flush();
    } else {
      this.timer('deltaTimer', Math.max(0, this.deltaMs - elapsed));
    }
  }

  flush(extra) {
    if (this.closed) return;
    clearTimeout(this.deltaTimer); this.deltaTimer = null;
    clearTimeout(this.traceTimer); this.traceTimer = null;
    const events = [];
    if (this.text) events.push({ event: 'delta', data: { text: this.text,
      ...(this.hasRequestId ? { requestId: this.requestId } : {}) } });
    if (extra) events.push(extra);
    const trace = this.trace;
    // On a rejected write none of these events were published. Do not retry an
    // oversized batch forever while trying to persist a terminal failure.
    this.text = ''; this.textBytes = 0; this.trace = {};
    if (!events.length && !Object.keys(trace).length) return;
    const saved = this.store.update(this.id, task => {
      if (TERMINAL.has(task.status)) throw fault('task_terminal', 409);
      for (const [key, value] of Object.entries(trace)) {
        if (['rawUpstreamBytes', 'rawUpstreamChunks', 'upstreamBytes', 'upstreamEvents'].includes(key)) {
          task.trace[key] = Math.min(Number.MAX_SAFE_INTEGER, (task.trace[key] || 0) + value);
        } else if (key.startsWith('first')) task.trace[key] ??= value;
        else task.trace[key] = value;
      }
      for (const { event, data } of events) this.store.addEvent(task, event, data);
    }, !events.length);
    if (events.some(item => item.event === 'delta')) this.lastDeltaFlush = this.store.now();
    if (events.length) this.publish(saved);
  }

  close() {
    this.closed = true;
    clearTimeout(this.deltaTimer);
    clearTimeout(this.traceTimer);
    this.text = ''; this.textBytes = 0; this.trace = {};
  }
}

module.exports = { DurableQAStreamBuffer };
