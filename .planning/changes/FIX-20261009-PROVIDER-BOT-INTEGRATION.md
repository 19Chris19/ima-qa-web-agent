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

## Rollout and Rollback

Parent integrates each atomic commit then runs combined full/container acceptance.
Do not merge the earlier pair-disabling commit 436c83b. Revert the matching fix
commit to roll back; never delete journals or rewrite session bindings.
