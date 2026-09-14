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

Implementation in progress. No release, live acceptance or deployment claimed.

### 0.3.0 implementation checkpoint

Implemented locally: native knowledge session contract; conversation-pinned modes; generation-fenced encrypted directory updates with private migration backup; one-shot enrollment proof with no implicit auth refresh; admin verification/mode endpoints and UI; protected capacity projection; synthetic terminal bot adapter.

Verification at this checkpoint: 220 tests passed, including native client request shape, source classification, legacy conversation continuity, stale generation rejection, cancelled probe, web-only rejection and enrollment failure retention. The synthetic bot adapter runs without credentials. No real IMA calls were made.

Browser verification also passed at 1280px and 390px for main/embed restored formatting, sources, admin dialog closure, hidden sections and the in-page single-account verification confirmation. It uses mocked responses and is not real login or upstream acceptance. Package dry-run found no runtime, key or raw environment files. Version remains at the patch baseline until all 0.3.0 release gates pass.

Release blockers still open: full process-crash/reaper/parallel writer tests; durable service-side idempotency; bounded batch verification; complete mode/enrollment browser acceptance; standalone package upgrade/rollback validation; 30-minute full request/cancel/timeout soak; real isolated IMA acceptance; public README architecture and synthetic case screenshot. The prior parser-only soak does not close those gates. This branch is not release-ready.
