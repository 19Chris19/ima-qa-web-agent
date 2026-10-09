# Durable Tasks Ordinary Authentication Alignment

- Change-ID: FIX-20261009-PROVIDER-TASK-ORDINARY-AUTH
- User-Goal: Restore the existing ordinary API authentication policy for local-demo durable tasks without bypassing configured bearer authentication.
- Base: 5841c4dd50488910b98b50462eaab8f54648acde
- Scope: ordinary task middleware and capability gate, synthetic HTTP tests, authentication documentation.
- Non-goals: credential injection, new browser authentication, internal auth relaxation, transport/scheduler edits, live calls, push or deployment.
- Change: use existing requireApiToken for tasks; capability reflects durable availability after ordinary authentication. Empty token supports local-only cookie-owned browser tasks. Configured token still requires bearer; internal token absent still returns 404.
- Acceptance: tokenless cookie POST/list/status/SSE work; foreign cookie cannot read/cancel/use owned conversation; configured cookie-only/wrong bearer return 401 and valid bearer succeeds; internal routes stay disabled without service token.
- Verification: Before implementation, tokenless regression failed because capability was false; configured bearer enforcement regression already passed. Final app/task suite passed 89 tests with 1 companion-scheduler-dependent skip (19362ms). Task suite with integrated queue/pool read-only injection passed 33/33 (10456ms). Cookie-owned POST/list/status/SSE and cross-owner rejection pass; no real IMA calls.
- Rollout: local candidate for parent integration only. Tokenless mode must remain local-only; secured built-in browser requires an authenticated proxy/client as before.
- Rollback: revert this follow-up; do not modify private task/history storage.
- Governance: diff whitespace checks and installed checker staged-index scan passed (14 checks, 3 existing soft warnings). Repository-local `python3 scripts/check_governance.py --ci` remains unavailable because the public checkout lacks the script; no unrelated bootstrap performed.
