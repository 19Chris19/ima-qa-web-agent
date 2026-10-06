# DOC-20261006-PUBLIC-DEPLOY-ACCEPTANCE

Owner: provider-admin-20261006
Source: f04d9904dcd3e1e5b15a03a1fedf54666faaca62
Branch: codex/DOC-20261006-PUBLIC-DEPLOY-ACCEPTANCE

## Goal and boundaries
Verify the public candidate (including 5ae0c462), not Air, using clean tracked
Node installation and ARM64 Docker startup with empty synthetic accounts.
Documentation only; no IMA, real credentials, runtime/config mounts, mutation
requests, existing services, deployment, merge or push. Serial image builds.

## Plan
Export fixed tracked source, install clean dependencies, start Node with isolated
synthetic storage and loopback-only ephemeral listener; enforce loopback-only
outbound connections in the temporary host harness. Build original Dockerfile,
run network none/read-only/tmpfs/no host ports, repeat GET auth/contracts/pages.
Distinguish public single knowledge-agent probe from Air seven-request evidence.
Record exact source/image and limitations, clean owned resources.

## Results
Clean npm ci and original Dockerfile build passed. Host Node and Linux ARM64
Docker each passed 54 GET checks, with empty accounts/capacity and no synthetic
token echoes in checked responses/logs. Three Docker healthchecks passed.
Evidence: docs/PUBLIC_DEPLOYMENT_ACCEPTANCE_20261006.md, including exact image ID,
public-vs-Air contract differences, harness corrections and bounded limitations.
Owned processes/container/image/temp files cleaned; no live calls or deployment.

## Rollback
Revert documentation commit only; remove only named synthetic test resources.
