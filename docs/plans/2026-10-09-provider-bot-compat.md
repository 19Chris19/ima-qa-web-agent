# Provider Bot Compatibility Plan

Goal: prepare the smallest independently testable bot contract adapters without
editing concurrently owned runtime files.

Architecture: pure adapters plus an injected single-use context consumer;
authenticated app routing and lifecycle remain with the parent. Node CommonJS,
native fetch/AbortController, existing answer-profile classifier, node:test.

1. Add `test/bot-compat.test.js` for source policy validation, context binding
   fingerprints, verified evidence, and dual bot/website capacity shapes.
2. Implement `src/bot-compat.js`; invalid inputs fail with fixed safe errors.
3. Add `test/bot-recent-context.test.js` using synthetic fetch responses only.
4. Implement `src/bot-recent-context.js`: loopback origin, no redirects/retries,
   bounded v1/v2 payloads, original-byte verification before normalization.
5. Record live-code hashes, root commit provenance, preserved contracts,
   intentional safety differences and unmounted integration gates in
   `docs/BOT_COMPATIBILITY.md`.
6. Run both new tests plus existing app/config/capacity/bot-adapter tests, inspect
   named staged diff, run governance and commit with a structured body.
