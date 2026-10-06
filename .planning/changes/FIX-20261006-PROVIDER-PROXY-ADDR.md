# Resolve proxy-addr audit blocker

User-Goal: Ship management/deployment changes without known critical dependency findings.
Scope: lockfile-only transitive proxy-addr 2.0.7 -> 2.0.8; no API or configured trust-proxy change.
Evidence: npm audit reported GHSA-jqcg-44mw-7w3h; lockfile update audit reports zero findings.
Verification: clean npm ci succeeded with zero audit findings; three focused origin/IP/proxy tests passed. Full integration regression remains pending. No live dependency installation.
Rollout: include in next tested Provider candidate, not a standalone live restart.
Rollback: revert this lockfile commit only if required; doing so restores the known audit finding.
