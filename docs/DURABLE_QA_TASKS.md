# Durable QA Tasks V1

This API separates QA execution from HTTP subscribers. Legacy `/api/ask` and
`/internal/provider-a/deep-ask` remain available. Never proxy `/internal/` publicly.

## Authentication and Identity

- `/api/tasks`: the same `requireApiToken` policy as `/api/conversations` and
  legacy `/api/ask`. A configured ordinary token requires the matching Bearer
  header (401 otherwise). An empty token preserves tokenless local-demo access.
- `/internal/provider-a/tasks`: configured internal service Bearer token.
- Every operation uses the existing `getConversationOwnerKey` identity (stable
  `x-ima-client-id` or owner cookie). Changing it does not expose another owner's tasks.
- Ordinary and internal task namespaces are isolated, even for the same owner.
- Tokenless mode is for local-only deployments. Owner cookies/client IDs keep
  browser conversations separate but are not a substitute for authentication on
  an exposed service. Do not expose a tokenless Provider to an untrusted network.
  In configured-token mode, the bundled browser needs an authenticated proxy or
  client that supplies the ordinary bearer, as with the legacy APIs. Cookies alone
  never bypass the bearer check; no shared or internal token is embedded in JS.
  With no legacy or mapped internal credential, internal routes remain disabled (404).
- Optional maintainer-managed `IMA_QA_APPLICATIONS_JSON` maps ordinary/internal
  credentials to stable `application:<id>` scheduler/owner identities. Visitor and
  conversation isolation follow that application identity, never browser-selected
  application headers. See [Application Identity](APPLICATION_IDENTITY.md) for the
  configuration, rotation and migration contract. The companion executor must
  forward applicationKey for mapped durable tasks.
- Legacy single-token/tokenless requests retain groups `ordinary` and `internal`
  and their existing owner space. Independent deployments sharing one credential
  are not independently fair; configure separate application IDs to distinguish
  them. Legacy asks also pass trusted application/visitor/conversation keys.

## HTTP Contract

`POST /api/tasks` (or the internal equivalent) requires `Idempotency-Key` (1-128
ASCII letters/digits or `._:-`) and JSON strings `question`, `conversationId`.
V1 requires an existing owned conversation. The internal endpoint additionally
accepts `retrieval_policy: "knowledge_agent"`, `knowledge_scope_ref` (the SHA-256
of the configured knowledge-base ID), and optional `source_intent: "web_requested"`.
These fields are forbidden on ordinary routes. Existing native scope/mode checks
apply. Task question and native answer whitespace are preserved.

New admission returns 202; exact idempotent replay returns 200:

```json
{"task":{"id":"<uuid>","conversationId":"<uuid>","status":"queued","lastEventId":1,"requestKey":"<sha256>"}}
```

Additional task fields are `createdAt`, `updatedAt`, `expiresAt` (event-retention
deadline, null before terminal), `eventsExpired`, `trace`, and a `history` pointer
for succeeded tasks. Times are Unix milliseconds. Status is one of `queued`,
`running`, `succeeded`, `failed`, `cancelled`, `indeterminate`.

- `GET /tasks`: `{tasks:[...]}`, newest first. Optional `requestKey` and
  `conversationId` filters are ANDed. Owned task metadata includes `question` and
  `sourceIntent` (`web` or `knowledge`) while input is retained, to restore a
  pending question before history exists. These are not health/diagnostic fields.
- `GET /tasks/:id`: `{task,snapshot:{events:[{id,event,data}]}}` with the complete
  accumulated event sequence, including partial output on failure.
  Failed/cancelled/indeterminate tasks retain private partial events for the event
  retention window but do not append a failed conversation-history turn.
- `GET /tasks/:id/events?after=N`: replays strictly greater IDs, then subscribes.
  `Last-Event-ID` is accepted when `after` is absent. Default cursor is zero.
  Malformed/duplicate/noncanonical cursors are 400; a cursor ahead of the ledger is
  409. Event names: `conversation`, `process`, `sources`, `delta`, `done`, `error`,
  and `task.status`. Every persisted event has `id: N` in the SSE frame.
- `DELETE /tasks/:id`: `{task}`. Persists cancellation before aborting queued or
  running work. Terminal cancellation is idempotent. Disconnect never cancels QA.
- `DELETE /api/conversations/:id`: returns 409 `conversation_busy` while any
  owned durable task in either API scope is unfinished, including queued recovery
  work and pending completion/binding journals. Cancel tasks explicitly first.
  After owner lookup, unavailable configured task storage returns 503
  `task_store_unavailable`; foreign or missing conversations still return 404.
- SSE heartbeat comments occur every 15 seconds; subscriptions rotate after 240
  seconds. Reconnect using the last received ID. Slow subscribers are disconnected
  at 256 KiB buffered output; at most 8 per task / 256 globally.

Use the full namespace prefix above for each `/tasks` path. Cross-owner/scope IDs
return 404. A full scheduler returns 429 with `failureReason: "queue_full"` before
persisting a new task. Storage unavailability returns 503, with no private error
text. Changed input under an existing key returns 409 `idempotency_conflict`.
A new task also returns 409 `conversation_busy`, before creating a receipt, if
the same owned conversation has unfinished work in the other task API scope or
an active request held by a legacy ask. Same-scope durable tasks still queue FIFO.
Exact idempotent replay remains available during conflicts. Once conflicting work
finishes or is cancelled and releases its conversation lock, the refused key may
be submitted again; a refusal never reserves that key.

## Ambiguous POST Recovery and Retention

The BFF sends `sha256("demo:tasks:v1:" + clientId + ":" + requestId)` as its key.
A lowercase 64-character hex key is exposed unchanged as `task.requestKey`;
other valid keys are exposed as SHA-256 of the supplied key. A separate private
hash of the exact key prevents treating these two representations as identical.
After an ambiguous POST, query the owned list by `requestKey` and `conversationId`,
or repeat the identical POST. Do not create a new key automatically.

Terminal input/events are pruned after 24 hours. Minimal owner/scope identity,
key hash, request fingerprint, terminal metadata and conversation/task history
pointer are retained indefinitely. Thus the same key never automatically re-asks
the question the next day. After pruning, status returns `snapshot.events: []`,
`snapshot.eventsExpired: true` and its history pointer; SSE returns 410
`task_events_expired`. `lastEventId` remains the original terminal cursor.
Conversation detail messages carry `taskId` for lookup while history still exists.
History has its independent existing retention/turn limit, so a pointer is not a
promise that an old answer is still available. A new deliberate ask needs a new key.

## Persistence, Recovery and Limits

The default private task directory is `${config.conversations.storePath}.tasks`.
An embedding application may set `config.durableTasks.storePath` to another private
directory or set `config.durableTasks.enabled` false. Only persistent conversation
stores with the IMA Web Agent provider enable the capability. Inspect
`GET /internal/provider-a/capacity` -> `features.durable_qa_tasks_v1`; a failed
startup/recovery/writer lease or later storage fault makes it false.
The ordinary-auth browser endpoint is `GET /api/capabilities` returning
`{schemaVersion:1,features:{durable_qa_tasks_v1:true}}` when durable storage is healthy
(false otherwise), after the same ordinary authentication policy above. Tokenless
local-demo mode is not independently disabled. It exposes no service capacity or
internal token. Frontends must use this endpoint, not the internal capacity route.

The store uses a process-lifetime exclusive local-filesystem writer lease, 0700
directory and 0600 files. Atomic replacement fsyncs file and directory before
acknowledgement or publication. Do not run multiple Provider processes against
the same conversation/task directory or place it on a network filesystem. After
an unclean exit, lease expiry can take 30 seconds; restart after that interval if
the capability is unavailable. Never delete the ledger to fix admission errors.

Queued records resume on restart. `running` is persisted by the client's
`onDispatch` callback immediately before the upstream QA POST; waiting for a
preferred pool account remains `queued` with `trace.executionStartedAt` set.
Dispatched records without a completion journal become `indeterminate` with a
terminal error event and are not retried. This is conservative if a crash occurs
between persisting the dispatch marker and sending the upstream request.
The journal persists answer, metadata, upstream identity and terminal payload
before idempotent history application; recovery finishes it without upstream work.
History receipts are independent of trimmed turns and are never age-pruned;
their 10,000-per-conversation cap matches the task store's total receipt bound.
This prevents newer completion replay from removing an older journal's dedupe key.
Failure between journal,
history, and terminal write fails closed until recovery.
Confirmed account/session bindings use a separate durable handoff before the
upstream ask, not only at successful completion. Failed/cancelled partial answers
therefore retain conversation affinity. A binding write interrupted between the
task journal and history store is replayed before restart admission. Credentials,
account IDs and upstream session IDs are never exposed in public task metadata.

Resource defaults: 500 unpruned task records, 10,000 retained receipts, 128 MiB
ledger budget, 2 MiB/task and 10,000 events/upstream events (small reserved terminal
space). Admission stops at a bound; receipts are never evicted to admit new work.
Capacity planning must account for retained receipts. Task records, temp files,
lock state and conversation history are private runtime data, never Git inputs.

Task execution has no total 180-second deadline. Explicit transport options use
`config.concurrency.taskConnectTimeoutMs` (default 60,000) and
`config.concurrency.taskIdleTimeoutMs` (default 600,000), mapped to
`transportTimeouts.headersMs` / `idleMs`. The scheduler/transport companion change
implements native HTTP transport and per-byte idle accounting. The task core
requires exactly one successful upstream `done` marker before history completion.
An explicit success with zero answer characters fails with `upstream_empty_answer`
and no history turn; no fallback answer is fabricated. Whitespace-only answers
remain exact upstream output. Legacy ask fallback behavior is unchanged.
Failure events and `trace.terminalReason` retain a fixed allowlist of protocol and
transport codes, including `upstream_headers_timeout`, `upstream_idle_timeout`
and `upstream_terminal_missing`. Unknown codes/messages become a generic reason;
raw upstream error text never enters durable events or trace.

## Slot Capacity

The companion scheduler commit is required for fair queueing and per-conversation
lanes. Automatic Provider capacity now sums eligible account **slots**, including
occupied slots, rather than counting accounts or shrinking to currently free
slots. Zero eligible slots pauses dispatch. Readiness/capacity expose separate
`totalSlots`, `eligibleAccounts`, `schedulableAccounts` and `totalAccounts`; the
existing `capacity` / `maxConcurrent` and `schedulable` / `available` values are
slot counts. Native policy capacity sums only qualified knowledge-agent slots.

Per-account `maxConcurrent` defaults to one and survives encrypted directory
reload, reauthentication replacement, pool sync and configured startup seeding.
Existing directory accounts apply an explicitly configured value without replacing
their credentials. No real deployment's slot configuration is changed by this
candidate. The fair scheduler reserves an account only for a runnable task.
A task waiting for its pinned account stays queued without taking a global
execution slot. Other account slots remain usable. The private reservation is
released once on cancellation, pre-dispatch failure or completion; the pool's
availability notifications wake queued selection. It never migrates a follow-up
to another account merely because the original account is busy. The session's
recorded question mode is passed explicitly into the upstream client.

`task.trace` includes received/execution/dispatched/first-event/terminal timestamps,
terminal reason and subscription/disconnect/rotation counters.
`lastUpstreamActivityAt`, `rawUpstreamBytes` and `rawUpstreamChunks` come only from
the transport's metadata-only raw-byte callback, including SSE comments/heartbeats.
`lastUpstreamEventAt` and existing `upstreamBytes`/`upstreamEvents` describe normalized
events (the byte count is their serialized JSON size, not network bytes). Subscriber
heartbeats never update upstream activity. A client without raw activity support
leaves the raw timestamp null; it is not inferred from normalized events. These
fields contain no question, answer, credentials, upstream URL or raw error text.
No task question/answer logging is added.

## Synthetic Integration

`createApp({config, conversationStore, imaWebAgentClient})` accepts a synthetic
client exposing `async *streamAsk({question,signal,onDispatch,onActivity,transportTimeouts,...})`.
Call `onDispatch()` once immediately before the synthetic ask; yield normal
`process`/`sources`/`delta` events and exactly one `{type:"done"}`. Record synthetic
raw-activity evidence with `onActivity({bytes: positiveInteger})` only when upstream
response bytes arrive, never from subscriber events. Set persistent
stores in an `os.tmpdir()` directory, not real runtime. `app.locals.durableQATasks`
exposes `close()` for teardown. The lower-level `DurableQATasks` constructor accepts
an injected queue, execution callback, store clock/limits, heartbeat and rotation
intervals for deterministic fault/recovery tests.

```sh
node --test test/durable-qa-tasks.test.js
DURABLE_QA_SOAK=1 node --test test/durable-qa-soak.test.js
npm test
```

The opt-in soak uses an actual 365-second upstream pause, disconnects the first
subscriber, verifies execution past 180 seconds, reconnects and checks one history
turn and one upstream invocation. It never contacts IMA or uses real credentials.
