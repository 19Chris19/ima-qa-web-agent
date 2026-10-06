# Public management capability evidence

Change-ID: FIX-20261006-PUBLIC-MANAGEMENT-EVIDENCE
User-Goal: Correct management evidence semantics without changing the legacy health contract, basic QA admission, runtime state or admin UI.

## Findings and Plan

- `health.web_ready` is set by session initialization and successful bound knowledge QA. Neither independently proves generic web search. The public backend has no independent generic-search proof contract; management must report unknown.
- Classic compatibility readiness can be ready/busy/cooling without a bound knowledge proof. Those scheduling states must not become positive knowledge capability evidence in management.
- Preserve session health, health fields and scheduling. A legitimate bound knowledge proof still qualifies after the single successful answer; a negative or positive legacy knowledge health flag alone neither grants nor removes that proof.
- DONE: Projection regressions first reproduced 13 failures (8 passed). Fixed only management projection and added synthetic check/probe integration coverage and docs. No real requests, credentials, runtime changes or public/admin edits.
- DONE: The opt-in actual backend/UI serialization contract now checks unknown generic search (rendered as unverified by the unchanged UI) and passes.

## Verification

- Full synthetic suite: `npm test -- --test-concurrency=1` with PROVIDER_ADMIN_CONTRACT_ROOT pointing at this worktree: 531 passed, zero failures, zero skipped. Includes the normally opt-in backend contract and prior basic admission/protection regressions.
- Existing dependencies were temporarily linked for the test run, with no installs/lockfile changes; the link was removed afterwards.
- `git diff --check`: passed.
- `python3 scripts/check_governance.py --ci`: unavailable, exit 2 because the target repository has no such script.

## Limits

- `initSession` succeeds on a returned session ID, not independent membership/QA evidence. Projection no longer promotes classic compatibility scheduling to qualified knowledge capability.
- No new detection of post-proof access revocation: readiness remains the authority for valid bound QA evidence and operational state. Legacy health booleans alone cannot establish that evidence.
- Generic search stays unknown until a separately designed independent proof contract exists. This change neither probes search nor treats unknown as a scheduling failure.

## Rollout and Rollback

Local follow-up commit on the same isolated branch, after 07d5ec7. Cherry-pick only this follow-up onto the already integrated base. Revert this follow-up to restore the previous projection. No deployment or push.
