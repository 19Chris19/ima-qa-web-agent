# DOCS-20261015-PROVIDER-README

## User Goal
Rewrite the public Provider homepage for current stable capabilities using
beautify-github-readme, with clear installation, account onboarding and visuals.

## Scope
README, current Agent version references, static README visuals, synthetic UI
screenshots and documentation regressions only. Base: public main 880d816.
Skill upstream d6562a5 is byte-identical to the installed skill; no update needed.
Gemini direction was attempted but returned HTTP 503/model_not_found; no external
design recommendation is claimed. Use existing product identity and skill rules.

## Boundaries
Base-SHA: 880d816a431595cae8c1e3aa5cbc97ae2a7f4161.
No app/runtime/credential/Release/container-image change, no real IMA question, no live
service start, no brand assets from the private website in this public repository.
Screenshots use current committed frontend with synthetic HTTP fixtures only.
Local preview first; remote publication requires authorization and CI review.

2026-10-15: local preview approved for commit, feature-branch push and a Draft PR.
Merge, Release, production-branch movement and runtime deployment remain excluded.

## Verification
Add red-first README/asset/link/version regressions, run the skill audit, inspect
desktop/mobile rendered previews and verify synthetic source provenance.
Record actual results before handoff; not an all-platform deployment acceptance.

## Verification Results

- Full npm suite: 929 passed, 6 existing skips, 0 failures (935 tests).
- Added preview-server regression separately: 1 passed, covering read-only
  fixtures, unknown API rejection and encoded directory traversal protection.
- README story/assets/link tests: 2 passed; README skill audit passed.
- Ego space 37 captured current synthetic QA/admin pages at 1366 x 900; README
  checked at 980 and 360 pixels in light/dark, embedded diagrams at 874 pixels.
- PNGs 140/121 KiB; no real answer, account or browser profile is included.
- Root governance: 0 failures, 3 pre-existing workspace warnings. Per-repo
  governance rerun after this result entry; legacy initialization/worktree
  ownership warnings are not cleaned by this task.
- Installed README skill byte-identical to latest upstream d6562a5f5c484d069f8560b39c215c9cda4b5a55.
- Gemini unavailable (503); no advisor output or ImageGen artwork used.
- Public read-only health returned 200/ready and reported v0.6.1 / website
  v0.4.1; this is a version check, not a new real QA acceptance.

## Rollout and Rollback
Docs-only codex branch. Revert the documentation commit without touching data or
runtime services. Do not move a production branch or rewrite released tags.
