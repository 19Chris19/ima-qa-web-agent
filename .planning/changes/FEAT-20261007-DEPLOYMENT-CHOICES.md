# Provider Deployment Choices

Change-ID: FEAT-20261007-DEPLOYMENT-CHOICES
Base: v0.4.2 (dc966550bbd6aafc8823740a2c037b11dbfabde2)
Branch: codex/FEAT-20261007-DEPLOYMENT-CHOICES

## Goal And Scope

Ask online/shared/independent before installing anything. Provide read-only
Shell and PowerShell choice and dependency preflight without requiring Node.
Public Provider is primarily an independent generic service; private Explorer
access requires separate permission. Shared use waits for an invitation and
never requests raw upstream secrets. Own entry scripts, tests, README and
deployment/dependency documentation only; no gateway implementation.

## Design And Acceptance

- No selection defaults. Native agent question or numbered terminal menu must
  wait for the user. Noninteractive missing/invalid mode refuses.
- `--deployment-mode` selects the product path; existing `--mode` continues to
  mean desktop/server. Selecting a path does not authorize installation.
- Choice/preflight run without runtime bootstrap, clone, package install,
  browser launch, credentials, service startup or configuration writes.
- Independent preflight identifies OS/architecture, missing Docker CLI,
  inaccessible daemon, permissions and Compose v2 using stage/missing/next.
- Runtime dependencies are reported, never installed implicitly. Explicit
  independent install/runtime plus --allow-bootstrap retains the original
  private Node 22.22.3 checksum/no-overwrite and locked dependency preparation;
  no system Node installation is required. Other commands reuse cached Node.
  Official
  Docker installation needs explicit consent and human license/system steps.
- Existing installer ownership, volumes, digest and loopback guards remain.
- Synthetic command doubles only; no live Docker/IMA/install/push.

## Clarification

Shared Explorer does not install Provider. Gateway is a separate candidate,
not in v0.4.2; reference its docs/SHARED_GATEWAY.md and
`node scripts/shared-gateway.cjs` with private `SHARED_GATEWAY_CONFIG`, without
adding or invoking gateway code. User-reported Air has no Tailscale on PATH or
in /Applications and Provider 3117 still listens on all interfaces. Real shared
opening is blocked pending separate network configuration; no ready/working claim.

Review correction: initial implementation over-restricted runtime preparation.
Restored the private-runtime path behind explicit mode and bootstrap consent.
Existing Explorer wrappers call Provider runtime without deployment-mode; exact
required flags and the candidate-only compatibility break are documented in
AGENT_DEPLOYMENT.md. Explorer files remain outside this task's ownership.

Air review correction: user observed a false compose_v2 blocker with a working
newer Compose plugin. Gate now accepts a successful docker compose version
probe with parsed major >=2, including the user-confirmed 5.0.2 and synthetic
12.x, while refusing legacy, empty or unknown output. No local Docker query
performed by this task.

## Verification And Handoff

- PASS: `node --test test/deployment-choice.test.js`: 60 tests, 59 passed,
  one skipped (PowerShell unavailable). Includes synthetic fresh private
  bootstrap, checksum mismatch, destination protection, cached runtime reuse,
  no-mode/no-consent refusal, Docker failure classifications and PTY menu wait.
  Compose 5.0.2/v5.0.2 plus other compatible majors also passed a five-case
  focused run after the user supplied the exact installed version.
- PASS: original guided-deployment/shared-kb-target/onboarding-verifier focused
  regression: 24 tests. No expectations in existing tests were changed.
- PASS: full `npm test -- --test-reporter=spec` with
  `PROVIDER_ADMIN_CONTRACT_ROOT` set to this checkout: 613 tests, 610 passed,
  zero failed, three skipped (PowerShell and two opt-in private archive parser
  interop cases). Existing installer implementation under src/ is unchanged.
- The first full attempt using NODE_PATH had six ESM resolution failures, not
  behavioral assertion regressions. Retried using a temporary node_modules
  symlink to the existing aligned-v0.4.2 checkout (matching package-lock.json),
  without installing dependencies. Subsequent full runs passed, including the
  final >=2 Compose gate. The
  temporary symlink was removed after tests; no dependency files are committed.
- PASS: `sh -n onboard.sh scripts/deployment-choice.sh scripts/private-runtime.sh`
  and `git diff --check`.
- Repository-local `python3 scripts/check_governance.py --ci` is unavailable
  in this public v0.4.2 repository (file absent). Use the installed governance
  skill's check_governance.py with --repo and --ci: PASS, including staged
  secret scan (no suppressions or expression false positives), zero hard
  blockers, four historical/planning/upstream soft warnings. Ownership verify
  also passed. No historical metadata rewrite.
- NOT RUN: real PowerShell/Windows, Docker installs, runtime downloads, gateway,
  IMA enrollment/QA, Air network changes, publication or push. Bootstrap tests
  use command doubles and synthetic files only, all in owned temporary folders.

Downstream action: update Explorer's Provider runtime invocation to
`runtime --deployment-mode independent --allow-bootstrap` only after the
user selects independent and approves preparation; omit --allow-bootstrap
when reusing prepared dependencies. Online/shared must skip Provider clone and
runtime entirely. Do not mix these candidate flags with the old v0.4.2 wrapper.
Exact Shell/PowerShell forms are in docs/AGENT_DEPLOYMENT.md. Cross-repository
integration and real shared opening are not complete or claimed ready.

## Rollout And Rollback

Local atomic commit only. Review before release. Revert this commit to restore
the previous entry behavior; this change does not migrate runtime state.
