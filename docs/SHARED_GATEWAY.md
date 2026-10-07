# Shared Provider Gateway

Dedicated, dependency-free Node gateway. Run from this repository with Node 18.18+
using `SHARED_GATEWAY_CONFIG=/absolute/private/gateway.json node scripts/shared-gateway.cjs`.
The listener is always `127.0.0.1` (default port 8790). No package script changes,
dotenv loading, live probes, account access, or Provider startup are performed.
The site backend, not its browser, holds the site bearer token. Expose only these
gateway routes through an authenticated HTTPS transport when remote sites need
access. Never expose Provider `/internal/` routes.

## Private Configuration

Use a private file outside Git, readable only by the service operator. Required
fields: `providerUrl` (HTTP literal `127.0.0.1` or `[::1]` origin, no path, query,
userinfo or fragment), `apiToken`, `serviceToken`, `knowledgeScopeRef` (64 lowercase
hex characters, SHA-256 of the configured shared knowledge-base ID), `hmacKey`
(at least 32 bytes, generated randomly), and `sites` (array of
`{deploymentId, token}`). Optional `port` defaults to 8790; `timeoutMs` defaults
to 200000 and bounds the complete request including streaming (configuration
range 1-600000 ms). Keep this above the caller's 190-second timeout in production.

Site tokens are unique, 24-512 printable non-space ASCII characters; use randomly
generated high-entropy secrets. Deployment IDs match `[a-zA-Z0-9._:-]{1,100}`.
Multiple tokens can map to the same deployment during rotation. Provider API and
service credentials remain server-side and are used only for their fixed routes.
Gateway errors, readiness and logs do not expose Provider error bodies or headers.
Successful history JSON is allowlisted to Provider's public conversation fields
(conversationId, title, createdAt, updatedAt, expiresAt, turnCount), message fields
(role, content, createdAt, searchSummary and source evidence counts/basis/intent),
and source fields (index, title, snippet), plus success and envelope arrays.
Unknown fields, ownerKey and upstream metadata are dropped at every object level.
SSE is Provider's existing public contract and remains byte-for-byte unchanged.

After atomically editing the private file's `sites`, send SIGHUP to replace the
registry. Invalid reloads retain the previous registry. Removing a token revokes
new requests immediately after reload; an empty sites array revokes all tokens.
In-flight requests may complete. Keep the
deployment ID and HMAC key unchanged to retain history and deduplication across
rotation/restarts. Other configuration changes require restart. Losing/changing
the HMAC key changes ownership namespaces; preserve it securely.

## Exact Client Contract

Every route requires `Authorization: Bearer <site token>` and
`X-IMA-Client-Id: <visitor>`, including capabilities. Visitor IDs are case-sensitive
and match `[a-zA-Z0-9._:-]{1,160}`. The site backend must derive this ID from its
authenticated user/session; it must not trust a browser-supplied identity.
Cross-visitor access within a site is only as secure as that site's authentication.
Duplicate authorization/visitor headers are rejected. No caller headers other
than these identities affect upstream routing or credentials; cookies and caller
idempotency keys are never forwarded. No CORS support is provided.

| Method | Route | Request | Response |
| --- | --- | --- | --- |
| GET | `/v1/capabilities` | No body/query | Sanitized readiness JSON below |
| GET | `/v1/conversations` | Optional `?limit=1` through `?limit=50` | Provider list JSON |
| POST | `/v1/conversations` | Empty body or `{}` | Provider create JSON, 201 |
| GET | `/v1/conversations/:id` | No body/query | Provider detail JSON |
| DELETE | `/v1/conversations/:id` | No body/query | Provider delete JSON |
| POST | `/v1/ask` | JSON below | Raw keyed SSE, 200 |

```json
{
  "schemaVersion": 1,
  "features": {"knowledge_agent_keyed_sse_v1": true},
  "connected": true,
  "configured": true,
  "authenticated": true,
  "contractSupported": true,
  "ready": true,
  "capacity": 2,
  "active": 0,
  "queued": 0,
  "webIntentSupported": true
}
```

`configured` means local startup configuration passed validation. `connected`
means Provider returned an HTTP response; `authenticated` requires both valid
capacity JSON with HTTP 200 using the service credential and an ordinary-token
`GET /api/conversations?limit=1` with the HMAC owner returning `ok`. This does not
mean every upstream account is logged in. `contractSupported` and the keyed feature require Provider
schema 1 plus its explicit keyed-SSE flag. `ready` additionally requires positive
native capacity. Capacity/active/queued are nonnegative safe integers.
`webIntentSupported` requires the separate Provider web-intent feature. Failure
is reported as false/zero values, never as account diagnostics. Readiness does not
dispatch an IMA question. The ordinary history check is read-only and its contents
are discarded.

```json
{
  "question": "Synthetic question",
  "conversationId": "11111111-1111-4111-8111-111111111111",
  "request_id": "22222222-2222-4222-8222-222222222222",
  "sourceIntent": "web"
}
```

`conversationId` and `sourceIntent` are optional. Questions must be nonblank strings
of at most 1200 UTF-16 code units, without control characters except tab/newline/CR.
Conversation IDs match `[a-zA-Z0-9-]{1,100}`. Request IDs must be RFC-variant UUIDs
(versions 1-8), normalized to lowercase for deduplication. Only `web` is supported
when sourceIntent is present. All unknown fields, including `history`, `owner`,
`deploymentId`, `retrieval_policy`, `knowledge_scope_ref`, `source_intent`, credentials
and URL overrides, are blocked with 400. The gateway forwards only question and
optional conversationId, adding fixed `retrieval_policy: knowledge_agent` and
`knowledge_scope_ref`; `sourceIntent: web` becomes `source_intent: web_requested`.

Length alignment: Provider `src/config.js`/`src/app.js` accepts 2000 code units at
the HTTP boundary, but `src/ima-knowledge-agent-contract.js` caps the selected native
lane at 1200 Unicode code points. Gateway uses a conservative 1200-code-unit cap;
a BFF allowing 2000 must surface the gateway 400 or lower its native-lane limit.
No Provider implementation changes are included here. Web-intent suffixes are
added upstream and can further reduce the native lane's effective input budget.

The upstream owner is `sg:` followed by HMAC-SHA256 over JSON-encoded
`["owner-v1", deploymentId, visitor]`. Idempotency-Key is HMAC-SHA256 over
`["request-v1", deploymentId, visitor, lowercaseRequestId]`. Token values are not
part of either namespace. Provider enforces owner isolation and persistent keyed
SSE deduplication; its persistent conversation/idempotency store must be enabled.
The gateway has no independent history store or retry ledger.

## Failure and Stream Semantics

Raw request targets are allowlisted, without URL normalization or redirects.
Unknown routes/query fields return 404; disallowed methods return 405. Invalid
credentials return 401, invalid fields/IDs return 400, oversized requests return
413, non-JSON POST bodies return 415. Requests are capped at 16 KiB; upstream
capacity JSON at 64 KiB and history JSON at 2 MiB. Unsupported readiness/web intent
returns 503 before dispatch. Safe Provider 400/404/409/429 statuses are retained
with a generic error; other upstream failures return 502. Timeout returns 504
before headers, or closes an already-started stream. No upstream headers, cookies,
redirect locations or error text are forwarded.

SSE bytes pass unchanged with backpressure, no parsing, replay or automatic retry.
Only a Provider `done` event confirms completion; HTTP 200 or EOF does not.
Disconnecting or cancelling the downstream request aborts the upstream request.
Duplicate keyed SSE returns 409; on uncertain completion read conversation history,
do not silently change the request ID. Web intent is not proof of web sources.

## Verification / Rollback

Run `node --test test/shared-gateway.test.js`. Tests use loopback synthetic Provider
responses only, covering tenants, visitor ownership, rotation/revocation, spoofed
fields, keyed SSE, cancellation, redirects and denied paths. No live acceptance is
claimed. Stop the gateway and revert its commit to roll back; no Provider data is
modified by installation. Site authentication, TLS, quotas and rate limiting remain
deployment responsibilities.
