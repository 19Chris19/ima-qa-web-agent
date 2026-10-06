# Account Enrollment: Pending Activation Candidate

This is a local implementation candidate, not a release or live acceptance claim.
The public admin UI offers an explicitly authorized single-probe retry for saved
pending accounts. No production or all-platform acceptance is claimed.

## Reauthentication Contract

Reauthentication with the same verified IMA identity keeps the existing replacement
flow. A missing original or captured identity fails closed. A distinct scanned
identity enters `identity_conflict` before session verification or persistence;
the original account, encrypted credentials and pool session are not replaced.

The task retains captured authentication only in private process memory until the
original enrollment deadline. Task responses expose `state: "identity_conflict"`
and `identityConflict: { actions: ["add", "cancel"] }`, never captured headers,
cookies, tokens, raw UID or identity fingerprint. The deadline is not extended by
reads, retries or an add decision. Restart does not recover a pending capture.

## Protected API

`POST /api/admin/enrollments/:enrollmentId/identity` uses the existing admin auth
middleware and accepts `{ "action": "add", "name": "new-account" }`.
It delegates to `resolveIdentityConflict(id, {action, name})`; replacement flags
and credential payloads are not accepted. Names use the existing enrollment name
normalization. Invalid action/name returns 400; a non-conflict task returns 409.

Add verifies membership using the retained authentication and then initializes a
session before an add-only directory write. With a configured share URL, only
`joined` passes; otherwise the existing legacy session-check behavior applies.
If membership is pending or unverified, use the existing protected `POST
/api/admin/enrollments/:enrollmentId/continue`. It reuses the retained login, so a
still-valid pending capture does not require another scan.

Concurrent add/continue calls are single-flight: an overlapping call receives the
current task snapshot, not another write or QA check. Poll the task for the final
result. A repeat after completion returns 409. Task-level verification/write
errors return a successful API envelope containing `enrollment.state: "failed"`;
inspect that state and `diagnostics.lastFailure.code`, not just HTTP status.

The directory reloads before the synchronous uniqueness check and uses its
existing generation-guarded store commit. A duplicate identity fails with
`duplicate_ima_identity`; no existing credentials are replaced and no extra
capacity is inserted. Store-generation conflicts fail rather than overwrite.

Cancel uses the existing DELETE enrollment endpoint. Cancellation, timeout,
shutdown and terminal failure clear the pending auth reference and close the
temporary browser/profile. Late verification completion cannot persist a cancelled
or expired task. The existing `onEnrolled` callback performs the declared single
QA check after insertion; no background QA probe or GET-triggered probe is added.
A failed post-insertion QA check does not remove the enrolled account, but it
now remains disabled in both classic and knowledge-agent modes.

## Durable Admission Gate

Browser capture, admin credential capture and runtime-text import persist encrypted
credentials with `disabled: true` and `enrollmentQualificationRequired: true` in
their first account write. New/previously enabled accounts use
`pending_enrollment_qualification`. Same-identity reauthentication recovers
`auth_failed` and `knowledge_base_unavailable` into pending; manual, migration,
duplicate and unknown disable reasons are not silently released. Existing accounts
are not mass-migrated or probed. Imported accounts do not start an automatic probe.

Only an explicit admin verify action or the declared enrollment callback starts
one knowledge-agent probe. GET, startup and ordinary enable never do so. Pending
accounts cannot be enabled through the normal enable API (409); paused credentials
remain encrypted and available to the verifier, not to ordinary scheduling.
Verification of an already enabled account first persists the same disabled gate,
so failure cannot fall back to classic scheduling or inherit an older proof.

On success, the directory reloads and compares the store generation and a digest
of the captured account, including encrypted credentials, identity, scope, model,
disabled state and events. Proof contract, principal, scope and one dispatch/terminal
are checked again. Proof and release of the gate are one existing locked atomic
store commit. Only the pending reason automatically enables the account. A manual
or migration pause can acquire proof but stays disabled; a subsequent explicit
enable is then possible. Unrelated store changes conservatively invalidate a probe
too; the user can retry. Manual disable, deletion/recreation, recapture or credential
rotation while a probe runs cannot be undone by its late result.

Failure, cancellation and timeout retain disabled credentials, with no proof.
Use **Verify QA capability** in the account list to retry without scanning again;
each retry authorizes one fresh question. Expired credentials still require login.
Successful proof committed before cancellation wins: cancellation reports completed
rather than claiming to undo an already committed activation. To pause it, use
the explicit disable action. A successful proof with pool-sync failure is reported
as `pool_sync_failed` and remains locally quarantined, not as ready; its disk proof
may already be committed and requires reconciliation before service acceptance.

| Phase/result | Durable account state | Next action |
|---|---|---|
| Before insertion, cancelled/expired | No new account; existing account unchanged | Restart login if needed |
| Captured, awaiting/running probe | Saved and disabled; no classic capacity | Await or cancel the authorized probe |
| Probe failed/cancelled/timed out | Saved and disabled | Explicit single-probe retry; no rescan unless auth expired |
| Proof committed for pending account | Proof and enable committed together | Normal scheduling |
| Proof committed for manual/migration pause | Proof saved; pause preserved | Explicit enable if desired |

## Cancellation and Phase Deadlines

`expiresAt` is the login/authorization deadline (five minutes by default), not a total task deadline. It
includes waiting for scan, identity-conflict resolution, membership and session
initialization. Retrying or choosing add does not extend it. Membership retains
its own 15-second request bound even when the enrollment cancellation signal is
provided.

On successful insertion, cleanup closes the temporary browser, drops pending
authentication/QR references, aborts remaining login-stage requests and clears
the login expiry timer. Only then does `onEnrolled` run the declared single
knowledge-base probe. Public `WebReadiness.verify` has its own timeout (60 seconds
by default), one dispatch/terminal evidence requirement and no auth refresh.
It may finish after the former login deadline. That is not an extension of the
login authorization and is not a seven-mode qualification procedure.

Explicit cancellation and manager shutdown cancel an in-flight post-insertion
probe through `onCancelVerification`. Shutdown does not merely hide its task.
A cancelled callback cannot perform a late enrollment sync/completion, and the
readiness cancellation guard prevents a late proof commit. Accounts already
inserted are retained disabled; cancellation does not roll back their credentials.
Cancellation after a completed atomic proof commit is the completed-success case
described above, not a cancelled probe.

Session initialization now receives the login AbortSignal. Client guards reject
late responses before refresh/retry or mutation of refreshed credentials, even
when an injected transport ignores cancellation. Native requests also receive
the signal. Late QR screenshots are discarded after cancellation, expiry or
cleanup, and cannot restore a cleared task QR. No background retry is added.

## Air Porting Notes

Port the lifecycle controller, shutdown cancellation propagation, post-await
guards and QR signal/terminal checks into the corresponding Air code selectively.
Preserve any newer Air late-cancel guards and its native profile/policy/lane
qualification contracts. Air may not have public `WebReadiness` or the same
`onEnrolled` hook: connect cancellation to its actual verification owner rather
than copying the public one-probe proof schema. Keep the existing Air client
request bodies, session context and SSE parser unchanged when porting the narrow
AbortSignal guards. Reconcile membership request timeouts only where that helper
exists. Do not copy this public enrollment file wholesale over Air.

## Verification Boundary

Tests use temporary stores, fake browsers/clients, controlled clocks and local
HTTP fixtures. No real IMA network, live runtime, credentials, restarts, push or
release are part of this candidate. Parent integration must retain the narrow
route addition alongside independently edited management snapshots.

The cancellation follow-up uses explicit synthetic keys, temporary stores, fake
browser/session transports and deferred responses. It covers cancel/shutdown/
expiry during initialization, cancellation during refresh, shutdown/cancel during
the single probe, late QR, and independent phase timeouts. Real upstream abort
acknowledgement and real browser teardown remain untested; no live acceptance is
claimed.
