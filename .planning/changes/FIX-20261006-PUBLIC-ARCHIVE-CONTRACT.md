# FIX-20261006-PUBLIC-ARCHIVE-CONTRACT

## Goal and isolation

Make the public Provider candidate's pure history exporter satisfy the unchanged
Explorer schema-v1 archive privacy contract. Branch starts at 32be509, isolated
from the release candidate's ongoing UI changes. No real histories, credentials,
services, Docker, push or release operations are authorized.

## Evidence and minimal fix

Explorer f4992da cross-repository test reproduced five failing child tests:
auditHistoryInput/exportHistoryWithReport are absent. The old public exporter
projects fields before validating owners, dates, aliases, completion and URLs.
It also silently drops native flat evidence. Public ConversationStore persists
nested evidence; Air's historical adapter additionally supports flat metadata.

Port only the pure preflight/export logic reviewed at monorepo 92c01bd7 (following
cb2898e1), with synthetic tests. Do not port Air CLI, retirement, lock or runtime
code. Keep account-transfer cryptography and filesystem preparation unchanged.
Existing exportHistory keeps its schema-v1 success shape but becomes strict:
invalid input throws archive_preflight_failed with a count-only report.

## Verification

- Red: Explorer f4992da against unmodified public candidate failed five of six
  child tests (missing APIs); source mapping already passed.
- Green: unchanged Explorer interop 7/7 including parent test; Provider targeted
  account-transfer/preflight/native-store tests 19/19 with actual parser enabled.
- Provider full `npm test -- --test-reporter=dot` with actual parser enabled:
  exit 0. Explorer full suite with actual Provider enabled: 158/158, zero skips.
- `npm run build:web-vendor` (Provider) and `npm run build` (Explorer): passed.
- Both `npm ci --ignore-scripts` commands succeeded, 0 vulnerabilities reported.
- `git diff --check`: passed. Both standalone repositories lack
  scripts/check_governance.py; required invocation returned exit 2, not green.
- Production account-transfer.js and history-export-preflight.js are byte-for-byte
  identical to their reviewed monorepo 92c01bd7 versions. Public native-store
  tests are new and use only fresh temporary synthetic data. Website parser,
  interop assertions and fixture are unchanged from f4992da.

No live data, credential files, existing services, Docker or registry operations
were used. Full tests use their isolated synthetic fixtures and fake endpoints.

## Semantic differences from public 32be509

- Adds count-only audit and explicit report-returning export; successful schema-v1
  exportHistory shape remains. Invalid exports now throw archive_preflight_failed.
- Checks ownership, shape, date chronology, completion, metadata and quotas before
  projection. Raw input is conservatively capped at 16 MiB, including redactions.
- Preserves nested public evidence and supported timing/process/completion fields;
  maps flat legacy evidence without coercion and rejects conflicts. No changes to
  public ConversationStore's own normalization or persistence behavior.
- Explicit options may exclude valid empty shells or remove all source URLs with
  counts. Defaults reject empty shells and URLs with query/fragment/userinfo or
  unsafe schemes. Invalid records and URL-only remnants cannot be discarded.
- Known private fields are removed with counts; unknown metadata is rejected.
  Absent/null searchSummary exports as null instead of an invented empty string.
- No new CLI flags, guards, service endpoints or Air runtime dependency. Existing
  prepareTransfer uses strict export and fails before creating a bundle on invalid
  history. Existing account cryptography and offline apply/rollback are unchanged.

## Rollout and rollback

Candidate only. Review/cherry-pick this branch independently of UI work. Reverting
the commit restores the old exporter but invalidates the strict interop claim;
do not enable archive migration on that basis. No data migration is performed.
