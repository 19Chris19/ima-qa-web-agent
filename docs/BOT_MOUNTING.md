# Air Bot Route Mount

The shared app mounts bot support only when startup supplies `airPolicyCapacity`
or an explicit `botCompatibility` adapter. No module is loaded from a live release,
no credentials are read by this adapter, and ordinary/internal authentication and
trusted application ownership remain the existing middleware's responsibility.

## Startup Interfaces

Air startup may pass its existing `appOptions` unchanged:

```js
createApp({
  ...baseOptions,
  recentContextConsumer,
  observation, // observationExporter is also accepted; sample(event) is optional
  qualificationMonitor,
  airPolicyCapacity,
});
```

The capacity object provides synchronous `profileSnapshot()`,
`policyCapacitySnapshot()`, `laneCapacitySnapshot()`, and
`pairedCapacitySnapshot()` (the latter returns `knowledge_web_parallel`). The
app derives a positive generation that advances when those public facts change.
Optional boolean `features` are retained alongside authoritative website features.
Startup and pool owners must mount policy-qualified account selection; merely
injecting capacity is not permission to route through unqualified accounts.

Alternative explicit `botCompatibility` injection:

```js
{
  snapshot: () => ({ generation, profile, policyCapacity, laneCapacity,
    pairedCapacity, features }),
  resolveKnowledgeScopeRef: ({ applicationKey }) => trustedScopeDigest,
  healthCapabilities: { /* sanitized declarations of mounted contracts */ },
}
```

`profile` contains `answer_profile`, `profile_generation`, `capability_digest`,
and `ready`; each policy/lane capacity is a nonnegative integer, not inferred
from total slots. Without the optional scope resolver the existing server-side
KB configuration supplies its SHA-256 digest. No request field selects a trusted
scope or application identity. Absent/invalid readiness fails closed. Empty
policies remain unavailable. Pair capacity is bounded separately from total slots.

`healthCapabilities` is also an app option for sanitized existing capability
declarations. Recent-context v1/v2 is advertised only with the bot adapter and
consumer mounted. The qualification capability is added when startup registers
the actual qualification manager on app locals. The injected monitor supplies
its public snapshot. No v3 context support is inferred.
Health retains numeric `policyCapacity`, `recentContext.enabled/contracts`, and
the mounted qualification declaration both at top level and under `capabilities`.

## Native and Bot Requests

Native-only `knowledge_agent`, `knowledge_scope_ref`, and `source_intent`
requests keep the previous native validation, key acceptance, mode and exact
Chinese web-intent suffix. Bot global profile readiness does not gate this path.
Extended bot fields (including context binding, decision digest and paired legs)
or `auto/group_knowledge/web/mixed` opt into bot validation and a required 64-hex
idempotency key. Ordinary routes reject every internal field, even empty ones.

New extended `knowledge_agent` conversations use native mode; the other bot
policies use `classic_knowledge`, regardless of the server's default native mode.
Existing incompatible modes/profiles return a conflict without clearing affinity.
Actual client `answerProfile` on any event determines evidence. Session profiles
come only from observed callbacks/session events and persist with upstream binding;
old journals without a profile remain readable and do not acquire a guessed one.

## Execution and Evidence

Original question plus the normalized full bot contract, including all five
context-binding fields, is fingerprinted before execution. Legacy receipts are
never reinterpreted or repaired by replaying an uncertain request. Completed
durable replay and event subscription do not consume context again.

Single-use context is consumed only inside admitted execution after a runnable
account slot has been acquired. App glue augments the upstream question once and
passes `originalQuestion`, routing fields, recorded mode and account lease. It
does not pass the raw recent-context payload to the client for a second injection.
The original question, never the augmented prompt, is saved in history.

Actual source kinds and the actual injected prompt plan determine done/history
evidence. L0 message counts do not increase retrieved document counts. Policy
evidence must pass before success. Valid L0 bundles and observed session profiles
survive completion journals and history reload. Task answers retain exact raw
whitespace and long content. Legacy `appendTurn` trimming/8000-character limits
are unchanged; this change does not claim unlimited legacy answer fidelity.

The observer receives only fixed lifecycle/protocol fields, no question, context,
owner, group binding, account ID or credentials. Observer failures cannot change
QA outcome. Transport start/close and qualification/admin lifecycle remain startup
responsibilities; this module does not start a background service.

## Verification Boundary

`test/bot-mount.test.js` uses temporary ledgers and synthetic loopback servers.
It covers auth/ownership, replay/conflict, admission/cancel, native-vs-bot mode,
JSON/SSE/task evidence, actual profile, capacity, observer safety and recovery.
No live IMA question, release process, runtime directory or credential is used.
Air client/pool/startup acceptance remains a combined integration test gate.
