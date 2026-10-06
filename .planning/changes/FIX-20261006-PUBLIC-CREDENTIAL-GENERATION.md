# Public credential generations

- Change-ID: FIX-20261006-PUBLIC-CREDENTIAL-GENERATION
- Base: ad62b69
- Owner: provider-admin-20261006
- Status: implemented and synthetically verified candidate; parent review required

## Scope

Fence late refresh results and credential/runtime writes across public capture and
sync. Keep public direct header replacement, existing expiry semantics, single
probe and cancellation receipts. No Air expiry guard, seven-mode probe, changes
to shared runtime, live access, push or merge.

## Plan

1. Real client + encrypted synthetic Directory deferred tests, red first.
2. Client generations; capture/sync boundary invalidation; callback fencing.
3. Focused and full tests with actual admin backend contract root, governance,
   named-file staged diff review and structured commit.

## Verification

- Clean `npm ci --offline --ignore-scripts`; dependencies/lockfile unchanged.
- Initial real-client/deferred suite red: 15 tests, 12 failures, 3 compatibility passes.
- Fixed initial suite: 15/15 pass; expanded suite has 19 regression/compatibility cases.
- Expanded suite replayed against base ad62b69 source in memory: 15 fail / 4 pass;
  all 19 pass in the fixed focused run. No base checkout was modified.
- Focused client/maintenance/enrollment/readiness run: 111/111 pass, no skips.
- Full `PROVIDER_ADMIN_CONTRACT_ROOT=$PWD npm test`: 489/489 pass, no skips.
- Complete local synthetic logs: `/tmp/public-credential-generation-red.log`,
  `/tmp/public-credential-generation-focused-all.log`, and
  `/tmp/public-credential-generation-full-rootcontract.log`.
- All credentials and runtime exports are disposable synthetic data; real login,
  runtime recovery and cross-process coordination are NOT tested.
- Governance rule 04 initially flags the new test's `onAccountCredentialsChange`
  arrow-function property as a secret assignment. This new expression false positive
  is not a baseline finding.
- Staged governance: 1 HARD (rule 04), 4 pre-existing soft warnings. Manual comparison
  against ad62b69 identifies 36 unchanged assignment matches and 5 new expression
  matches: client `credentialGeneration = 0`, `credentialWritesSuspended = false`,
  `pendingCredentialPersistence = false`, `credentialWritesSuspended = suspend`,
  and the test callback property. The corrected count uses occurrence multiplicity,
  not set membership: the pending-persistence assignment also existed elsewhere. All are
  code, not credentials. The checker scans full staged blobs and treats these
  expressions as secrets (SECRET_ASSIGNMENT_RE lines 45-48, placeholder handling
  lines 130-147, staged scan lines 302-315). No scanner changes or suppressions.
  Complete report: `/tmp/public-credential-generation-governance.log`.
- Ownership and staged diff checks pass. Governance is NOT reported green.

## Implementation

The pool's synchronous replacement boundary is shared by QR capture, admin capture
and runtime-text import. It invalidates old client generations before writes and
isolates the target on failure. `applyConfig` retains public direct replacement
semantics, without Air expiry ordering. Refresh results and maintenance callbacks
check their captured generation before applying or persisting. Existing single
probe, qualification CAS, cancellation receipts and deadlines are unchanged.

## Canonical target follow-up

- Review reproduced a runtime-only ID import bypassing old-client isolation when
  sync throws before applying the new account configuration.
- Capture, runtime import and QR replacement now share Directory target resolution
  before writing. Runtime ID precedence, normalized name fallback and ordered
  first ID-or-name matching remain unchanged. Writers receive the resolved identity;
  pool isolation uses exact ID only, including when another account has that name.
- Added 12 real-client/encrypted-directory deferred cases: runtime-only ID,
  disagreeing runtime/top-level IDs, top-level fallback, capture/import name fallback,
  successful/failed sync, and ordered identity collisions with injected write failure.
- Before fix: 8 failures / 4 compatibility passes in the new cases. After fix:
  credential suite 31/31; full actual admin contract suite 501/501, no skips.
- Logs: `/tmp/public-canonical-target-red.log`,
  `/tmp/public-canonical-target-focused.log`,
  `/tmp/public-canonical-target-full-rootcontract.log`.
- Synthetic verification only; no live login, credentials, runtime, deployment,
  cross-process behavior, Air modification, merge or push.
- Follow-up staged governance: 1 HARD expression false-positive category, 4 existing
  SOFT warnings. All 51 assignment matches in the five flagged source/test blobs
  already occur in cf5c11c6 (multiset comparison); manually inspected code expressions
  and protocol/status literals, not credentials. No new scanner matches in this
  follow-up. Report: `/tmp/public-canonical-target-governance.log`.
- Ownership verification and staged whitespace checks pass. Governance is not green.

## Follow-up rollout / rollback

Parent reviews and integrates separately. Reverting restores the known late-refresh
race; reconcile affected accounts before any deployment decision.
