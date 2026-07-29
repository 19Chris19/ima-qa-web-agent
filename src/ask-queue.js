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
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent || 1));
  const queueLimit = Math.max(0, Number(options.queueLimit || 0));
  let activeRequests = 0;
  const queue = [];

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
      };

      const onAbort = () => {
        if (entry.started) {
          return;
        }
        const index = queue.indexOf(entry);
        if (index >= 0) {
          queue.splice(index, 1);
        }
        reject(new RequestAbortedError());
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        entry.onAbort = onAbort;
      }

      if (activeRequests < maxConcurrent) {
        start(entry);
        return;
      }

      if (queue.length >= queueLimit) {
        cleanupQueuedEntry(entry);
        reject(new QueueFullError());
        return;
      }

      queue.push(entry);
    });
  }

  function cleanupQueuedEntry(entry) {
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
  }

  function drain() {
    while (activeRequests < maxConcurrent && queue.length > 0) {
      start(queue.shift());
    }
  }

  function start(entry) {
    entry.started = true;
    cleanupQueuedEntry(entry);
    activeRequests += 1;

    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        activeRequests -= 1;
        drain();
      });
  }

  return {
    run,
    stats,
  };
}

module.exports = {
  QueueFullError,
  RequestAbortedError,
  createAskQueue,
};
