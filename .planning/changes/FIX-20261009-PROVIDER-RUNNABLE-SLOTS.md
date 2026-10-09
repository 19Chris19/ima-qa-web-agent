# Account-aware runnable scheduling

User goal: preserve long task ownership while sharing every usable account slot.
Pinned follow-ups must wait for their original account without consuming global
execution capacity or migrating context. One slot per account remains default.

Implementation: reserve an account synchronously at the fair scheduler's runnable
selection boundary; pass the private lease into execution; release exactly once
on every outcome. Pool availability wakes queued selection. Non-pool clients and
legacy interfaces preserve their existing execution semantics.

Verification: synthetic blocked account/free account, cancelled reservation,
same-lane FIFO, cross-application fairness, state changes, task/history recovery.
No account data, live requests or production runtime changes.
Focused verification: 50 scheduler/durable assertions passed. The real HTTP
application test confirmed a pinned task remains queued while another account
completes, preserving original session, exact whitespace and one history turn.
Explicit upstream mode propagation also prevents a native task from falling
back to the client's classic-mode default; model selection is unchanged.
Independent review found and repaired reentrant capacity updates, lost wakeups,
rejected same-lane heads and exceptional lease cleanup. The final focused
scheduler suite passed 20 tests. Cleanup failure counts are sanitized queue
diagnostics; failures do not strand unrelated work. Reservation persistence
failure rolls back in-memory occupancy. Temporary maintenance waits, rather
than being interpreted as permanent loss of qualification.

Rollback: drain tasks before reverting the compatible runtime pair; preserve
task journals, sessions and account data.
