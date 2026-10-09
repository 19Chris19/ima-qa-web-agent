# Trusted Provider Application Identity

- Change-ID: FEAT-20261009-PROVIDER-APPLICATION-IDENTITY
- User-Goal: Bind maintainer-managed credentials to stable application identities, isolate visitors/conversations/tasks/idempotency by application and preserve identity through credential rotation.
- Base: b7c3482
- Scope: configuration, application auth/owner identity, task route/store identity, legacy queue keys, synthetic tests and documentation.
- Non-goals: queue/pool/task-executor edits owned by parent, real credentials, live services, IMA traffic, deployment or push.
- Contract: IMA_QA_APPLICATIONS_JSON contains unique application IDs with explicit ordinary/internal token arrays. Duplicate/invalid mappings fail closed. Requests cannot choose application via headers/body. Same application may have both credential types; route scopes still gate operations. Unmapped legacy single credentials and tokenless builtin retain existing owner space; old task receipts gain their original scope identity without state transitions.
- Integration: tasks.submit/cancel receive applicationKey; store owned/list/find accept optional trailing applicationKey; store.create accepts applicationKey. Parent owns forwarding through durable executor and resource reservation. Legacy queue callers receive trusted application/visitor/conversation keys.
- Risks: stable IDs must not be reassigned; removing all ordinary security still leaves legacy local-only builtin accessible. Existing legacy data cannot be silently adopted by a newly named deployment.
- Verification: full offline suite passed 639 tests with 6 optional skips, zero failures (90338ms). After the final middleware injection cleanup and migration fault regression, focused app/config/task/identity suite passed 123 tests with 1 integration opt-in skip (16528ms). With the parent runnable-slots executor loaded read-only into this process and this branch's store, all 9 identity tests passed including full task HTTP and scheduler identity (1492ms). No real IMA requests.
- Rollout: offline candidate only; parent integrates disjoint changes and runs combined validation.
- Rollback: revert code while preserving private ledger/history. Do not downgrade to code that ignores application-qualified owners.

## Handoff and Governance

- Store signatures match parent integration: find argument five, owned argument four, list argument five, create.applicationKey; routes pass submit.applicationKey and cancel argument four. Parent still owns durable executor/reservations and app lease plumbing. Those files were not edited here.
- Mapped keys use application:<id>. Legacy single tokens and builtin retain ordinary/internal keys and old owner namespace. Mapped credentials do not silently adopt old legacy histories.
- Dependencies were reused through a local-only ignored node_modules symlink. No dependency manifests, live configuration, credentials or runtime data changed.
- Named files only staged; diff whitespace checks pass. Required repository-local scripts/check_governance.py is absent (exit 2). Installed checker reports src/config.js JavaScript environment-reader expressions as sensitive assignments; baseline and staged contain the same 9 expression matches and no actual credentials. This heuristic result is not claimed green. No checker bypass or unrelated governance bootstrap was added.
