# Provider stable durable-task release

User goal: publish the reviewed RC functionality as the default stable install,
paired with website v0.3.0. Preserve v0.5.0-rc.1; publish new v0.5.0 tag after PR,
tests, packaging, multiarch startup and immutable manifest acceptance.

Scope: version and current installation/release documentation; no executor,
account, robot or running-service changes. No new real IMA questions.

Gates: clean npm install, full synthetic tests, package scan, CI, merged tag and
public image visibility/anonymous pull. Windows, SSH enrollment, new-account
real QA and Linux long uptime remain unverified. Air host 503s are not resolved
by a stable Release label. Publication does not restart local deployments.

Rollback: retain task-aware compatible code and current data. Never start a
legacy task-unaware writer on new task logs or reinitialize account/session data.
