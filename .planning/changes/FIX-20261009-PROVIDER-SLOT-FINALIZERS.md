# Slot finalization fault boundaries

Cancel during synchronous reservation must release the acquired slot once and
must not dispatch or remove another queued task. A failed availability observer
must not block other observers. Legacy reservation persistence failures reject
the affected waiter instead of stranding it.

Verification: three of four new synthetic assertions failed before the fix.
All 46 slot, scheduler and pool regressions passed after implementation. No live account
or upstream request is used.

Rollout: isolated candidate only. Rollback: drain tasks and revert code, retaining
new task, account and conversation data.
