# FEAT-20261004-PROVIDER-KB-AUTHORIZATION

- User goal: verify shared-library access before saving newly captured credentials; allow manual joining and resuming in the same controlled window.
- Depends on: guided-deployment commit 1e0036a.
- Scope: optional share-link configuration, protected enrollment/continue routes, official metadata verification, admin and maintenance CLI. Ordinary QA JSON/SSE unchanged.
- Evidence: read-only official share bundle on 2026-10-04 identifies `knowledge_share_get/get_share_info`, request shareId/cursor/limit/folderId, member roles 100/1000/9000/10000. Numeric ID also resolves from official Remix metadata; no script evaluation.
- Security: captured auth stays within task memory until access is affirmed; failure/cancellation/expiry never inserts it. Unknown/network responses are not classified as non-membership. Share links only come from server configuration. Legacy installations without a share link keep their existing enrollment contract.
- Verification: synthetic state, authorization and cleanup tests; new-account scan, live authorized metadata response and real QA NOT RUN. No service restart.
- Rollback: revert this feature before reverting its deployment dependency; retain encrypted account data.
