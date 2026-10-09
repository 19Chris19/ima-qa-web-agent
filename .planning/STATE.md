# Durable QA candidate handoff

As of 2026-10-10, branch codex/INT-20261009-PROVIDER-DURABLE is an isolated
candidate, not a deployed or published release. Earlier verified runtime: 866b731.
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
No real IMA probe.
Final ARM64/AMD64 image builds, isolated Nginx/BFF/Provider chain and restart
recovery passed. Image identities: docs/DURABLE_TASK_ACCEPTANCE_20261009.md.
Private image paths absent; fixed paired Air artifact short chain passed 2221ms.
Only synthetic test containers were stopped; their volumes remain retained.

Remaining before full plan acceptance:
- Fixed Air artifact is prepared, not deployed; production Node 22 startup and
  old-admin consent tests passed 7/7. Only three named old admin assets are overlaid;
  the private manifest records their hashes. No runtime data or credentials copied.
- Legacy credentials remain legacy groups; per-deployment fairness requires
  distinct private registrations. Existing Air keys were not reconfigured.
- Renew maintenance authorization before shared Provider or website cutover.
- Verify actual public proxy/network recovery, screenshots, and authorized real
  long question/follow-up. Synthetic results are not native IMA equivalence.
- Review and publish compatible paired releases/images only after those gates.

Keep branches, task ledgers and new histories. Never roll back by restoring an
old data snapshot or automatically resubmitting dispatched uncertain work.
