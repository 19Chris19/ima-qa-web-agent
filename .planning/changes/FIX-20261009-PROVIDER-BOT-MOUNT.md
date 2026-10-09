# FIX-20261009-PROVIDER-BOT-MOUNT

## Goal and Scope

Mount the reviewed Air bot adapters onto trusted ordinary/internal routes and
durable execution at d6853b8, without changing live services or exposing secrets.
Use additive opt-in app dependencies; preserve default website/legacy behavior,
authenticated application ownership, recorded modes and runnable account leases.
Helper dependency: e395501. Startup/config/client/pool remain other owners' work.
Parent additionally authorized conversation-store L0 evidence/session profile
preservation. This change also extends the fixed public task failure allowlist.
Air startup's existing airPolicyCapacity and observation injections are accepted;
native-only website fields remain on their original validation/dispatch path.

## Implementation Plan

1. Validate all internal bot fields with trusted scope; reject them on ordinary
   routes. Bind original question and full normalized context contract into
   legacy/durable idempotency before any single-use consume.
2. Consume/augment only inside admitted execution. Preserve upstream affinity,
   mode and lease; send one augmented question, never raw context for a second
   client augmentation. Enforce actual source/L0 evidence before completion.
3. Mount verified snake-case v4 capacity alongside website fields and features.
   Unknown/unsupported policies fail closed; do not invent readiness.
4. Test synthetic route auth, replay/conflict, queue cancellation, consumption,
   JSON/SSE/durable evidence, session/lease propagation, and capacity contracts.

## Verification and Rollout

Verification: 36/36 new mounting tests passed. The combined app/task/history/
idempotency/identity run passed 148 tests with one optional identity test skipped;
that identity integration was explicitly enabled separately and passed 9/9.
Full `npm test -- --test-reporter=dot` passed (exit 0). The final health-shape
adjustment is covered by the repeated focused run. Diff whitespace checks pass.
The repository-local governance script is absent; the installed governance CI
checker passes with five existing initialization/history/worktree/upstream warnings.

No live questions, runtime reads, credentials, pushes, deployment or service
changes. Queue/pool/config/server/client files were not edited. Parent integrates
this scoped commit onto d908196 with its Air startup/client/pool companions.
Rollback by reverting this mounting commit only. Legacy answer trimming/8000-char
limits are intentionally unchanged; durable full raw answer/recovery is tested.
