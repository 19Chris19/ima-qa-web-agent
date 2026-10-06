# Public basic admission and capacity alignment

Change-ID: FIX-20261006-PUBLIC-BASIC-ADMISSION
User-Goal: Review public v0.4.2 basic knowledge QA admission and scheduling from 8b29c37; admit one successful bound answer without Air-specific qualifications and preserve disable/migration protections.

## Scope and Evidence

- `onEnrolled` already calls the public single-probe readiness verifier. Retain its one dispatch, one terminal, nonempty answer and knowledge-source evidence, CAS binding and cancellation semantics.
- A successful proof commit leaves old authentication-check failures intact, so readiness can reject a newly proved account.
- Pool status reports maintenance accounts as available although leasing rejects them. The fallback queue capacity also includes cooling accounts.
- Capacity is eligible concurrency, including busy eligible accounts; schedulable is idle capacity. Do not reduce concurrency to idle slots.
- No public/admin UI changes, Air code, real questions, credential reads, service restarts, Docker operations or push.

## Plan

1. DONE: Synthetic baseline run: 59 passed, 5 failed (three stale-health cases, maintenance availability and fallback capacity).
2. DONE: Health evidence updates in the same successful proof commit; failed/unknown probes stay closed and explicit disable reasons remain intact.
3. DONE: Pool maintenance status and fallback queue capacity aligned. Check/refresh results now project state after maintenance release, preserving their completed-operation contract.
4. DONE: Final focused run passed 69/69; full run passed 511 with zero failures and one opt-in skip. Named-file diff reviewed for the structured local commit.

## Verification

- Final focused command (NODE_PATH pointed at the integration checkout's existing dependencies): `node --test --test-concurrency=1 test/enrollment-activation.test.js test/ima-web-agent-pool.test.js test/provider-a-capacity.test.js test/web-readiness.test.js`: 69 passed, zero failures/skips.
- First full run used NODE_PATH only: 505 passed, 6 failed, 1 skipped. ESM example imports cannot resolve packages through NODE_PATH; a temporary link to the existing node_modules fixed dependency resolution without installing or modifying dependencies.
- Final `npm test -- --test-concurrency=1`: 511 passed, zero failed, one skipped out of 512 tests. The opt-in admin/backend contract test requires PROVIDER_ADMIN_CONTRACT_ROOT; it was not enabled. The temporary dependency link was removed after testing.
- `git diff --check`: passed.
- `python3 scripts/check_governance.py --ci`: unavailable (exit 2, file absent in this repository). No unrelated governance infrastructure was imported.

## Risks and Boundaries

- Synthetic verification only; no new live acceptance claim. The existing candidate acceptance was not repeated.
- Persisted historical proofs/health are not rewritten automatically. The fix applies on a newly authorized successful probe commit.
- A healthy proof remains distinct from admission: manual/migration disable and local sync-failure quarantine still block scheduling.
- Capacity includes eligible busy accounts; it is not instantaneous idle capacity. The queue minimum of one does not promise an available account.

## Rollout and Rollback

Local review/cherry-pick only; no deployment. Revert this change's commit to restore the 8b29c37 behavior.
