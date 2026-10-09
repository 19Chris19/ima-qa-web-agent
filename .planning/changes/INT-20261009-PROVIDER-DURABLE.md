# Provider durable task integration

Goal: persist accepted QA independently of browser connections, without rewriting
IMA content or inferring completion. Isolated candidate, not a released version.

Integrated features: scheduler/transport ffa0c96, task store bf58c89, built-in
viewer 6a1cf50. Preserve legacy interfaces and the existing default one slot per
account. Do not replace the Air runtime with this public-base candidate: its
local bot extensions require separate reconciliation and a maintenance window.

Verification in progress: combined tests, actual-clock synthetic native HTTP
chain, isolated Docker fixture, and independent review. No actual IMA request,
account access, live service change or public deployment is part of these checks.

Initial combined suite: 611 passed, 5 optional skips, 0 failed. Native HTTP
actual-clock acceptance: 365867 ms, upstream silence 365115 ms, subscription
rotation at 241031 ms, exactly one QA POST and two history messages. These are
synthetic loopback results, not IMA or the real public proxy.

Raw activity follow-up: forward byte-count-only callbacks from the native task
transport through the client to the durable ledger. No payload reaches the
diagnostic callback; initialization traffic is excluded. Two new assertions
failed before implementation; all 9 transport tests then passed. A callback
storage failure aborts reception instead of falsely claiming durable progress.

Known boundary: scheduler application groups are trusted route classes, not
individually registered deployments. See docs/DURABLE_QA_TASKS.md.

Final isolated verification (2026-10-09): 637 tests, 632 passed, 5 optional
skips, no failures. Runtime source 866b731. The final paired Node chain ran
370717ms, rotated its viewing connection once, dispatched once and completed
once with exact whitespace. Final ARM64 Docker pair passed replay, ownership,
history uniqueness, explicit stop, management blocking and restart recovery.
An interrupted dispatched task became indeterminate and was not resubmitted.
See the website docs/DURABLE_TASK_ACCEPTANCE.md for paired image identities.
No actual IMA, Vercel, ngrok or live bot compatibility acceptance was performed.

Rollback: stop task admission and drain active work before code rollback. Keep
task ledgers and new conversations; never restore stale runtime snapshots.
