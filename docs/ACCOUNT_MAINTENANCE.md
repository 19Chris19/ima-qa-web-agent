# Account maintenance (unpublished candidate)

This contract is implemented in the management candidate, not the published v0.4.1 image.
Do not apply these instructions to a running installation merely because its health endpoint responds.

`GET /api/admin/accounts` remains administrator-authenticated. Each account adds `management`:
- `knowledge`: explicit qualification state/proof time, not inferred from generic Web health.
- `web` and `session`: independent observations, including `unknown`.
- `schedulable`: current readiness, distinct from configured concurrency and account count.
- `maintenance`: the renewal scheduler's actual next check/retry, last check, expiry metadata and last successful refresh.

The periodic check only renews authentication when needed; it does not ask IMA questions.
Default check interval is 60 seconds, with renewal eligible 10 minutes before access-token expiry.
Failures back off exponentially (up to 15 minutes, or the configured interval if longer).
Checks never overlap; stopping an account cancels its timer. A check already in flight must finish
before transferring credentials. Disabling an account is not proof that a previously started request has ended.
Successful automatic renewal is persisted through the account directory callback.

An access token expiring does not imply a scan is required. Refresh credentials may allow renewal;
their recorded expiry also cannot guarantee future upstream access. Missing upstream expiry stays unknown.
Next check is an actual in-process schedule, not an SLA or an invented future login deadline.
Service restarts rebuild schedules; the UI must display timezone alongside absolute dates.

Deployment: isolated tests first. The Air running Provider has additional Bot contracts and cannot
be replaced by this candidate without a separate compatibility review and maintenance window.
No real account or real question is part of the synthetic test suite.
