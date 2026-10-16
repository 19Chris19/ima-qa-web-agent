# Paired release and production gate

Current mobile interaction patch pair: Provider **v0.6.2** / website **v0.4.2**. Native Chromium touch regression is covered; physical iOS/Android safe-area and keyboard acceptance remains pending. This patch does not submit real IMA questions.

Release order: Provider candidate, website candidate pinned to that Provider, then the stable pair. A merged PR is not a production deployment. GitHub main remains the integration branch; the website Vercel project tracks `codex/production-stable` for Production. Main and PR deployments remain previews. Move the production branch only to an accepted, immutable stable Release commit after the Provider and BFF have been deployed and verified.

Record both package versions, full source revisions, release image digests and runtime asset hashes in one private deployment manifest. Health reports packaged versions and validated source revisions; an arbitrary environment label is not a version. Image manifests are attached only after native amd64/arm64 startup checks. Container checks are synthetic and do not certify IMA account eligibility.

For an existing installation: close admission, drain to zero, stop the single writer, encrypt and verify a consistent private backup, apply reviewed files, restart Provider first, verify account count, original encryption and Cookie keys and conversation ownership, then update the website and public entry. Preserve installation-specific credentials and migration overlays; list their paths and digests privately instead of copying them into Git. Never replace migration code by checking out floating main.

Task records now use bounded version 2 JSONL with compact checkpoints. Existing legacy records are read without re-asking. After accepting new tasks, rollback must retain the JSONL reader/writer; do not restore an older data snapshot over new history. Cover previews are independent, anonymous and optional: 2 seconds on the client, 3 seconds on the worker, no automatic retry, no browser screenshots. A failed cover leaves the accurate text source available.

A deployment is complete only when the running Provider, BFF, Vercel commit and served asset hashes agree with the accepted manifest. Air robot configuration and login renewal are separate maintenance operations.
