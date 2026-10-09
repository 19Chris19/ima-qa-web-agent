# Durable Conversation Scope Admission

- Change-ID: FIX-20261009-PROVIDER-TASK-SCOPE-ADMISSION
- User-Goal: Reject known cross-scope and legacy-held conversation conflicts before accepting durable work that would fail at dispatch.
- Base: e4a5e66074ff7013a32895a72f5eeebb69e5b834
- Scope: durable manager admission and lock ownership tracking, synthetic tests and API documentation.
- Non-goals: scheduler fairness redesign, transport/client changes, authentication changes, live calls, credentials, push or deployment.
- Policy: exact idempotent replay first; new owned requests return 409 conversation_busy for unfinished other-scope tasks or a conversation lock not held by this scope's durable execution. No receipt is created on refusal. Same-scope durable FIFO remains unchanged.
- Verification: Three focused regressions reproduced HTTP 202 instead of 409 for running cross-scope, queued cross-scope and legacy-held conversations before implementation. Final app/task suite passed 92 tests with 1 companion-scheduler-dependent skip (23525ms). Integrated scheduler/pool injected task suite passed 36/36 (12829ms), including auth compatibility and same-scope FIFO tests. No live calls.
- Rollout: local candidate for parent integration only; existing persisted tasks are not rewritten.
- Rollback: revert this follow-up while preserving task receipts/history.
- Governance: diff whitespace checks passed; repository-local checker remains absent in this public checkout. No integration, client, transport or scheduler files modified.
