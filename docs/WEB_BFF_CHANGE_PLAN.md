# Web BFF contract candidate

Change-ID: FEAT-20260929-PROVIDER-A-WEB-BFF-CONTRACT

Goal: let a separately hosted website backend use Provider A's native
knowledge-agent lane without embedding account or service credentials in the
browser. This candidate starts at the public v0.3.0 release and does not
include the private website, bot, runtime data, or deployment configuration.

## Scope

1. Advertise native-lane capacity and supported request features on the
   service-token-protected capacity endpoint. Do not infer readiness from
   `/healthz` or total account count.
2. Accept keyed SSE on the protected deep-ask endpoint. The key prevents a
   second upstream dispatch; a repeated keyed stream returns a conflict, not
   a replay. Persist a terminal idempotency state before a successful `done`.
3. Bind native requests to the deployment's knowledge-base fingerprint, keep
   older sessions in their existing mode, and distinguish a web-search request
   from evidence that web sources were actually returned.
4. Publish a small synthetic, credential-free web BFF example and operational
   contract. Keep ordinary, internal-service and administrator credentials
   separate.

## Verification and rollout

Run failure-first synthetic contract tests, the full public test suite and a
package dry run. No live IMA questions, deployment, public push, PR or release
are part of this change. Review the resulting candidate before deciding
whether to open a public PR. Revert the individual contract commit if its
synthetic regression suite fails; no account data is migrated.
