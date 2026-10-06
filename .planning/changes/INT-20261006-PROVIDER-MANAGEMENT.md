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
- Candidate integration complete at 76201e6: maintenance (5d53099, 349e997, bbd3a9d), enrollment (9303db1), admin (cdaf776e, b894910), QA (cd1d40d, deca72b4), migration (36a30b7), dependency patch (fe1c9bc).
- Provider combined regression: 378 passed, zero skipped, with PROVIDER_ADMIN_CONTRACT_ROOT pointing at this integration worktree.
- Companion website branch codex/FEAT-20261006-EXPLORER-ARCHIVE: 6237d8a + b764a93; 106 tests passed with actual synthetic exporter enabled; build passed. Cross-repository export-to-parser checks passed against this integration.
- Integrated admin desktop/mobile synthetic browser check passed; mobile drawer has no horizontal overflow, Escape restores account focus. No real account data in screenshots.
- Runtime compatibility, private final backups/archive acceptance, durable source retirement, live migration and real first-question/follow-up remain unperformed gates. No service restarted, no remote push or release.
- See docs/MANAGEMENT_CANDIDATE_ACCEPTANCE.md for verification and continuation boundaries.
