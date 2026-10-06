# FIX-20261006-PUBLIC-ENROLL-RECEIPT

- User goal: preserve committed enrollment truth across presentation and callback faults.
- Base: 880aa396; independent owned worktree, no changes to the parent candidate.
- Plan: add synthetic failing regressions; retain commit receipts before reads;
  allowlist fixed warnings; protect cancel/shutdown; update UI and docs; verify and commit.
- Boundaries: no live data, credentials, upstream requests, deployment or push.
- Changes: enrollment receipts precede account reads; fixed warning allowlist;
  readiness final notification/snapshot and cancel reads preserve committed truth;
  the manual verification route uses the same post-commit callback protection.
- Preserve: successful reads still check the current proof and enrollment gate,
  so a recaptured account cannot be completed using an obsolete proof. Pool-sync
  quarantine warnings take precedence. No retry, probe or account rollback added.
- Red evidence: post-commit account read/callback, cancel display read, unknown
  warning regressions failed before the fix; manual verify callback returned 400
  after commitment before its guard. All fixtures use synthetic credentials.
- Verification: final npm test: 470 tests, 469 passed, 0 failed, 1 skipped
  (external PROVIDER_ADMIN_CONTRACT_ROOT not configured). Includes the existing
  old-object/replacement quarantine matrix and recapture proof invalidation.
  Named staged diff inspected; git diff --check and staged --check passed.
- Governance limitation: this public candidate does not contain
  scripts/check_governance.py; attempted --ci exits 2 (missing file).
- Rollout: candidate only, parent review/integration; no live success claim.
- Rollback: revert this independent commit; persisted account truth is untouched.
