# Durable Task Lifecycle Follow-up

- Change-ID: FIX-20261009-PROVIDER-TASK-LIFECYCLE
- User-Goal: Close integrated deletion and diagnostic-fidelity gaps without changing live services or exposing private upstream content.
- Base: bf58c898d080f7a93352232114fa28a8e8ca137a
- Scope: core app/task modules, focused synthetic tests and task API documentation. Client/transport/scheduler changes remain separately owned.
- Non-goals: auth redesign, UI changes, live requests, credentials, runtime, push or deployment.
- Review: read-only integrated tests passed 40/40. Synthetic HTTP repro confirmed queued conversation deletion returned 200 then accepted task failed execution_failed; active deletion returned 409 and foreign-owner deletion 404. Also confirmed same-conversation ordinary/internal accepted tasks could collide because scheduler lanes include scope. No cross-owner/scope read leak observed. onDispatch is synchronous before native QA POST.
- Implementation: owner-first deletion guard checks persisted unfinished tasks across both scopes, including recovery backlog and pending journals; unavailable configured durable storage fails closed. Empty successful upstream task answers fail explicitly without fabricated history. Fixed allowlist preserves safe protocol/transport failure reasons. Raw-byte activity callback updates separate metadata from normalized events.
- Acceptance: regressions must fail before fixes and pass afterward; no bearer or service auth relaxation; no question/answer/error text in diagnostics; no dispatch from refused deletion/cancelled queued work.
- Verification: Initial deletion regressions failed 200 vs expected 409/503; initial empty-answer/failure-reason/raw-activity regressions all failed as expected. App/history/idempotency/task suite passed 98 tests with 1 companion-scheduler-dependent skip (14746ms). Task suite with integrated scheduler/pool loaded read-only into the process passed 31/31 (5285ms). Raw activity is tested through the injected client callback; native heartbeat-only delivery still requires the separately owned transport hook. No live calls.
- Rollout: local follow-up candidate for parent integration, alongside separately owned transport activity hook. Offline validation only.
- Rollback: revert follow-up commit; preserve private task and conversation storage.
- Remaining review issue: cross-scope conversation lane collision requires scheduler or admission policy coordination. Built-in UI tokenless browser access and configured ordinary bearer routes need an explicit auth-contract decision; this follow-up does not relax auth.
- Governance: `git diff --check` passed. Required `python3 scripts/check_governance.py --ci` exits 2 because this public checkout has no such script; not claimed green. Installed governance checker against the staged index passed with 14 checks and 3 existing soft warnings. No unrelated governance bootstrap or integration checkout edits.
