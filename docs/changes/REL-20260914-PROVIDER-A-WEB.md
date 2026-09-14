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
