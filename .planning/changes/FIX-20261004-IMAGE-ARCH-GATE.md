# FIX-20261004-IMAGE-ARCH-GATE

Versioned image run 37195194011 built both architectures, passed AMD64 smoke,
then failed ARM64 verification on the same AMD64 runner. Keep v0.4.1 tag and
Release draft unchanged. Split startup verification into independent native
AMD64/ARM64 runners, avoiding a shared image cache and emulation for acceptance.
Only produce the manifest after BOTH checks pass. Re-dispatch the reviewed
workflow from main for the existing merged tag; never move the tag.

No app runtime, accounts, tokens or QA contract changes. CI startup is synthetic
and network-disabled. Visibility and anonymous/authorized pulls remain separate
Release gates.
