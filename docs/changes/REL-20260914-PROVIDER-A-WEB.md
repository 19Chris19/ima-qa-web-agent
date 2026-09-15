# Provider A web releases

## Intent

Prepare 0.2.2 as a compatible web QA reliability patch, then 0.3.0 with native knowledge Agent enrollment and a standalone bot adapter example. When the maintainer has no isolated IMA account available, publish a clearly labeled candidate branch with actionable downstream live-acceptance instructions instead of claiming that real upstream acceptance passed.

## Boundaries

Base: public 0.2.1 (67b4f468). Work only in isolated release checkouts. Do not restart 3117, modify production accounts, or deploy. Candidate-branch push is allowed only after explicit user authorization; do not push directly to `main` or create a formal release without the required review and authorization. Never include credentials, private identities, corpora, answers or runtime receipts in the public package.

## Acceptance

- 0.2.2: protocol compatibility, explicit terminal handling, safe account recovery, operator feedback, no post-dispatch repeat.
- 0.3.0: mode migration, isolated enrollment verification, generation-fenced account persistence, capacity and idempotent adapter contracts.
- Both: clean install, regression, package inspection, synthetic browser acceptance and upgrade validation. Real IMA acceptance is performed by a deployer using an isolated authorized account and the public acceptance guide; it cannot be inferred from unit or synthetic tests.

## Status

Local implementation and synthetic acceptance are complete. Real IMA acceptance was not performed because the maintainer has no isolated authorized test account. The user chose to publish v0.3.0 with clear downstream acceptance instructions rather than delay for a maintainer account; this does not claim real upstream validation.

### 0.3.0 implementation checkpoint

Implemented locally: native knowledge session contract; conversation-pinned modes; generation-fenced encrypted directory updates with private migration backup; one-shot enrollment proof with no implicit auth refresh; admin verification/mode endpoints and UI; protected capacity projection; synthetic terminal bot adapter.

The follow-up adds a private durable idempotency receipt ledger for internal JSON asks, replay after restart, unknown-state no-retry behavior, request fingerprint conflicts, and cross-process generation-locked writes. Bot adapter real mode now derives a stable idempotency key from each platform message ID. No real IMA calls were made.

Browser verification passed at 1280px and 390px for main/embed restored formatting, sources, admin dialog closure, hidden sections and the in-page single-account verification confirmation. It uses mocked responses and is not real login or upstream acceptance. The 30-minute full HTTP synthetic soak passed with eight clients: 9,127 completed asks, 536 idempotent replays, 200 injected timeouts, 152 cancellations, four controlled overload timeouts, zero failures/leaks, peak active concurrency 4/4, and an empty final queue. Clean `npm ci` installed 80 pinned dependencies; the package tarball passed clean-install and all 233 tests. The v0.3.0 package contains 109 allowlisted files including the public acceptance guide, with no runtime credentials or real user data. The synthetic package upgrade/rollback check also passed. Release metadata is aligned to v0.3.0; the public release does not certify real IMA login, knowledge-base source quality or upstream capacity.

Open validation: real IMA enrollment, account verification, target-library source retrieval and upstream capacity have not been exercised by the maintainer because no isolated account is available. `docs/ACCEPTANCE_TESTING.md` provides the steps for deployers to test these with their own authorized accounts. The 30-minute soak is synthetic and cannot prove upstream account capacity or policy eligibility. README UI screenshots use synthetic data; the bot adapter has a terminal example and contract document, not a live-platform screenshot. This software release is not a certification of real IMA upstream behavior.
