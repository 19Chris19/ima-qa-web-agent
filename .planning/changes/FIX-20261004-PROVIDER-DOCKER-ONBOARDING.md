# Docker onboarding publication review

- User goal: publish the already rehearsed Docker initialization and private maintenance-browser fixes as a separate Provider A PR.
- Base: public main d12950b; carry only the deployment, browser bridge and fresh-enrollment client-version patches. Exclude answer-process and website changes.
- Review follow-up: redact malformed private helper configuration errors and validate the helper port and absolute executable path before launching.
- Verification: fresh dependency install, serial full suite, package and credential checks; the prior Air onboarding evidence is not a new login or cloud Linux acceptance.
- Rollout: authorized public PR, CI and recorded maintainer review before merge; no Release or restart of 3117/3317.
- Rollback: revert the PR in a new commit. Never restore old account data or change running helpers during publication.
