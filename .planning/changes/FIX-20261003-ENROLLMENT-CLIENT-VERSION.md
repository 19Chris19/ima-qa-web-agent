# Fresh enrollment client-version compatibility

- Diagnosis: native session initialization failed locally with knowledge_agent_cookie_version_missing before any HTTP dispatch. Fresh captured browser cookies need not contain WEB-VERSION.
- Fix: append only the declared client version when absent, while retaining existing auth validation and duplicate-version rejection. Do not mutate stored credentials.
- Verification: synthetic header tests, full serial suite, then one authorized serial qualification probe. Never record question, response or credentials in Git.
- Rollback: restore previous image without overwriting runtime volumes. This change is separate from the maintenance-browser transport.
- Result: 265/265 serial tests passed. Deployed only to Docker lab 3317 using air-provider:enrollment-version-fix. One authorized real qualification returned ok, qualified=true and knowledge-agent capacity=1. The probe requires one dispatch, one success terminal, nonempty text and knowledge sources. No real answer was logged or committed; ordinary website first-turn/follow-up acceptance remains separate.
