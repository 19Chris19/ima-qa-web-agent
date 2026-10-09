# Air legacy admin qualification consent

Change-ID: FIX-20261009-AIR-ADMIN-CONSENT

## Goal

Keep the preserved Air admin assets compatible without expanding a one-request
confirmation into an advanced seven-request qualification. Based on parent
67be4c7. Generic admin behavior and public assets remain unchanged.

## Plan

1. Add red-first synthetic HTTP route tests using the real qualification manager,
   in-memory reports and counting runners with no upstream access.
2. Add Air bootstrap enrollment qualification metadata: required/automatic,
   requestsPerTarget=1. Preserve the independent batch qualification metadata.
3. Default the Air single-account route to basic only when mode is absent;
   retain explicit advanced with exactly seven authorized requests. Reject unknown
   modes without dispatch. Leave batch and manager defaults unchanged.
4. Run focused admin/qualification/runtime/startup tests, inspect named changes,
   run governance and commit. No live operations, credentials or real QA.

## Rollback

Revert this commit. No store migration or runtime state changes are involved.

## Red-first evidence

Before implementation, `node --test test/air-admin-consent.test.js`: 1 passed,
3 failed. Bootstrap lacked enrollment qualification metadata; no-mode/one-request
consent returned 409; no-mode/seven-request consent incorrectly ran advanced.
After the Air-only route change, all four route tests pass, including exact
runner dispatch counts, unchanged batch/generic behavior, malformed mode rejection
and zero dispatch for invalid budgets or missing authorization.

## Final verification

- Focused route/runtime/qualification/startup/admin suite: 41 passed, 0 failed,
  1 optional backend-contract test skipped (9.04 seconds).
- The optional test was then enabled with `PROVIDER_ADMIN_CONTRACT_ROOT` pointing
  to this branch: 1 passed, 0 failed. All 42 selected checks were exercised.
- Actual spawned Provider startup passes with the new nested bootstrap metadata;
  the outbound/dotenv guards and five-slot native durable fixture remain green.
- Only Air route implementation, synthetic tests and documentation changed.
  No public assets, generic route implementation, shared app/capacity code,
  credentials, live service or real question was touched.
