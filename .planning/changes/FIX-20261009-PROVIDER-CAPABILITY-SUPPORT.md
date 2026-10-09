# FIX-20261009-PROVIDER-CAPABILITY-SUPPORT

## Goal and Scope

Restore mode-level website native contract support independently of account
capacity, and close prior paired caller wire parity with code evidence. Base:
parent 67be4c7. Own app/tests/docs only; no startup/admin/pool/queue edits.

## Findings and Implementation

Website provider-a-client.mjs derives contractSupported from the feature flag;
server.mjs returns provider_contract_incompatible when it is false. Native mode
must keep the feature true with zero eligible accounts. Preserve separate bot
and website capacity snapshots; BFF must prefer the website snapshot when present.

Prior paired caller 836ebe17/a1e43e0d uses identical account/group/sender identity
for both legs, no context binding, one shared pair ref, and leg-specific request
keys/conversations. Extend synthetic SSE/task tests for that exact identity and
scope shape. No logs, credentials, private questions or live requests are used.

Actual supplied WorkingDirectory release 0ac50d7a has no dual-source module or
parallel ref/leg sender. Its task-runner passes a five-field context binding and
account/group/sender identity into one ask. The capacity reader still understands
pairs, but this is not a paired execution path. Do not infer current two-leg
identity/binding equality from the separate historical caller evidence.

## Verification

Two capacity regressions failed before the fix. Final app/mount/Air startup/pair
tests passed 114/114. Historical SSE/task wire tests verify one exclusion record,
two distinct accounts, no context consume, and durable restart preservation.
Whitespace checks pass. Parent owns the final combined full/container run.

## Rollout and Rollback

Parent cherry-picks this commit and coordinates BFF website-snapshot preference.
No deployment. Revert this commit to roll back; do not alter journals or history.
