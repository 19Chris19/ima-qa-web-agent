# UI-20261006-PUBLIC-QA-SINGLE-SEND

## Goal
Complete public QA send/stop reuse on base 014b93c7. Owner:
provider-admin-20261006. Keep public client/API/branding and editable busy draft;
no queue or extra stop button. Independent claimed candidate worktree.

## Design
Busy primary button always stops, regardless of draft text. Busy Enter retains
draft without submitting or aborting. Terminal state restores send. Remove only
the redundant draft-stop node and its bindings/styles; retain primary nodes.

## Verification
PASS: six contract assertions failed before implementation; focused 31/31 and
full public 474/474 passed with PROVIDER_ADMIN_CONTRACT_ROOT set to this worktree.
Six main/embed slow-SSE browser cases passed; natural completion tested with
deterministic JSDOM. Ownership/diff checks passed; governance zero hard blocks.
Results and device limitations recorded in docs/QA_SINGLE_SEND_20261006.md.

## Rollout and rollback
Not deployed. No live, push or merge. Revert this commit only to restore the
014b93c7 dual-button behavior; no runtime/account rollback.
