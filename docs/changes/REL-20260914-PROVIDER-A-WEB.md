# Provider A web releases

## Intent

Prepare 0.2.2 as a compatible web QA reliability patch, then 0.3.0 with native knowledge Agent enrollment and a standalone bot adapter example.

## Boundaries

Base: public 0.2.1 (67b4f468). Work only in isolated release checkouts. Do not restart 3117, modify production accounts, deploy, or push without release authorization. Never include credentials, private identities, corpora, answers or runtime receipts in the public package.

## Acceptance

- 0.2.2: protocol compatibility, explicit terminal handling, safe account recovery, operator feedback, no post-dispatch repeat.
- 0.3.0: mode migration, isolated enrollment verification, generation-fenced account persistence, capacity and idempotent adapter contracts.
- Both: clean install, regression, package inspection, synthetic browser acceptance and upgrade validation. Real IMA and soak acceptance are recorded separately and cannot be inferred from unit tests.

## Status

Local candidate implementation and synthetic acceptance are complete. No real IMA acceptance, public release, or deployment is claimed.

### 0.3.0 implementation checkpoint

Implemented locally: native knowledge session contract; conversation-pinned modes; generation-fenced encrypted directory updates with private migration backup; one-shot enrollment proof with no implicit auth refresh; admin verification/mode endpoints and UI; protected capacity projection; synthetic terminal bot adapter.

The follow-up adds a private durable idempotency receipt ledger for internal JSON asks, replay after restart, unknown-state no-retry behavior, request fingerprint conflicts, and cross-process generation-locked writes. Bot adapter real mode now derives a stable idempotency key from each platform message ID. No real IMA calls were made.

Browser verification passed at 1280px and 390px for main/embed restored formatting, sources, admin dialog closure, hidden sections and the in-page single-account verification confirmation. It uses mocked responses and is not real login or upstream acceptance. The 30-minute full HTTP synthetic soak passed with eight clients: 9,127 completed asks, 536 idempotent replays, 200 injected timeouts, 152 cancellations, four controlled overload timeouts, zero failures/leaks, peak active concurrency 4/4, and an empty final queue. Clean `npm ci` installed 80 pinned dependencies; the 108-file package tarball was extracted, clean-installed, and passed all 233 tests. The package inspection found no runtime credentials or real user data. The synthetic package upgrade/rollback check also passed. Version remains at the patch baseline until all 0.3.0 release gates pass.

Release blockers still open: full browser acceptance for actual enrollment, re-login, native-mode upgrade and capacity transitions; real isolated IMA acceptance with a dedicated authorized account. The 30-minute soak is synthetic and cannot prove upstream account capacity or policy eligibility. README UI screenshots use synthetic data; the bot adapter has a terminal example and contract document, not a live-platform screenshot. This branch is not release-ready.
