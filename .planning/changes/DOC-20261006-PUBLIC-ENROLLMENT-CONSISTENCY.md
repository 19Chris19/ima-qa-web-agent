# Public enrollment documentation consistency

- Change-ID: DOC-20261006-PUBLIC-ENROLLMENT-CONSISTENCY
- Base: f04d9904dcd3e1e5b15a03a1fedf54666faaca62
- Owner: provider-admin-20261006
- Status: documentation candidate; parent review required

## Scope

Reconcile README with AGENT_DEPLOYMENT and ACCOUNT_ENROLLMENT: explicit official
QR window and human consent, durable pending login, separate membership/QA failure,
single authorized probe, CLI retry, commit/sync receipts and phase deadlines.
Correct QA_EXPERIENCE's stale separate-stop description against client source/tests.
No code, dependency, runtime, credential, deployment or release changes.

## Verification

Read the reference docs and current primary-control implementation/tests. The
primary control remains enabled for empty input, with empty submissions guarded;
documentation follows this integrated behavior rather than older disabled wording.
Named-file diff/whitespace checks pass. Governance CI: 13 pass, 4 existing soft
warnings, 0 hard blockers. No live requests or browser use.
Full application suite is not rerun for this documentation-only change; parent
reported 505/505 at integration, which is not a new run or live acceptance here.

## Rollout / rollback

Parent reviews this isolated documentation commit. No push or deployment.
Revert this commit to roll back wording only; no data migration.
