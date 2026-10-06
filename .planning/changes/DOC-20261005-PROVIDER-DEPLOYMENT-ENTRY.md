# DOC-20261005-PROVIDER-DEPLOYMENT-ENTRY

## Goal
Give new operators one recommended guided Docker installation route, distinguish the standalone public service from the independently maintained website, and remove contradictory legacy onboarding claims.

## Scope and boundaries
Documentation only. Retain manual Node and existing Docker routes as advanced instructions. No service restart, release, tag, credentials, or real question.

## Verification
Changed-document links checked as part of a 49-link two-repository pass; git diff --check passed. Runtime files are unchanged, so the 288-test prior onboarding baseline is not represented as rerun here. Windows, remote Linux and real new-account QA remain unverified. Root governance passed with 3 pre-existing warnings.

## Candidate handoff
Parent b8a4fbd retained on codex/REL-20261004-PROVIDER-V042. Website companion: codex/FEAT-20261005-EXPLORER-DEPLOYMENT-BUNDLE. Public latest v0.4.1 confirmed read-only via GitHub CLI; no v0.4.2 release or existing service change.

## Rollback
Revert the documentation commit; no runtime or stored data changes.
