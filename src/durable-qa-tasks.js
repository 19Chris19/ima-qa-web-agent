'use strict';

const { DurableQATaskStore, TERMINAL, fault } = require('./durable-qa-store');
const { safeTaskFailureReason } = require('./durable-qa-failure');

class DurableQATasks {
  constructor({ directory, conversations, queue, execute, accountPool = null, mode, storeOptions = {}, heartbeatMs = 15000, rotationMs = 240000 }) {
    this.conversations = conversations;
    this.queue = queue;
    this.execute = execute;
    this.accountPool = accountPool;
    this.mode = mode;
    this.unsubscribeAvailability = accountPool?.onAvailability?.(() => this.queue.wake?.());
    this.controllers = new Map();
    this.activeConversations = new Map();
    this.pending = new Map();
    this.subscribers = new Map();
    this.closed = false;
    this.heartbeatMs = heartbeatMs;
    this.rotationMs = rotationMs;
    this.store = new DurableQATaskStore({ ...storeOptions, directory, onUnavailable: () => this.stopExecution() });
    try {
      // Resolve the completion journal before admitting any new requests.
      for (const task of this.store.tasks.values()) {
        if (task.bindingPending) this.applyBinding(task.id);
        if (task.completion) this.complete(task.id, task.completion);
        else if (task.status === 'running') this.terminal(task.id, 'indeterminate', 'execution_interrupted');
      }
      for (const task of [...this.store.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)) {
        if (task.status !== 'queued') continue;
        this.schedule(task);
      }
    } catch {
      this.close();
      throw fault('task_store_unavailable');
    }
    this.sweeper = setInterval(() => {
      try { this.store.prune(); } catch { this.stopExecution(); }
    }, 60000);
    this.sweeper.unref();
    this.pumpTimer = setInterval(() => this.pump(), 250);
    this.pumpTimer.unref();
  }

  get available() { return !this.closed && this.store.available; }
  ensure() { if (!this.available) throw fault('task_store_unavailable'); }

  hasUnfinishedConversation(conversationId, ownerKey, excludedScope) {
    this.ensure();
    // Conversations are shared across API scopes, including queued recovery work.
    return [...this.store.tasks.values()].some(task => task.ownerKey === ownerKey && task.scope !== excludedScope &&
      task.input.conversationId === conversationId &&
      (!TERMINAL.has(task.status) || task.completion || task.bindingPending));
  }

  submit({ ownerKey, scope, applicationKey = scope, key, input, validateNew = () => {} }) {
    this.ensure();
    const existing = this.store.find(ownerKey, scope, key, input, applicationKey);
    if (existing) return { task: this.store.publicTask(existing), isNew: false };
    const conversation = this.conversations.require(input.conversationId, ownerKey);
    const activeTask = this.activeConversations.get(input.conversationId);
    if (this.hasUnfinishedConversation(input.conversationId, ownerKey, scope) ||
        (conversation.activeRequest && (activeTask?.ownerKey !== ownerKey || activeTask?.scope !== scope))) {
      throw fault('conversation_busy', 409);
    }
    if (this.pending.size || !this.canSchedule({ scope, applicationKey, ownerKey, input })) throw fault('queue_full', 429);
    validateNew();
    const claim = this.store.create({ ownerKey, scope, applicationKey, key, input });
    this.schedule(claim.task);
    return { task: this.store.publicTask(claim.task), isNew: true };
  }

  schedule(task) {
    if (!this.canSchedule(task)) { this.pending.set(task.id, task); return; }
    this.pending.delete(task.id);
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    let acquired = false;
    if (this.closed) return;
    void this.queue.run(async accountLease => {
      this.ensure();
      if (controller.signal.aborted) return;
      this.conversations.beginRequest(task.input.conversationId, task.ownerKey);
      acquired = true;
      this.activeConversations.set(task.input.conversationId, { ownerKey: task.ownerKey, scope: task.scope });
      this.store.update(task.id, current => { current.trace.executionStartedAt = this.store.now(); });
      let upstream = this.conversations.getUpstream(task.input.conversationId, task.ownerKey);
      let turn;
      const bindUpstream = binding => {
        this.ensure();
        const next = { accountId: binding.accountId || upstream.accountId || '', sessionId: binding.sessionId || upstream.sessionId || '' };
        if (next.accountId === upstream.accountId && next.sessionId === upstream.sessionId) return;
        this.store.update(task.id, current => { current.upstreamBinding = next; current.bindingPending = true; }, true);
        try { this.applyBinding(task.id); } catch { this.store.unavailable(); throw fault('task_store_unavailable'); }
        upstream = next;
      };
      const check = () => {
        this.ensure();
        if (controller.signal.aborted || TERMINAL.has(this.store.tasks.get(task.id).status)) throw fault('task_terminal', 409);
      };
      const conversationStore = {
        getUpstream: (...args) => this.conversations.getUpstream(...args),
        setUpstream: (_id, value) => { check(); bindUpstream(value); },
        appendTurn: (_id, question, answer, metadata) => { check(); turn = { question, answer, metadata, upstream }; },
      };
      const response = this.response(task, () => turn);
      await this.execute({ task, signal: controller.signal, res: response, conversationStore,
        accountLease,
        onUpstreamBinding: bindUpstream,
        onDispatch: () => {
          check();
          this.publish(this.store.running(task.id));
        },
        onUpstreamActivity: ({ bytes } = {}) => {
          check();
          if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
          this.store.update(task.id, current => {
            current.trace.lastUpstreamActivityAt = this.store.now();
            current.trace.rawUpstreamBytes = Math.min(Number.MAX_SAFE_INTEGER, (current.trace.rawUpstreamBytes || 0) + bytes);
            current.trace.rawUpstreamChunks = Math.min(Number.MAX_SAFE_INTEGER, (current.trace.rawUpstreamChunks || 0) + 1);
          }, true);
        },
        onUpstreamEvent: event => {
          check();
          this.store.update(task.id, current => {
            if (current.trace.dispatchedAt === null) throw fault('task_dispatch_marker_missing');
            current.trace.firstUpstreamEventAt ??= this.store.now();
            current.trace.lastUpstreamEventAt = this.store.now();
            current.trace.upstreamBytes = (current.trace.upstreamBytes || 0) + Buffer.byteLength(JSON.stringify(event));
            current.trace.upstreamEvents = (current.trace.upstreamEvents || 0) + 1;
            if (current.trace.upstreamBytes > this.store.maxTaskBytes || current.trace.upstreamEvents > this.store.maxEvents) throw fault('task_capacity', 429);
          });
        },
      });
      if (this.available && !TERMINAL.has(this.store.tasks.get(task.id).status)) this.terminal(task.id, 'failed', 'upstream_terminal_missing');
    }, this.queueOptions(task, controller.signal)).catch(error => {
      if (!this.available || TERMINAL.has(this.store.tasks.get(task.id)?.status)) return;
      // A persisted completion cannot be overwritten with failure after a history fault.
      if (this.store.tasks.get(task.id).completion) { this.store.unavailable(); return; }
      try { this.terminal(task.id, 'failed', safeTaskFailureReason(error?.code, 'execution_failed')); }
      catch { this.store.unavailable(); }
    }).finally(() => {
      this.controllers.delete(task.id);
      if (acquired) {
        this.conversations.endRequest(task.input.conversationId, task.ownerKey);
        this.activeConversations.delete(task.input.conversationId);
      }
    });
  }

  canSchedule(task) {
    const keys = this.queueOptions(task);
    if (typeof this.queue.canAccept === 'function') return this.queue.canAccept(keys);
    const stats = this.queue.stats();
    return stats.activeRequests < stats.maxConcurrent || stats.queuedRequests < stats.queueLimit;
  }

  queueOptions(task, signal) {
    const options = { signal, applicationKey: task.applicationKey || task.scope,
      visitorKey: task.ownerKey, laneKey: task.input.conversationId };
    if (this.accountPool?.tryAcquireSlot) {
      const accountOptions = () => ({ ...this.conversations.getUpstream(task.input.conversationId, task.ownerKey),
        mode: task.input.retrieval_policy || this.conversations.require(task.input.conversationId, task.ownerKey).mode || this.mode, signal });
      options.isRunnable = () => this.accountPool.canAcquireSlot(accountOptions());
      options.tryAcquire = () => this.accountPool.tryAcquireSlot(accountOptions());
    }
    return options;
  }

  pump() {
    if (!this.available) return;
    for (const task of this.pending.values()) this.schedule(task);
  }

  response(task, getTurn) {
    let buffer = '';
    const manager = this;
    return {
      writableEnded: false,
      status() { return this; },
      setHeader() {},
      flushHeaders() {},
      end() { this.writableEnded = true; },
      write(chunk) {
        manager.ensure();
        if (TERMINAL.has(manager.store.tasks.get(task.id).status)) return true;
        buffer += String(chunk);
        if (buffer.length > 2 * 1024 * 1024) throw fault('task_capacity', 429);
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const raw = /^data: (.+)$/m.exec(frame)?.[1];
          if (!event || !raw) continue;
          const data = JSON.parse(raw);
          if (event === 'done') {
            const turn = getTurn();
            if (!turn) throw fault('task_completion_missing');
            const completion = { ...turn, done: data };
            manager.store.journal(task.id, completion);
            manager.complete(task.id, completion);
          } else if (event === 'error') {
            if (manager.store.tasks.get(task.id).completion) {
              manager.store.unavailable();
              throw fault('task_store_unavailable');
            }
            manager.terminal(task.id, 'failed', safeTaskFailureReason(data.failureReason));
          } else if (['conversation', 'process', 'sources', 'delta'].includes(event)) {
            manager.publish(manager.store.append(task.id, event, data));
          }
        }
        return true;
      },
    };
  }

  complete(id, completion) {
    const task = this.store.tasks.get(id);
    this.conversations.appendTaskTurn(task.input.conversationId, task.id, completion.question, completion.answer,
      completion.metadata, task.ownerKey, completion.upstream);
    this.publish(this.store.finish(id, 'succeeded', completion.done));
  }

  applyBinding(id) {
    const task = this.store.tasks.get(id);
    this.conversations.bindTaskUpstream(task.input.conversationId, task.upstreamBinding, task.ownerKey);
    this.store.update(id, current => { delete current.bindingPending; delete current.upstreamBinding; }, true);
  }

  terminal(id, status, reason) {
    const task = this.store.tasks.get(id);
    this.publish(this.store.finish(id, status, { error: reason, failureReason: reason,
      conversationId: task.input.conversationId, requestId: id }));
  }

  cancel(id, ownerKey, scope, applicationKey) {
    const task = this.store.owned(id, ownerKey, scope, applicationKey);
    if (!TERMINAL.has(task.status)) {
      if (task.completion) throw fault('task_completion_pending', 409);
      this.terminal(id, 'cancelled', 'task_cancelled');
      this.pending.delete(id);
      this.controllers.get(id)?.abort();
    }
    return this.store.publicTask(this.store.tasks.get(id));
  }

  publish(task) {
    for (const subscriber of this.subscribers.get(task.id) || []) {
      try { subscriber.send(task); } catch { subscriber.end('disconnect'); }
    }
  }

  subscribe(task, after, res) {
    this.ensure();
    const subscribers = this.subscribers.get(task.id) || new Set();
    if (subscribers.size >= 8 || [...this.subscribers.values()].reduce((n, s) => n + s.size, 0) >= 256) throw fault('task_subscriber_capacity', 429);
    task = this.store.update(task.id, current => { current.trace.subscriptions += 1; }, true);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    let cursor = after;
    let ended = false;
    let heartbeat;
    let rotation;
    const cleanup = (reason = 'disconnect') => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      clearTimeout(rotation);
      subscribers.delete(subscription);
      if (!subscribers.size) this.subscribers.delete(task.id);
      res.off('close', cleanup);
      if (this.available && ['disconnect', 'rotation'].includes(reason)) {
        try { this.store.update(task.id, current => { current.trace[reason === 'disconnect' ? 'disconnects' : 'rotations'] += 1; }, true); }
        catch { this.store.unavailable(); }
      }
    };
    const end = (reason = 'complete') => { cleanup(reason); res.end(); };
    const subscription = { end, send: current => {
      if (ended) return;
      for (const event of current.events) {
        if (event.id <= cursor) continue;
        if (res.writableLength > 256 * 1024) { cleanup(); res.destroy(); return; }
        res.write(`id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        cursor = event.id;
      }
      if (TERMINAL.has(current.status)) end();
    } };
    subscribers.add(subscription);
    this.subscribers.set(task.id, subscribers);
    res.on('close', cleanup);
    heartbeat = setInterval(() => {
      if (res.writableLength > 256 * 1024) { cleanup(); res.destroy(); return; }
      res.write(': heartbeat\n\n');
    }, this.heartbeatMs);
    rotation = setTimeout(() => end('rotation'), this.rotationMs);
    heartbeat.unref();
    rotation.unref();
    subscription.send(task);
  }

  stopExecution() {
    for (const controller of this.controllers.values()) controller.abort();
    for (const subscribers of this.subscribers.values()) for (const subscriber of subscribers) subscriber.end();
  }

  close() {
    this.closed = true;
    this.unsubscribeAvailability?.();
    clearInterval(this.sweeper);
    clearInterval(this.pumpTimer);
    this.stopExecution();
    this.store.close();
  }
}

module.exports = { DurableQATasks };
