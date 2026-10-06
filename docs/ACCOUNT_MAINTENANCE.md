# Account maintenance (unpublished candidate)

This contract is implemented in the management candidate, not the published v0.4.1 image.
Do not apply these instructions to a running installation merely because its health endpoint responds.

`GET /api/admin/accounts` remains administrator-authenticated. Each account adds `management`:
- `knowledge`: explicit qualification state/proof time, not inferred from generic Web health.
- `web`: generic web-search evidence, currently `unknown`; the public backend has no independent generic-search proof contract.
- `session`: the existing session-health observation, including `unknown`.
- `schedulable`: current readiness, distinct from configured concurrency and account count.
- `maintenance`: the renewal scheduler's actual next check/retry, last check, expiry metadata and last successful refresh.

Legacy `health.web_ready` describes Web session/context health, not generic IMA
web search. Session initialization and a successful bound knowledge answer may
set it to true without exercising generic search. Neither true nor false implies
a generic-search result. These health fields and their existing consumers remain
unchanged; no new probe, proof schema or scheduling gate is introduced.

Likewise, `health.knowledge_ready` from session initialization is not evidence of
a completed bound knowledge answer or an independent membership authorization
check. An account without knowledge access is not proven capable merely because
initialization succeeds. In classic compatibility mode readiness may report
ready/busy/cooling without qualification; management projects those unqualified
knowledge states as pending, with no proof timestamp, while preserving the
separate schedulable flag. Actual single-answer qualification still produces ready
knowledge evidence. Legacy health flags alone neither grant qualification nor
invalidate a valid bound proof; existing disable, revalidation and failure guards
continue to determine admission. This change does not claim to newly detect
upstream knowledge-access revocation.

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
