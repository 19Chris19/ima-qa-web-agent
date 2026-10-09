'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { QualificationMonitor } = require('../src/air/qualification-monitor');

test('independent timer warns, deduplicates, expires and recovers without QA', () => {
  let state = { qualified: 3, capacity: 3 };
  let callback; let cleared = 0; const events = [];
  const monitor = new QualificationMonitor({ read: () => state,
    observation: { transition: event => { events.push(event); return true; } },
    schedule: (fn, ms) => { assert.equal(ms, 60000); callback = fn; return { unref() {} }; },
    cancel: () => { cleared += 1; } });
  monitor.start(); monitor.start();
  assert.equal(events.length, 0);
  state = { expiring: 1, qualified: 2, capacity: 3 }; callback(); callback();
  assert.equal(events.length, 1);
  assert.equal(events[0].category, 'qualification_expiring');
  assert.deepEqual(monitor.snapshot().active_categories, ['qualification_expiring']);
  state = { expired: 3, capacity: 0 }; callback();
  assert.equal(events.at(-1).category, 'qualification_capacity_zero');
  state = { qualified: 3, capacity: 3 }; callback(); callback();
  assert.equal(events.at(-1).category, 'qualification_recovered');
  assert.equal(events.filter(e => e.category === 'qualification_recovered').length, 1);
  assert.deepEqual(monitor.snapshot().active_categories, []);
  monitor.stop(); monitor.stop(); assert.equal(cleared, 1);
});

test('read failure and rejected enqueue cannot hide warning or block the caller', () => {
  let failRead = true; let accept = false; const events = [];
  const monitor = new QualificationMonitor({ read: () => {
    if (failRead) throw new Error('synthetic-private-value');
    return { binding_changed: 1, invalid: 1, capacity: 1 };
  }, observation: { transition: event => { events.push(event); return accept; } } });
  assert.doesNotThrow(() => monitor.tick());
  assert.equal(monitor.snapshot().read_failure_count, 1);
  failRead = false; monitor.tick(); accept = true; monitor.tick();
  assert.ok(events.filter(e => e.category === 'qualification_binding_changed').length >= 2);
  const before = events.length; monitor.tick(); assert.equal(events.length, before);
  assert.ok(monitor.snapshot().enqueue_failure_count > 0);
  assert.doesNotMatch(JSON.stringify(monitor.snapshot()), /synthetic-private-value/);
});

test('disabled transport remains explicitly unavailable, transport rejection permits resubmission', () => {
  const noExporter = new QualificationMonitor({ read: () => ({ expired: 1, capacity: 0 }) });
  noExporter.tick(); assert.equal(noExporter.snapshot().delivery_state, 'unavailable');
  let dropped = 0; let calls = 0;
  const monitor = new QualificationMonitor({ read: () => ({ expired: 1, capacity: 0 }),
    observation: { transition: () => { calls += 1; return true; } },
    transport: { snapshot: () => ({ started: true, connected: true, queued: 0,
      in_flight: false, exported_count: 0, dropped_count: dropped, connect_failure_count: 0 }) } });
  monitor.tick(); const before = calls; monitor.tick(); assert.equal(calls, before);
  dropped += 1; monitor.tick(); assert.ok(calls > before);
});
