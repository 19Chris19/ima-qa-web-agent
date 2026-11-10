'use strict';
const { COMPONENTS, STATES } = require('./history');
const SAMPLE_MS = 5000, BUCKET_MS = 10000, WINDOW_MS = 600000, MAX_POINTS = 120;
const PRIORITY = ['outage', 'maintenance', 'unknown', 'degraded', 'busy', 'normal'];
const worst = values => PRIORITY.find(state => values.includes(state)) || 'unknown';
class RecentStatus {
  constructor({ now = Date.now } = {}) { this.now = now; this.points = []; }
  record(snapshot) {
    const at = this.now(), slot = Math.floor(at / SAMPLE_MS) * SAMPLE_MS;
    this.prune(at);
    const states = Object.fromEntries(COMPONENTS.map(key => [key,
      STATES.has(snapshot.components?.[key]?.state) ? snapshot.components[key].state : 'unknown']));
    const previous = this.points.find(point => point.at === slot);
    if (previous) for (const key of COMPONENTS) previous.states[key] = worst([previous.states[key], states[key]]);
    else this.points.push({ at: slot, states });
    this.points.sort((a,b) => a.at-b.at);
    if (this.points.length > MAX_POINTS) this.points.splice(0, this.points.length-MAX_POINTS);
  }
  prune(now) { this.points = this.points.filter(point => point.at > now-WINDOW_MS && point.at <= now); }
  snapshot(now = this.now()) {
    this.prune(now);
    const to = Math.floor(now / BUCKET_MS) * BUCKET_MS + BUCKET_MS;
    const from = to-WINDOW_MS;
    const components = {};
    for (const key of COMPONENTS) {
      components[key] = Array.from({ length:60 }, (_, index) => {
        const start = from+index*BUCKET_MS, end = start+BUCKET_MS;
        const points = this.points.filter(p => p.at >= start && p.at < end);
        const expected = Math.min(2, Math.max(0, Math.floor((now-start)/SAMPLE_MS)+1));
        return { from:start, to:end, state:worst(points.map(p => p.states[key])),
          samples:points.length, expectedSamples:expected, coverage:expected ? Math.min(1, points.length/expected) : 0 };
      });
    }
    return { schema:'provider_recent_status_v1', from, to, observedAt:now,
      sampleMs:SAMPLE_MS, bucketMs:BUCKET_MS, maxPoints:MAX_POINTS, points:this.points.length, components };
  }
}
module.exports = { RecentStatus, worst, SAMPLE_MS, BUCKET_MS, WINDOW_MS, MAX_POINTS };
