# Durable QA JSONL journal

## Problem and behavior

Cumulative reference events repeat earlier sources and citation mappings. Writing
the entire growing task as JSON after each update can hit the 2 MiB task limit
even for a short answer with few unique webpages. It also repeatedly serializes
and fsyncs earlier text and reference excerpts. Raising that limit alone leaves
the amplification in place.

New records use `<task-id>.json` (version 2 compact checkpoint) and
`<task-id>.jsonl` (one checksummed transaction per committed batch). Transactions
contain changed header fields and newly appended events. Exact long strings are
interned within the task. This does not merge sources by URL, index, array position
or title: different excerpts and every citation relationship remain distinct.
In-memory/public task models remain version 1; task/SSE/history and robot contracts
are unchanged. Completion journals use the same representation and retain the
existing journal → idempotent history → terminal ordering.

The first text flush and existing batching stay in place. A batch is published
only after its JSONL append has passed fsync. Checkpoint compaction is triggered
by pressure or expiry, retaining all unexpired event IDs. It is not a per-token
rewrite. Old source events still replay exactly, including whitespace.

## Recovery and private files

- Existing version 1 JSON tasks are read without wholesale rewriting. Before the
  first mutation, their original file is copied once to `.legacy-v1/` (0700/0600).
  That rollback backup is separate from the active ledger byte budget.
- New files are 0600 under the existing 0700 task directory and exclusive writer
  lease. A copied journal must include **both** checkpoint and JSONL, plus the
  conversation history and routing/receipt files from the same stopped service.
- Newline-terminated, checksummed transactions are committed. An incomplete final
  line is not published and is trimmed on recovery while holding the lease.
  Invalid committed lines, cursor gaps, missing checkpoints, symlink logs and
  excess expanded replay fail closed; they are never skipped or reset to empty.
- Checkpoint epochs prevent stale logs from overwriting a newer checkpoint after
  a crash between replacing the checkpoint and clearing the old log. Stale-only
  logs are reclaimed under the writer lease. Partial/failed append writes close
  admission until recovery; the acknowledged prefix stays intact.
- Restart retains owners, application identity, idempotency keys, task IDs and
  upstream affinity. Dispatched incomplete tasks remain indeterminate. It never
  re-asks IMA to repair a record or turns a failed partial answer into success.

Do not tail these private files into shared logs. For offline diagnostics,
`require('./src/durable-qa-store').readTaskRecord(checkpointPath)` reconstructs
either format read-only. It returns private content: print only allowlisted
counts/statuses, never answers, source URLs or identity data. Do not edit logs,
delete receipts, or use the reader concurrently with a live writer for backups.

## Bounded resource use

| Budget | Default |
| --- | --- |
| Active tasks / retained receipts | 500 / 10,000 |
| Physical active ledger / one task | 128 MiB / 2 MiB |
| Expanded replay overall / one task | 128 MiB / 16 MiB |
| Persisted events per task | 10,000 |
| Upstream normalized stream | 16 MiB / 100,000 semantic events |

Small terminal reserves remain available. These are serialized byte/count bounds,
not an OS memory quota. Genuinely oversized/new unique sources can still exhaust
a bound. `task_capacity` stays the public failure code; optional `trace.capacityKind`
distinguishes `task_record_bytes`, `store_record_bytes`, `task_replay_bytes`,
`store_replay_bytes`, `task_events`, `task_receipts`, `upstream_stream` and
`response_frame`, without source/question data. Diagnose the specific bound;
never delete execution receipts or bypass deduplication to admit new work.

## Upgrade and rollback

Test against synthetic private storage first. Deployment requires draining tasks,
stopping the **single** writer, and taking a private consistent backup of current
code and runtime. Apply the reviewed files to the fixed migration code; do not
replace it with main or alter account secrets, browser state or robot patches.

The old executable cannot read version 2 checkpoints and will fail closed.
Rollback after accepting new work must retain this JSONL reader/writer alongside
the earlier application code. Do not restore an old ledger/history over newer
accepted tasks. A full binary/data rollback is safe only before any new task was
accepted, using the consistent pre-upgrade backup. Archived original JSON files
are evidence, not permission to overwrite newer tasks.

This patch does not retroactively finish already failed answers. It does not
convert the low-frequency conversation-history store into JSONL: that store
retains its existing atomic durability and per-conversation retention. Whole
history serialization can still grow costly at large scale and needs its own
measured, receipt-preserving migration before changing its format.

## Verification

`node --test test/durable-qa-jsonl.test.js test/durable-qa-stream-buffer.test.js
test/durable-qa-tasks.test.js` covers rich references, exact replay, completion and
history recovery, legacy backup, partial writes, torn tails, corruption,
compaction, symlinks, ownership and bounds. Existing application/bot retention
tests use the format-aware reader and continue checking the original contracts.

`node --expose-gc scripts/benchmark-task-journal.cjs <baseline-ref>` runs 30
synthetic rounds per mode against temporary directories, with no account pool,
network or IMA calls. Results describe local commit/timer timing, bytes written,
CPU and whole-process RSS; they do not establish real IMA first-token latency.
