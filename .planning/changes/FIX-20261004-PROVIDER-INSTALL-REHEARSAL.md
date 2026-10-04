# FIX-20261004-PROVIDER-INSTALL-REHEARSAL

- Goal: finish the deployment path without asking users to discover private IDs or repeat cold-start preparation.
- Evidence: clean-directory desktop install initially hit the helper readiness timeout; safe retry completed without configuration reset.
- Scope: bounded longer cold-start wait, login-gated metadata resolution in an isolated official context, and credential-free target manifests for desktop-to-server handoff.
- Verification: synthetic login/timeout/cleanup tests, full regression, native helper and clean-directory rehearsal. Authenticated real share resolution, Windows, remote Linux and fresh-account QA NOT RUN.
- Rollout: local candidates only, no existing service restart or publication.
- Rollback: revert before the candidate evidence commit; retain existing private configuration and runtime data.
