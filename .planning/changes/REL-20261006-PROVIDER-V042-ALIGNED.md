# Provider v0.4.2 aligned release

## Goal
Ship one public Node/Docker Provider baseline that the private Explorer website
can install by fixed version. Preserve the familiar account management layout,
make basic knowledge QA admission agree with scheduler capacity, and retain the
generic QA improvements and guided enrollment already implemented.

## Scope and boundaries
Base: public candidate 8b29c37; published baseline v0.4.1 / d4eb621.
Do not ship the rejected table/drawer redesign. Keep account maintenance and
identity recovery functionality accessible. Do not copy Air credentials, runtime,
robot-specific configuration, or brand assets. No running Air service cutover.

## Work and acceptance
- [x] Restore familiar management presentation with current backend actions.
- [ ] Review basic admission, capacity and enrollment behavior with synthetic tests.
- [ ] Reconcile README, Agent guide, package/image versions and release notes.
- [ ] Run final tests, clean Node install and isolated Docker acceptance.
- [ ] Review source/package for private files; review PR and CI.
- [ ] Publish immutable v0.4.2 source and multi-platform image, verify installation.

Real login, follow-up and platform gaps must be stated for the exact tested
artifact; existing Air evidence does not count as public artifact acceptance.
User scan/confirmation is performed by the human when required.

## Verification progress
- Expanded-row regression was reproduced before implementation. Admin UI and
  experience tests passed 19/19; explicit backend contract test passed 1/1.
- Synthetic browser previews at 1366x900 and 390x844 showed no horizontal
  overflow. No real accounts or administrator requests were used.
- Governance checker supplied by the installed skill passed with four soft
  warnings (historical planning metadata, ownership and upstream setup).
- After staging, its generic secret-assignment regex flags four unchanged
  baseline expressions: tokenInput.value/token assignments and two synthetic
  tokenExpiresAt fields. All four were verified present in HEAD; no new secret
  assignment was introduced. The staged checker therefore remains non-green;
  this documented false-positive review does not claim a passing CI result.
- Full Provider test command with explicit admin contract root completed with
  exit code 0 after UI restoration and admission integration.
- Basic admission fix integrated as 32be509; generic web-search evidence is
  under separate review and must not be inferred from knowledge QA success.
- Cross-repository archive test exposed missing public export audit helpers.
  Release remains blocked until the matching export/parser contract passes.

## Integrated verification at 2cd17fb
- Full synthetic suite: 544 total, 542 passed, zero failed; two optional private
  parser cases were then explicitly enabled and passed in a 10/10 focused run.
- Explorer f808602 full suite with this exporter: 158/158, zero skipped.
- Native ARM64 and emulated AMD64 builds and network-none startup passed;
  unauthenticated internal capacity requests were rejected. No IMA access.
- Local image tags: provider-v042-aligned:2cd17fb-arm64 and
  provider-v042-aligned:2cd17fb-amd64. These are not published release images.
- npm package dry-run contains 188 files; forbidden runtime/config path scan
  found zero. This path scan alone is not a complete source-secret audit.
- Final release review and clean full installation remain pending. No account,
  browser enrollment, existing service, or persisted runtime data was touched.

## Rollout
Candidate only. Existing 3117, 3317, 4317, 4318, 4417 and Bot are unchanged.

## Image/version gate
The default compose image was still v0.4.1; a new source/package-version
assertion reproduced the mismatch and now guards v0.4.2. This references the
intended release, not an assertion that its image already exists. CI and image
publication explicitly enable the synthetic admin backend contract test.

## Documentation reconciliation
The onboarding acceptance page now leads with the aligned candidate evidence
and remaining review blockers. Earlier independent-branch evidence is explicitly
historical. Agent instructions identify v0.4.2's expanded account presentation;
they do not claim publication or successful real enrollment.
Release preparation notes now cover the complete shipped scope, fixed-source
installation, upgrade/rollback and explicit platform/real-account boundaries.

## Clean-source follow-up
Git archive of 38e1775 extracted into a fresh temporary directory; npm ci
installed 123 packages and onboard.sh doctor passed on Air (Node22.22.3,
Playwright1.62.1, Docker/Compose available, no existing installation). This is
not an install of the pending post-review fixes. Empty-pool container check of
2cd17fb failed once without a retained cause, then passed both a diagnostic run
and an unchanged rerun. Record this instability; do not call the first failure
resolved or use these runs as final-install acceptance.
The empty-pool verifier now emits only allowlisted failure stages, never raw
command stderr or configuration. Synthetic fake-Docker tests cover known and
unknown stages. The 2ecd5df image passed a subsequent diagnostic run; the earlier
undifferentiated failure is still not attributed to a specific cause.

## PR and review follow-up
Public draft PR #12 contains the isolated release candidate. GitHub Test and
pack passed for c943860. Local 2ecd5df full run passed 548/550 with two timing
failures in enrollment waiting/cancellation; both passed unchanged in a focused
rerun (2/2). Do not describe that local full run as entirely green. Private PR #6
at Explorer 173c35a passed synthetic/build and Docker synthetic-chain CI.
No maintainer merge, tag or release has occurred at this checkpoint.

## Rollback
Revert scoped commits or select the previous version image; preserve current
account and conversation volumes. No tag replacement or history rewrite.
