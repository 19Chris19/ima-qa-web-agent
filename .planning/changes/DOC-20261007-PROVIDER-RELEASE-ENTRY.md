# Versioned deployment entry

User goal: Keep Agent installation instructions accurate before and after release.

Change: Describe v0.4.2 source capabilities while requiring the matching formal Release and accepted image manifest. Do not claim publication or real-platform acceptance. Label historical screenshots explicitly.

Verification: Documentation-only diff; inspect named staged files, whitespace and governance checks before commit.

Rollout: Include in the existing release PR. No service or account changes.

Rollback: Revert documentation commit without changing runtime state.
