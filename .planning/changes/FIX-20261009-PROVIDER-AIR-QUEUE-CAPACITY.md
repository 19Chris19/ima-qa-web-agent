# Air shared execution capacity

Change-ID: FIX-20261009-PROVIDER-AIR-QUEUE-CAPACITY

## Goal and scope

Do not use the native website qualification count as the shared queue ceiling
when Air bot policies are mounted. Count each operational pool account's slots
once if a mounted policy or the existing website route can use that account.
Keep non-Air and explicitly fixed concurrency behavior unchanged.

Only capacity calculation, Provider startup wiring, focused tests and this change
record are owned here. No app, helper, pool or live configuration edits. Parent
owns final integration and full-suite verification.

## Plan

1. Add red tests using real pool, Air policy capacity and Air readiness instances.
2. Calculate the union of eligible account slots, excluding disabled, cooling
   and maintenance accounts but retaining busy eligible slots.
3. Wire startup synchronization and verify qualification/state/slot changes,
   native-only public compatibility and actual leased queue execution.

## Verification

- Base: parent integration 98efcbc. Red first: three actual-pool regression
  cases failed with 0 instead of 3, 3 instead of 5, and 0 instead of 4 slots.
- Final focused run: 29 passed, 0 failed, 0 skipped across air-queue-capacity,
  provider-a-capacity, air-runtime, runnable-slots and provider-a-release tests.
  Includes real leased queue dispatch and unchanged public/fixed behavior.
- Initial broader run could not load express/cors in the new worktree; installed
  dependencies using `npm ci --ignore-scripts --offline` before the passing run.
- `git diff --check` passed. Repository governance script is absent; installed
  skill checker flags two unchanged token-expiry property assignments in
  provider-a-server.js (baseline 2 / staged 2, identical regex matches) plus five
  existing soft warnings. No credential literals; governance is not reported green.
- No full-suite duplication: parent owns final integrated full/Docker checks.

Synthetic clients only; no IMA, browser, live runtime or credentials.

## Rollout and rollback

Local candidate only. Parent integrates the focused commit and reruns final
acceptance. Revert this commit to restore the prior website-scoped ceiling;
do not rewrite task journals or history.
