# Air bot runtime overlay

Change-ID: FIX-20261009-PROVIDER-AIR-OVERLAY

## Goal

Mount the named Air bot source extensions on the durable candidate without
replacing parent-owned app, pool, queue or durable execution. Preserve public
startup defaults; Air deployment remains gated on integrated synthetic tests.

## Plan

1. Port named code-only observation, identity/context and qualification modules
   into an isolated Air namespace; record provenance and intentional changes.
2. Extend the current transport/credential-safe client with policy/profile
   request building and single-use L0, never restore dispatched retries.
3. Add explicit Air config/startup/admin integration and exact parent interfaces.
4. Test with synthetic transports, temporary stores, injected runners and no
   credentials, live endpoints, browser accounts or real QA.
5. Commit named files after focused/full candidate verification and governance.

## Boundaries

No live reads outside explicitly named code, no runtime/credential/account reads,
no restart or deployment. Parent integrates app/pool/queue hooks. Rollback is
reverting the Air overlay commit and leaving the opt-in disabled.

## Completed verification

- `node --test --test-concurrency=4`: 697 tests, 692 passed, 5 skipped,
  0 failed (94.03 seconds), using synthetic fixtures and transports only,
  before the final readiness state/qualification separation.
- Final focused run: Air runtime/client, bot compatibility, base web readiness,
  Provider entrypoint and config tests: 46 passed, 0 failed (13.23 seconds).
  Valid proofs remain qualified during disabled/cooling/maintenance states;
  capacity counts eligible slots and schedulable counts currently free slots.
- Regressions cover the actual pool's second-argument client factory, current
  directory-backed policy predicate, five valid basic native proofs without
  qualification writes, changed proof bindings, session/profile conflict before
  context consumption, preserved native transport/model, admin eligibility and
  qualification/enrollment cancellation.
- Parent d908196 policy-slot and app mounting changes are not present in this
  isolated branch. Their combined integration verification remains a separate
  parent step, not a deferred implementation item in this overlay.
- No app, pool, queue or durable execution files were edited. No live changes,
  credential reads, account reads or real QA were performed.
- Staged whitespace check passes. Governance CI reports one sensitive-content
  blocker in three existing startup/config files and five baseline warnings.
  Every matched assignment was compared with HEAD and is unchanged: expiry
  metadata, `parseOptionalInteger(...)` and `readEnv(...)` expressions, not
  credential literals. The checker result is not represented as green and no
  scanner exception or unrelated source rewrite was introduced.
