# Account transfer (unreleased offline candidate)

Two installations encrypt their accounts with different keys. Never concatenate account JSON,
copy an entire runtime over another, or compare installation-specific HMAC fingerprints directly.

Use `node scripts/prepare-account-transfer.mjs --help` for the exact supported options.
Without `--prepare`, the tool reads stores/keys locally and emits only counts and a verification boundary.
It decrypts in memory to deduplicate IMA identities, checks the configured numeric knowledge scope,
and does not load account directories, contact IMA, renew tokens, ask questions or write live stores.

`--prepare --output /private/new-directory` writes encrypted source/target backups, key backups,
a target-key-encrypted candidate, hashes and an optional owned history archive. The directory is 0700;
files are 0600. Its existing parent is resolved through symlinks before checking every real ancestor
for a Git marker; a symlink into a worktree subdirectory is rejected. The output must not already exist. Interrupted preparation
is not resumable in place: inspect and retain the partial private directory, then choose a fresh output path.
The archive contains private conversation text: do not commit, publish, attach or print it.

New candidate accounts are **disabled**, without copied qualification proofs or machine-specific export paths.
Existing target records are retained unchanged. Duplicate identities never overwrite target credentials.
IDs and names share one reserved lookup namespace, including normalized aliases; ambiguous targets fail
closed and incoming collisions receive unique suffixes. The original account's lookup cannot be shadowed.
`prepared_not_applied` does not mean accounts were imported, enabled, valid, or able to answer questions.

## Explicit Offline Apply

The CLI supports `--apply --bundle PRIVATE_DIRECTORY --source-port PORT --target-port PORT`,
with the same four source/target store/key arguments. Do not combine apply, prepare or rollback modes.
This is an explicit maintenance operation, not an unattended cutover or permission to use live data.

Both Provider entrypoints acquire a canonical account-store lifecycle fence before constructing the
directory, reading account-store credentials or refreshing them, and retain it until process exit. Apply and
rollback acquire the same two fences in canonical path order, then both ordinary writer locks. The writer
lease settings match the regular store commit worker. Partial lock acquisitions are released on failure.
The lifecycle fence detects a starting refresh owner even before it listens; two loopback ports alone cannot.
After acquiring fences and again after writer locks, both distinct supplied ports must refuse connections
on IPv4 and IPv6. Any successful connection, timeout or non-refusal socket error rejects the operation.

The tool validates bundle hashes, unchanged keys, add-only original records, disabled additions, lookup
uniqueness, decryptability and distinct IMA identities. It compares whole current store hashes, not just
generations. It writes a private temporary file, flushes it and atomically renames only the target store.
Source store, keys and conversation stores are not changed. Existing target settings are retained.
An identical applied result returns `already_applied` without writing or incrementing generation;
a subsequently modified target instead fails closed. Reapplying a rolled-back bundle requires preparation
from fresh snapshots because rollback advances generation.

## Conservative Rollback

Use `--rollback` instead of `--apply` with the same paths/ports. The same fences, port checks, key checks
and unchanged-source hash requirement apply. Every still-present imported record must match its prepared
record exactly, including runtime, credentials, events and proof fields. Used, enabled, refreshed or otherwise
changed imports reject the whole rollback before any write. A normal Provider startup can change metadata;
even if it did not answer a question, this conservative rollback may therefore refuse it.

Rollback removes only unchanged imported IDs from the current target snapshot. Newer unrelated accounts,
settings, original account changes and all conversation history remain intact. An already absent import is
left absent; when all are absent, return `already_rolled_back` without writing. This is not a general restore
tool and never restores stale credentials from a backup. A changed source requires manual review, not a bypass.

## Archive Consumer Contract

The exporter targets schema version 1; consumer reference: `6237d8a`, `history-archive.mjs`.
Sources emit only `index`, `title`, `url`, `snippet`, `type`. Upstream numeric `sourceType` is not emitted:
when `type` is absent, 0 maps to `web`, and 1/2 map to `knowledge`. Existing `type` is retained.
Legacy `sourceIntent` is never emitted; its supported values map to `source_intent` when that field is absent.
Upstream session/account bindings and credential metadata are omitted. The consumer remains authoritative
for UUID owner IDs, dates, value/size limits and read-only visibility; its parser must accept a synthetic
export before any integration. Cross-repository export-to-parse acceptance is independently owned; this
candidate does not modify the consumer or claim that acceptance on its behalf.

## Operator Cutover Gate

Before applying any artifact:
1. Verify the target running-code schema and Bot contracts; public candidate code is not interchangeable with a customized live Provider.
2. Install the shared-fence-capable code on both sides, disable old launchers and automatic restarts, drain queues, pause submissions and fully stop both services and other writers. Old binaries do not honor this fence; port checks cannot prove their lifecycle state.
3. Take final backups, regenerate the bundle from final snapshots, and recheck source/target hashes immediately before any write.
4. Test history ownership and read-only restrictions in the BFF; preserve current signing keys and visitor ownership.
5. Apply only the reviewed account additions to the stopped target, preserving all original records; start target and verify new identity separately before enabling scheduling.
6. Keep the source stopped for imported identities. A rollback must stop target ownership first and use the freshest credentials;
   never restore an obsolete login token or overwrite conversations created after cutover.

The fences protect this offline operation, not permanent cross-installation identity ownership. After apply,
keep the old source refresh owner stopped for transferred identities before enabling any target account.
For the parent cutover topology, **3317 must remain stopped with automatic restart disabled until source
scheduling/refresh disablement has been separately implemented and verified**. Merely applying a bundle,
seeing disabled target records, or releasing a lock is not evidence of source ownership retirement.
Existing old 3117/3317 binaries do not recognize the fence: manually pause ingress, drain queues, stop
both services/refresh owners and keep their launchers stopped throughout maintenance. The tool does not
perform those actions or verify supervisor state. Port numbers supplied to the CLI must match the actual
reviewed topology; no default assumes that 3117/3317 are stopped.

A durable migrated-out marker or controlled source-disable workflow, its startup enforcement, and evidence
that the source scheduler no longer owns these identities are a **separate acceptance gate**. This tool
does not write such a marker, disable the source, or enable target accounts. Success means only
`applied_disabled` (or conservative rollback), never completed cross-instance ownership transfer.
Results explicitly report `sourceOwnershipTransferred: false`; offline results also report
`sourceMustRemainStopped: true`, including idempotent retries. Do not restart 3317 solely on these results.
Local filesystem/lease semantics and trusted private directory ownership are prerequisites; this is not
a distributed migration protocol or protection against an administrator replacing files behind the locks.

Only temporary synthetic stores, fake port listeners and local code were used for candidate verification.
No real credentials, runtime directories, IMA requests, service restarts, push or release are involved.
Live validity, historical visitor ownership and one-question/follow-up acceptance remain separate gates.
