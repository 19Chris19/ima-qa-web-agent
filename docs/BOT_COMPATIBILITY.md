# Air bot extension compatibility review

## Status and evidence boundary

Prepared against candidate `b7c3482`, branch
`codex/FIX-20261009-PROVIDER-BOT-COMPAT`, on 2026-10-09. This is **not a
mounted runtime or a release approval**. No live HTTP requests, questions,
credential/account/runtime reads, process inspections, restarts or deployments
were performed. Only named JavaScript source files in the supplied immutable
release and tracked Git history were read. No live module was imported.

Release identifier:
`88cfcc1e9406b090b855c2f6cb22528cec2a516394c0cda19d49154d716030e0`.
Paths below are relative to that release's `apps/ima-qa-web` directory.

| Controlled code file | SHA-256 |
| --- | --- |
| `server.js` | `7e5202490ab8d28c7035e160aa154d593b39daea7c819fba1d0ac2d277490393` |
| `src/app.js` | `8773e0e239fd4616c650ccbed1bd3ede99a1c910b6973897e5eddfa9173baf2c` |
| `src/config.js` | `5ea4489123deb1d7b774e02a9edcf5e2d777c6eb1a8960438b7a1b073ea63b06` |
| `src/recent-context-client.js` | `b3682448abc9ed74c46ed102d71cef23d4338066e5e4137d0163258815532c51` |

Also inspected named `admin-routes.js`, `provider-a-capacity.js`, and exported
class names in first-party context, qualification and observation modules.
These code fingerprints do not prove which process or environment is active.

Root-repository history anchors (not interchangeable with the live snapshot):

- `d09b124e`: Provider answer continuity and idempotent bot requests.
- `3e45c46c`, `60cf1f1e`: source policy and fenced recent context.
- `5a675cbe`: paired knowledge/web legs.
- `83eaa2b6`: pass all five group-binding fields to consume.
- `556dd93f`: validate byte counts before NFKC normalization.
- `c614ed71`: v2 context capacity/evidence, bounded prompt selection.
- `657b5f19`: newer on-demand context/v3 history. The inspected live code
  declares only v1/v2 and rejects v3; this preparation does not advertise v3.
- `7f81ecea`, `245e5853`, `6dee0aa4`: qualified knowledge routing and startup
  qualification integration. Do not restore old pool/scheduler internals.

## Required wire contracts

| Surface | Behavior that must survive integration |
| --- | --- |
| `GET /internal/provider-a/capacity` | Separate internal auth; no-store. Bot requires snake-case versioned contract and profile/policy fields, not just website `schemaVersion: 1`. |
| `POST /internal/provider-a/deep-ask` | Internal service auth, 64-hex `Idempotency-Key`, stable authenticated application plus client ownership. SSE conversation/sources/delta/done/error; no automatic replay of dispatched uncertain work. |
| `POST /api/ask` | Ordinary auth policy stays distinct. Reject internal retrieval fields and raw KB identifiers. Do not allow caller-controlled fields to elevate identity. |
| `POST/GET /api/conversations`, `GET/DELETE /api/conversations/:id` | Preserve caller ownership, original question/history and upstream-session continuity. A native expired session must not be silently recreated. |
| `GET /healthz` | Live exposes recent-context contract versions, knowledge-agent qualification capability, policy capacity and optional qualification monitor. Advertise these only after their implementation is mounted. |
| `POST /api/admin/accounts/:accountId/qualification` | Admin-only qualification start; maintenance admission and account eligibility must be honored. |
| `/api/admin/qualifications/{bootstrap,active,reports,reports/:reportId}` | GET surfaces plus POST `/api/admin/qualifications`; sanitized reports and qualification lifecycle. |
| `GET /api/admin/v2/accounts/eligibility`, `GET /api/admin/bootstrap` | Preserve eligibility and qualification bootstrap metadata if deployed management clients depend on them. |
| Enrollment/account/exercise routes | Existing admin auth and enrollment identity/preflight/continue/cancel controls must remain. Do not replace them with public bot routes. |

The historical bot at `657b5f19` accepts capacity schemas
`provider.a.capacity.v1` through `.v4`. For v4 it validates positive generation,
`max_concurrent`, ready consistency, `active`, `queued`, `answer_profile`,
`answer_profile_ready`, `profile_generation`, 64-hex `capability_digest`,
five policy entries and `paired_capacity.knowledge_web_parallel`. Policies are
`knowledge_agent`, `auto`, `group_knowledge`, `web`, `mixed`; each has
`ready` and `max_concurrent`. Keep website camel-case metrics/features alongside
these fields. Pair capacity is not the total slot count.

Deep-ask optional fields are `retrieval_policy`, `knowledge_scope_ref`,
`recent_context_ref`, `recent_context_binding`, `source_decision_digest`,
`parallel_pair_ref`, `parallel_leg`, and `source_intent`. Scope/digests are
64 lowercase hex; context refs are `ctx_` plus 64 hex. The five bound fields are
`account_id`, `group_id`, `route_ref`, `route_generation`, `feature_generation`.
`source_intent=web_requested` requires `knowledge_agent`. Paired knowledge/web
legs require matching `group_knowledge`/`web` policies. Trusted server scope
mapping must be checked before consume/dispatch.

Done/history evidence must preserve `answer_basis`, source counts by kind,
`source_intent`, and `l0_context_count`, `l0_source_count`, `l0_snapshot_count`,
`l0_injected_count`, `l0_omitted_count`, `l0_truncation_reason`. Never label an
unverified general answer as knowledge/web evidence, or count L0 messages as
retrieved source documents. Persist original question, not the augmented prompt.

## Exports and startup dependencies

Live `server.js` injects `IMAFirstPartyClientContextProvider` into the pool,
optional `ProviderAObservationExporter`/`ObservationSocketTransport` into app
and queue, `RecentContextConsumer` into app, and
`KnowledgeAgentQualificationManager`/`KnowledgeAgentQualificationReportStore`
into enrollment/admin/app locals. Candidate startup lacks these dependencies.
Their existence must be reconciled by the owners before choosing an Air entrypoint.

Keep existing app exports, especially `createApp`, `validateAskRequest`,
`requireInternalServiceToken`, `requireProviderAIdempotencyKey`,
`getConversationOwnerKey`, `classifyFailureReason`, `classifyStreamingFailure`,
`getErrorStatusCode`, and security/CORS/request-signal helpers. Compatibility
helpers below do not replace authentication or ledger exports.

Other historical integration exports include `ProviderACapacityTracker`,
`synchronizeProviderAQueueCapacity`, `ProviderRequestStateError` and conversation
ledger methods `beginProviderRequest`, completion/interruption/replay handling;
`RecentContextConsumer`, `RecentContextConsumeError`, `validatePayload`,
`buildRecentContextQuestion`, `buildRecentContextQuestionPlan`. New modules
provide the latter context exports at `src/bot-recent-context.js`, not the old
filename; imports must be explicitly changed by the integrating owner.

## Config behavior to preserve additively

- `IMA_QA_RECENT_CONTEXT_URL/TOKEN` must be configured together; URL must be a
  literal loopback origin. The context token must differ from the internal
  Provider service token. Timeout defaults to 3000ms; new consumer bounds
  500..10000ms. Nothing in these modules reads process environment or secrets.
- `WECHAT_QA_OBSERVABILITY_ENABLED/SOCKET_PATH/MAX_QUEUE`: explicit opt-in,
  bounded absolute external socket path, default queue 1024. Telemetry must
  neither block QA nor expose raw question, group binding or credentials.
- `IMA_UPSTREAM_PROTOCOL_DIAGNOSTICS_ENABLED/PATH/INSTANCE_ID/MAX_BYTES/MAX_FILES`:
  explicit opt-in, external path, instance-scoped filenames, bounded rotation.
  Do not copy old repository-root path calculations into a differently laid-out
  private package without adjusting them.
- `IMA_WEB_AGENT_ANSWER_PROFILE`, `IMA_WEB_AGENT_PROFILE_CAPABILITY_DIGEST`,
  per-account `answerProfile` and `routingLane` (`knowledge/agent/flex`): preserve
  verified semantics, not merely parsed config. Keep new `webMode`, native
  readiness and per-account `maxConcurrent` support too.
- Keep account-store fence before any credential refresh/seeding. No compatibility
  helper may open the account store, runtime env, browser profile or diagnostics.

## Mounting instructions for parent

1. Keep existing trusted auth/application identity and base question validation.
   On the internal bot path, call `validateBotRetrievalContract(body, { internal:
   true, expectedKnowledgeScopeRef })` from `src/bot-compat.js`, with the scope
   resolved from server configuration, never from request authority. Ordinary
   routes reject all `FIELDS`, even if a supplied field is empty.
2. Bind `contract.requestBinding` into the durable/legacy idempotency fingerprint
   together with owner, application, original question and conversation. It now
   includes the five-field context binding. Existing ledger rows must not be
   reinterpreted as a new request or retried to "repair" a fingerprint conflict.
3. Construct the injected `RecentContextConsumer` only from validated config.
   Call `prepareBotAsk` **inside the admitted execution**, after idempotency
   replay/conflict decisions. It performs at most one consume, no retries.
   Reconnect/replay must never consume a single-use context snapshot again.
4. The candidate client at b7c3482 ignores `recentContext` and `retrievalPolicy`.
   For this client, call `buildRecentContextQuestionPlan(prepared.question,
   prepared.recentContext, contract.retrievalPolicy)` and send its `question`
   exactly once; retain its counters for evidence. If porting an older client
   that already augments context, do not augment it twice. Source policy routing
   must be implemented by the pool/client owner or rejected explicitly.
5. **Mode discrepancy confirmed by parent:** old live app passes retrieval policy
   and session answer profile; candidate client defaults `mode` to classic.
   Parent reports its scheduler patch now passes recorded `mode` and
   `accountLease` through legacy/durable dispatch (not re-verified here).
   Preserve both through native, legacy JSON and SSE dispatch. Our helper deliberately does not choose mode
   or preserve a `mode` hidden in upstream metadata. Set trusted mode after
   merging prepared options. Test session compatibility across native/legacy
   modes in the integrated app; profile-only matching is not sufficient proof.
6. Build evidence from actual source kinds and the actual prompt plan using
   `buildBotAnswerEvidence`. Merge with request/conversation/timing metadata for
   done; translate snake-case fields to the existing history metadata fields.
   Enforce policy before committing success. Preserve existing failure reason
   allowlists, including `recent_context_unavailable` and
   `retrieval_policy_unsatisfied`, without leaking upstream messages.
7. On capacity GET, use `buildBotCapacitySnapshot` with sanitized website metrics,
   verified profile and explicit policy/lane/pair capacities. Unknown policies
   remain zero; keep generation changes managed by the real capacity owner.
   Missing profile evidence is a safe 503, never invented readiness.
8. Reconcile startup qualification/observation/context dependencies and health
   capabilities before release. These modules are not automatically registered
   and do not restore missing admin or qualification implementations.

## Concrete server glue

`src/bot-server-glue.js` supplies two dependency factories. They perform no I/O
on import and never start transport or qualification. Parent must supply the
actual extension constructors; missing enabled constructors fail explicitly.
Do not load them from the live release path in candidate code.

```js
// After the account-store fence, before constructing pool/app:
const bot = createBotServerDependencies({ config, constructors });
// Add ...bot.poolOptions to the SECOND IMAWebAgentPool constructor argument.
// Add ...bot.appOptions to createApp options (same observation object for queue).
// After app and exercise manager construction, before enrollment/admin:
const qualification = createBotQualificationDependencies({
  config, app, accountDirectory, pool: imaWebAgentClient,
  accountPoolExerciseManager, synchronizeQueueCapacity, constructors,
});
// Add ...qualification.enrollmentOptions to WebAgentEnrollmentManager options.
// Add ...qualification.adminOptions to registerAdminRoutes options.
// Only once all startup validation succeeds:
bot.observationTransport?.start();
// The server shutdown path must await bot.observationTransport?.close().
```

### Code-only live call-site inventory

Line anchors refer to the named immutable source snapshot, not a running process.
This covers the identified bot-extension entrypoints; it is not a whole-release
source equivalence claim. No live dependency is imported by these tests.

| Live call site | Required preserved behavior / candidate action |
| --- | --- |
| `server.js` observation transport/exporter construction and start | Glue preserves shared exporter and explicit transport lifecycle; overlay supplies classes. |
| `server.js` client context injection into pool options | Glue supplies provider; pool/client owner must consume it. |
| `server.js` recent-context injection into createApp | New bounded consumer, same one-use binding contract; app mounting required. |
| `server.js` qualification store/manager, app.locals, enrollment/admin injection | Glue preserves one shared manager, exercise conflict manager, queue and sync callback. |
| `app.js:52`, `app.js:60`, `app.js:882` | Queue/capacity observations and sanitized protocol failure samples; never fail QA on telemetry. |
| `app.js:89`, `app.js:97`, `app.js:171` | Health capability/monitor and qualification maintenance admission guard. |
| `app.js:304`, `app.js:640`, `app.js:647` | Pass policy/binding/pair options, consume once inside execution, preserve trusted mode/lease. |
| `app.js:703`, `app.js:714`, `app.js:735`, `app.js:752` | Actual L0/source evidence, enforce policy before success, persist original question and evidence. |
| `app.js:917`, `app.js:968`, `app.js:1468`, `app.js:1488` | Internal field validation, stable fingerprint, replay/history metadata. New binding intentionally includes all five fields. |
| `ask-queue.js:73`, `ask-queue.js:119` | Safe queue-state observation, exception isolation; parent-owned scheduler retains authority. |
| `ima-web-agent-pool.js:70`, `ima-web-agent-pool.js:272`, `ima-web-agent-pool.js:341` | Client context, policy lease/profile and account routing; do not restore old semaphore/admission. |
| `ima-web-agent-pool.js:416`, `ima-web-agent-pool.js:746`, `ima-web-agent-pool.js:766` | Qualification maintenance, alert/capacity eligibility; no minimum-one fallback. |
| `ima-web-agent-client.js:392`, `ima-web-agent-client.js:414`, `ima-web-agent-client.js:518`, `ima-web-agent-client.js:610` | One prompt augmentation, first-party auto context, policy-specific body/headers and native evidence parsing. |
| `admin-routes.js:105`, `admin-routes.js:110`, `admin-routes.js:131`, `admin-routes.js:331`, `admin-routes.js:537` | Qualification APIs/bootstrap, lane mutations, sanitized eligibility; admin auth remains mandatory. |
| `web-agent-enrollment.js:175`, `web-agent-enrollment.js:227`, `web-agent-enrollment.js:351`, `web-agent-enrollment.js:810` | Qualification consent/preflight, start/wait, pending activation and cancellation. Passing an unused constructor option is not preservation. |
| `provider-a-capacity.js:47`, `provider-a-capacity.js:116`, `provider-a-capacity.js:125` | Bot versioned snapshot, paired/policy capacities and generation; dual-shape adapter supplied. |

## Intentional safety differences

- Do not copy the old minimum-one queue capacity or profile-ready fallbacks.
  Zero eligible slots remains zero; unsupported policies are never inferred.
- All five group-binding fields participate in the request fingerprint. Unknown
  binding keys and coerced/noninteger generations are rejected.
- Context origins reject query/fragment/userinfo; redirects are never followed.
  HTTP response bytes are bounded before JSON parsing; negative v2 omitted
  counts are rejected. Validate received message bytes before NFKC.
- Prompt context is marked untrusted source material; newest messages fit first,
  then retain chronological order. Prompt wording is not asserted byte-identical
  to the old upstream prompt. No real upstream equivalence was tested.
- Verified injected L0 can establish knowledge evidence even without retrieved
  document sources; L0 does not inflate `source_count`. It cannot satisfy a
  web-only policy. Unsupported v3 stays rejected.

## Verification and remaining gates

New contract/context tests use synthetic strings, in-memory fetch stubs and no
service credentials. Existing app/config/capacity/bot-adapter regressions were
run with the parent dependency directory symlink, not live dependencies.
The historical bot `validateCapacity` from root commit `657b5f19` also accepted
synthetic ready and blocked snapshots through an isolated code evaluation.

Outstanding release gates: mounted app request/response tests against the bot
client; native/legacy mode propagation; correct trusted application identity;
source-policy execution and readiness; single-use L0 through queue/reconnect;
qualification and observation lifecycle; startup entrypoint reconciliation.
No live compatibility, mounted-route compatibility, full-suite, image, or
deployment acceptance is claimed by this preparation alone.
