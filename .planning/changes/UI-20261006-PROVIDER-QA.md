# UI-20261006-PROVIDER-QA

## Goal and Approved Plan

Improve generic Provider QA input, reading and copying in an isolated candidate
based on 0db3fc2. Parent reviews and integrates; no push or deployment.

1. Reuse the safe GFM answer-renderer for live/history answers and copy text.
2. Keep one textarea: 56px compact capsule, full-width multiline text above
   controls, 144px text limit. Busy drafts are local only; stop or wait first.
3. Suspend streaming follow on manual reading; expose a centered latest button.
4. Copy terminal/received partial answers and assistant-only selections, with
   accessible feedback and selectable fallback when clipboard access fails.
5. Verify with synthetic jsdom tests, review named-file diff and commit locally.

## Boundaries

Own public/index.html, public/embed.html, public/client.js, public/styles.css,
new generic frontend helpers, appropriate tests, docs/QA_EXPERIENCE.md and this
record only. No admin, backend, vendor or renderer-core edits. Website reference
files are read-only: no branding, navigation, prompt bank or animations copied.
No real QA, credentials, services, external AI, persistent queue or concurrent
turns. Do not invent upstream process data.

## Risks and Acceptance

Exercise IME/Enter, busy draft retention, abort/error/EOF, history copy, mapped
citations versus literal numbers/code, selection boundaries and dismissal,
clipboard failure, scrolling and compact/multiline transitions. Browser layout
and live-service behavior must not be claimed verified by jsdom.

## Verification / Handoff

Implemented one shared frontend helper and integrated both main/embed pages.
The independent baseline has no scripts/check_governance.py or .planning/STATE.md;
the required governance command was attempted and failed with missing-file exit 2.
No shared governance files were added outside this ownership.
Worktree ownership is provider-admin-20261006 on codex/UI-20261006-PROVIDER-QA.
Ownership verify passed. `npm ci --ignore-scripts` completed without manifest or
lockfile changes. Initial full suite: 297/297; after three extra regression cases,
`npm test -- --test-reporter=dot` passed all 300 cases. Final focused suite passed
21/21 after the last selection-identity hardening. `git diff --check` passed.

Isolated fake HTTP/SSE browser checks: desktop main and 390x844 embed, 56px/28px
compact composer, full-width stacked text above tools, no horizontal overflow,
retained busy draft after stop, partial-copy action, centered return-latest
(195px center in 390px panel). Screenshots inspected outside Git. Fake server and
browser task closed. No real QA or actual service mutation.

Gaps: real provider/deployment, OS clipboard permissions, screen readers, mobile
Safari/soft keyboard, backend partial-history persistence. Public SSE has no
structured process events, so no process UI was invented. Existing npm audit
critical proxy-addr advisory GHSA-jqcg-44mw-7w3h remains out of scope.

One atomic UI commit intentionally includes its helper, regression tests and
candidate documentation. Parent must review/integrate; no push/release performed.
Rollback: revert the candidate commit; no runtime migration.
