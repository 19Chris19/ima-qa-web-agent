# Air shared queue capacity

`providerAExecutionCapacity({ pool, webReadiness, airPolicyCapacity })` returns
the shared execution ceiling. With Air mounted, it uses the actual pool-backed
accounts exposed by `AirPolicyCapacity.accounts()`, evaluates existing policy
eligibility, and counts each eligible account's `maxConcurrent` once. It does not
sum overlapping policy capacities or count accounts instead of slots.

Busy slots remain part of the ceiling; reservation decides which work can run
now. Disabled, maintenance and cooling accounts are excluded. Native eligibility
also respects the pool's website readiness check. Existing classic website
accounts remain usable independently of bot proofs, preserving that route's
behavior. No proof, policy or website mode is changed by this calculation.

Provider startup passes `airPolicyCapacity` into queue synchronization. Native
website capacity must not be reused as the global ceiling: a native-ineligible
account can still have valid classic/web bot eligibility. Per-policy capacity
and native website readiness remain separate API facts; the helper does not
change those response shapes.

Without Air, synchronization keeps the existing website readiness/pool fallback.
Explicitly fixed concurrency remains fixed. Synthetic tests use real pool,
Air readiness, policy and queue instances with fake upstream clients; they do
not access IMA or establish release readiness. Parent integration owns final
full-suite and Docker verification.
