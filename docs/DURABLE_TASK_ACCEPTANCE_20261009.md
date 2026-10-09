# Durable task final candidate acceptance

Started 2026-10-09; final container/documentation closeout 2026-10-10 (Asia/Shanghai).
Runtime source: 350bc8bdf663e963c8b7bfb0fdd597f40f6348a0.
Branch: codex/INT-20261009-PROVIDER-DURABLE. These isolated results predate the
authorized Air preview rollout below; no new Release has been published.
Documentation-only closeout commits do not change that tested runtime source.

## Verified with synthetic data

- Full Node suite: 804 tests, 798 pass, 6 optional skip, 0 fail.
- Separately enabled integrations: application identity 9/9, actual admin backend
  1/1, cross-repository history parser 10/10.
- Final native task route -> fair scheduler -> pool -> fake native HTTP: one POST,
  upstream silence 365127ms, success at 365738ms, two history messages. Viewing
  subscription rotated at 240811ms without cancelling the execution.
- Paired website 370977ms real-clock test used Provider 81f24de and website
  9adec552 before final receipt/proxy fixes; one dispatch/completion, exact text.
  Tunnel hop was local emulation, not real Vercel/ngrok.
- Pair retention/routing: 100 focused pass, 8196 synthetic receipts, incomplete
  affinity retained and completed deadlines never renewed by restart.
- Air production Node 22.22.3 artifact: actual-entrypoint and old-admin consent
  7/7 pass; five synthetic basic-qualified accounts, default one slot/account.
  Exactly three previous admin assets retained with private manifest hashes.
- Package dry run: 257 files / 2917118 bytes, no private runtime/profile/env paths.
  Clean production installs and unchanged ARM64 retry audit found zero issues.

Local image IDs (not registry digests):

| Platform | Local image | Identity |
| --- | --- | --- |
| ARM64 | provider-durable-test:20261009 | sha256:ed80d5be1849af8fa1b9a85ab812b65c6fb150a5ed3269c1584ac6319ca25ed5 |
| AMD64 | provider-durable-test:20261009-amd64 | sha256:6b17a2f6944704a6957871a03666cfa05017680fa435d6fa1cefa40e18a8d623 |

ARM64 and AMD64 isolated Nginx/BFF/Provider chain and restart passed. Each verified
replay, ownership, exact whitespace/history, stop and blocked management paths;
restarted dispatched work became indeterminate without redispatch. Both images start with
no .env, runtime or account data; AMD64 is emulated, not a performance benchmark.
The first ARM64 build hit an npm exit-handler failure; unchanged retry passed.
Fixed paired Air artifacts also passed a 2221ms short synthetic chain using
Node 22.22.3; this does not substitute the real-clock long acceptance.

## Scope and promotion gates

Application registration, account-aware dispatch, separate website/bot capacity,
old-admin compatibility and bounded paired-account recovery are integrated.
Legacy credentials preserve legacy ownership/history; independent application
fairness needs distinct private registrations. Existing Air configuration was not
changed. Current robot uses legacy asks, not the durable API. Default single-account
concurrency remains one; no real multi-account/per-account parallel test was run.

Root governance: zero failures, three pre-existing warnings. Standalone skill
scanner's unchanged callback assignment warning was reviewed as a false positive;
that scanner is not claimed all green. Named staged diffs require whitespace and
private-file checks before commit.

During the isolated phase, no account/credential read, real question, production restart, robot restart,
remote push, PR or release occurred. Fixed private Air artifact is prepared only.
Renew maintenance authorization before 3117/4318 rollout; preserve old admin UI,
five accounts, conversations and rollback code. Confirm queues idle and back up
privately first. Real long IMA question/follow-up, actual public-network recovery,
fresh desktop/mobile visual approval and phone keyboard checks remain unaccepted.
Do not claim equivalence to native IMA or publish using an existing released tag.

Rollback stops admission and drains work. Keep new histories and task journals;
never restore stale data, delete unfamiliar ledgers or reask dispatched uncertain
work. Already-pruned pair metadata from an older binary cannot be reconstructed.

## Authorized Air preview addendum, 2026-10-10

3117/4318 were updated after idle checks and private backups. Five accounts,
old admin assets, original data and legacy robot contracts remain intact. The
legacy Air website mode was explicitly set to knowledge_agent before admission
reopened. 4317, Docker website and public proxy code were not updated.

One real long first question and one serial follow-up succeeded through 4318:
312709ms and 146294ms execution, one success terminal each, exact event replay
and history, same account/session, two history answers. Viewer disconnection did
not cancel the first task; its body rendered three tables, the follow-up one.
No extra real probe was sent when an inspection transport read failed.

Those real results cover Provider 350bc8bd and website 418cbdb0. A separately
tested cooperative-parser correction (97dbb5c) addressed health-read starvation
during dense output and was subsequently installed at idle. Full Node tests,
three observer regressions and fixed-artifact startup/admin checks pass. Finished
tasks/history survive its restart without redispatch. Earlier Docker identities
above do not include this last correction; rebuild before publishing images.

Fresh browser visual/public-network acceptance remains pending. This is not
evidence of native IMA equivalence, real five-way parallel capacity, or a public
release. See the dated OPS change record for rollout and code-only rollback.
Cooperative yielding is not a throughput optimization for synchronous task
snapshot writes; profile dense-stream persistence before production load claims.
