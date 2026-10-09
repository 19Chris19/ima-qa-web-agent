# Durable paired release preparation

Final evidence and remaining gates: docs/RELEASE_ACCEPTANCE_20261010.md. Draft
PR #14 has green Test and pack. It is not a published or deployed RC.

User goal: update the public Provider repository together with the private
website and authorized Air/public preview, without changing account ownership
or restarting the bot. This branch prepares reviewed artifacts; no Release or
runtime switch is implied by a local commit.

Image workflow now accepts exact stable tags or numbered `-rc.N` prereleases.
Package/tag equality, main ancestry, immutable tags, both native architecture
smokes and manifest evidence remain mandatory. No `latest` tag is introduced.
Initial regression: release-version test failed before the validator existed.
Focused version/image tests passed after implementation.

On the Air, unconstrained full-suite process fan-out exhausted two startup-test
deadlines; the same focused tests passed unchanged. The npm test runner now
limits test-file concurrency to two for reproducible resource use. It does not
alter service account slots, transport timeouts or the five-way synthetic
concurrency inside an acceptance test. The complete bounded suite is a separate
gate; a focused retry alone is not claimed as a full green regression.

Before promotion, integrate review fixes, run clean tests/pack and privacy
checks, review PR/CI, then build both architectures from the merged tag.
Recommended testing pair: Provider v0.5.0-rc.1 and website v0.3.0-rc.1; it does
not replace the prior stable Release. Runtime authorization and fresh idle
proof remain separate gates. Preserve the old Air admin assets and five-account
store. Real questions are not part of read-only checks.

Rollback stops admission and drains tasks before changing compatible code.
Never restore stale histories/account stores or discard task ledgers to downgrade.
