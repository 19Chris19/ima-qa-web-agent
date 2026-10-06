# Provider management and installation convergence

Baseline: 0db3fc2 (unpublished onboarding candidate). Companion website baseline: 6323d32.

## Approved scope
- Separate capability, scheduling and authentication maintenance evidence.
- Modern account table with a details drawer; automatic declared enrollment verification.
- Preserve a newly scanned different identity without overwriting the original account.
- Port generic composer, reading and copy interactions without website branding.
- Synthetic-tested encrypted account transfer and ownership-filtered read-only history archive.
- Consolidate this Air installation into 3117 only after queue drain, backups and rollback validation.
- Keep independent Provider installations the default for new website deployments.

## Delivery sequence
1. FEAT-20261006-PROVIDER-MAINTENANCE: scheduler-backed maintenance contract and tests.
2. FEAT-20261006-PROVIDER-ENROLLMENT: identity conflict continuation and verification.
3. UI-20261006-PROVIDER-ADMIN: approved table/drawer and responsive accessible states.
4. UI-20261006-PROVIDER-QA: generic input and reading experience.
5. FEAT-20261006-PROVIDER-MIGRATION: offline preflight/import and synthetic recovery.
6. FEAT-20261006-EXPLORER-ARCHIVE: owned history archives and controlled upstream switch.

## Safety gates
No production restart, real probe, account transfer or publication has occurred in this change.
Never replace the running Provider with this public candidate: the running build contains additional Bot contracts.
No runtime values, account identities, credentials or conversations belong in commits.
Each feature carries tests and matching documentation; version numbers remain candidates.
Code rollback must preserve newer runtime data; account transfer rollback must prevent simultaneous refresh owners.

## Progress
- Planning/branch setup only. Feature implementation and release gates are pending.
