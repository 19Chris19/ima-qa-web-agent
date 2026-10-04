# Guided deployment and maintenance browser

User goal: ship account enrollment as part of installation, with an Agent-friendly
workflow for desktop Docker and remote Linux. Do not make maintainers discover a
missing browser after installation.

Baseline: d4eb621. Scope: official share-link metadata, isolated maintenance
dependencies, deployment preflight, repeatable private configuration, desktop
helper lifecycle and remote CLI preparation. Enrollment authorization is a
separate dependent feature; documentation is a third feature.

Security: no everyday browser profiles, no public control socket, no credentials
in reports, no account import from the Air, no automatic membership changes.
Existing installations and unrelated services must remain untouched.

Acceptance: synthetic resolver/installer tests, exact helper/container version
checks, owned-resource recovery and no-secret reports. Native Windows, remote
Linux desktop-to-server, fresh-account scan and live QA remain NOT RUN until
explicitly exercised. Candidate only; no shared-service restart or release.

Rollback: revert this feature commit; stop only its owned helper. Preserve all
current account and conversation data. Do not initialize an existing install.
