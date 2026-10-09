'use strict';

const { createHash, randomUUID } = require('node:crypto');

class ProviderAObservationExporter {
  constructor({
    enqueue = () => false,
    processGeneration = createHash('sha256').update(randomUUID()).digest('hex'),
    clock = () => new Date().toISOString(),
  } = {}) {
    if (typeof enqueue !== 'function') throw new TypeError('observation_enqueue_required');
    if (!/^[a-f0-9]{64}$/u.test(processGeneration)) {
      throw new TypeError('observation_process_generation_invalid');
    }
    if (typeof clock !== 'function') throw new TypeError('observation_clock_required');
    this.enqueue = enqueue;
    this.processGeneration = processGeneration;
    this.clock = clock;
    this.sequence = 0;
    this.accepted = 0;
    this.dropped = 0;
    this.states = new Map();
  }

  span(input) { return this.emit('SPAN', input); }
  transition(input) { return this.emit('TRANSITION', input); }
  sample(input) { return this.emit('SAMPLE', input); }
  recovery(input) { return this.emit('RECOVERY', input); }

  recordState(input = {}) {
    const component = String(input.component || 'provider_a');
    const next = String(input.state || 'unknown');
    const signature = JSON.stringify([
      next,
      input.category,
      input.capacity,
      input.generation,
      input.queueDepth,
    ]);
    const previous = this.states.get(component);
    if (previous?.signature === signature) return false;
    this.states.set(component, { state: next, signature });
    return this.transition({
      ...input,
      component,
      stage: input.stage || 'state_transition',
      stateFrom: previous?.state || 'unknown',
      stateTo: next,
    });
  }

  emit(eventKind, input = {}) {
    try {
      this.sequence += 1;
      const event = compact({
        schema_version: 'wechat.qa.observation.v1',
        producer: 'provider_a',
        process_generation: this.processGeneration,
        producer_sequence: this.sequence,
        event_kind: eventKind,
        component: input.component,
        stage: input.stage,
        category: input.category,
        observed_at: input.observedAt || this.clock(),
        precision_ms: input.precisionMs ?? 1,
        clock_class: input.clockClass || 'host_wall',
        duration_ms: input.durationMs,
        queue_depth: input.queueDepth,
        capacity: input.capacity,
        generation: input.generation,
        retry_count: input.retryCount,
        state_from: input.stateFrom,
        state_to: input.stateTo,
        outcome: input.outcome,
        evidence_class: input.evidenceClass,
        metric_name: input.metricName,
        metric_value: input.metricValue,
        metric_unit: input.metricUnit,
      });
      if (this.enqueue(Object.freeze(event)) === false) {
        this.dropped += 1;
        return false;
      }
      this.accepted += 1;
      return true;
    } catch {
      this.dropped += 1;
      return false;
    }
  }

  snapshot() {
    return Object.freeze({ accepted_count: this.accepted, dropped_count: this.dropped });
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

module.exports = { ProviderAObservationExporter };
