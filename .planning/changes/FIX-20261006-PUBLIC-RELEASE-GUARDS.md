# Public release guard follow-up

Change-ID: FIX-20261006-PUBLIC-RELEASE-GUARDS

## Goal and scope
Fix the release review findings from baseline 38e1775 in an isolated branch.
Protect new installation from orphan Compose volumes; require one bound QA proof
for imported accounts while retaining their explicit migration stop; reconcile
rollback and deployment-artifact documentation without loosening safety.
No admin UI, live stores, credentials, Docker runtime, service operations or push.

## Plan
- Add failing synthetic orphan-volume and imported-admission regressions.
- Reject existing project volumes and the exact generated volume name before
  image pull, configuration generation or service start; fail closed on query errors.
- Set the existing pending-QA flag on new transfer records, not legacy env seeds.
- Preserve migration disablement after proof until explicit enable.
- Correct rollback documentation and identify locked Git source as canonical.
- Run focused and full synthetic tests; commit named files with structured bodies.

## Verification
- Offline dependency installation with lifecycle scripts/audit disabled passed.
- Initial regressions: 19 passed, 5 failed as expected (three orphan-volume cases
  and two imported-admission cases). Old-bundle apply regression separately failed.
- Installation fix: 13/13 passed, including unrelated-volume acceptance, existing
  project protection, orphan label/name rejection, query failure and owned resume.
- All Docker/SSH installation commands were mocked; no runtime commands executed.
- Focused transfer/readiness/activation/rollback/installation run: 109/109 passed.
  The later legacy-bundle apply guard separately went red then green (1/1).
- New imports now require QA before enable; a successful proof preserves migration
  stop in both modes. Old unguarded prepared additions are rejected on apply, not
  silently upgraded. Rollback retains its original journal checks.
- Complete-suite verification is recorded in the documentation follow-up commit.
- Repository governance command cannot run: scripts/check_governance.py is absent.
  Main owns clean deployment acceptance.

## Rollout and rollback
Cherry-pick the scoped commits into the release candidate and run clean deployment
acceptance separately. No existing installation or prepared bundle is rewritten.
Revert the corresponding commit to roll back code, retaining private live data.
