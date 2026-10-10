# Provider Bot Mount Implementation Plan

Goal: connect reviewed bot adapters to real app admission and execution paths.
Architecture: an opt-in trusted botCompatibility snapshot adapter plus injected
recentContextConsumer; unchanged default app and shared auth/ownership middleware.
Tech stack: existing Express, durable manager, node:test synthetic HTTP fixtures.

1. Add route regressions for bot validation, scope, idempotency and admission.
2. Extend app and durable route validation, persisted input and fingerprint glue.
3. Prepare one augmented prompt in admitted execution and preserve mode/lease.
4. Enforce bot evidence before append/completion and propagate L0 metadata.
5. Add v4 capacity/health regression without dropping website or bot features.
6. Run focused suites, full suite and governance; inspect named staged files and
   make one structured mounting commit. Do not modify config/server/client/pool.
