# Public enrollment activation gate

Change-ID: FIX-20261006-PUBLIC-ENROLL-ACTIVATION
User-Goal: Persist captured credentials without admitting unqualified accounts to classic or knowledge-agent scheduling; activate only after one authorized successful bound probe.
Baseline: 7d2006eca6932ffbf2e731119d3fda6e278c43d3

## Design and scope
Use the existing encrypted directory and generation-store atomic CAS. Capture is disabled from its first write. A durable qualification-required marker prevents ordinary enable or stale runtime callbacks from bypassing the gate. A single-probe retry uses saved credentials. Bind completion to identity, knowledge scope, credential ciphertext and disabled state as well as store generation. Preserve manual/unknown/migration disable intent; only the pending-enrollment reason permits automatic activation. No Air multi-mode flow, automatic retries, live services or migrations of existing accounts.

## Plan
1. DONE: failing synthetic coverage for first-write isolation, classic scheduling, cancellation/failure/retry, state and credential drift, pause preservation and atomic activation.
2. DONE: capture, readiness and directory CAS connected. Admin capture/import and local CLI request the same gate; startup legacy env seeding remains unchanged. Admin retry and paused-success messages reflect actual state.
3. DONE: targeted and full synthetic tests and phase/state documentation. Named diff/governance review recorded below; isolated candidate for parent review, not merged into INT.

## Verification
Verification: Full suite 438/438 passed, zero failures/skips, using PROVIDER_ADMIN_CONTRACT_ROOT pointed at this worktree and npm test. Clean npm ci --ignore-scripts --no-audit --no-fund installed 123 packages; no dependency or lockfile change.
- Red: initial 17/17 activation checks failed on baseline. Two more tests failed for import bypass and late cancel outcome; the pending-admin action and local CLI gate checks also failed before their fixes.
- Green: the intermediate affected-suite run passed 130/130; final full regression includes 32 additional cases versus the 406-test baseline. Existing timeout/failure tests now assert failed and disabled; the old direct-enable assertion now expects 409. A final red/green jsdom check covers completed-success feedback returned to a cancel action.
- Synthetic checks cover real Directory/Pool callbacks and temporary encrypted reloads; protected local HTTP routes; one dispatch/terminal evidence; failed/cancelled/expired probes; retry without capture; manual/migration pause; cross-directory identity/scope/credential/deletion CAS; proof-write failure; committed-success cancellation; pool-sync quarantine; jsdom retry/pause UI.
- Only synthetic temporary stores and controlled transports were used. No private configuration, runtime, real credentials/questions, browser, container or deployment access. Live upstream cancellation, Windows/Linux behavior and full-platform acceptance remain NOT TESTED. Local CLI gate has static wiring coverage plus Directory behavior coverage, not a real CLI login rehearsal.
- Named staged diff, git diff --check and ownership verification passed. Installed governance CI reports one rule04 HARD and four existing soft warnings, not green. Its staged full-blob scan flags public/admin.js, scripts/enroll-web-agent-account.mjs, src/admin-routes.js, src/web-agent-account-directory.js, src/web-agent-enrollment.js, test/admin-experience.test.js, test/app.test.js and test/web-agent-enrollment.test.js. All 80 assignment matches are unchanged in 7d2006e and each baseline blob also triggers the scanner; added-lines scan returns false. No rule was suppressed and no unrelated code rewritten to evade it. The four soft warnings concern an older change record, an unrelated unclaimed worktree, missing scaffold and no upstream.

## Review notes
The global generation CAS deliberately rejects an otherwise valid proof when another account changes. No automatic re-probe is performed. A proof commit followed by pool-sync failure is a distinct local quarantine outcome, not an uncommitted probe failure; disk proof can already exist. No shared pool/client protocol, readiness mode contract, Dockerfile or deployed runtime was changed. The public one-probe contract stays separate from Air's seven-mode qualification.

## Rollout and rollback
Unreleased independent candidate; parent reviews the diff before integration. The new marker is additive runtime metadata. A rollback to older code does not enforce this gate, so do not resume admissions on old code without a reviewed account-state plan. No data deletion or credential replacement is required for rollback.
