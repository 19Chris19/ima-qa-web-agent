# Docker onboarding publication review

- User goal: publish the already rehearsed Docker initialization and private maintenance-browser fixes as a separate Provider A PR.
- Base: public main d12950b; carry only the deployment, browser bridge and fresh-enrollment client-version patches. Exclude answer-process and website changes.
- Review follow-up: redact malformed private helper configuration errors and validate the helper port and absolute executable path before launching.
- Verification: fresh dependency install, serial full suite, package and credential checks; the prior Air onboarding evidence is not a new login or cloud Linux acceptance.
- Rollout: authorized public PR, CI and recorded maintainer review before merge; no Release or restart of 3117/3317.
- Rollback: revert the PR in a new commit. Never restore old account data or change running helpers during publication.

## Local acceptance

- Clean npm install/audit: zero vulnerabilities. Package dry-run: 139 files and no private runtime paths. Tracked blobs checked against the lab's actual private credential values without printing them.
- Eight focused regression tests pass. Final serial full suite: 266/266 pass. Two earlier loaded full runs each hit one enrollment polling timeout; the isolated enrollment suite then passed 24/24 before the final full rerun. Those failed runs are not counted as success.
- Root governance: zero failures, warnings for existing worktree count and unconfigured root upstream only. No running service, helper, account pool or runtime configuration changed by this publication review.
