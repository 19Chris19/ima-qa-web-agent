# v0.4.2 onboarding candidate acceptance

## Sync-fault review follow-up (independent candidate)

`FIX-20261006-PUBLIC-ENROLL-SYNC-FAULTS` follows review of `6fc756a` without
merging INT. Capture/quarantine-stage and post-commit pool sync faults retain local
admission isolation. Explicit `commitApplied` and `warning` distinguish a rejected
attempt from an already committed proof with failed local synchronization;
completion/cancel/shutdown do not pretend to roll back the latter. Startup env-seed
remains legacy-compatible, not universally subject to a new proof requirement.

Final explicit-root synthetic regression: **457/457 passed, zero failures/skips**.
The 15-case phase/fault/mode matrix and two capture-sync cases were red before
their fixes; UI checks cover both commit outcomes. No live, private runtime,
container, release or all-platform acceptance was performed. See the change record
and ACCOUNT_ENROLLMENT.md for the isolation and receipt contract.

## Pending-activation follow-up (independent candidate)

`FIX-20261006-PUBLIC-ENROLL-ACTIVATION`, based on integration revision
`7d2006eca6932ffbf2e731119d3fda6e278c43d3`, closes the classic-capacity blocker
identified below. New captured credentials are persisted disabled, one successful
bound probe atomically commits proof and pending activation, and failed/cancelled
probes retain disabled credentials for explicit retry. Manual pauses are preserved.
See ACCOUNT_ENROLLMENT.md for phase deadlines, state transitions and the distinct
post-commit pool-sync-failure outcome. This independent candidate has not been
merged, deployed or accepted on all platforms.

Clean npm installation with lifecycle scripts/audit disabled and full explicit-root
synthetic regression passed **438/438, zero failures/skips**. Existing 406-test
integration evidence below remains historical. No real login, QA, runtime access,
container build/start, push or release was performed for this follow-up.

## Public integration acceptance (2026-10-06)

Candidate only, not a release. Clean integration branch `codex/INT-20261006-PROVIDER-MANAGEMENT`
at `af9627c` merged cancellation fix `1f7827a6c26e0f78f8a677156821da5e21fad02b`
as `8248c1de65baf65877d8a80f85074457f7452c7c`.

- Clean dependency install: `npm ci --ignore-scripts --no-audit --no-fund`, 123 packages installed. Install hooks and vulnerability audit were not run.
- Integrated full regression: `PROVIDER_ADMIN_CONTRACT_ROOT=/Users/a123/Developer/provider-management-20261006 npm test`, **406 passed, zero failures/skips**. The explicit root includes the opt-in admin contract test.
- No Docker build/start, helper connection, private configuration/runtime read, real login/question, push or release was performed. Earlier container evidence below belongs to its stated older revision, not this integrated candidate.
- Public behavior remains one bounded readiness probe, separate from the login deadline; no Air seven-mode qualification was imported. See ACCOUNT_ENROLLMENT.md for cancellation and retained-account semantics.

### Read-only deployment review gaps

- Dockerfile copies the entrypoint, source, scripts and committed public renderer assets, and uses production dependencies. No missing cancellation-fix resource was found. Chromium remains an external desktop-helper responsibility, not an in-container browser.
- Dockerfile defaults revision/version labels to `local-dev`; plain compose build supplies neither build argument. Candidate image acceptance must explicitly bind both labels to the reviewed revision/version and record its digest. No current candidate image was built here.
- compose.images.yaml still defaults to v0.4.1. It is not an image of this candidate; use an explicitly reviewed candidate image when rehearsing, never silently combine current source tools with that default.
- AGENT_DEPLOYMENT.md line 50 overstates cancellation/failure as never adding schedulable capacity: after insertion the account is retained, and classic mode does not require the new knowledge-agent proof. Document phase-specific outcomes rather than implying rollback of insertion. Existing ACCOUNT_ENROLLMENT.md records this boundary.
- AGENT_DEPLOYMENT.md does not summarize the separate login/probe deadlines or shutdown/late-QR guarantees, and its acceptance table lacks the post-insertion verification state/outcome. Its linked enrollment document is authoritative for these details.

### Governance interpretation

The installed checker (this repository has no scripts/check_governance.py) reports four existing soft warnings: old change verification, an unrelated unclaimed worktree, incomplete scaffold, and no upstream. An empty-index check passes but is not a full-source secret clearance.

The fix's staged full-blob rule04 HARD result remains documented, not waived: check_governance.py lines 45-48 match JavaScript property assignments containing TOKEN/CREDENTIAL/AUTHORIZATION; lines 130-147 treat expressions as non-placeholder secrets; lines 302-315 scan entire staged blobs. Comparing af9627c with 1f7827a found 21 matches in src/ima-web-agent-client.js and 11 in src/web-agent-enrollment.js, all unchanged baseline expressions (for example tokenExpiresAt assigned Number(...), pendingCredentialPersistence assigned false, and authorizationStatus assigned a conditional expression). Both baseline and fixed blobs trigger the rule. This is a baseline scanner false positive, not evidence of newly introduced credentials or a claim that the source-staged gate passed.

## Earlier onboarding evidence (historical)

Date: 2026-10-04. Source baseline: public main d4eb621. This is a local candidate, not a release.

| Area | Result | Boundary |
|---|---|---|
| Official share metadata | Read-only structure checked | No login, join or QA |
| Deployment core | Synthetic tests passed | Private writes, interrupted resume, foreign-project blocking, image/PW matching |
| Membership flow | Synthetic tests passed | No pool insertion before access; same-window continue, cancellation, unknown/network separation |
| Admin interface | Protected preflight/continue/import tests passed | No real credential captured |
| Shell bootstrap | Syntax and Air doctor passed | Native installed Node used; downloadable bootstrap not exercised |
| macOS helper | Dedicated Chromium installed, repeated install and user LaunchAgent readiness passed | No IMA page opened; isolated helper removed after checks |
| Container to helper | Native ARM64 Playwright connection passed | No page, account, login or question created |
| Container | Native ARM64 build and network-disabled empty-pool startup passed | Local-only image, not a published artifact |
| Full regression | 288/288 passed; production audit 0 | Synthetic events; no real IMA login |
| Login-gated metadata | Synthetic login, timeout, context cleanup and manifest tests passed | Authenticated real share resolution NOT RUN |
| Clean source | Fixed-source extraction, npm ci and Shell doctor passed | Node download fallback NOT RUN; existing Node 22 used |
| Windows desktop | NOT RUN | No Windows maintenance machine supplied |
| Maintenance to Linux over SSH | NOT RUN | No SSH server supplied |
| New account scan / membership / one question and follow-up | NOT RUN | Requires a fresh authorized account and human scan |
| Auth renewal / Linux longevity | NOT RUN | Separate production acceptance |

Do not publish this as an all-platform out-of-box success claim. Credentials, profiles, share-page bodies, answers and runtime logs are excluded from Git. Existing 3117, 3317, 4317 and Bot were not restarted.

## Fixed artifacts and handoff

- Verified Provider code: `76cd647acc9c57bf6aaf92039884893c2a498369`; local ARM64 image ID `sha256:b9355564ec204099151e3447f422a3973b0da36802fbe2a4e630f9730a874a00`. This is not a GHCR release digest.
- Verified with website code `2ae76caff3f89c2ce658654065a4345beb763890` through its clean-directory double-service entry: first install, resume with unchanged private configuration, blocked repeated init, empty capacity and protected enrollment preflight.
- Temporary helper was uninstalled and rehearsal services stopped. Private scratch configuration and empty rehearsal volumes remain local, excluded from Git; no existing service data was copied.
- An earlier cold start exceeded the original helper wait; safe retry succeeded. Final code uses a bounded 30-second wait and the final fresh install passed.
- Tests/builds cover ARM64 only in this candidate. AMD64 execution, native Windows, SSH-to-Linux, new authorized-account scan, real QA and longevity are still separate release gates.

Feature refs are retained: guided deploy (`1e0036a`), membership (`fdd57c2`), readiness fix (`5b3e81a`), Agent docs (`20b3785`), installation follow-up (`76cd647`). They form a linear dependency chain; the local `codex/REL-20261004-PROVIDER-V042` includes them without rewriting history. Revert the follow-up/docs/readiness before removing membership or deployment support. Do not reset branches or overwrite current runtime data.
