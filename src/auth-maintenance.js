class AuthMaintenance {
  constructor({ check, interval, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { check, interval, now, setTimer, clearTimer });
    this.enabled = false;
    this.generation = 0;
    this.failures = 0;
    this.inFlight = false;
    this.timer = null;
    this.nextAt = null;
    this.lastCheckAt = null;
  }

  start() {
    this.stop();
    this.enabled = Number.isFinite(this.interval()) && this.interval() > 0;
    if (this.enabled) this.schedule(this.interval());
    return this.timer;
  }

  stop() {
    this.enabled = false;
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  schedule(delay) {
    if (!this.enabled) return;
    const generation = this.generation;
    this.nextAt = this.now() + delay;
    this.timer = this.setTimer(async () => {
      this.timer = null;
      this.nextAt = null;
      if (!this.enabled || generation !== this.generation) return;
      if (this.inFlight) { this.schedule(this.interval()); return; }
      this.inFlight = true;
      this.lastCheckAt = this.now();
      try {
        await this.check();
        if (generation === this.generation) this.failures = 0;
      } catch {
        if (generation === this.generation) this.failures++;
      } finally {
        this.inFlight = false;
        if (this.enabled && generation === this.generation) {
          // Back off failures without overlapping refresh requests or inventing a timer in the UI.
          const backoff = Math.min(900000, this.interval() * 2 ** Math.min(this.failures, 10));
          this.schedule(Math.max(this.interval(), backoff));
        }
      }
    }, delay);
    this.timer?.unref?.();
  }

  snapshot() {
    return {
      state: !this.enabled ? 'disabled' : this.inFlight ? 'checking' : this.failures ? 'retry_wait' : 'scheduled',
      lastCheckAt: this.lastCheckAt === null ? null : new Date(this.lastCheckAt).toISOString(),
      nextCheckAt: this.nextAt === null ? null : new Date(this.nextAt).toISOString(),
      nextRetryAt: this.failures && this.nextAt !== null ? new Date(this.nextAt).toISOString() : null,
      failures: this.failures,
    };
  }
}

module.exports = { AuthMaintenance };
