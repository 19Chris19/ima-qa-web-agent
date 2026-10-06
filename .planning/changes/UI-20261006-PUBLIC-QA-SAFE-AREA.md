# UI-20261006-PUBLIC-QA-SAFE-AREA

## Goal and scope
Adapt Air UI fix 5a01e6ca to public Provider base
ad62b69e45f3d8298003217e48a1a700fd987f1a in an independent claimed worktree.
Owner: provider-admin-20261006. Preserve public branding, backend and QA nodes,
including its separate draft-stop button. No whole-page replacement.

## Design
Reserve form and notice height using grid rows, dynamic viewport sizing and
bottom safe-area padding. Keep glyph sizes; use 44px minimum QA hit targets.
Use the same candidate public asset root for main/embed slow-SSE verification.

## Verification
PASS: two layout tests red before implementation, focused 29/29 and full public
472/472 with PROVIDER_ADMIN_CONTRACT_ROOT pointing to this worktree. Six Ego
main/embed viewport and slow-SSE cases passed. Governance: zero hard blocks;
git diff --check passed. Results and truthful device limitations recorded in
docs/QA_COMPOSER_SAFE_AREA_20261006.md.

## Rollout and rollback
Not deployed. Local candidate only; no push, merge, live credentials or services.
Rollback by reverting this UI commit only; never restore runtime/account data.
