# Public candidate bounded deployment acceptance

Date: 2026-10-06. Documentation-only candidate evidence, not a production release.
This verifies the public repository, not the Air integration.

## Identity

- Fixed source: `f04d9904dcd3e1e5b15a03a1fedf54666faaca62`.
- `5ae0c462` is an ancestor; generic admin UI and scan-flow source are included.
- Branch: `codex/DOC-20261006-PUBLIC-DEPLOY-ACCEPTANCE`.
- Task-owned worktree registered through shared `manage_worktree.py` with owner
  `provider-admin-20261006`.
- Tracked tar SHA256:
  `b3932b8ccacde07354f8918671cd68a78bc740a3171d375a68bbd3546291d60a`.
- Temporary image: `codex-public-synthetic:f04d9904-i97gld`.
- Image inspect ID:
  `sha256:42e8221cf75a935eefac7b385635b335b2fa5fd482879c4499acd2a9dda33d84`.
- Build config digest:
  `sha256:e6d8899d107765389082007c89fa9712c48f5735473c4c7f0b01168f9ba5c5bf`.
- Base: `node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`.
- Image platform: `linux/arm64`; revision label matches the full source SHA.
- Container ID:
  `76b31b50e9434f382a5a470f8bd16d38ef1bfda5be07f8567444492ca6488f3f`.

## Clean source and installation

The source worktree was clean. Tests did not use its node_modules, runtime,
account store, env files or browser profiles. Export command:

```sh
git archive --format=tar --output="$TMP/source.tar" \
  f04d9904dcd3e1e5b15a03a1fedf54666faaca62 \
  Dockerfile .dockerignore package.json package-lock.json src public scripts \
  provider-a-server.js
```

All 80 tar entries were checked: no links, `.env*`, runtime, node_modules or .git.
Extracted into a new temporary directory. Clean host `npm ci` installed 123
packages successfully (124 audited, zero vulnerabilities reported at that time).
No dependency or application code was changed.

Host run used Node v22.22.3 on Darwin ARM64, the original entrypoint and a fresh
synthetic store. A temporary preload changed only the listener to loopback with
OS-assigned port 0 and rejected non-loopback Node socket connections. The child
received an explicit minimal environment, not the host's credential environment.
HOME and all store/key/report/conversation paths were under the owned temporary
directory, and the runtime env path did not exist. No real browser was launched.
The host guard is a test harness, not an OS network namespace or production setup.
The child was terminated and awaited after each run.

## Docker isolation

Built the unchanged Dockerfile directly from the same tar, once, serially:

```sh
docker build \
  --build-arg SOURCE_REVISION=f04d9904dcd3e1e5b15a03a1fedf54666faaca62 \
  --label codex.audit=public-f04d9904-i97gld \
  -t codex-public-synthetic:f04d9904-i97gld - < "$TMP/source.tar"
```

Build-time registry/npm access was allowed; production install succeeded with
83 packages added (84 audited, zero vulnerabilities reported at that time).
This is not an offline-build claim. Container Node was v22.23.3.

Runtime used `--network none --read-only --user node --cap-drop ALL
--security-opt no-new-privileges:true`, no host ports, no bind/volume mounts.
Independent tmpfs only: `/runtime` mode 0700 UID/GID 1000 and `/tmp` mode 1777,
both noexec/nosuid/nodev. Inspect confirmed these settings; UID was 1000 and an
attempted `/app` write was rejected. `/app/.env`, `/app/runtime` and the configured
nonexistent runtime env file were absent.

Environment selected `ima-web-agent`, synthetic KB ID `123456789`, internal port
3000 and three distinct obvious synthetic API/admin/internal tokens. Account
store, key, conversations and reports were all under `/runtime`; no accounts were
seeded. HTTP checks used `docker exec` and container loopback. No host ingress,
external service, IMA, login, enrollment, verification or question call occurred.

## Results: 54 GET checks per environment

The same corrected assertion script passed **54/54** on clean Node and **54/54**
in Docker. This adapts the previous Air 41-check matrix to actual public routes:

| Category | GET requests | Result |
| --- | ---: | --- |
| `/healthz` | 1 | 200; empty pool, zero active and queued work |
| Five admin routes, five token cases each | 25 | Admin token 200; absent/wrong/API/internal tokens 401 |
| `/internal/provider-a/capacity` | 5 | Internal token 200; absent/wrong/API/admin tokens 401 |
| `/api/conversations` | 5 | API token 200 with empty list; other four cases 401 |
| Four Air-only management paths | 4 | 404 even with admin token |
| Admin/QA pages and static dependencies | 11 | 200 |
| Private/source paths | 3 | 404 |

Admin routes: `/api/admin/accounts`, `/api/admin/bootstrap`,
`/api/admin/exercises/templates`, `/api/admin/exercises/active`,
`/api/admin/exercises/reports`.

Absent Air routes: `/api/admin/v2/accounts/eligibility`,
`/api/admin/qualifications/bootstrap`, `/api/admin/qualifications/active`,
`/api/admin/qualifications/reports`. Their absence is expected public behavior,
not evidence that Air contracts have been migrated.

Pages/assets: `/admin.html`, `/`, `/embed.html`, `/admin.js`, `/admin.css`,
`/client.js`, `/styles.css`, `/answer-renderer.js`, `/qa-experience.js`,
`/vendor/marked.umd.js`, `/vendor/purify.min.js`.
Blocked paths: `/.env`, `/src/config.js`, `/runtime/accounts.json`.
Static admin HTML is public by design; its management APIs remain authenticated.

Additional response assertions:

- Accounts, active enrollment, active exercise and exercise reports were empty.
- Readiness mode `knowledge_agent`, generation 2, capacity/knowledgeAgentCapacity/
  schedulable/basicHealthy/pending all zero. No synthetic account was qualified.
- Capacity schemaVersion 1, maxConcurrent/available/active/queued all zero,
  knowledge_agent policy max_concurrent zero and keyed-SSE support true.
- Health queue maxConcurrent is 1 (implementation floor), not account capacity.
- Every checked response and both startup logs excluded all three exact synthetic
  token values. This is bounded canary-leak checking, not an exhaustive secret audit.
- Docker healthcheck was healthy, failing streak 0; three checks exited 0 at
  approximately 08:36:00, 08:36:30 and 08:37:00 UTC.

Two initial harness assumptions were corrected without product edits: Mac's
installed-browser path discovery reports local_browser/supportsAdminPageQr true,
whereas the browser-free container reports remote_cli/false; and public QA loads
client.js, not app.js. Detection does not prove browser launch, membership or login.

## Public probe is not Air qualification

`src/web-readiness.js` checks one dispatched knowledge_agent request, one terminal,
nonempty answer and knowledge-source evidence, binding the proof to principal,
scope and contract. This is source-level contract inspection only: no probe ran.
The admin page's one-real-question copy was present in fetched HTML.
Public bootstrap has no Air `enrollment.qualification.requestsPerTarget=7` field.
Neither generic health nor this public single-probe contract establishes Air's
six-mode/seven-request qualification, strict profile or migration acceptance.

## Cleanup and limits

Owned host child processes exited. Removed the named Docker container and image;
label-filtered container/image listings were empty afterward. Deleted the owned
temporary source, node_modules, synthetic stores and harness. Shared base images
and build cache were not pruned. No existing service/resource was changed.

No IMA, scan, browser interaction, real account, populated-store migration,
AMD64, sustained load, visual UI or reverse-proxy/TLS acceptance is claimed.
No mutations were sent. No full unit suite was rerun; this is install/start/GET
packaging acceptance. Docker used an explicit non-root runtime override; the
Dockerfile itself does not declare USER node. No deployment, merge or push.
This public repo has no `scripts/check_governance.py`; no root-checker pass is
claimed. Ownership verification and staged whitespace review are recorded at
commit time.
