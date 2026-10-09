# FIX-20261009-PROVIDER-BOT-INTEGRATION

## Goal and Scope

Fix integrated Air bot legacy-profile compatibility and preserve distinct-account
pair routing with trusted owner/application scoping. Work from parent 98efcbc.
No live requests, deployment, runtime state, credentials or raw logs.

## Commit Plan

1. Preserve account/session for legacy unknown profiles; reject known conflicts.
   Restrict context-error sanitization to the context consumer call itself.
2. Port pair exclusion with active-lease lifetime, bounded completed retention,
   trusted scope, and synthetic cancellation/concurrency/capacity tests.

## Verification

Focused helper/mount/app regressions passed 100/100 for the first commit. Existing
six native/classic JSON/SSE/task cases cover bound legacy sessions without
profile metadata; explicit helper test verifies one consume and no profile guess.
Pair implementation follows only after those basic tests pass.

The startup marker, independent native/classic policy admission and dual capacity
declarations each had a failing regression (3/3 red) before the app fix. Bot v4
policies and mode-specific website capabilities are intentionally separate.
Focused post-fix helper/mount/app regressions passed 103/103.

Pair implementation now binds account exclusion to leases under a bounded 4096
record map. Active/incomplete records do not expire; only fully consumed/released
pairs expire after five minutes. Exact context binding plus trusted application
forms the pair namespace across visitors, with owner fallback if no binding exists.
Durable journals restore exclusions before scheduling; unknown affinity blocks.
Shared helper a94917e supplies bot union capacity without changing website gating.
Synthetic real-pool HTTP scope/SSE/task/restart tests pass 3/3. The combined
pool/runnable/policy/session/mount/durable/shared-capacity run passed 127/127.
Full `npm test -- --test-reporter=dot` passed (exit 0); final native-zero website
gating and blocked-pair cleanup adjustments passed the 108/108 focused rerun.
No queue edits. Pool edits were explicitly assigned after 98efcbc.

Final whitespace checks pass. Installed governance CI reports one false positive
on the unchanged pool callback assignment `this.onAccountCredentialsChange =
options.onAccountCredentialsChange || null` (also present at parent HEAD line 28).
It is source code, not a credential; no scanner suppression or unrelated rewrite
was introduced. Five pre-existing soft warnings remain. The standalone repository
does not include `scripts/check_governance.py`.

## Rollout and Rollback

Parent integrates each atomic commit then runs combined full/container acceptance.
Do not merge the earlier pair-disabling commit 436c83b. Revert the matching fix
commit to roll back; never delete journals or rewrite session bindings.
