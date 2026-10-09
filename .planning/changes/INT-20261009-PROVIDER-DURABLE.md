# Provider durable task integration

Goal: persist accepted QA independently of browser connections, without rewriting
IMA content or inferring completion. Isolated candidate, not a released version.

Initial integrated features: scheduler/transport ffa0c96, task store bf58c89,
built-in viewer 6a1cf50. Preserve legacy interfaces and the existing default one
slot per account. Air extensions are now reconciled below, but promotion still
requires a renewed maintenance window.

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

Historical boundary at the first acceptance: scheduler application groups were
trusted route classes. The subsequent application-identity integration adds
explicit deployment registration; legacy keys still retain legacy ownership.
See docs/APPLICATION_IDENTITY.md before changing any existing credential map.

Final isolated verification (2026-10-09): 637 tests, 632 passed, 5 optional
skips, no failures. Runtime source 866b731. The final paired Node chain ran
370717ms, rotated its viewing connection once, dispatched once and completed
once with exact whitespace. Final ARM64 Docker pair passed replay, ownership,
history uniqueness, explicit stop, management blocking and restart recovery.
An interrupted dispatched task became indeterminate and was not resubmitted.
See the website docs/DURABLE_TASK_ACCEPTANCE.md for paired image identities.
No actual IMA, Vercel, ngrok or live bot compatibility acceptance was performed.

Closeout round: application identity, runnable account reservations, policy
eligibility, cancellation finalizers and early session-profile binding are
integrated. The Air overlay and bot mounting preserve the local extensions,
with independent website readiness and shared execution capacity. Pair legs
reserve distinct accounts before dispatch, use trusted application/context
scoping and retain active exclusions through long executions. Current supplied
bot code uses single deep-ask calls; paired historical wire compatibility is
separate synthetic evidence, not a claim that the running robot now uses tasks.

Combined actual-entrypoint / mount / pair tests passed 61/61 on 67be4c7.
This includes five synthetic basic-qualified accounts executing concurrently,
without changing real per-account slots or sending IMA requests. Final combined
suite, fixed-image acceptance and old-admin API checks are recorded at closeout.

Rollback: stop task admission and drain active work before code rollback. Keep
task ledgers and new conversations; never restore stale runtime snapshots.

Final closeout runtime source: 350bc8bd (2026-10-09). Full suite 804 tests:
798 pass, 6 optional skip, 0 fail. Separate enabled integrations: identity 9/9,
actual admin backend 1/1 and unchanged website history parser 10/10.
Native task -> scheduler -> pool -> synthetic native HTTP survived 365127ms of
upstream silence and succeeded at 365738ms; one QA POST and two history messages.
The ordinary paired website chain at 81f24de / 9adec552 lasted 370977ms before
the final pair-receipt and proxy-error follow-ups. These are synthetic only.

Pair receipts retain only minimal affinity/exclusion fields through 24-hour event
pruning. Completed-pair expiry is absolute, never renewed on restart; recovery
groups before bounded insertion. 100 focused tests cover 8196 synthetic receipts,
incomplete exclusion, scoped identity and fail-closed overflow. Already-pruned
legacy pair metadata cannot be reconstructed. No real single-account concurrency
increase or credential mapping change occurred.

Fixed Air source archive and production dependencies are prepared privately.
The three previous admin assets are preserved with recorded SHA-256 provenance;
the current backend and old-admin one-question consent pass 7/7 with Air Node 22.
No live credentials, account directories or conversation data enter that artifact.
Paired final image results and remaining deployment gates are recorded in the
Explorer docs/DURABLE_TASK_ACCEPTANCE.md. Package dry run: 257 files,
2917118 unpacked bytes, no private runtime/profile/environment paths.

Final ARM64/AMD64 builds and Nginx/BFF/Provider replay/restart checks passed with
injected fake upstream, no IMA egress and isolated volumes. Dispatched restart
work became indeterminate without redispatch/history fabrication. Network-disabled
image checks found no private data. Local image IDs and exact limits are recorded
in docs/DURABLE_TASK_ACCEPTANCE_20261009.md. AMD64 emulation is not performance
evidence. Fixed paired Air artifact short chain passed in 2221ms on Node 22.22.3.
Test containers stopped without deleting volumes; live processes were not changed.
