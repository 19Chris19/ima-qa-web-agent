# Air bot overlay integration

Change-ID: FIX-20261009-PROVIDER-AIR-OVERLAY

## Scope and provenance

Built on public adapters e395501 / candidate b7c3482. The app and policy-slot
branches are integrated by their owners, not overwritten here. The controlled
release ID and initial call-site inventory are in BOT_COMPATIBILITY.md.

The following explicitly named release code was ported under `src/air/`:
`observability/exporter.js`, `observability/socket-transport.js`,
`ima-client-identity.js`, `ima-first-party-client-context.js`,
`classic-knowledge-contract-proof.js`, `knowledge-agent-qualification.js`,
`knowledge-agent-qualification-job.js`, `qualification-monitor.js`, and
`protocol-diagnostic-recorder.js`. No live module was executed. Qualification
imports now point to the isolated Air client and candidate native contract;
evaluation/report default paths were adjusted to the private package layout.

Six synthetic historical test modules came from root commit 657b5f19, with
imports redirected to this namespace. New tests exercise the actual candidate
pool factory, native/legacy client requests, config, admin HTTP, directory CAS,
five-account basic proof readiness and enrollment cancellation. All transports
are stubbed or ephemeral local synthetic HTTP; no upstream QA, credential,
account, runtime, browser profile or live endpoint was accessed.

## Startup

`IMA_QA_AIR_BOT_EXTENSIONS=true` is the explicit opt-in; default is disabled.
Existing Air variables retain their names (context, observation, diagnostic and
profile settings). `getConfig` adds only `airBot`, preserving application identity
configuration when branches are combined. Startup reads validated config; helpers
do not independently load environment files.

Both `server.js` (when enabled) and `provider-a-server.js` use one startup path.
The account-store fence precedes any account operations. Air supplies its client
factory in the **second** pool constructor argument and selects
`AirAccountDirectory` / `AirWebReadiness`. The client inherits current credential
generation and durable transport safety instead of copying the old client.
No model or profile is elected by startup and no qualification runs automatically.

The Air directory preserves legacy lane/profile fields in runtime metadata and
retains qualification evidence verbatim; it does not manufacture web probe
receipts. Valid single-request basic native proofs count, with the live deferred
age-expiry policy retained. A changed binding, disabled account, maintenance or
cooldown remains ineligible. The five-basic-account synthetic test keeps capacity
5 and performs no QA or proof rewrite. Existing generic public proofs also work.

App glue must set `app.locals.airBotExtensionsMounted = true`; missing app glue
stops Air startup before auth refresh, listening or transport start. The flag is
not evidence by itself: integrated app/pool tests must verify the hooks below.

## Exact parent interfaces

`createAirRuntime({config})` returns `null` when disabled. Otherwise:

```js
const runtime = createAirRuntime({ config });
const pool = new IMAWebAgentPool(poolConfig, {
  ...runtime.poolOptions,
  onAccountStateChange, onAccountCredentialsChange,
});
const policies = runtime.attachPool(pool, accountDirectory);
const app = createApp({ ...runtime.appOptions, config, imaWebAgentClient: pool });
```

`poolOptions.clientFactory(account)` creates the isolated client.
`poolOptions.policyEligibility(account, requestOptions)` reads the current
directory-backed account by id, then checks `requestOptions.retrievalPolicy`.
An absent policy returns true, leaving ordinary native selection to
`AirWebReadiness`. Parent must invoke this predicate during reservation,
recorded-lease consumption and legacy waiter selection. It must not migrate a
bound session to a different account. Pair references additionally require the
parent's distinct-account pair exclusion.

`appOptions` supplies:

- `botCompatibility.snapshot()` returning `{generation, profile, policyCapacity,
  laneCapacity, pairedCapacity}`. Pair capacity is a number; other capacities are
  name-to-integer maps. Generation increments on effective capability changes.
- `airPolicyCapacity`, the same provider with `eligible`, `profileSnapshot`,
  `policyCapacitySnapshot`, `laneCapacitySnapshot`, `pairedCapacitySnapshot`,
  `eligibilitySnapshot`, `qualificationAlertSnapshot` and `snapshot` methods.
- `recentContextConsumer.consume(ref, {binding, signal})`, single-use/no retry.
- `observation.recordState(entry)` / `.sample(entry)` and other exporter methods;
  app/queue call sites must isolate telemetry failures.
- `qualificationMonitor.snapshot()`. The historical runtime disables autonomous
  qualification-age alerts; no new timer or probe is enabled here.

`profile` is `{answer_profile, profile_generation, capability_digest, ready}`.
Native `knowledge_agent` validates the native contract digest separately from
classic profile metadata. Group knowledge requires its classic policy proof;
auto/web/mixed require the configured ready auto profile and matching policy
proof. No unsupported profile is made ready and no unproved policy is advertised.

After creating the app/exercise manager, `runtime.attachApp(...)` creates one
qualification manager, assigns `app.locals.knowledgeAgentQualificationManager`,
registers authenticated qualification/eligibility/lane routes and adds the
qualification field to the existing admin bootstrap response. Parent admission
must check `isMaintenanceActive()` for both legacy and durable requests.
`runtime.start()` starts only opt-in observation; `runtime.close()` shuts it down.

## Client and execution contract

- Candidate `mode`, model, transport timeouts, activity and dispatch callbacks
  are retained. Native uses the existing version-coupled native headers and
  native request builder, not an auto-profile substitute. Native still has a
  classic profile carrier; these are separate concepts.
- Explicit mode/policy or existing session/profile conflict rejects before QA;
  `prepareBotAsk` now rejects before consuming context, never clears affinity.
- Session and account bindings are preserved. The old expired-session replay
  and speculative knowledge-first second QA are intentionally not restored.
- `answerProfile` is attached to emitted normalized events and `onSession`
  metadata. Parent must persist it without overwriting recorded mode/account.
- L0 augmentation occurs once. Parent may build a prompt plan itself (pass the
  result question, originalQuestion, and no recentContext), or let Air client
  build it (pass raw question + recentContext and onRecentContextPlan). Never both.
- Context-augmented prompts are bounded to 18,000 characters; the validated
  original question is kept separately for title/history. The old profile
  builder's 2,000-character ordinary question guard must not truncate L0.
- Context cache is scoped by account/credential fingerprint and caller abort;
  it no longer shares device context across unrelated accounts.

## Admin and qualification behavior

Preserved routes: qualification bootstrap/active/list/report/start, per-account
qualification and `GET /api/admin/v2/accounts/eligibility`; live routing-lane
mutation uses PUT. Explicit DELETE qualification cancellation is additive.
Existing base enrollment/exercise/account routes stay owned by their modules.
Only fixed error categories leave the extension routes.

The qualification manager retains exact confirmation/request budgets, current
candidate digest checks, maintenance exclusion, per-request cancellation,
bound proof commits and sanitized report persistence. Basic requires one request;
advanced is one smoke plus six scenarios and is never required for an existing
valid basic account. Existing enrollment's declared one-request consent drives
basic qualification; advanced qualification remains an explicit admin action.
Run identifiers use `runId`; cancellation is mapped to the exact pending account
run and post-commit receipts/warnings survive downstream sync failure.

## Verification and rollout boundary

Isolated full suite before the final readiness-state adjustment:
`node --test --test-concurrency=4`, 692 passed, 5 skipped, 0 failed out of 697
tests (94.03 seconds). Final focused suite after that adjustment: 46 passed,
0 failed. Proof qualification is independent of temporary availability; eligible
capacity includes busy slots, while schedulable capacity counts free slots.
All tests used synthetic inputs.
The factory, existing basic-proof readiness, profile-conflict and policy-proof
review items have implementation and regression coverage in this branch.
Staged whitespace passes. Governance's sensitive-content rule flags unchanged
startup/config expressions, verified against HEAD, rather than literal secrets;
the nonzero checker result and baseline warnings are recorded in the change log.

This branch prepares code only. Parent must combine app bot glue and policy-slot
callbacks, run the combined full suite and synthetic mount test, then perform
separate controlled image acceptance. No live rollout, restart, credential read
or real question is authorized or claimed. Rollback: disable the opt-in and
revert this commit; do not remove or rewrite stored evidence.
