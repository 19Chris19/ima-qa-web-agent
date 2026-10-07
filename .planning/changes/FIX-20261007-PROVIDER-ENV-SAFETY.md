# Provider Installer Environment Safety

## CI Follow-up (2026-10-07)

Linux PowerShell CI exercised a locally skipped test and found that the .NET
setter left an environment entry visible to PowerShell. Use explicit Env-provider
removal instead. The existing strict test remains unchanged; rerun CI before
acceptance. No Windows desktop validation is implied.

Change-ID: FIX-20261007-PROVIDER-ENV-SAFETY
Base: 98455bd045a3632dd28e7af65342a104ce01eaa3
Branch: codex/provider-shared-env-safety-20261007

## User Goal And Scope

Prevent ambient Node preload, module-search and TLS-disable settings from reaching
the first installer Node process, including preflight and authorized bootstrap/npm.
Only native wrappers, synthetic tests and this record change. Parent owns direct
shared TLS guards, server behavior and documentation. No live services, installs,
credentials, source configuration loading or push. Preserve the integrated source
worktree and its uncommitted edits; start from the captured commit above.

## Design And Acceptance

- Remove NODE_OPTIONS, NODE_PATH and NODE_TLS_REJECT_UNAUTHORIZED using native
  Shell/PowerShell operations before entering the deployment gate or bootstrap.
- Keep online/shared choice dependency-free and missing-mode refusal unchanged.
- Run harmless preload tests red first, then cover the first Node probe, final
  runtime dispatch and synthetic npm bootstrap with the same clean environment.
- Do not source user configuration to rebuild the environment.
- One atomic local commit; inspect named staged files and run available governance.

## Verification

- RED: targeted new tests reproduced four failures before the fix: unsafe first
  Node probe, runtime preload, bootstrap/npm preload and missing PowerShell guard.
  Dependency-free choice passed; the execution-only PowerShell test was skipped.
- GREEN: `node --test test/deployment-choice.test.js`: 66 tests, 64 passed,
  2 skipped (PowerShell unavailable), 0 failed. Includes real harmless Node
  preloads, synthetic Node/npm dispatch and an ignored synthetic user config.
- PASS: `sh -n onboard.sh scripts/deployment-choice.sh scripts/private-runtime.sh`
  and `git diff --check`.
- Repository-local `python3 scripts/check_governance.py --ci` unavailable (script
  absent, exit 2). Installed skill checker `check_governance.py --repo <worktree>
  --ci`: PASS, 13 checks passed, 4 pre-existing soft warnings, 0 hard blockers;
  named staged files passed the secret scan. No historical governance repair.
- NOT RUN: full application suite (outside this wrapper-only change), native
  Windows/WSL, real Docker, bootstrap downloads, npm installs or live services.
  PowerShell ordering is checked statically; execution coverage is explicitly
  skipped when pwsh is unavailable, not reported as Windows verification.

## Rollout And Rollback

Parent may review/cherry-pick the commit into the integrated candidate. No release
or deployment here. Revert the commit for source rollback; no runtime data changes.
