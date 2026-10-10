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

The mounted pool now records paired exclusions synchronously with slot reservation,
including direct pool streaming and queued task leases. Two slots on one account
never satisfy two pair legs. Each leg retains its selected account; a conflicting
existing session cannot override the other leg's exclusion. Cancellation before
lease consumption removes unused reservations; release is idempotent.

Pair keys are hashes of trusted application identity, the full normalized context
binding (account/group/route and both generations), and the pair ref. Exact binding
permits distinct visitor IDs to join; absent a binding, the trusted owner is the
fallback scope. Neither raw group identifiers nor the internal pair key reach the
upstream client.

Prior paired caller parity is verified from Git code, not production traffic:
`836ebe17` and its later `a1e43e0d` version of
`apps/wechat-qa-bot/src/dual-source-retrieval.js` both pass the same
`clientIdentity: [task.account_id, task.group_id, task.sender_id]` to both legs.
`provider-a-client.js` hashes that identity into `X-IMA-Client-ID`; leg/policy are
not part of the visitor identity. The pair ref is shared, while request keys and
conversation IDs are leg-specific. These callers pass no recent-context binding,
so both legs correctly join the trusted application/owner fallback namespace.
Synthetic SSE/task tests reproduce that wire and assert one shared exclusion
record, two distinct accounts, no context consume and durable recovery. Separate
tests cover exact-binding cross-visitor requests.

Actual caller code was separately checked in release
`0ac50d7a49da0ba6a1808f58f91e0730ac4d0136c43781d8ad7e89aae3f4e001`:
`src/task-runner.js:529` constructs account/group/route/route-generation/feature-
generation binding; `:557` makes one ask with identity account/group/sender.
`src/ima/provider-a-client.js:93` serializes its body and `:201` hashes visitor
identity. There is no dual-source module and no parallel ref/leg sender in this
release's `src` JavaScript; only the capacity reader retains paired fields.
Consequently there are no two active wire legs whose bindings or visitors can be
compared in this version. Historical paired parity and current single-ask binding
compatibility are separate findings, not evidence of live paired execution.
No env, runtime data, logs, private questions or live traffic were read.

Active and incomplete pair records never expire. Only two consumed, released legs
start the five-minute cleanup period. Records are capped at 4096; no protected
record is evicted to admit a new pair, and mounted pair capacity is clamped to
remaining record capacity. Durable restart reconstructs exclusions before queued
work; unknown dispatched affinity blocks the pair. Legacy pair reservations remain
process-local, matching the previous pool contract; no new legacy replay is added.

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

`app.locals.airBotExtensionsMounted` is true only with the Web Agent provider and
a mounted bot snapshot adapter. Native/classic bot policies use their independent
qualified capacities even when the elected auto profile is blocked. Auto/web/mixed
remain gated on profile readiness. The v4 `policies` remain bot qualifications;
the additive `website` object retains the website-native mode-specific snapshot.
The bot execution ceiling uses the shared eligible-account union helper, not the
website's current native-only capacity; busy eligible slots remain in that ceiling.
The top-level website feature `knowledge_agent_keyed_sse_v1` is false in classic
website mode, but remains true in native mode even with zero accounts. It reports
contract support, not readiness. Website consumers must read `capacity.website`
when present (falling back to the legacy top-level shape), so bot qualifications
cannot become website capacity. The BFF's contract and account-capacity checks are
separate; a native empty pool is compatible with zero capacity, not incompatible.
Both nested and legacy website shapes include `mode`, resolved from snapshot mode
first and `config.webAgent.mode` second. The native capability uses that same
effective mode even when the snapshot omits it or the pool has zero accounts.

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

Durable pair recovery uses a private minimal `pairReceipt`: scoped key, pair ref,
leg, policy and observed account ID. It contains no question, context body or raw
five-field context binding and is not included in task responses. The existing
10,000-receipt store bound also bounds these records. Legacy unpruned tasks acquire
this receipt before the 24-hour input/event prune; existing registered application
identities are preserved. Account affinity is journaled even when it matches an
already-bound conversation.

Restart resolves binding/completion journals before grouping pair receipts. A
group with both legs terminal expires at its original latest `terminalAt` plus
the pool retention interval, not restart time. Expired complete groups never
enter the 4096-entry pool map. Incomplete groups retain exclusion without a TTL;
unknown dispatched account affinity blocks that pair. If unfinished groups alone
exceed the map bound, startup fails closed rather than evicting exclusions.

Independent review reproduced both the loss of exclusion after 24-hour pruning
and completed-pair TTL renewal on restart. The former normal default store held
at most 500 unpruned tasks, so a 10,000-receipt/4096-map overflow was a risk of an
unfiltered retention fix, not a demonstrated production overflow. Regression
coverage loads 8196 synthetic receipts (4097 expired complete pairs and one
unfinished pair), retaining only the unfinished group in the map.

Receipts already pruned by an older binary without pair metadata cannot be
reconstructed from a hash or conversation ID. This migration does not claim to
repair that lost information; upgrade before pruning incomplete pairs. Do not
redispatch uncertain work or restore old ledgers to manufacture missing metadata.

`test/bot-mount.test.js` uses temporary ledgers and synthetic loopback servers.
It covers auth/ownership, replay/conflict, admission/cancel, native-vs-bot mode,
JSON/SSE/task evidence, actual profile, capacity, observer safety and recovery.
No live IMA question, release process, runtime directory or credential is used.
Combined synthetic client/pool/actual-entrypoint acceptance passed on the final
candidate; see DURABLE_TASK_ACCEPTANCE_20261009.md. Real Air maintenance and IMA
acceptance remain separate gates. Existing robot calls still use the legacy API.
