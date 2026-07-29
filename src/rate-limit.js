function createRateLimiter(options = {}) {
  const windowMs = Math.max(0, Number(options.windowMs || 0));
  const max = Math.max(0, Number(options.max || 0));
  const buckets = new Map();

  function consume(key, now = Date.now()) {
    if (!windowMs || !max) {
      return { ok: true, remaining: null, retryAfterSeconds: 0 };
    }

    const bucketKey = String(key || 'unknown');
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(bucketKey, bucket);
    }

    cleanup(now);
    if (bucket.count >= max) {
      return {
        ok: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    bucket.count += 1;
    return {
      ok: true,
      remaining: Math.max(0, max - bucket.count),
      retryAfterSeconds: Math.max(0, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  function cleanup(now = Date.now()) {
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }

  function stats() {
    return {
      trackedClients: buckets.size,
      windowMs,
      max,
    };
  }

  return {
    consume,
    stats,
  };
}

module.exports = {
  createRateLimiter,
};
