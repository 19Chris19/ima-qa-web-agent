# Docker Desktop: admin-page enrollment on a maintenance Mac

The optional maintenance helper supplies a visible, isolated browser. Provider A
still owns enrollment jobs, identity checks, verification and encrypted account
storage. The browser shows the official IMA site. Each job gets a fresh browser
context, not the maintenance user's normal browser profile.

## Private configuration

Run `scripts/enrollment-browser-helper.mjs /absolute/private/config.json` on the
maintenance Mac. Configuration contains `browserPath`, `port` and a random
32-byte hexadecimal `key`. Keep it outside Git with mode 0600. The helper binds
only 127.0.0.1. Use identical Playwright versions in the helper and container.

Set the container's `IMA_ENROLLMENT_BROWSER_ENDPOINT` to the private WebSocket
endpoint on `host.docker.internal` using that port and key as the path. Never
print, publish or expose this endpoint to frontend code. It grants control of
the dedicated browser. Do not bind the helper to a LAN or public interface.
Set `IMA_WEB_AGENT_ENROLLMENT_BROWSER_MODE=visible`.

The admin page retains the existing Add Account, progress, focus and cancel
controls. If the helper is offline, launching the task fails with a redacted
maintenance-helper message. The advertised capability means configured, not a
continuous liveness guarantee.

## Air rehearsal outcome (2026-10-03)

- A loopback-only LaunchAgent was installed for the dedicated helper; it does
  not start or modify the original Provider service or everyday browsers.
- Docker-to-Mac browser connection, fresh page creation and cleanup passed.
- All 262 tests passed when rerun serially. The initial parallel run had two
  failures under load; it is not reported as a passing run.
- The new 3317 bootstrap returns HTTP 200, the intended real shared-library
  binding, and enrollment enabled. The 4417 website is connected but not ready
  for QA until an account is enrolled and verified.
- Deployment uses the local `air-provider:browser-enrollment` image and the
  private `.docker-lab/browser-enrollment.yaml` Compose override in the website
  checkout. Include that override when recreating this lab; the base Compose
  alone still refers to the earlier baseline image.
- Real login, account verification and QA remain pending user scan. No success
  is inferred from the enabled button or synthetic connection test.

## Rollback

Stop any pending enrollment first. Remove the endpoint setting and recreate
only the lab with its former image. Stop the dedicated helper LaunchAgent.
Keep the current account and conversation volumes; never restore an older
account snapshot over newly enrolled users. The pre-change env backup contains
synthetic scope settings, so it must not blindly replace real scope bindings
after accounts have been added.

This is a Docker Desktop maintenance workflow, not a remotely exposed browser
service or a claim that a headless Linux host can open a Mac window by itself.
