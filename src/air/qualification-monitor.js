'use strict';

const ALERT_STATES = ['expiring', 'expired', 'binding_changed', 'invalid'];

// No credentials, persistence or QA client: this observer cannot renew evidence.
class QualificationMonitor {
  constructor({ read, observation = null, transport = null,
    schedule = setInterval, cancel = clearInterval } = {}) {
    if (typeof read !== 'function') throw new TypeError('qualification_reader_required');
    this.read = read;
    this.observation = observation;
    this.transport = transport;
    this.schedule = schedule;
    this.cancel = cancel;
    this.timer = null;
    this.signatures = new Map();
    this.hadAlert = false;
    this.readFailures = 0;
    this.enqueueFailures = 0;
    this.transportDrops = 0;
    this.checks = 0;
    this.readState = 'unknown';
    this.activeCategories = [];
  }

  start() {
    if (this.timer !== null) return;
    this.tick();
    this.timer = this.schedule(() => this.tick(), 60000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer === null) return;
    this.cancel(this.timer);
    this.timer = null;
  }

  tick() {
    this.checks += 1;
    let summary;
    try {
      const drops = this.transport?.snapshot().dropped_count || 0;
      if (drops > this.transportDrops) this.signatures.clear();
      this.transportDrops = drops;
      summary = this.read();
      if (!summary || !Number.isSafeInteger(summary.capacity) || summary.capacity < 0
          || ALERT_STATES.some(key => summary[key] !== undefined
            && (!Number.isSafeInteger(summary[key]) || summary[key] < 0))) {
        throw new Error('qualification_summary_invalid');
      }
      this.readState = 'ready';
    } catch {
      this.readFailures += 1;
      this.readState = 'unavailable';
      this.activeCategories = ['qualification_monitor_unavailable'];
      this.hadAlert = true;
      this.emit('qualification_monitor_unavailable', 1, undefined);
      return;
    }
    const current = new Set();
    for (const key of ALERT_STATES) {
      if (!(summary[key] > 0)) continue;
      const category = `qualification_${key}`;
      current.add(category);
      this.emit(category, summary[key], summary.capacity);
    }
    if (summary.capacity === 0) {
      current.add('qualification_capacity_zero');
      this.emit('qualification_capacity_zero', 1, 0);
    }
    this.activeCategories = [...current];
    if (current.size > 0) this.hadAlert = true;
    else if (this.hadAlert && this.emit('qualification_recovered', 1, summary.capacity)) {
      this.hadAlert = false;
    }
    for (const category of this.signatures.keys()) {
      if (!current.has(category)) this.signatures.delete(category);
    }
  }

  emit(category, count, capacity) {
    const signature = JSON.stringify([count, capacity]);
    if (this.signatures.get(category) === signature) return true;
    try {
      if (this.observation?.transition({ component: 'provider_a', stage: 'state_transition',
        category, capacity, stateFrom: 'unknown',
        stateTo: category === 'qualification_recovered' ? 'ready' : 'degraded',
      }) !== true) throw new Error('qualification_enqueue_unavailable');
      this.signatures.set(category, signature);
      return true;
    } catch {
      this.enqueueFailures += 1;
      return false;
    }
  }

  snapshot() {
    let transport;
    try { transport = this.transport?.snapshot(); } catch {}
    return Object.freeze({ checks: this.checks, read_state: this.readState,
      active_categories: Object.freeze([...this.activeCategories]),
      read_failure_count: this.readFailures, enqueue_failure_count: this.enqueueFailures,
      // ACK counts are process-wide collector acceptance, not human notification.
      delivery_state: !transport ? 'unavailable'
        : !transport.connected ? 'disconnected'
          : transport.queued || transport.in_flight ? 'pending' : 'collector_connected',
      collector_accepted_count: transport?.exported_count || 0,
      transport_dropped_count: transport?.dropped_count || 0,
      queued_count: transport?.queued || 0 });
  }
}

module.exports = { QualificationMonitor };
