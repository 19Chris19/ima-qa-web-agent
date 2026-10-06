# Public enrollment sync fault follow-up

Change-ID: FIX-20261006-PUBLIC-ENROLL-SYNC-FAULTS
User-Goal: Close admission on quarantine-stage sync faults and preserve committed proof outcomes when post-commit sync fails.
Baseline: 6fc756af34616f3f7bef6995ad2f24e0ea86aa01

## Scope
Same independent activation worktree and branch; no INT merge before review. Classify both sync phases consistently, retain the target's local maintenance lock even when pool objects are replaced, and record commitApplied independently from the final job code. The capture-before-readiness sync uses the same local quarantine on failure. Enrollment completion/cancel/shutdown and admin feedback preserve a committed receipt with its sync warning. Only the verify UI request accepts an unsuccessful HTTP-200 result for receipt inspection; other request errors still throw. Keep public single-probe behavior and legacy env-seed compatibility; no live, protocol-core, dependency or deployment changes.

## Verification
Verification: Full explicit-root npm test passed 457/457 with zero failures/skips. Red-first matrix: 15/15 new cases failed on 6fc756a. Two capture-before-readiness fault tests also failed before fixing that path. Targeted readiness/activation/cancellation suite passed 59/59; the capture/UI warning follow-up passed 4/4. The first full follow-up run caught UI result handling, fixed before the final 457-test run. No dependency changes or reinstall were needed.
Synthetic matrix covers pre/post sync, throws before/after/replacement updates, classic/knowledge-agent, actual pool lease rejection, durable disabled/proof state, cancel and shutdown after commit plus sync failure. UI tests distinguish committed and uncommitted warnings. No private runtime/config, credential, real question, service, browser or container access.

Named diff/whitespace and ownership verification passed. Installed governance CI reports one rule04 HARD baseline false positive and four existing soft warnings, not green. public/admin.js, src/web-agent-enrollment.js and test/admin-experience.test.js contain 14 flagged assignments, all unchanged from 6fc756a; all three baseline blobs also trigger the scanner, while added-lines scan returns false. The rule was not suppressed. Never interpret an empty-index scan as clearance of the staged-source false positive. Live cancellation, browser, container and all-platform behavior remain untested.

## Rollout and rollback
Independent review candidate only, no merge/push/restart. Reverting this follow-up reintroduces the two reviewed blockers; do not release that state. Keep current encrypted account data and reconcile synchronization faults separately; cancel is not a storage rollback.
