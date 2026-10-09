# FEAT-20261009-PROVIDER-TASK-UI

## Goal and Plan

Integrate the built-in generic QA main/embed pages with ordinary durable tasks,
keeping the existing renderer, sources, raw Markdown copy and visual layout.
Work only in the designated isolated feature branch; parent integrates the
separately owned backend capability and task contract. No service changes/pushes.

1. Add a frontend task transport with one idempotent POST per explicit send,
   snapshot replay, sequenced SSE deduplication and bounded GET-only recovery.
2. Integrate existing owner/auth request options, capability gating, explicit
   DELETE stop, detached navigation, refresh restoration and terminal history.
3. Extend synthetic jsdom regressions for disconnect/EOF, replay, refresh,
   expired events, owner headers, busy drafts and Markdown/source preservation.
4. Run focused/full tests, whitespace and governance checks; inspect named-file
   staged diff and commit one independently reviewable frontend change.

## Boundaries and Risks

Only public generic QA files, frontend tests, this record and QA documentation.
Do not edit src/app.js, task core, pool, config, admin, renderer or vendor assets.
No real IMA requests, credentials, browser profiles or runtime data in Git.
GET /api/capabilities must expose features.durable_qa_tasks_v1 using ordinary
auth. Never call internal capacity or add an internal token to browser assets.
Ambiguous submission must recover by owner-scoped request hash, never repost.
Stale callbacks after navigation must not alter another conversation. Terminal
history is authoritative when events expire or a page restores completed work.

## Verification and Handoff

Implementation complete in public/client.js and public/qa-tasks.js, loaded by
index.html/embed.html. Three scoped CSS rules cover recovery visibility and
process text. Existing renderer, source/copy helper and vendor assets unchanged.
Explicit non-IMA openapi-mimo/local-rag-mimo retains legacy ask; native IMA never
falls back. Core agent confirmed ordinary capabilities, owner-scoped requestKey
lookup, existing-conversation prerequisite and snapshot.eventsExpired contract.

- npm ci --ignore-scripts: PASS; manifests/lockfile unchanged.
- Focused client/renderer/composer suite: PASS, 48/48 (17 durable task cases).
- npm test: PASS, 570 total, 567 passed, 3 existing skips, 0 failures.
- git diff --check: PASS.
- Repository-local python3 scripts/check_governance.py --ci: unavailable,
  missing script (exit 2). This independent baseline also lacks AGENTS.md and
  shared STATE/template/config files; no infrastructure added outside scope.
- Installed governance checker --repo <this-worktree> --ci: PASS with baseline
  initialization/ownership warnings. Initial false positive classified the
  standard fetch credentials: same-origin option as a credential assignment;
  formatting the options object unambiguously resolved it without changing auth.
- Synthetic loopback browser: desktop native page completed one task across an
  EOF/reconnect, with source-mapped table and terminal send control. DOM checks
  confirmed no horizontal overflow and hidden reconnect control. Browser
  snapshot confirmed the completed answer. Screenshot capture timed out twice;
  do not claim visual/pixel or mobile screenshot verification.

No real IMA, live credentials, service changes, backend edits, push or deployment.
Parent must integrate core/scheduler and run integrated Provider/Docker checks.
One atomic commit keeps transport, both entrypoints, regression coverage and
contract documentation together. Rollback: revert this frontend commit; no
runtime migration or task deletion. Local reference stores IDs/request hash
only; refreshed task events/history remain the server's authority.
