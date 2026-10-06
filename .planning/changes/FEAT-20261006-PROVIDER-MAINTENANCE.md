# Scheduler-backed maintenance status

User-Goal: Show real maintenance timing and distinguish knowledge eligibility from general web health.
Baseline: 0db3fc2, candidate only.
Implementation: bounded non-overlapping renewal scheduler; additive authenticated management fields.
Verification: full synthetic suite 295/295 passed; three additional scheduler/persistence lifecycle tests passed afterward (7/7 timer tests total). No real IMA traffic. Root governance: zero failures, three pre-existing warnings. Dependency audit finding is tracked separately.
Rollout: isolated candidate only; runtime Provider compatibility audit required before deployment.
Rollback: revert this feature without changing account or conversation stores.
