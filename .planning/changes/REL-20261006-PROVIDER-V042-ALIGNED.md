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

## Rollout
Candidate only. Existing 3117, 3317, 4317, 4318, 4417 and Bot are unchanged.

## Image/version gate
The default compose image was still v0.4.1; a new source/package-version
assertion reproduced the mismatch and now guards v0.4.2. This references the
intended release, not an assertion that its image already exists. CI and image
publication explicitly enable the synthetic admin backend contract test.

## Rollback
Revert scoped commits or select the previous version image; preserve current
account and conversation volumes. No tag replacement or history rewrite.
