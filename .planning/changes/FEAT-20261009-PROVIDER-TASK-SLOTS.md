# Task transport and fair account slots

Change-ID: FEAT-20261009-PROVIDER-TASK-SLOTS

## Goal

Add opt-in header/byte-idle task transport, trusted application/visitor fair
scheduling with serial lanes, and configurable per-account slots (default one).
Preserve legacy callers and never replay dispatched questions.

## Scope and boundaries

Own ask-queue, ima-web-agent-pool, ima-web-agent-client, config, new transport,
synthetic tests and integration documentation only. Core owns app and task storage.
No live configuration, credentials, IMA traffic, deployment, or push.

## Design and acceptance

- Native HTTP(S) task transport: 60s connection/headers, 600s upstream-byte idle,
  no total deadline, explicit abort, no redirects or retries.
- Trusted run metadata; round robin applications then visitors; skip blocked
  lanes without reserving idle capacity. Legacy callers share a default app.
- Dynamic queue limits retain setMaxConcurrent compatibility.
- Read-only canAccept probe matches lane-aware run admission before persistence.
- Per-account maxConcurrent defaults to one; account and slot stats are distinct;
  maintenance rejects active accounts; affinity remains binding.
- Synthetic tests exercise timeout, heartbeat, cancellation, fairness, affinity,
  parallel sessions, capacity updates and cleanup.

## Integration

See docs/TASK_SCHEDULER_INTEGRATION.md. Core must forward trusted scheduler keys
and transport options and must not impose the legacy total timer on task work.
Core also owns preserving maxConcurrent through directory rows, capacity scaling,
and acquiring conversation locks only when a queued callback starts.

Task-only configuration defaults: IMA_QA_TASK_CONNECT_TIMEOUT_MS=60000 and
IMA_QA_TASK_IDLE_TIMEOUT_MS=600000. No runtime or example configuration changed.

## Verification

Initial full regression run exposed five maintenance-quarantine cleanup failures;
the guard was corrected. Synthetic timer margins were widened after CPU-load
flakes; production budgets were not altered.

- Final `node --test --test-reporter=spec`: 574 tests, 570 passed, 4 skipped,
  zero failures, 80.368 seconds. Includes legacy regression tests; opt-in native
  long-clock test is skipped in the ordinary full suite.
- Explicit two-session affinity regression: full account A waits cancelably even
  while account B is free; no migration, waiter counts visible, no leaked leases.
  Pool waiters still occupy a global queue slot; core owns queued presentation
  until onDispatch and any future account-aware runnable admission.
- Separate `TASK_NATIVE_LONG_CLOCK=1` run with core checkout supplied via
  `PROVIDER_TASK_CORE_ROOT`: PASS, one test, no skips, 365.676 seconds total.
  Started 2026-10-09T12:59:33.214Z; chain elapsed 365285ms; upstream silence
  365124ms; browser rotation 240221ms; exactly one QA POST; terminal succeeded;
  history has two messages; all queue/account leases released.
- Short-duration unit tests are not long-clock evidence. This run used core files
  loaded at startup, not later core edits. Revalidate changed core integration.
- `git diff --check`: PASS.

Loaded core SHA-256 evidence (synthetic run, no source copies):

```
app.js 76d703a558f47a35c799bf895526ecaac98bbd9a6de12020b747ce4ba43b9edc
durable-qa-tasks.js afc0e939d1dec4208825650b99d71b1d34816ae83785db659d80e94a903d6a0f
durable-qa-store.js 6a6b6986027321d09e6c308b36f31ccedc678123b017595f1380f923a37b8926
durable-qa-routes.js fec7ff3f80d2c12a910376cb1f09394c676bde977aff69f96047c8856723df59
```

`python3 scripts/check_governance.py --ci` was attempted but exits 2: this standalone
repository does not contain the script. Named-file staging, staged diff inspection,
secret/path audit and `git diff --check` are still required before the local commit.

## Rollout / rollback

Local atomic commit only. Task transport is opt-in; no account limits are raised
in real configuration. Revert this commit together with dependent core integration.
