# Task scheduler integration contract

This change supplies queue, account slots, and transport only. The task route,
task storage, admission and public response formats belong to the core change.

## Core route / dispatch

```js
await askQueue.run(async () => {
  for await (const event of imaWebAgentClient.streamAsk({
    question,
    signal: taskController.signal,
    applicationKey, // optional to the pool; scheduler consumes it below
    accountId, // preserve existing account affinity on follow-up
    sessionId,
    mode: 'knowledge_agent',
    allowAuthRefresh: false,
    transportTimeouts: { headersMs: 60_000, idleMs: 600_000 },
    onDispatch, // durably record dispatched before issuing the native POST
  })) {
    // Persist task events; browser reconnection must not re-dispatch work.
  }
}, {
  signal: taskController.signal,
  applicationKey: trustedApplicationId,
  visitorKey: trustedVisitorId,
  laneKey: trustedConversationId,
});
```

- Keys must come from authenticated application registration and server-owned
  visitor/conversation state, never arbitrary headers. Missing app/visitor keys
  share `legacy`; a missing lane imposes no additional serialization.
- Lanes are scoped by `(applicationKey, visitorKey, laneKey)`. Core must use a
  stable visitor identity throughout a conversation. Requests in a lane remain
  FIFO and serial, including when earlier work is cancelled or fails.
- Waiting applications rotate, then their visitors rotate. Active work is not
  preempted. Blocked lanes are skipped and no tenant permanently reserves slots.
- Explicit `transportTimeouts` is preferred. As a narrow bridge for dispatch
  helpers that currently forward only the signal, assign
  `taskController.signal.transportTimeouts = { headersMs: 60000, idleMs: 600000 }`.
  The client reads this only when the explicit argument is omitted. Neither the
  pool nor client reads request headers for this option.
- Do not use the legacy total request timer for task execution. Browser SSE
  disconnects/heartbeats must neither abort a persistent task nor reset upstream
idle time. The task cancellation endpoint aborts the task controller explicitly.
- `onActivity({ bytes })` receives only the byte count of QA response data,
  including comments and incomplete heartbeat frames. The integrated durable
  ledger uses it for actual upstream activity timestamps, never downstream
  heartbeat timestamps or response-body logging. A thrown callback fails closed.
- `onDispatch` remains synchronous. Complete any asynchronous durable dispatch
  recording before entering `streamAsk`; throwing in `onDispatch` prevents POST.
- The opt-in transport also applies to task-owned session initialization and auth
  refresh. Existing fetch injection continues to serve legacy calls. Tests can
  inject `config.taskFetchImpl(url, options)` to replace the native task transport.

## Timeouts and failure behavior

`config.concurrency.taskConnectTimeoutMs` reads `IMA_QA_TASK_CONNECT_TIMEOUT_MS`
(default 60000), and `config.concurrency.taskIdleTimeoutMs` reads
`IMA_QA_TASK_IDLE_TIMEOUT_MS` (default 600000). Core maps these to `headersMs` and
`idleMs` respectively. `requestTimeoutMs` is the unchanged legacy total deadline.

The native HTTP(S) task request starts its headers deadline before connection,
covering DNS/TCP/TLS and response headers. After headers, only raw upstream body
bytes reset the idle timer, including incomplete events, comments and heartbeats.
There is no total-duration timer and no fetch/Undici default body timer. Reading
upstream is independent of downstream iteration, with a 2 MiB pending-byte safety
cap (the existing parser separately caps stream/event sizes).

Errors retain `upstream_headers_timeout`, `upstream_idle_timeout`,
`upstream_connection_interrupted`, or `upstream_buffer_limit` instead of being
misclassified by the parser. Explicit cancellation preserves the signal reason.
There are no redirects, automatic network retries, or replays of a dispatched QA
POST. The existing pre-question auth/session refresh behavior is unchanged.

## Queue capacity and account configuration

`askQueue.updateLimits({ maxConcurrent, queueLimit })` updates either value;
`setMaxConcurrent(number)` remains supported. Zero concurrency pauses dispatch.
Reducing limits does not evict queued jobs or interrupt active work. Increasing
capacity immediately drains runnable work.

`askQueue.canAccept({ signal, applicationKey, visitorKey, laneKey })` is a read-only
admission probe matching `run()`, including blocked lanes and paused concurrency.
Probe immediately before durable creation and call `run()` in the same synchronous
turn; it is not a reservation across an `await`. Acquire `conversation.beginRequest`
only in the queued callback and release it only if acquired by that callback.
Queued cancellation must not release the conversation lock of another active task.

Each account accepts `maxConcurrent`, a positive integer defaulting to `1`, via
account JSON configuration or `pool.syncAccounts()`. No real configuration is
changed. An account can serve independent sessions concurrently only when this
limit is explicitly raised. Serial conversation lanes belong to the scheduler.

The integrated account directory preserves `maxConcurrent` through
`getPoolAccounts()` and synchronization. Missing limits remain one, including
after `syncAccounts()`. Multi-slot tests are synthetic, not evidence that IMA
supports real parallel execution on one login.

Pool summary fields:

- `totalAccounts`, `availableAccounts`, `busyAccounts`: existing account counts;
  a partially occupied account remains `busy`, even with a free slot.
- `totalSlots`: configured slots across all accounts, including disabled accounts.
- `capacity`: slots on enabled, non-maintaining, non-cooling accounts, including
  slots currently occupied. Use this as the scheduler concurrency ceiling.
- `availableSlots`: free schedulable slots now; never use this as total capacity.
- `activeRequests`: active leases across all accounts.
- `waitingRequests`, `waitingPreferredRequests`: cancelable account-slot waiters,
  exposed so core can distinguish waiting for affinity from actual upstream work.
- Detailed accounts expose `maxConcurrent`, `activeRequests`, `availableSlots`.

The integrated `src/provider-a-capacity.js` and readiness checks use execution
slots rather than account count, with the configured global cap.
Trusted callers can dynamically pass limits to the queue. Maintenance refuses
active accounts; automatic refresh is deferred while leased, and leasing waits
until maintenance finishes. Preferred account affinity never silently migrates.
Busy preferred accounts wait cancelably instead of failing or selecting a free
different account. Integrated task scheduling now uses `isRunnable` and
`tryAcquire` to reserve a private account lease during selection, before counting
a global execution slot. Resource-blocked lanes preserve FIFO while other lanes
can run; availability notifications call `wake()`. Reservations are released
once even when cancellation occurs before the execution microtask. The lease
cannot be forged, reused or moved to another account. Standalone pool callers
still have the original cancelable preferred-account waiting interface.

## Local verification

`node --test test/task-scheduler.test.js test/task-transport.test.js`
uses only synthetic clients and loopback HTTP servers. Run `npm test` for legacy
regressions. No test in the new files contacts IMA or loads live credentials.

For a separate >=6-minute real-clock chain, set `TASK_NATIVE_LONG_CLOCK=1` and run
`node --test test/task-native-long-clock.test.js`. Before core integration, point
`PROVIDER_TASK_CORE_ROOT` at the core checkout; the test composes its app/task code
with this queue/pool/client in memory without changing core files. It uses a real
365-second silent loopback response, 240-second browser stream rotation, reconnect,
one upstream QA POST, durable completion, and history checks. Unit timings are
never substitutes for this result. The test logs hashes of core files it loaded.
