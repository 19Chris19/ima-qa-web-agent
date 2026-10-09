# Durable QA candidate handoff

Current release preparation: docs/RELEASE_ACCEPTANCE_20261010.md. Draft PR #14
is not merged/published/deployed. Following runtime references are dated evidence,
not a claim that the new RC runs on Air.

As of 2026-10-10, branch codex/OPS-20261010-PROVIDER-DURABLE-PREVIEW records an
authorized Air preview rollout, not a published release. Earlier verified runtime: 866b731.
That earlier acceptance is historical evidence, not the latest code.

Implemented: durable owned tasks, sequenced replay, explicit cancellation,
restart uncertainty, idempotent history commit, native task transport, account
slots and generic UI task observation. Trusted application registration, runnable
account reservation, cancellation finalizers and early profile binding are
integrated. Air startup, separate website/bot capacity, old-admin consent and
bounded paired-account recovery are integrated and synthetically verified.
Legacy interfaces remain available; the robot's legacy asks do not become
durable merely because the new task API exists.

Historical verification: 632 passed / 5 optional skipped; paired synthetic run
370717ms; ARM64 Docker chain and restart checks passed. New round: real-clock
371075ms chain passed before Air glue, identity 9/9, slot finalizers 46/46,
profile/policy pool tests 24/24. Final runtime source: 350bc8bd.
Complete suite: 798 pass / 6 optional skip / 0 fail; optional identity 9/9,
admin backend 1/1, cross-repository history 10/10 passed separately.
Final native task/queue/pool/HTTP real-clock test: 365738ms, upstream silent
365127ms, one POST, succeeded, exactly two history messages. The paired website
370977ms run used Provider 81f24de / Explorer 9adec552 before the final bounded
pair receipt and safe proxy-error follow-ups. Pair retention tests: 100/100,
including 8196 synthetic receipts and non-renewing restart deadlines.
No real IMA probe was used for the isolated evidence above.
Final ARM64/AMD64 image builds, isolated Nginx/BFF/Provider chain and restart
recovery passed. Image identities: docs/DURABLE_TASK_ACCEPTANCE_20261009.md.
Private image paths absent; fixed paired Air artifact short chain passed 2221ms.
Only synthetic test containers were stopped; their volumes remain retained.

Authorized preview update: 3117 now runs fixed 97dbb5c with old admin assets;
4318 runs 418cbdb0. Five accounts/capacity five and original private data preserved.
Legacy Air native website mode is explicitly retained as knowledge_agent.
Real first task succeeded in 312709ms; follow-up in 146294ms, same account/session,
exact replay/history, one success each and two history turns. Viewer disconnect
did not cancel. Dense stream health starvation prompted independent 97dbb5c fix;
three focused regressions, full suite and fixed-artifact startup tests passed.
After its idle rollout completed tasks/history remain unchanged. No extra real
probe or new container build covers the final small yield patch.
Old admin hashes match, unauthorized management routes remain blocked, gates OPEN.
Robot job was not loaded initially and was neither started nor restarted.
4317/4417/public code unchanged; legacy clients do not inherit task reconnection.

Remaining before full plan acceptance:
- Legacy credentials remain legacy groups; per-deployment fairness requires
  distinct private registrations. Existing Air keys were not reconfigured.
- Verify actual public proxy/network recovery and fresh authorized screenshots;
  true phone keyboard/long-term behavior is not proven by API or DOM checks.
- Rebuild/recheck final yield-patch images before registry publication. Earlier
  platform evidence remains tied to 350bc8bd. Do not claim native IMA equivalence.
- Profile per-event persistence throughput before a production load claim;
  cooperative yielding improves responsiveness, not disk-write complexity.
- Review and publish compatible paired releases/images only after those gates.

Keep branches, task ledgers and new histories. Never roll back by restoring an
old data snapshot or automatically resubmitting dispatched uncertain work.

## Source-only Air compatibility follow-up

Change-ID: FIX-20261010-PROVIDER-AIR-ADMISSION
Branch-At-Audit: codex/FIX-20261010-PROVIDER-AIR-ADMISSION
Audit-HEAD: 71a2ed7
Audited-At: 2026-10-10

This follow-up starts at a1e6d59 and does not update the historical preview above.
Commit 46d70b1 rejects all ordinary/internal legacy and durable QA POSTs during
Air qualification run/preflight, using existing maintenance responses before
dispatch and receipt admission. Reads/events/cancellation, pool concurrency,
authentication, consent and account qualification writes remain unchanged.
Focused admission/task/ownership/finalizer regressions: 129 pass, 1 optional skip.

The source packaging fix copies only the reviewed public 50-question JSONL,
without versions, image-publication workflows or private data. Serial real
entrypoint/COPY-layout/image tests: 8 pass; both children exit via SIGTERM;
Provider/upstream listeners close and queue/leases return to zero. Native Docker
artifact acceptance is NOT RUN here. Four-worker and single-worker full runs
each report 820 pass, 1 fail, 6 skip. The serial failure is the existing exercise
response-copy assertion, corrected in separate commit 71a2ed7; original exercise
and qualification regressions now pass 19/19. Final concurrency-2 affected-module
check: 191 pass, 1 optional skip, 0 fail (24.22 seconds), including app, admission,
task ownership/recovery/cancellation, startup/image, consent and slot finalizers.
Parent owns merged full tests, image builds, release and rollout. Details and
disclosed limits are in the change record; no deadlines were extended.
