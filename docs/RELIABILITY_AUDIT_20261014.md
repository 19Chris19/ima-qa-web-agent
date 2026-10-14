# QA persistence reliability audit — 2026-10-14

Status: tested candidate, not a production deployment or real-IMA acceptance.
Scope: Provider task journal/stream buffering/completion/recovery, conversation
history, and the paired website's queue/cache/observation/routing persistence.
Tests use synthetic local data; no credentials or real history are fixtures.

## Confirmed findings and treatment

| Finding | Treatment |
| --- | --- |
| Cumulative source snapshots repeat long excerpts and hit the 2 MiB record cap | Incremental JSONL, exact string interning and pressure compaction; original events/IDs retained |
| Every answer batch clones, serializes and fsyncs the entire accumulated record | Copy immutable event pointers; append only the new transaction, fsync before publication |
| Completion journal duplicates answer/reference fields before history commit | Same compact codec; journal → history → one terminal event preserved and fault-tested |
| Upstream semantic counters share the persisted-record byte/event limits | Separate bounded upstream, physical-record and expanded-replay budgets; safe capacity diagnostics |
| Website queued replay retains repeated sources as raw bytes under its own 2 MiB cap | Bounded lossless large-frame compression; identical SSE on replay, independent wire/global limits |
| Website catches output/cache exceptions as transport failure and repeatedly retries | Propagate downstream failure, retain original task identity and pause; later GET rebuilds cache without another POST |
| Low-frequency website session ownership and legacy request ledger rename without fsync | File and parent-directory fsync, memory rollback on write failure, invalid-file rejection |
| Repeated website status observations rewrite unchanged pending metadata | Skip unchanged queued/running status |
| One website subscriber's write/close exception propagates into queued execution | Isolate and remove that observer; other readers and execution continue |

The confirmed reference-heavy failure is not evidence of a full disk or a cover
preview failure. This patch does not require webpage screenshots, additional
account pools, browser processes, model calls or cover fetching.

## Verification results

Node 22 on macOS arm64:

- Provider full suite: **884 pass, 0 fail, 6 existing skips**.
- Website full suite: **312 pass, 0 fail, 2 existing skips**; build, built routing
  module imports, public-asset budgets and staged release checks pass.
- New coverage includes 33 source updates/31 citation relations/6 webpages,
  long text, exact cursor/body recovery, one completion/history append, owner
  isolation, legacy backup, partial write faults, torn UTF-8 tails, committed
  corruption, missing checkpoints, compaction epochs, expanded-replay bounds,
  no new POST on website recovery, and routing fsync order/failure handling.
- Code-only patch preflight applies to the current fixed migration source. The
  live process and its data have not been changed. Cover-preview candidate
  integration retains its extra build-module list: isolated Provider full suite
  **903 pass, 0 fail, 6 skips**; website full suite **322 pass, 0 fail, 2 skips**
  before the final observer checks, and all **18** affected bridge/queue tests
  pass again with those checks.

Thirty rounds per synthetic local-disk mode, measured with
`node --expose-gc scripts/benchmark-task-journal.cjs`:

| Metric | Original, ordinary stream | JSONL, same ordinary stream |
| --- | ---: | ---: |
| Total written payload | 12,011,940 B | 663,240 B |
| Commit P95 | 15.10 ms | 7.90 ms |
| First text commit P95 | 13.52 ms | 5.81 ms |
| Adjacent synthetic event interval P95 | 17.59 ms | 10.56 ms |
| Timer lag P95 | 0.84 ms | 1.33 ms |
| CPU, 30 rounds | 1,404 ms | 996 ms |
| Whole child process peak RSS | 55.4 MiB | 54.7 MiB |

Written payload falls **94.5%** without removing the durability barrier. A further
30 rich-reference rounds complete: each reconstructed task is 8,632,151 bytes,
while its physical checkpoint/log total is 273,601 bytes (267 KiB); commit P95
is 7.92 ms. Whole child process peak RSS is 122.2 MiB for this richer workload,
including JS objects and heap allocation. It is not a preview-worker RSS result
or a guaranteed service memory quota. Unique-source/replay limits still apply.

The website's separate 30-round replay benchmark sends 2,632,805 bytes per rich
stream and retains 27,720 bytes. Emit/compression P95 is 1.42 ms; complete replay
P95 is 5.54 ms, with identical reconstructed wire hashes. Peak whole-process RSS
is 70.2 MiB. Reproduce with
`node --expose-gc scripts/benchmark-queue-replay.mjs` in the companion repository.

Timing includes local filesystem/host scheduling noise; it does not measure IMA
generation, network first-token latency or browser rendering. Bytes are payload
passed to file writes, not a claim about APFS/SSD physical write amplification.
Real QA and production rollout remain separate acceptance steps.

## Remaining operational limits

1. Conversation history still writes one atomic JSON file on creation, confirmed
   binding and completed turn. It is not written per answer token, but growing
   history can block the event loop longer. A separate measured per-conversation
   or JSONL history migration must preserve task receipts and ownership.
2. Receipt caps (Provider 10,000, website watch 20,000) intentionally stop new
   work rather than forget idempotency. There is no safe automatic receipt
   archival policy yet. Never delete them to clear a full error.
3. Exhausted disk, lost writer lease or corrupt committed storage still fail
   closed. Keep consistent private backups and alert on unavailable readiness;
   this patch does not promise automatic repair of arbitrary corruption.
4. Already failed/indeterminate answers remain partial. Nothing automatically
   retries IMA or rewrites them as successful history.
5. Old executables cannot read version 2 tasks. Roll back other code while
   retaining the JSONL reader/writer after new tasks are accepted; never overwrite
   newer runtime data with a pre-upgrade snapshot.

See [journal format, recovery and rollback](TASK_JOURNAL_JSONL.md). The website
companion changes are independently reviewable; update the compatible Provider
first, then the website, under a confirmed drain/backup/restart window.
