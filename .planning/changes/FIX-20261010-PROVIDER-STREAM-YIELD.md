# Cooperative parsing for dense upstream streams

Goal: keep health, subscription recovery and explicit stop responsive while a
durable task persists a dense burst of upstream events. Do not change text,
ordering, terminal validation, timeout policy or the durable write-before-send
rule. No additional real IMA requests are authorized by this fix.

Evidence: authorized Air preview first question and follow-up succeeded, but
health reads timed out during dense streaming and recovered after completion.
Process sampling showed upstream callbacks/microtasks and structured cloning,
not an idle network wait. This establishes a responsiveness risk, not proof of
all previously reported mobile failures.

Scope: bound uninterrupted parsing work with an event/time budget and yield to
the Node event loop. Test dense semantic and control frames, exact output,
unique terminal and a concurrent local HTTP observer before completion.

Rollout: isolated tests first; idle authorized 3117/4318 preview only, retaining
old admin assets, all account/history data and existing robot configuration.
Rollback: drain tasks and switch compatible fixed code; never restore old data.

Verification: both parser observer regressions failed before the fix and passed
after it. Three focused tests pass, including native HTTP -> durable per-delta
persistence with a concurrent health observer before completion, one dispatch,
exact history and one success terminal. Existing client/transport/task focused
suite passed 57 tests before adding the third integration test. Full Node test
suite passed (exit 0); optional long-clock/desktop gates retain their documented
skip policy. No additional real IMA question was sent for this patch.

Status: isolated verification complete; fixed artifact preview rollout pending.
