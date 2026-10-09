const http = require('node:http');
const https = require('node:https');

const DEFAULT_TASK_TIMEOUTS = Object.freeze({ headersMs: 60_000, idleMs: 600_000 });
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

function normalizeTransportTimeouts(options = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_TASK_TIMEOUTS).map(([key, fallback]) => {
    const value = options[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new TypeError(`Invalid transport timeout: ${key}`);
    }
    return [key, value];
  }));
}

// A single native request: no fetch body deadline, redirects, or POST replay.
function taskTransportFetch(url, options = {}) {
  const timeouts = normalizeTransportTimeouts(options.transportTimeouts);
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
  if (!transport) throw new TypeError('Task transport requires HTTP(S)');
  options.signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    let request;
    let incoming;
    let controller;
    let timer;
    let finished = false;
    let failure;
    let bufferedBytes = 0;
    const chunks = [];

    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
    function fail(error) {
      if (finished) return;
      finished = true;
      failure = error;
      cleanup();
      chunks.length = 0;
      controller?.error(error);
      request?.destroy(error);
      incoming?.destroy(error);
      reject(error);
    }
    function arm(kind, ms) {
      clearTimeout(timer);
      timer = setTimeout(() => fail(Object.assign(new Error(`Upstream ${kind} timeout`), {
        name: 'TimeoutError', code: `upstream_${kind}_timeout`,
      })), ms);
    }
    function onAbort() {
      fail(options.signal.reason || new DOMException('Request aborted', 'AbortError'));
    }
    function flush() {
      while (chunks.length && controller.desiredSize > 0) {
        const chunk = chunks.shift();
        bufferedBytes -= chunk.length;
        controller.enqueue(chunk);
      }
      if (finished && !failure && !chunks.length) controller.close();
    }

    arm('headers', timeouts.headersMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      request = transport.request(target, {
        method: options.method || 'POST',
        headers: { ...options.headers, 'accept-encoding': 'identity' },
        // Isolate task sockets from unrelated callers' timeout/agent policies.
        agent: false,
      }, response => {
        incoming = response;
        arm('idle', timeouts.idleMs);
        const body = new ReadableStream({
          start(value) { controller = value; },
          pull() { flush(); },
          cancel() {
            finished = true;
            cleanup();
            chunks.length = 0;
            incoming.destroy();
            request.destroy();
          },
        });
        // Read upstream independently of downstream event/heartbeat delivery.
        incoming.on('data', chunk => {
          if (finished || !chunk.length) return;
          arm('idle', timeouts.idleMs);
          chunks.push(chunk);
          bufferedBytes += chunk.length;
          if (bufferedBytes > MAX_BUFFERED_BYTES) {
            fail(Object.assign(new Error('Upstream buffer limit exceeded'), { code: 'upstream_buffer_limit' }));
            return;
          }
          flush();
        });
        incoming.on('end', () => {
          if (finished) return;
          finished = true;
          cleanup();
          flush();
        });
        incoming.on('error', fail);
        incoming.on('aborted', () => fail(Object.assign(new Error('Upstream connection interrupted'), {
          code: 'upstream_connection_interrupted',
        })));
        const result = new Response([204, 205, 304].includes(incoming.statusCode) ? null : body,
          { status: incoming.statusCode, headers: incoming.headers });
        Object.defineProperty(result, 'transportError', { get: () => failure });
        result.closeTransport = () => {
          if (!finished) {
            finished = true;
            cleanup();
            chunks.length = 0;
            incoming.destroy();
            request.destroy();
          }
        };
        resolve(result);
      });
      request.on('error', fail);
      request.end(options.body);
    } catch (error) {
      fail(error);
    }
  });
}

module.exports = { DEFAULT_TASK_TIMEOUTS, normalizeTransportTimeouts, taskTransportFetch };
