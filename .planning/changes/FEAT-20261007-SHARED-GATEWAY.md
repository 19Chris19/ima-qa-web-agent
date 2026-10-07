# Shared Provider gateway

Change-ID: FEAT-20261007-SHARED-GATEWAY
User-Goal: A dedicated loopback gateway for independently authenticated sites,
with isolated visitor history and protected native keyed SSE.

## Plan and Boundaries

- Add a dependency-free Node HTTP gateway and direct launch script.
- Read fixed local Provider credentials and scope; never accept routing or
  credential overrides from requests. No live Provider calls or credentials.
- Bind stable deployment IDs and validated visitors with domain-separated HMAC;
  delegate persistent request deduplication and history ownership to Provider.
- Strictly allowlist routes, methods and body fields; propagate cancellation,
  bound requests and JSON responses, forbid redirects and retries.
- Test synthetic tenants, rotation/revocation, spoofing, idempotency, cancellation
  and path denial. Document the exact public contract.
- No README, onboarding, package, Provider runtime, deployment or push changes.

## Contract Decisions

- Capabilities include schemaVersion 1, explicit keyed-SSE feature and all flat
  readiness fields. Both service capacity and owner-namespaced ordinary history
  credentials must succeed for authenticated/ready.
- Client capabilities supplies a stable visitor (for example demo:readiness).
- Question fields are question, optional conversationId, UUID request_id and
  optional sourceIntent web; unknown/internal fields fail closed.
- Default deadline is 200 seconds, above the BFF's 190 seconds. Normal JSON uses
  public-field allowlists; SSE remains byte-exact. Revocation rejects new requests,
  while active requests may finish.
- Known alignment difference: Provider HTTP config allows 2000 UTF-16 code units,
  but its native request builder caps at 1200 code points. Gateway conservatively
  caps at 1200 code units; upstream web-intent suffix also consumes native budget.
  Provider code is outside this change's ownership and remains unchanged.

## Acceptance / Verification

- PASS: node --test test/shared-gateway.test.js (10 synthetic tests).
- PASS: npm test (560 passed, 3 skipped, 0 failed); installed locked dependencies
  from local cache using npm ci --ignore-scripts --offline --no-audit --no-fund.
  Initial attempt without installed dependencies failed to load existing modules.
- PASS: git diff --check.
- Requested python3 scripts/check_governance.py --ci cannot run: the standalone
  Provider worktree does not contain this checker.
- PASS: shared git-agent-governance checker --repo <this-worktree> --ci, zero hard
  blocks. Existing partial governance initialization, missing upstream, unrelated
  worktree ownership and older change-record warnings remain out of scope.
- No live Provider/IMA credentials, questions, deployment or push performed.

## Integration Documentation (2026-10-07)

The gateway, dependency selector and private-network guide are now integrated in
one candidate. README and Agent instructions distinguish the released v0.4.2
baseline from candidate-only commands. Explorer supports both old and explicit
deployment-mode runtime syntax. Read-only Air checks found no Tailscale executable
or standard app and a wildcard Provider listener; opening remains blocked.
No live configuration was changed. Final integrated verification is recorded in
the candidate acceptance documentation, not implied by component test counts.
Final integrated code at 9ba954c passed the full Node test suite. Companion BFF
at 5cb5711 passed the cross-repository synthetic gateway tests and full suite.
Actual Tailscale, second-device access and Windows execution remain unverified.

## Rollout / Rollback

Opt-in direct Node script with private local configuration. No deployment in this
change. Stop the gateway and revert this atomic commit to roll back; Provider
history remains untouched. Preserve deployment IDs and HMAC key across rotation.
