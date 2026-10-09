# Durable Provider QA Tasks

- Change-ID: FEAT-20261009-PROVIDER-DURABLE-TASKS
- User-Goal: Persist authenticated QA work independently of HTTP subscribers, with resumable events and exactly-once local history completion.
- Base: dc96655 (public origin/main)
- Scope: app dispatch integration, durable-qa modules, conversation task receipts, history export redaction, slot capacity/readiness and directory startup preservation, synthetic tests and API documentation.
- Non-goals: queue/pool/client/config changes owned by another agent; live services, credentials, deployment and push.
- Design: private per-task atomic fsynced records; exclusive writer lease; queued recovery; running recovery becomes indeterminate; completion journal precedes idempotent history and terminal publication.
- Acceptance: owned ordinary/internal routes; required idempotency key; complete cursor snapshots; explicit cancellation; bounded resources; persistence-before-ack/publish; no total request timeout.
- Verification: full suite passed 572/577 tests (5 optional skips, 0 failures; 136800ms); after the final binding-recovery and indefinite-receipt regressions, companion scheduler/pool injected durable/capacity/history suite passed 32/32 (4951ms). Actual-clock synthetic task soak passed at 365398ms. `git diff --check` and staged diff checks passed. No real IMA traffic.
- Rollout: local candidate only; parent integration and explicit release approval required.
- Rollback: revert this candidate commit; preserve private durable receipts and history to prevent accidental re-dispatch during a later rollout.

## Decisions

- V1 requires an existing owned conversation. Internal contract validation uses the existing knowledge-agent scope checks.
- Capability is available only for IMA Web Agent with persistent conversation and task stores and a held writer lock.
- Task input and native answer whitespace are preserved. Transport budgets are 60 seconds for headers and 600 seconds idle; disconnects do not abort execution.
- Terminal events/input retain for 24 hours; minimal idempotency receipts retain indefinitely under a bounded admission budget. Unknown dispatched tasks are never automatically retried.

## Implementation and Evidence

- Ordinary and service-auth task namespaces are owner-isolated. POST/list/status/cursor SSE/DELETE preserve legacy asks. Ordinary `/api/capabilities` exposes only the feature boolean; it is false when ordinary token access or healthy durable storage is unavailable.
- Hashed BFF request keys remain unchanged in owned task metadata and support list filtering with conversationId. Other keys expose a SHA-256 correlation value, never the original key. Owned task question/sourceIntent restore pending UI bubbles; neither appears in trace, health or new logs.
- Task input, events, dispatch markers, affinity handoffs, completion journals and terminals are atomically fsynced before acknowledgement/publication. History receipts survive turn trimming. Faults fail closed and recovery cannot repeat dispatched asks.
- Queued work acquires conversation ownership only inside actual scheduler dispatch. Trusted application/visitor/lane keys and synchronous canAccept admission integrate with companion scheduler commit ffa0c96. Waiting for preferred account capacity remains queued until onDispatch; it still consumes a global scheduler slot.
- Fairness scope is explicitly ordinary/internal durable route groups plus legacy ask group, not per deployment. Current auth has one configured ordinary token and one service token, with no finer trusted application identity. Request bodies or arbitrary application headers never set the scheduler application key.
- Terminal pruning strips events/private input, preserves terminal cursor/identity and returns eventsExpired/history pointer. Original key replay remains terminal after pruning/restart. A deliberate new ask requires a new key.
- Binding journal preserves confirmed upstream account/session before QA POST, including failed/cancelled partial work. History exporter explicitly redacts new private task IDs/receipts to keep archive v1 compatible.
- User-requested integration sums eligible slot capacity including occupied slots, keeps account counters separate, permits zero-capacity pause with the companion scheduler, and preserves account maxConcurrent through directory reload/replacement/startup. No real account configuration was changed.
- Synthetic tests cover auth/owner/scope, cursor strictness/replay, missing/duplicate upstream terminal, whitespace, queue rejection before persistence, cancellation/disconnect, heartbeat/rotation, writer lock, capacity bounds, storage faults, completion recovery, history dedupe, receipts after 24 hours, affinity after failed first task and directory settings.
- The optional actual-clock synthetic harness passed with 365398ms duration, one upstream call, reconnect after the legacy 180-second deadline, and one history turn. It loaded code before later metadata/scheduler/affinity refinements; later targeted tests cover those refinements. Parent separately reported a 370596ms whole-chain pass; scheduler agent separately recorded its actual native-transport 365124ms pass.

## Governance and Release Boundary

- `npm ci --ignore-scripts` succeeded with zero reported vulnerabilities; dependency manifests unchanged.
- This public checkout lacks `scripts/check_governance.py`; the required exact command was attempted and exits 2. The installed checker with `--repo ... --ci` initially passed before staging, but its staged whole-blob scan flags existing credential-related JavaScript expressions in provider-a-server.js and web-agent-account-directory.js. Baseline vs staged assignment-pattern counts are 2/2 and 29/29, with zero new matches. Reviewed additions contain no real credentials. This final checker result is not claimed green. Existing initialization/older-record/unrelated-worktree warnings remain; no unrelated governance bootstrap was performed.
- Late-recovery review removed age-based history receipt pruning entirely. A regression advances 72 hours, appends/trims a newer turn, reloads and reapplies the old task key without duplicating history. Receipts stay bounded at 10,000 per conversation and are never silently evicted.
- No queue/pool/client/config files owned by the scheduler agent were edited. Companion integration was tested read-only through process-local module injection; no sibling files copied or worktrees removed.
- No live service, runtime, real credentials, push, deployment or Docker release. Final combined candidate must include scheduler ffa0c96 and the independently owned frontend changes; parent owns release integration.
