class QueueFullError extends Error {
  constructor(message = '当前访问人数较多，请稍后再试') {
    super(message);
    this.name = 'QueueFullError';
    this.statusCode = 429;
  }
}

class RequestAbortedError extends Error {
  constructor(message = '请求已取消') {
    super(message);
    this.name = 'RequestAbortedError';
    this.statusCode = 499;
  }
}

function createAskQueue(options = {}) {
  let maxConcurrent = normalizeMaxConcurrent(options.maxConcurrent);
  let queueLimit = normalizeQueueLimit(options.queueLimit);
  let activeRequests = 0;
  const queue = [];
  const activeLanes = new Set();
  const activeEntries = new Set();
  const applications = new Map();
  const applicationOrder = [];

  function stats() {
    return {
      activeRequests,
      queuedRequests: queue.length,
      maxConcurrent,
      queueLimit,
    };
  }

  function run(task, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(new RequestAbortedError());
    }

    return new Promise((resolve, reject) => {
      const entry = {
        reject,
        resolve,
        signal,
        started: false,
        task,
        applicationKey: String(options.applicationKey || 'legacy'),
        visitorKey: String(options.visitorKey || 'legacy'),
        lane: laneFor(options),
      };

      const onAbort = () => {
        if (entry.started) {
          return;
        }
        const index = queue.indexOf(entry);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        cleanupQueuedEntry(entry);
        pruneMetadata();
        reject(new RequestAbortedError());
        drain();
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        entry.onAbort = onAbort;
      }

      drain();
      if (activeRequests < maxConcurrent && !activeLanes.has(entry.lane)) {
        register(entry);
        start(entry);
        return;
      }

      if (queue.length >= queueLimit) {
        cleanupQueuedEntry(entry);
        reject(new QueueFullError());
        return;
      }

      queue.push(entry);
      register(entry);
      drain();
    });
  }

  function canAccept(options = {}) {
    // Every mutation drains runnable work before returning, so free capacity
    // implies that any remaining entries are blocked on active lanes.
    return !options.signal?.aborted && ((activeRequests < maxConcurrent
      && !activeLanes.has(laneFor(options))) || queue.length < queueLimit);
  }

  function cleanupQueuedEntry(entry) {
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
  }

  function drain() {
    while (activeRequests < maxConcurrent && queue.length > 0) {
      const entry = selectNext();
      if (!entry) break;
      queue.splice(queue.indexOf(entry), 1);
      start(entry);
    }
  }

  function register(entry) {
    if (!applications.has(entry.applicationKey)) {
      applications.set(entry.applicationKey, []);
      applicationOrder.splice(Math.max(0, applicationOrder.length - 1), 0, entry.applicationKey);
    }
    const visitors = applications.get(entry.applicationKey);
    if (!visitors.includes(entry.visitorKey)) visitors.splice(Math.max(0, visitors.length - 1), 0, entry.visitorKey);
  }

  function rotate(items, value) {
    items.splice(items.indexOf(value), 1);
    items.push(value);
  }

  function selectNext() {
    for (const app of applicationOrder) {
      for (const visitor of applications.get(app)) {
        const entry = queue.find(item => item.applicationKey === app
          && item.visitorKey === visitor && !activeLanes.has(item.lane));
        if (entry) return entry;
      }
    }
    return null;
  }

  function pruneMetadata() {
    for (const app of [...applicationOrder]) {
      const visitors = applications.get(app).filter(visitor => [...queue, ...activeEntries].some(entry =>
        entry.applicationKey === app && entry.visitorKey === visitor));
      if (visitors.length) applications.set(app, visitors);
      else {
        applications.delete(app);
        applicationOrder.splice(applicationOrder.indexOf(app), 1);
      }
    }
  }

  function setMaxConcurrent(nextMaxConcurrent) {
    return updateLimits({ maxConcurrent: nextMaxConcurrent });
  }

  function updateLimits(limits = {}) {
    if (limits.maxConcurrent !== undefined) maxConcurrent = normalizeMaxConcurrent(limits.maxConcurrent);
    if (limits.queueLimit !== undefined) queueLimit = normalizeQueueLimit(limits.queueLimit);
    drain();
    return stats();
  }

  function start(entry) {
    entry.started = true;
    cleanupQueuedEntry(entry);
    activeRequests += 1;
    activeEntries.add(entry);
    if (entry.lane) activeLanes.add(entry.lane);
    rotate(applicationOrder, entry.applicationKey);
    rotate(applications.get(entry.applicationKey), entry.visitorKey);

    Promise.resolve()
      .then(() => {
        if (entry.signal?.aborted) throw new RequestAbortedError();
        return entry.task();
      })
      .then(entry.resolve, entry.reject)
      .finally(() => {
        activeRequests -= 1;
        activeEntries.delete(entry);
        if (entry.lane) activeLanes.delete(entry.lane);
        drain();
        pruneMetadata();
      });
  }

  return {
    run,
    canAccept,
    setMaxConcurrent,
    updateLimits,
    stats,
  };
}

function laneFor(options) {
  return options.laneKey == null || options.laneKey === '' ? null
    : JSON.stringify([String(options.applicationKey || 'legacy'), String(options.visitorKey || 'legacy'), String(options.laneKey)]);
}

function normalizeMaxConcurrent(value) {
  const number = Number(value ?? 1);
  return Number.isSafeInteger(number) && number >= 0 ? number : 1;
}

function normalizeQueueLimit(value) {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

module.exports = {
  QueueFullError,
  RequestAbortedError,
  createAskQueue,
};
