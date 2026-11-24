'use strict';
const crypto = require('node:crypto');
// Passive only; bounded memory. Never stores questions, account IDs or URLs.
class OperationsMetrics {
  constructor(now = Date.now) { this.now = now; this.instance = crypto.randomUUID(); this.startedAt = now(); this.samples = []; this.pending = new WeakMap(); this.completed = 0; this.failed = 0; }
  observe(context, stage, outcome) {
    if (stage === 'admitted') { this.pending.set(context, { at: this.now(), first: null }); return; }
    const sample = this.pending.get(context);
    if (!sample) return;
    if (stage === 'first_delta') { sample.first ??= this.now() - sample.at; return; }
    if (outcome !== 'failure' && !['complete', 'answer_generated'].includes(stage)) return;
    this.pending.delete(context);
    const success = outcome === 'success';
    success ? this.completed++ : this.failed++;
    this.samples.push({ at: this.now(), success, duration: this.now() - sample.at, first: sample.first });
    if (this.samples.length > 512) this.samples.shift();
  }
  snapshot() {
    const samples = this.samples.filter(x => this.now() - x.at < 3600000);
    const p95 = values => values.length ? values.sort((a,b) => a-b)[Math.ceil(values.length * .95)-1] : null;
    return { instance: this.instance, startedAt: this.startedAt, completed: this.completed, failed: this.failed,
      window: 'last_hour_up_to_512', samples: samples.length,
      successRate: samples.length ? samples.filter(x => x.success).length / samples.length : null,
      durationP95Ms: p95(samples.map(x => x.duration)), firstDeltaP95Ms: p95(samples.map(x => x.first).filter(x => x !== null)) };
  }
}
module.exports = { OperationsMetrics };
