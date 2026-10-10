# Integrated Air startup acceptance

Change-ID: TEST-20261009-AIR-STARTUP

## Goal and scope

Add acceptance tests on parent 98efcbc for the real Provider entrypoint with the
Air opt-in, plus the actual Air directory/pool/readiness/app durable HTTP path.
Only tests and this record may change. No server, app, pool or config edits.

## Plan

1. Spawn provider-a-server.js with a private empty temporary store, isolated
   environment and a preload that rejects every outbound network connection.
2. Verify startup, health, authenticated capacity/admin shapes and termination.
   PORT=0 is currently invalid, so reserve and release an ephemeral loopback port.
3. Mount five synthetic basic proofs through the real Air runtime, directory,
   pool and app. Inject only the upstream transport, routed to an ephemeral local
   HTTP fixture; prove five concurrent native tasks, exact answers and release.
4. Keep the startup acceptance red until the parent fixes its actual mounting;
   never fake the mounted flag or mark the known failure as expected/skip.

## Safety and handoff

No inherited credentials, live runtime reads, IMA connections, browser launch or
real questions. Temporary state is private and removed after child/server exit.
Parent owns the mounting fix and integrated full-suite/Docker verification.
Rollback is reverting this test-only commit; no runtime state is affected.

## Verification

`node --test test/air-startup-acceptance.test.js` on parent 98efcbc: 2 passed,
1 failed, 0 skipped (7.46 seconds). The genuine entrypoint exits before listening
with `air_bot_app_glue_required`; this failure is intentional regression evidence,
not an expected-failure assertion. Its downstream health/admin assertions have
not yet been reached and must be exercised after the owner's mounting fix.

The preload observes (never sets) the actual createApp mount flag: false, while
policy, eligibility, readiness, durable and queue dependencies are present.
The negative mount-declaration control passes. The mounted five-account test
passes with five concurrent native durable HTTP tasks, five distinct accounts,
unchanged model/native headers, one upstream QA each, exact whitespace, one done
event each, preserved basic proofs and complete slot release. Browser context
and legacy/external fetch paths are forbidden in that fixture.

Both fixtures use an unready auto profile; the five-account fixture retains valid
native/basic and classic policy evidence without electing another profile.
Child environment is an explicit whitelist, with every state/runtime-env path
under the private temp directory. Child preload denies outgoing sockets/fetch,
rejects any existing or unexpected dotenv file before reading it, and does not
change app behavior or its mount flag. The mounted HTTP fixture only allows its
two exact loopback ports, including a counter for swallowed connection failures.

Staged whitespace and governance CI checks pass (five existing baseline warnings).

No full suite was repeated. Child/server cleanup completed, and only this record
and the acceptance test are included in the commit.
