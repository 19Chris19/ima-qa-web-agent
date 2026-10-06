# UI-20261006-PROVIDER-ADMIN

Status: candidate, not deployed.

## Goal and approved design
Implement a compact Provider account table and right details dialog from the
approved design. Preserve enrollment, qualification, maintenance actions and
exercise/report workflows. Separate knowledge qualification, web and session
health; unknown evidence must not imply readiness. Preserve original identity on
enrollment conflict and offer only add-as-new or cancellation.

## Scope and isolation
Base: 0db3fc2. Branch: codex/UI-20261006-PROVIDER-ADMIN.
Owner: provider-admin-20261006. Independent worktree; base checkout unchanged.
Only public/admin.html, public/admin.js, public/admin.css, new admin UI tests,
docs/ADMIN_EXPERIENCE.md and this record may change. No backend, credentials,
runtime, live account calls, release or push.

## Plan
1. Inspect static UI, enrollment hooks and synthetic tests.
2. Implement responsive navigation, account table, accessible drawer and More menu.
3. Render management contract with readiness fallback and explicit unknown times.
4. Add identity-conflict add/cancel UI without replacing original identity.
5. Verify synthetic DOM tests, existing tests, scoped diff and structured commit.

## Verification and handoff
Implementation complete as a local candidate. `npm test -- --test-reporter=spec`:
300 passed, 0 failed, including 12 new synthetic jsdom cases. `git diff --check`
passed. Ownership verification passed and base worktree remained clean.

Synthetic browser preview: 320, 390, 768 and 1440 CSS-pixel viewports had no
horizontal overflow. Desktop/right drawer and mobile/fullscreen dialog inspected.
Tab/Shift-Tab containment, Escape/focus return and reduced motion confirmed in
Chromium. Only two mocked GET requests occurred during preview; no real account
or admin API calls. Screenshots outside Git:
- /tmp/provider-admin-ui-desktop.png
- /tmp/provider-admin-ui-desktop-drawer.png
- /tmp/provider-admin-ui-mobile.png
- /tmp/provider-admin-ui-mobile-drawer.png

The added removal/focus and normalized-name collision tests caught issues during
development; both were corrected before the final passing regression run.
Required `python3 scripts/check_governance.py --ci` could not run because this
target repository does not contain that script (exit 2). Adding governance
infrastructure is outside scope. Parent handles the known npm audit dependency
issue separately; package files remain unchanged.

Parent confirmed the maintenance projection, including unobserved and retry_wait;
top schedulable count follows readiness rather than legacy basicHealthy.
Parent integrates this candidate; enrollment identity contract still requires
cross-branch integration verification. No live success is claimed. No push,
release, service restart or real enrollment was performed.
Rollback: revert the UI commit or restore scoped files from 0db3fc2.

## Cross-branch contract review
Read-only backend review at management commit 5d3c4198be43d7c2e29dc5cd5eed8cd001b68542.
Plan: exercise actual management and identity route handlers with in-memory
dependencies and feed responses into the UI through mocked fetch. No listening
HTTP server, real account store, browser helper or credentials. Add an opt-in
contract test selected with PROVIDER_ADMIN_CONTRACT_ROOT so this UI-only branch
does not require backend files to be copied or merged.

Result: no contract mismatch found. Actual management projection supplies all
consumed fields; public enrollment uses taskId; identity route forwards only
action/name and returns success/enrollment. Added test exercises real handlers
with mocked dependencies, not auth middleware or real identity storage.
Focused run: 14 passed, 0 failed/skipped. Full regression with
PROVIDER_ADMIN_CONTRACT_ROOT set: 301 passed, 0 failed/skipped.
At final run backend HEAD was 3122794e09d8a1445a247a9e4f4d51acd33b5348;
the three reviewed backend files were unchanged from the review commit.
No UI/backend implementation edits, running-service access, browser-space
operations or credential reads. Governance-script absence remains unchanged.
