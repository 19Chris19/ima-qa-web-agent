# Provider bot compatibility preparation

Change-ID: FIX-20261009-PROVIDER-BOT-COMPAT

## Goal and boundaries

Compare the controlled Air release code snapshot with candidate b7c3482 and
root-repository extension history. Preserve required bot contracts through
independent compatibility helpers and synthetic tests, with explicit app/startup
integration instructions. Do not transplant obsolete scheduler or identity code.

Owned: new bot compatibility modules, tests, docs and this record. No app,
config, conversation store, route, queue, pool or durable task manager edits.
No credential/account/runtime reads, live requests, real questions, restarts,
deployment, or release activation. Startup mounting belongs to the parent.

## Plan

1. Read only named service JavaScript files from the supplied release snapshot;
   record code hashes and compare tracked extension commits/client contracts.
2. Implement pure retrieval-contract validation, bound request fingerprints,
   source evidence and capacity compatibility adapters. Keep authentication,
   owner identity, scheduling and lifecycle mounting in parent-owned code.
3. Implement an injected, loopback-only recent-context consumer and bounded
   payload validation, preserving the existing v1/v2 wire contract while
   rejecting redirects, invalid counts, and malformed bindings.
4. Add synthetic contract tests and a compatibility matrix/integration guide.
5. Run focused regressions, diff/secret/governance checks and commit named files.

## Acceptance and rollout

Helpers are independently tested, not automatically mounted. Report outstanding
qualification, observation and startup dependencies as release gates rather
than advertise nonexistent support. Parent integrates and tests the full app;
this task does not authorize a live switch. Roll back by reverting this commit.

## Verification

- Focused app/config/capacity/bot-adapter plus compatibility/context: 96 passed.
- Compatibility/context/server dependency glue: 15 passed.
- Historical bot capacity validator at 657b5f19 accepted synthetic ready/blocked
  v4 snapshots. No network or live module import was involved.
- Added concrete server constructor glue and a code-only live call-site matrix.
- Parent reports recorded mode/accountLease propagation in legacy and durable
  execution; this branch does not edit or duplicate that patch.
- Air-specific startup/client/qualification preservation continues in a separate
  overlay branch; these helpers alone are not a deployment candidate.
