# Deployment Dependencies And Consent

Choose **online / shared / independent** before cloning, downloading or
installing anything. An agent must ask with its native question tool, or show
a numbered menu and wait. Never infer consent from an installed Docker CLI.
Online needs an operator-provided website and access permission, not Docker.
Shared remains **pending invitation**; shared Explorer does not install Provider.
This selector does not provision a gateway or ask for raw upstream secrets.
The public Provider primarily serves
independent generic deployments. Private Explorer permissions are separate.

Gateway is a separate candidate, not part of v0.4.2 or this branch. Its contract
is in the candidate's `docs/SHARED_GATEWAY.md`; its operator CLI is
`node scripts/shared-gateway.cjs` with `SHARED_GATEWAY_CONFIG` pointing to a
private file outside Git. This is a reference, not an instruction to run it.
No gateway readiness is inferred from selection. As reported by the user on
2026-10-07, Air has no Tailscale on PATH or in `/Applications`, and Provider 3117
still listens on `*`. Real opening remains blocked pending separately approved
network configuration and verification. No live/network changes occur here.

## Read-Only Entry

```sh
sh onboard.sh choose
sh onboard.sh preflight --deployment-mode independent
```

On Windows use `.\onboard.ps1` instead of `sh onboard.sh`. `doctor` aliases
preflight; direct `node scripts/onboard.mjs preflight ...` uses the same native
entry. No Node runtime is needed to select a path or identify missing Docker.
Noninteractive missing mode refuses with exit 2. Read-only commands accept
only `--deployment-mode`; unknown flags and duplicate modes refuse. Existing
`--mode desktop|server` selects installation topology, not deployment path.

The final JSON has `stage`, `mode`, `platform`, `arch`, `missing` (array),
`next`, `readOnly` and `credentialsPrinted`. It reports the first blocker;
rerun after resolving that blocker. Unknown platform/architecture is explicit.
Online/shared and choice-only results leave local platform fields `unknown`
because they do not probe the host. Probe diagnostics are not printed.

| Stage / missing | Meaning and next step |
| --- | --- |
| blocked / deployment_mode_required | Ask the user and wait; no default. |
| online_access / operator_url_and_access | Ask the operator for URL/access; nothing installed. |
| pending_invitation / operator_invitation | Wait for invitation; no gateway activation claim. |
| mode_selected | Selection only, not installation consent. |
| blocked / unsupported_os or unsupported_arch | Review official platform support; do not bootstrap. |
| blocked / docker_cli | CLI not on PATH; check installation/PATH with the user. |
| blocked / docker_daemon_stopped_or_unreachable | CLI exists; daemon may be stopped or selected context unreachable. Ask user to start/check it, not reinstall. |
| blocked / docker_permission | Ask system owner to review access; no automatic elevation. |
| blocked / docker_daemon_unavailable | Unknown daemon/context failure, not proof of missing Docker. |
| blocked / compose_v2 | Compose plugin absent, unusable, unparseable or major version below 2. Newer majors (including 5.x) are accepted. |
| blocked / node_22 or node_dependencies | System/private maintenance runtime or modules missing; no implicit bootstrap/npm install. |
| dependencies_ready | Dependencies only; not installation, login, permissions, browser or QA verification. |

Docker probes are limited to `docker info --format '{{.ServerVersion}}'` and
`docker compose version --short`. They query the current context; a remote
context may make a read-only network request. They do not start the daemon,
pull images, create containers/volumes, change groups, write configuration,
clone, launch a browser or make an IMA request. Port and existing-state checks
remain in the original installer; this preflight does not claim to verify them.

## Official Docker Setup Is A Separate Human Step

Explain the proposed dependency changes, download source and system impact,
then obtain explicit consent. Never run a convenience install script, package
manager, privileged command, daemon start, group edit or license acceptance
as part of selection/preflight.

- [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/): select Apple silicon or Intel as appropriate. The user reviews the subscription agreement and completes any macOS security or privileged configuration prompts. Do not accept license terms for them.
- [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/): check the official OS/architecture requirements, virtualization and WSL/Hyper-V requirements. The user handles Windows elevation, required feature changes/restarts and license review. No execution-policy bypass.
- [Docker Engine on Linux](https://docs.docker.com/engine/install/): follow the official distribution-specific instructions with consent. Service start and account permissions are separate approved system changes.
- [Linux post-installation](https://docs.docker.com/engine/install/linux-postinstall/): Docker group membership grants root-level privileges. Do not fix access by blindly adding a user or making the socket world-writable; discuss the supported rootless option with the system owner.
- [Compose plugin](https://docs.docker.com/compose/install/): Desktop includes Compose; Linux Engine may need the Compose plugin separately. The `docker compose` command must work and report major version >=2; newer majors are not rejected merely for exceeding 2. A legacy `docker-compose` binary is not this command.

Docker Desktop licensing depends on use and organization; the user must
review current official terms and subscription eligibility. This project
does not grant a Docker license. Detection of x64/arm64 is not certification
of the OS version, virtualization support or Windows ARM compatibility.

## Maintenance Runtime

Global Node is **not required**. Preflight and ordinary operations can reuse
the original private Node cache (22.22.3) or an existing Node 22+ on PATH.
After independent selection and separate explicit approval, the native wrapper
retains the original checksum-verified private runtime preparation:

```sh
sh onboard.sh runtime --deployment-mode independent --allow-bootstrap
# Or, only when service installation is also approved:
sh onboard.sh install --deployment-mode independent --allow-bootstrap --share-url '<official-share-url>'
```

PowerShell accepts the same command/flags via `.\onboard.ps1`. Only `runtime`
and `install` accept `--allow-bootstrap`. Choice/doctor/preflight reject it.
Without the flag, missing runtime/dependencies refuse without downloads.
The approved path keeps HTTPS/SHA-256 checks, the private cache location,
no-overwrite checks, matching maintenance dependencies and `npm ci --omit=dev`.
Shell preparation needs curl, tar, awk, mktemp and a SHA-256 tool (sha256sum
or shasum); PowerShell uses its existing web/archive/hash commands. Missing
bootstrap tools are not installed automatically. This does not require a
global Node installation.
It never installs Docker or changes system permissions. Explain that npm
downloads code and can execute lifecycle scripts before obtaining consent.
An independently approved [Node.js runtime](https://nodejs.org/en/download)
and manual locked `npm ci` remain alternatives. Git is needed only for an
authorized checkout; an approved complete source archive is also supported.
Neither is fetched by these wrappers.

**Downstream break:** Explorer's old Provider `runtime` invocation must add
`--deployment-mode independent`, and add `--allow-bootstrap` only following
explicit preparation approval. Online/shared must skip Provider runtime/clone
entirely. See the exact Shell/PowerShell invocation changes in
[AGENT_DEPLOYMENT.md](./AGENT_DEPLOYMENT.md). This branch does not modify Explorer;
the candidate must not be presented as cross-repository release-ready.

Rerun preflight, review the pinned release/image, existing installation and
ports, then obtain service-install approval. Existing digest, ownership,
orphan-volume, loopback and resume protections remain in the installer.
Desktop installation still downloads the matching Chromium and registers a
user helper after approval. No dependency readiness result proves enrollment
or real QA; those retain their separate human consent gates.
