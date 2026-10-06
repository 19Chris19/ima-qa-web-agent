# Provider Reauthentication Identity Preservation

- Change-ID: FEAT-20261006-PROVIDER-ENROLLMENT
- User-Goal: Preserve a distinct scanned identity without replacing the original account; explicitly add it after authorization.
- Base: 0db3fc2
- Owner: provider-admin-20261006
- Scope: enrollment manager, account directory, enrollment/directory tests, account enrollment documentation, and one protected identity route.
- Design: expiring in-memory conflict; explicit named add; fail closed on unknown identity; serialize continuation; recheck membership and directory uniqueness before persistence; reuse the declared onEnrolled hook once.
- Non-goals: public admin UI, live credentials/runtime, real IMA probes, deployment, push, release.
- Verification: `npm test -- --test-reporter=tap` passed 303/303 tests; targeted enrollment/directory/route suite passed 52/52; `git diff --check` passed; governance worktree ownership verification passed.
- Rollout: local candidate only; parent integration and release review required.
- Rollback: revert the candidate commit before integration.

## Implementation And Evidence

- Distinct reauth capture becomes private, expiring `identity_conflict` before any session check or store write. Public task responses contain only action metadata.
- Explicit named add and membership continuation share a single-flight guard and reuse captured auth. Same-identity reauth retains its original path.
- Add-only directory persistence reloads current membership, refuses duplicate/unknown identities or existing names, forces replacement off, and retains generation-conflict protection.
- Cancel/expiry/failure/shutdown drop pending auth and browser resources; late session results cannot insert. Cancellation before persistence does not abort the original account's independent QA verification.
- Fake browser/client tests cover unchanged pending store bytes, unchanged original encrypted account and pool session, hook once, duplicate/racing writes, concurrent calls, invalid actions, unknown identity, membership retry, and cancellation/expiry during verification.
- Only the protected identity POST route was added to `src/admin-routes.js`; management snapshots and public admin assets remain untouched.

## Gaps And Candidate Boundary

- The requested `python3 scripts/check_governance.py --ci` could not run: this independent repository has no such script. No out-of-scope governance bootstrap was performed.
- Installed governance checker was run with `--repo ... --ci`: fails on pre-existing `.planning/changes/FEAT-20261002-PROVIDER-DOCKER-LAB.md` release evidence lacking a SHA. Existing initialization, older-record, unrelated-worktree and upstream warnings also remain. No unrelated records were edited.
- Staged full-blob scan also flags existing credential-related JavaScript fields/fixtures in five files. Comparing its assignment-pattern matches against HEAD found 58 baseline matches and the same 58 staged matches, with zero new matches. Reviewed additions contain synthetic fixtures only; the checker is not claimed green.
- `npm ci --ignore-scripts` succeeded and reported one critical dependency vulnerability; no dependency changes or audit remediation were made in this scoped candidate.
- No real IMA/browser acceptance, live runtime access, real credentials, restarts, push or release. Public admin UI integration remains parent-owned.
- Legacy configurations without a share URL retain the existing session-check fallback; with a share URL, membership must be `joined` before persistence.
