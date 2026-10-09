# Preserve the existing capacity exercise maintenance response

Change-ID: FIX-20261010-PROVIDER-EXERCISE-COMPAT
Parent-Change: FIX-20261010-PROVIDER-AIR-ADMISSION
Branch: codex/FIX-20261010-PROVIDER-AIR-ADMISSION

## User Goal

Keep existing maintenance admission compatible while adding Air qualification
rejection. Preserve pool concurrency, credentials, qualification and auth rules.
No private data, real IMA, image builds, release or deployment.

## Problem And Change

The first admission commit changed the ordinary capacity exercise error copy
to a generic maintenance message. The existing regression expects its original
capacity exercise message. Preserve that exact copy when only the exercise is
active; use the qualification maintenance message only when qualification is
active. Status, failure category, gate precedence and dispatch behavior do not
change. This follow-up is separate from the image payload commit.

## Verification

Red-first: the full single-worker run reports 820 passed, 1 failed, 6 skipped
(367.44 seconds). The failure is test/app.test.js:226: expected /capacity exercise/
(Chinese original text), received the generic qualification maintenance text.
All Air startup tests pass; both entrypoint children exit with SIGTERM, both
synthetic HTTP listeners close and active requests/account leases return to zero.
The earlier four-worker run also reports 820 passed, 1 failed, 6 skipped, but
its retained aggregate does not independently identify the failure.
Focused original exercise and new qualification regressions after fix:
`node --test --test-concurrency=2 --test-name-pattern='account pool exercise routes|qualification maintenance|qualification preflight|qualification gate|qualification clearing' test/app.test.js test/bot-mount.test.js`
Result: 19 passed, 0 failed, 0 skipped. The original capacity exercise response
is restored verbatim; qualification refusal remains before receipt/dispatch.
No test expectation or timeout was changed.

## Rollout And Rollback

Source-only correction on the requested feature branch. Parent owns final merged
suite and artifact acceptance. Revert this commit to restore the prior copy,
without restoring or deleting any private runtime state.
