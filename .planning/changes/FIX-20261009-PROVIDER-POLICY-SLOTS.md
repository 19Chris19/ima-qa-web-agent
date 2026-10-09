# Preserve policy-qualified account dispatch

Goal: Air bot retrieval policy must use the same eligible account at reservation
and execution, while native website mode and account affinity remain unchanged.

Add an injected server-only policy predicate to the shared pool; no account,
credential or policy implementation is copied into its scheduler. Verify native
and legacy slot selection, pinned rejection and state change before execution.
Verification: four new assertions failed before implementation; all 41 policy,
pool, scheduler and runnable-slot tests passed after implementation. No real
upstream or credential state was used.

Rollout: isolated candidate only; no live configuration or requests.
Rollback: drain and revert compatible code; retain task/session/account data.
