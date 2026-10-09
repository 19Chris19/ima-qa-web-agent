# Durable paired release preparation

User goal: update the public Provider repository together with the private
website and authorized Air/public preview, without changing account ownership
or restarting the bot. This branch prepares reviewed artifacts; no Release or
runtime switch is implied by a local commit.

Image workflow now accepts exact stable tags or numbered `-rc.N` prereleases.
Package/tag equality, main ancestry, immutable tags, both native architecture
smokes and manifest evidence remain mandatory. No `latest` tag is introduced.
Initial regression: release-version test failed before the validator existed.
Focused version/image tests passed after implementation.

Before promotion, integrate review fixes, run clean tests/pack and privacy
checks, review PR/CI, then build both architectures from the merged tag.
Recommended testing pair: Provider v0.5.0-rc.1 and website v0.3.0-rc.1; it does
not replace the prior stable Release. Runtime authorization and fresh idle
proof remain separate gates. Preserve the old Air admin assets and five-account
store. Real questions are not part of read-only checks.

Rollback stops admission and drains tasks before changing compatible code.
Never restore stale histories/account stores or discard task ledgers to downgrade.
