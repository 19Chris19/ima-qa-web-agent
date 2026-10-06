# FEAT-20261006-PROVIDER-SOURCE-RETIREMENT

User goal: durably retire the source store before offline disabled imports.
Scope: migration tools, startup store fence, synthetic tests and independent documentation.
Plan: failing regression tests; durable retirement journal; conservative journaled rollback; full synthetic suite.
Candidate only. No live credentials, runtime directories, service actions, push or release.
Rollback: explicit offline rollback only while source/key snapshots and imported records remain unchanged; otherwise retain retirement.

## Implementation

Persistent canonical-store sidecar seals the entire source before target writes. Startup
rejects retired/malformed journals independently of runtime disabled flags. Rollback
journals before/after hashes, preserves unrelated data and releases only once no source
identity remains in target. Completed transaction tombstones prohibit replay.
No source account deletion, target automatic enablement, or conversation writes.

## Verification

- Tests-first: two regression tests failed with missing expected rejection before implementation.
- Installed dependencies using npm ci --ignore-scripts only.
- PROVIDER_ADMIN_CONTRACT_ROOT="$PWD" npm test -- --test-reporter=tap: 394 passed, zero failures/skips.
- Includes synthetic apply/rollback interruption, restart subprocess, replay, unordered rollback,
  duplicate identities, changed keys/source, missing/used imports, IPv4/IPv6 running listeners,
  lifecycle/writer locks, concurrent apply, source/backup preservation and new-data preservation.
- CLI --help and git diff --cached --check passed; staged sensitive-file check passed.
- Repository has no scripts/check_governance.py. Installed governance checker --ci was run:
  existing FEAT-20261002-PROVIDER-DOCKER-LAB.md production record lacks SHA (one hard blocker).
  Unrelated governance scaffold/warnings were preserved; governance is not claimed green.

## Rollout And Remaining Gates

Candidate only, not released/pushed. Disable old launch/container automatic restart,
drain queues and stop both services before any actual operation. Old binaries can
refresh before listen and ignore retirement. Parent owns Air entrypoint integration.
Only marker-aware startup is covered. Keep 3317 stopped until source retirement is
verified; offline result still reports sourceOwnershipTransferred:false.
No real credentials/runtime/services or online IMA were accessed. Crash tests inject
filesystem-operation failures, not physical power loss. Deployment/filesystem durability
and actual supervisor disablement remain separate acceptance gates.
