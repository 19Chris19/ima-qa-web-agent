# REL-20261004-PROVIDER-V042

- Goal: preserve a reviewable, tested local candidate for bundled Agent deployment and knowledge-base-authorized scan access.
- Baseline: public main d4eb621; latest released version remains v0.4.1.
- Audit-HEAD / Verified-SHA: 76cd647acc9c57bf6aaf92039884893c2a498369. This evidence commit changes documentation only.
- Included dependencies: guided deploy, KB authorization, protected readiness/ownership, Agent docs, login-gated target handoff and cold-start recovery.
- Verification: 288 tests, clean source/production dependency audit, ARM64 container empty-pool startup, isolated Mac browser connection, and clean website double-service install/resume passed. Credential-free evidence only.
- NOT RUN: native Windows, AMD64 execution, real SSH maintenance, authenticated share metadata, new-account scan, real IMA QA and long-term Linux operation.
- Rollout: no remote PR, tag, Release, shared service restart or account migration. Later release review must retain these unverified gates.
- Rollback: revert candidate commits in reverse dependency order; preserve current private account/session data, and retain v0.4.1.
