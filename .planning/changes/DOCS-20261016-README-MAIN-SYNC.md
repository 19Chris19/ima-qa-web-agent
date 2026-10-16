# DOCS-20261016-README-MAIN-SYNC

## User Goal
Review and merge the README PR after passing current-head CI so the GitHub homepage updates.

## Scope
Merge current main into the existing docs branch without rewriting commits. Resolve
README conflicts using the approved visual layout and the published stable pair:
Provider v0.6.2 / website v0.4.2. Align Agent guidance and version assertions.
Preserve main's application and mobile-CI changes unchanged. Label older screenshot evidence.

## Verification
Focused documentation checks, full CI at the updated PR head, staged diff and root
governance checks. Do not infer real IMA acceptance from synthetic tests.

## Rollout
User authorized merging this README PR into main on 2026-10-16. No new Release,
production branch movement, account changes or runtime restart.

## Rollback
Revert the documentation PR through a new PR; do not restore runtime data.
