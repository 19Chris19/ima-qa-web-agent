# Durable pair receipt retention

## Goal and Scope
Preserve distinct-account exclusion for an incomplete durable pair after terminal
question/event retention and restart. Keep only scoped pair hashes, leg and actual
account affinity; never extend question, context body or event retention for pairs.
No queue, auth, configuration, deployment or live request changes.

## Acceptance
- Red-first real store/manager/pool fake-clock restart regression after 24 hours.
- Completed pairs use original terminal timestamps, never a renewed restart TTL.
- Expired completed history exceeding pool map capacity is skipped before restore.
- Unknown dispatched affinity remains fail closed; receipt count stays bounded by
  the existing durable store limit. Preserve idempotency and once-only dispatch.

## Verification
- Red first: initial five real pool/store/manager retention tests failed, including
  same-account reuse after prune and renewed completed-pair TTL.
- Final: `node --test test/durable-pair-retention.test.js test/parallel-pairs.test.js
  test/durable-qa-tasks.test.js test/bot-mount.test.js`: 100/100 passed.
- Includes 8196 receipts (4097 expired complete pairs plus one unfinished pair),
  registered application identity migration and unknown-account fail-closed tests.
- Independent read-only review found no new blocker; its selected migration,
  cancellation, unknown-account, absolute-deadline and prune checks passed 7/7.
- Named staged diff reviewed; `git diff --check` and staged whitespace passed.
- Installed governance checker ran: 11 passed, 5 baseline warnings, one known
  false positive for the unchanged `onAccountCredentialsChange` callback assignment
  in the pool file. No secret literal was added; checker was not bypassed/modified.
- Ownership reclaim refused the changed branch/Change-ID against the existing
  marker; preserved the marker and worktree, no cleanup or ownership overwrite.
- Main integration owns full/build/Docker/longchain; not rerun in this follow-up.

## Rollout / Rollback
Merge the atomic follow-up into the integration candidate; no live changes here.
Revert code if needed without restoring an old task ledger or redispatching work.
