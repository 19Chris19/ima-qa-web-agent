# Public enrollment cancellation candidate

Change-ID: FIX-20261006-PUBLIC-ENROLL-CANCELLATION
User-Goal: Fix shutdown probe cancellation, unabortable session initialization and late QR retention from review of af9627c.
Baseline: af9627cfd613052d7b6867f4cc64c081293ef75d

## Scope
Enrollment lifecycle, necessary client signal guards, synthetic tests and enrollment documentation only. Preserve the public single-probe contract. Login expiresAt and the independent bounded readiness probe are separate deadlines, not a total enrollment deadline.

## Boundaries
No Air seven-mode qualifications, shared runtime changes, real credentials/questions, live service, push or release. Work only in the claimed independent worktree.

## Verification
Verification: 406/406 synthetic tests passed, zero failures/skips, with PROVIDER_ADMIN_CONTRACT_ROOT pointing to this independent checkout. Default full run was 405 passed and one opt-in contract test skipped; the explicit rerun includes it.
- Red: 9/10 new lifecycle checks failed before the fix; independent phase-timeout behavior already passed. Two additional membership timeout-composition checks failed before preserving the 15-second bound.
- Green: 63 related enrollment/client/readiness tests passed; the lifecycle/membership suite passed 18/18 after signal composition. Full suite includes existing protocol, identity conflict, one-probe, pool, admin and migration regressions.
- Named staged diff/whitespace and installed governance CI checked before commit. Ownership verify passed. Original public worktree remains clean at af9627c.
- This repository has no scripts/check_governance.py. Installed checker --repo ... --ci passed before staging, but its staged full-blob scan reports one hard secret-scan failure and four existing soft warnings. The failure flags src/ima-web-agent-client.js and src/web-agent-enrollment.js. Comparing the checker matches to af9627c confirms every flagged expression is unchanged baseline JavaScript (for example tokenExpiresAt: this.tokenExpiresAt and authorizationStatus: job.authorizationStatus), not a newly added credential. The same checker flags both baseline blobs. This false positive is documented, not suppressed; final governance CI is not claimed green. Existing scaffold/older-record/unrelated-worktree/upstream warnings remain out of scope.
- No live validation: real upstream abort acknowledgement and browser teardown remain untested. Tests use explicit synthetic keys and controlled transports only.

## Implementation
- Login controller aborts membership, session initialization and QR fetch work at cleanup. Client guards reject late init/refresh responses before another request or credential mutation.
- Shutdown propagates cancellation to an enrolled account's active verification. A cancelled onEnrolled return cannot trigger a late enrollment sync or completion.
- QR buffers cannot be reattached after terminal cleanup; repeated cleanup clears private references.
- Login expiresAt ends before the post-insertion callback. Public readiness keeps its independent default 60-second single-probe timeout; membership keeps its independent 15-second bound.
- Air integration notes are in docs/ACCOUNT_ENROLLMENT.md: port narrow lifecycle/signal changes and retain Air-native late-cancel and qualification semantics.

## Rollout
Candidate for parent integration. No production activation.

## Integration acceptance (2026-10-06)
The clean public integration branch at af9627c merged this fix as 8248c1de65baf65877d8a80f85074457f7452c7c. After clean npm ci with install scripts/audit disabled, the explicit-root full suite passed 406/406 with no skips. Dockerfile and Agent deployment instructions were reviewed read-only; gaps and historical-image boundaries are recorded in docs/ONBOARDING_ACCEPTANCE.md. No deployment implementation changed, and no live/push operation occurred. The original isolated-worktree verification above is historical; this section records the parent candidate verification.

## Rollback
Revert the scoped fix commit; no account-store schema or data migration.
