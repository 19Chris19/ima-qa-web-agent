# Durable QA candidate handoff

As of 2026-10-09, branch codex/INT-20261009-PROVIDER-DURABLE is an isolated
candidate, not a deployed or published release. Runtime source: 866b731.

Implemented: durable owned tasks, sequenced replay, explicit cancellation,
restart uncertainty, idempotent history commit, native task transport, account
slots and generic UI task observation. Legacy interfaces remain available.

Verification: 632 passed / 5 optional skipped; final paired synthetic run
370717ms; ARM64 Docker chain and restart checks passed. No real IMA probe.

Remaining before full plan acceptance:
- Replace route-class fairness with trusted per-application deployment identity.
- Avoid consuming global dispatch slots while waiting for a pinned account.
- Reconcile Air's installed bot extensions before selecting a runtime candidate.
- Renew maintenance authorization before shared Provider or website cutover.
- Verify actual public proxy/network recovery, screenshots, and authorized real
  long question/follow-up. Synthetic results are not native IMA equivalence.
- Review and publish compatible paired releases/images only after those gates.

Keep branches, task ledgers and new histories. Never roll back by restoring an
old data snapshot or automatically resubmitting dispatched uncertain work.
