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
   record evidence and commit named files in structured atomic commits. Keep
   any full-suite compatibility correction separate from the image payload fix.

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
Subsequent named-file staging checks: 13 passed, 4 existing soft warnings, 0 hard
blockers; staged content/security and whitespace pass. Added STATE audit metadata
clears its earlier metadata warning. The native repository checker is still absent.

Admission implementation is committed as `46d70b1`.

Docker red-first: two new tests failed before the COPY fix. The real Air
entrypoint in the materialized Docker COPY layout exited with ENOENT for
eval/questions.jsonl before listening; the packaging assertion also failed.
After adding only that file, both tests pass. All 50 tracked records were reviewed:
generic public 3DGS questions only, with empty source-hint, answer-point and
must-not-invent arrays, no identities, credentials or real conversation data.
Reviewed SHA-256:
`e9353b32e5caf4845673d88e26b5fb2343bc67909d9563323b5d86382717c56b`.
The test pins this hash and exact schema/content constraints; the JSONL itself
is unchanged. No directory-wide eval COPY is allowed.

Serial acceptance:
`node --test --test-concurrency=1 test/air-startup-acceptance.test.js test/image-release.test.js`
Result: 8 passed, 0 skipped, 0 failed (10.52 seconds). Source and COPY-layout
children both exit with code null / signal SIGTERM, without forced SIGKILL.
The five-basic-proof test closes both HTTP listeners, leaves activeRequests=0
and accountLeases=0, with blockedConnections=0. No timeout was increased.
This is tracked COPY-layout acceptance with existing dependencies, not a native
Docker image build. No container build, real IMA or private-data access occurred.

First full run: `npm test -- --test-concurrency=4`, 820 passed, 1 failed,
6 skipped (206.47 seconds). Captured aggregate does not establish the failing
test's identity or cause; do not attribute it to load or claim a green full run.
Parent separately reported baseline parallel startup/shutdown/task deadlines.
Parent subsequently reported a complete baseline run at concurrency 2 passing;
this is not verification of these unmerged patches or a published artifact.
The isolated serial startup result above passes without extending deadlines.
Single-worker full result: 820 passed, 1 failed, 6 skipped (367.44 seconds).
The failure is the original capacity exercise error-copy assertion at
test/app.test.js:226, not Air startup or shutdown. The initial admission commit
changed that copy. Commit `71a2ed7` restores it verbatim while retaining the
qualification message and gate; the original exercise plus 18 qualification
regressions pass 19/19. No test expectation or timeout changed. See the separate
FIX-20261010-PROVIDER-EXERCISE-COMPAT change record. The first four-worker failure
cannot independently be attributed from its aggregate alone.
No full suite is rerun after that correction here: parent owns the merged
concurrency-2 full suite and final dual-architecture artifacts. A final affected
module regression at concurrency 2 passed:
`node --test --test-concurrency=2 test/app.test.js test/bot-mount.test.js test/air-startup-acceptance.test.js test/image-release.test.js test/durable-qa-tasks.test.js test/air-admin-consent.test.js test/application-identity.test.js test/task-scheduler.test.js test/slot-finalizers.test.js`
Result: 191 passed, 1 optional companion-executor skip, 0 failed (24.22 seconds).
Both entrypoint children exit via SIGTERM; both listeners close, active requests
and account leases return to zero, and blockedConnections=0. No image builds
were started. The final source-only history has admission, exercise-copy
compatibility and image-payload commits, each independently revertible.

## Rollout And Rollback

Parent owns artifact/release/rollout acceptance. This branch is source-only.
Revert the image and admission fixes and their compatibility follow-up to roll
back code; never restore old runtime snapshots
or delete ledgers, qualifications or conversation histories.
