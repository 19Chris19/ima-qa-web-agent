# Persistent Source Retirement (Candidate)

This contract supersedes the temporary-fence-only limitation in ACCOUNT_TRANSFER.md.
No live cutover, release or online credential verification is claimed.

Offline apply retains both lifecycle fences and writer locks, checks both supplied
service ports on IPv4/IPv6, verifies whole snapshots, bundle backups and keys, then
durably writes SOURCE_STORE.retirement.json BEFORE importing disabled target rows.
Source accounts and the source backup are not deleted or modified. History is never
written. The entire canonical source store is retired, not just selected accounts.
Startup acquires the lifecycle fence and checks retirement before constructing the
account directory or starting refresh/scheduling. UI disabled flags cannot bypass it.
Invalid markers fail closed. Target stores that are retired are rejected.

The private 0600 journal contains transaction hashes, not credentials or raw identities.
Writes use exclusive temporary files, file fsync, rename and parent-directory fsync.
A failure after source sealing retains retirement. Repeating the identical apply can
finish interrupted imports without duplication; rollback-pending transactions cannot
be applied. Retained completed transaction hashes prevent replay (bounded to 1000;
exhaustion rejects new operations rather than deleting history).

Explicit --rollback uses the same stopped-service and locking gates. It requires
unchanged source bytes and keys, and unchanged unused disabled imported records.
Missing imports also refuse rollback unless the durable rollback journal proves
their removal. Rollback preserves unrelated newer target accounts/settings and all
conversations. Before removing imports it journals before/after target hashes; a
crash can resume only from those exact snapshots. A changed target during recovery
fails closed. Source release is recorded only AFTER target removal is durable and
no source identity remains in target, including pre-existing deduplicated accounts.
Different transaction rollback, changed keys/source, used/enabled/refreshed imports
cannot unretire source. Released tombstones remain on disk; do not delete markers.

## Operator Gates

Stop ingress, drain queues, inhibit launchers/automatic restart and stop BOTH services
and other writers before offline operations. This tool performs none of those actions.
Old 3117/3317 binaries do not recognize either fence or retirement: keep them stopped.
Disabling old launch agents and container automatic restarts is a mandatory prerequisite
to actual migration: old code can refresh credentials and write stores BEFORE listen.
The retirement guarantee applies only to new marker-aware entrypoints, not old launchers.
In particular 3317 must stay disabled until source scheduling/refresh retirement is
verified under marker-aware code. Port refusal alone is not proof of stopped workers.
Never enable target automatically; qualification and any later activation are separate
explicit gates. Results retain sourceOwnershipTransferred:false and
sourceMustRemainStopped:true, with sourceRetired describing this journal only.

Protection assumes cooperative local writers, supported durable filesystem semantics,
and preservation of the canonical store plus its marker. It is not protection against
an administrator deleting markers, restoring old snapshots, copying accounts to another
path/host, old binaries, or independent owners of the same credentials. No global
cross-instance ownership transfer is claimed. Never downgrade a retired instance to
an old binary or restore its store without retaining the retirement marker.
