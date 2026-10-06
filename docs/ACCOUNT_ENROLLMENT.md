# Account Enrollment: Identity Conflict Candidate

This is a local implementation candidate, not a release or live acceptance claim.
The public admin UI is unchanged and needs separate integration.

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
As before, a failed post-insertion QA check does not remove the enrolled account.

## Verification Boundary

Tests use temporary stores, fake browsers/clients, controlled clocks and local
HTTP fixtures. No real IMA network, live runtime, credentials, restarts, push or
release are part of this candidate. Parent integration must retain the narrow
route addition alongside independently edited management snapshots.
