# Air admission and image startup compatibility

Change-ID: FIX-20261010-PROVIDER-AIR-ADMISSION
Base: a1e6d59
Branch: codex/FIX-20261010-PROVIDER-AIR-ADMISSION

## User Goal

Fix the two reviewed Air-only blockers: reject all ordinary/internal QA admission
during qualification maintenance, and include the reviewed public synthetic
question bank needed by Air-enabled Docker startup. No private data, real IMA
requests, credential/qualification changes, release, deployment, version or
image-publication workflow changes are authorized.

## Plan

1. Add failing synthetic HTTP tests for ordinary/internal legacy and durable
   admission, including SSE, keyed requests, preflight and recovery after the
   qualification gate clears. Keep authenticated reads and cancellation usable.
2. Implement the qualification check using existing 503/maintenance_exercise
   responses, before internal idempotency claims and task admission. Preserve
   existing exercise behavior, pool reservations and qualification consent.
3. Add a failing Docker-layout startup test with all outbound access blocked.
   Review the tracked JSONL schema/content, then copy only eval/questions.jsonl.
4. Run focused and full synthetic regressions, whitespace and governance checks;
   record evidence and commit named files in two structured atomic commits.

## Acceptance

- Qualification run/preflight blocks every QA POST, without upstream dispatch,
  context consumption, account leases or new idempotency/task receipts.
- Authentication remains first; task reads/events/cancel stay available.
- Gate clearing admits deliberately retried refused requests normally.
- Air-enabled startup succeeds in the Docker COPY layout with synthetic config,
  no private mounts and no external network or real environment reads.
- Only the reviewed public question bank is added to the image.

## Verification

Admission red-first: 16/16 new tests failed before implementation. The follow-up
unkeyed/mapped subset failed 6/6 using properly owned mapped conversations.
After implementation, all 18 qualification admission tests pass. They cover
JSON/SSE, unkeyed/keyed and extended bot asks, mapped credentials, both task
namespaces, preflight, authentication precedence, retained reads/cancellation,
POST replay rejection and deliberate retry after an authorized synthetic run.

Focused command:
`node --test --test-concurrency=4 test/bot-mount.test.js test/durable-qa-tasks.test.js test/air-admin-consent.test.js test/air-startup-acceptance.test.js test/application-identity.test.js test/task-scheduler.test.js test/slot-finalizers.test.js`
Result: 129 passed, 1 optional companion-executor test skipped, 0 failed.
No live IMA, private environment or runtime data was used.

The requested `python3 scripts/check_governance.py --ci` cannot run in this
independent Provider repository: the tracked checker is absent. Use the installed
Git governance checker with an explicit repo path and record its baseline limits;
do not add unrelated governance scaffolding or claim that gate passed.
Installed checker with `--repo` and `--ci`: 12 passed, 5 existing soft warnings,
0 hard blockers. Staged content/security and whitespace checks pass. Warnings
concern historical verification, other worktree ownership, incomplete governance
layout, legacy STATE audit metadata and the unpushed branch's absent upstream.

Docker red-first test and packaging fix remain pending for the second commit.

## Rollout And Rollback

Parent owns artifact/release/rollout acceptance. This branch is source-only.
Revert the two fix commits to roll back code; never restore old runtime snapshots
or delete ledgers, qualifications or conversation histories.
