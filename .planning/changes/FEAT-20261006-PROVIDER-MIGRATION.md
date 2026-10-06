# Offline transfer preparation and private archive

User-Goal: Consolidate account identities without rescanning, losing histories or running two refresh owners.
Baseline: 0db3fc2, unpublished candidate.
Change-ID: FEAT-20261006-PROVIDER-MIGRATION
Owner: provider-admin-20261006
Scope: read-only preflight, re-encrypted disabled-account candidate, private backup bundle, owned history export, explicit offline apply/rollback and shared Provider startup fence.
Safety: preparation never writes either live account store. Applying a bundle remains a separately gated maintenance operation.
Verification: PASS - full `npm test -- --test-reporter=tap`: 320/320; targeted `node --test test/account-transfer.test.js test/offline-transfer-apply.test.js`: 32/32. Diff whitespace and worktree ownership checks PASS. This task does not access live credentials, runtime directories or services; no live cutover evidence is claimed.
Rollback: discard an unused prepared bundle; never overwrite newer live conversations from an old backup.

## Security Fix Plan

1. Reserve normalized IDs and names in a shared lookup namespace; reject ambiguous targets and recheck candidate identities at apply.
2. Resolve output ancestors before checking Git boundaries; keep exclusive private bundle creation.
3. Add a shared account-store lifecycle fence held before both Provider startup paths read accounts and throughout offline apply/rollback, alongside existing writer locks and IPv4/IPv6 checks.
4. Add synthetic apply/rollback tests for idempotence, concurrent locks, running listeners, duplicate identities, stale snapshots, unrelated newer data and used-import refusal.
5. Run targeted/full tests, inspect named staging and governance findings, then make one structured candidate commit. No push or release.

## Completed Candidate

- Shared lookup namespace and repeated collision allocation protect original ID/name lookups; apply independently rejects ambiguous and duplicate-identity candidates.
- Canonical output-parent checks reject a symlink into a Git subdirectory before writing any bundle.
- Both Provider entrypoints take the lifecycle fence before constructing their account directory; offline apply/rollback take both lifecycle fences and ordinary store locks. IPv4/IPv6 stopped-port checks are additional gates, not ownership proof.
- Idempotent apply/rollback, concurrent apply, partial lock release, running listeners, startup/maintenance exclusion, unchanged-generation content changes, candidate/key tampering, disabled-add-only writes and conservative rollback all have synthetic coverage.
- Rollback preserves unrelated newer target data and history; used/enabled/refreshed/proven imports refuse rollback rather than restoring stale credentials.
- Exported source keys now match consumer schema v1 at 6237d8a: sourceType becomes type when needed; legacy sourceIntent becomes source_intent. No consumer files were edited. Cross-repository export-to-parse testing remains independently owned by Locke, not claimed here.

## Verification Gaps

- `python3 scripts/check_governance.py --ci` is unavailable because this repository has no such script.
- Installed governance checker was run: pre-existing FEAT-20261002-PROVIDER-DOCKER-LAB release record lacks a SHA; initialization/old-record/upstream/unrelated-worktree warnings remain outside this change.
- Its secret-assignment scan flags account-transfer.js metadata expressions (`tokenExpiresAt`, `refreshTokenExpiresAt`, `hasRefreshCredentials`). Manual review confirms property references and a credential-presence regex, not literal credentials. Staged provider-a-server.js and server.js each retain the same two baseline matches with zero new matches. Governance is not claimed green.
- Synthetic filesystem/socket tests do not establish real IMA validity, real service lifecycle behavior, archive visitor continuity or release readiness. Both installations must use the shared-fence startup paths and keep old launchers disabled; fences are local maintenance leases, not permanent cross-installation identity ownership.
- Parent review boundary: old 3117/3317 require manual ingress pause/drain/stop and restart inhibition. Keep 3317 stopped until separately verified source scheduling/refresh disablement. Durable migrated-out markers or controlled source disablement are a separate gate, not implemented here. Results explicitly deny cross-instance ownership transfer; target imports remain disabled.

Rollout: unreleased local candidate for parent review; no deployment, live-data operations, push or service restart.
Rollback: revert this candidate commit before adoption. For synthetic/offline imported data, use the documented unchanged-record-only rollback; never restore an entire old store over newer data.
