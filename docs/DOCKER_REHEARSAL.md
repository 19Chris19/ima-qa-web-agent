# Docker deployment rehearsal

Baseline: public v0.4.0 (d12950b03440f4048b9ee1985395e7eed10a9c8e).
This rehearsal uses an empty account pool and synthetic scope. It does not
verify IMA sign-in, real answers, refresh longevity or Linux host uptime.

## Reproduce the published baseline

```sh
npm ci
npm run setup:provider-a -- --kb 999000111 --allowed-origins= --host-port 3317
docker compose -p air-provider-baseline up -d --build
curl --noproxy '*' http://127.0.0.1:3317/healthz
```

Use a fresh clone and runtime. Never run this against an existing installation.
The synthetic ID is deliberately not an authorization to query a real library.
Open `/` and `/embed.html`. Health must report zero accounts. The generic
queue's maxConcurrent can be 1 even with zero accounts; use the protected
policy capacity, not that queue ceiling, to determine whether native QA is available.

## Findings and candidate fix

- Original `--allowed-origins ''` becomes `ALLOWED_ORIGINS=true`, causing
  startup validation failure. `--allowed-origins=` works in the original.
  Candidate argument parsing preserves the explicit empty value.
- Original enrolment hint always points to 3117 even when another host port
  was selected. Candidate distinguishes the Docker host port and direct Node port.
- Neither fix changes runtime API, account storage or the Docker image's
  service code. Original and candidate service-image inputs are identical.

Test: `node --test test/setup-port.test.js`, plus `npm test`.
Keep `.env` private (0600), `runtime` private (0700); no credentials in Git.
For another app container, put it on the same private Compose network and
address this service by its service name (for example `http://provider-a:3000`),
not container-local `127.0.0.1`. Keep ordinary, internal and admin credentials separate.
Do not publish `/internal/` through a website gateway.

## Lifecycle

```sh
docker compose -p air-provider-baseline stop
docker compose -p air-provider-baseline up -d --no-build
docker compose -p air-provider-baseline up -d --force-recreate --no-build
docker build --platform linux/amd64 -t air-provider:amd64 .
```

Stop only this project. Do not use `down -v` or global Docker prune. Back up
configuration and the complete runtime while this test service is stopped;
restore into a new directory/volume first. Code rollback uses a retained image
with the current data; do not overwrite current data with an old snapshot.

Docker Desktop runs Linux in a VM; the Air sleeping or Desktop exiting stops
availability. ARM64 native and AMD64 emulated startup do not establish x86
performance or 24/7 production reliability. Containers do not include a desktop
browser; real enrolment remains the documented maintenance-machine CLI workflow.

## Evidence

ARM64 original image: built and started; `/healthz`, `/` and `/embed.html`
respond; empty pool and isolated runtime confirmed. Initial startup failure
with the empty-string CLI argument was reproduced before the parser fix.
Candidate tests: 259 passed on Node 22. Package dry-run: 133 files, no runtime,
private env, key or log paths. Image scan: 47 application files, no lab secrets.
Original Provider container runs as root; this rehearsal does not claim rootless hardening.

AMD64 image built and started under emulation, `/healthz` reports x64, ok,
zero accounts. First download failed ECONNRESET; retry succeeded. During
concurrent host/build load, initial emulated starts hit the existing 20s
account-store worker deadline. A later start succeeded after the build load
finished. This is NOT evidence of stable x86 performance or a reason to weaken
storage locking. Native x86 server startup remains a separate verification.

The companion website authenticated with separate ordinary/internal tokens,
recognized schemaVersion=1 and knowledge_agent_keyed_sse_v1, and reported
ready=false/capacity=0. Wrong credentials were rejected. ARM64 data survived
container recreation. All questions in the companion tests used a fixture,
not this Provider or IMA. No production deployment, push or release was made.
