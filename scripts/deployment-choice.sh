# Sourced by onboard.sh. All messages contain fixed codes, never probe output.
report() {
  printf '{"stage":"%s","mode":"%s","platform":"%s","arch":"%s","missing":[%s],"next":"%s","readOnly":true,"credentialsPrinted":false}\n' \
    "$1" "$DEPLOYMENT_MODE" "$SYSTEM" "$ARCH" "$2" "$3"
}
block() { report blocked "\"$1\"" "$2"; exit 2; }
deployment_gate() {
  DEPLOYMENT_MODE= MODE_SUPPLIED=false SYSTEM=unknown ARCH=unknown ALLOW_BOOTSTRAP=false NODE=
  ACTION=${1:-choose}
  case "$ACTION" in
    choose|preflight|doctor|install|resolve|check|resume|repair|uninstall|browser-install|enroll|tunnel|remote-prepare|runtime) ;;
    *) block invalid_arguments 'Read docs/AGENT_DEPLOYMENT.md.' ;;
  esac
  [ "$#" -eq 0 ] || shift
  while [ "$#" -gt 0 ]; do
    key=$1; shift
    case "$key" in
      --allow-bootstrap)
        [ "$ALLOW_BOOTSTRAP" = false ] || block invalid_arguments 'Supply bootstrap consent only once.'
        case "$ACTION" in install|runtime) ALLOW_BOOTSTRAP=true ;; *) block invalid_arguments 'Bootstrap consent is accepted only for explicit install or runtime commands.' ;; esac ;;
      --deployment-mode)
        [ "$MODE_SUPPLIED" = false ] && [ "$#" -gt 0 ] || block invalid_arguments 'Supply one deployment mode.'
        DEPLOYMENT_MODE=$1; MODE_SUPPLIED=true; shift
        case "$DEPLOYMENT_MODE" in online|shared|independent) ;; *) DEPLOYMENT_MODE=; block invalid_mode 'Choose online, shared or independent.' ;; esac ;;
      --share-url|--target-file|--env|--project|--port|--mode|--image|--name|--server-url|--ssh|--remote-env|--remote-port|--local-port|--directory)
        case "$ACTION" in choose|preflight|doctor) block invalid_arguments 'Read-only commands accept only --deployment-mode.' ;; esac
        [ "$#" -gt 0 ] || block invalid_arguments 'Missing option value.'
        case "$1" in --*) block invalid_arguments 'Missing option value.' ;; esac
        shift ;;
      *) block invalid_arguments 'Read docs/AGENT_DEPLOYMENT.md.' ;;
    esac
  done
  if [ "$MODE_SUPPLIED" = false ]; then
    [ -t 0 ] || block deployment_mode_required 'Ask the user: 1 online, 2 shared, 3 independent; wait for their answer.'
    while :; do
      printf 'Choose before installation (no default):\n1) online: use an operator-provided website; private Explorer needs permission\n2) shared: pending invitation; no raw secrets\n3) independent: run your own generic Provider service\nSelection: ' >&2
      IFS= read -r answer || block deployment_mode_required 'Selection cancelled; nothing installed.'
      case "$answer" in 1|online) DEPLOYMENT_MODE=online; break ;; 2|shared) DEPLOYMENT_MODE=shared; break ;; 3|independent) DEPLOYMENT_MODE=independent; break ;; esac
    done
  fi
  case "$DEPLOYMENT_MODE" in
    online|shared)
      case "$ACTION" in choose|preflight|doctor) ;; *) block independent_mode_required 'This operation requires independent mode and separate consent.' ;; esac
      if [ "$DEPLOYMENT_MODE" = online ]; then
        report online_access '"operator_url_and_access"' 'Ask the operator for a website URL and access; private Explorer is not included. No local install.'
      else
        report pending_invitation '"operator_invitation"' 'Wait for an operator invitation; shared Explorer needs no Provider install. Gateway is candidate-only, not in v0.4.2; see candidate docs/SHARED_GATEWAY.md. Never paste raw secrets.'
      fi
      exit 0 ;;
  esac
  if [ "$ACTION" = choose ]; then
    report mode_selected '' 'Run preflight with --deployment-mode independent; selection is not installation consent.'; exit 0
  fi
  case "$(uname -s)" in Darwin) SYSTEM=darwin ;; Linux) SYSTEM=linux ;; *) block unsupported_os 'Use onboard.ps1 on Windows; review supported Docker platforms.' ;; esac
  case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=x64 ;; *) block unsupported_arch 'Review official Docker architecture support; do not install automatically.' ;; esac
  # Only explicit independent install/runtime consent may reach preparation.
  if [ "$ALLOW_BOOTSTRAP" = true ]; then return; fi
  case "$ACTION" in preflight|doctor)
    command -v docker >/dev/null 2>&1 || block docker_cli 'Docker CLI missing from PATH. Ask consent; see docs/DEPENDENCIES.md for official installation and license/system steps.'
    # Do not forward daemon details: they may contain hostnames or credentials.
    if detail=$(LC_ALL=C docker info --format '{{.ServerVersion}}' 2>&1); then :; else
      case "$detail" in
        *'permission denied'*|*'Permission denied'*|*'access is denied'*|*'Access is denied'*) block docker_permission 'Ask the system owner to review Docker access. No sudo, chmod or group changes are performed.' ;;
        *'Cannot connect to the Docker daemon'*|*'Is the docker daemon running'*|*'is the docker daemon running'*) block docker_daemon_stopped_or_unreachable 'Docker CLI exists. Ask the user to start Docker or check the selected context; do not reinstall.' ;;
        *) block docker_daemon_unavailable 'Docker CLI exists but the daemon probe failed. Review context, connectivity and permissions; do not assume Docker is missing.' ;;
      esac
    fi
    if compose=$(docker compose version --short 2>/dev/null); then
      version=${compose#v}; major=${version%%.*}
      case "$major" in ''|*[!0-9]*) block compose_v2 'Cannot identify Compose major version; review the installed plugin.' ;; esac
      [ "$major" -ge 2 ] 2>/dev/null || block compose_v2 'Compose plugin major 2 or newer is required; review official installation with consent.'
    else block compose_v2 'Compose plugin missing or unusable. Review official installation with consent.'; fi ;;
  esac
  NODE=$(command -v node || :)
  if [ -n "$NODE" ] && "$NODE" -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' >/dev/null 2>&1; then :; else
    NODE="${XDG_CACHE_HOME:-$HOME/.cache}/ima-qa-maintenance/node-v22.22.3-$SYSTEM-$ARCH/bin/node"
    [ -x "$NODE" ] && "$NODE" -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' >/dev/null 2>&1 || block node_22 'Use existing Node 22+ or separately authorize runtime --deployment-mode independent --allow-bootstrap for a private runtime. No bootstrap performed.'
  fi
  (cd "$ROOT" && "$NODE" -e 'for(const name of ["dotenv","playwright-core","parse5"])require.resolve(name)') >/dev/null 2>&1 || block node_dependencies 'Separately authorize runtime --deployment-mode independent --allow-bootstrap for locked dependencies, or approved npm ci; then rerun preflight.'
  case "$ACTION" in preflight|doctor)
    report dependencies_ready '' 'Dependencies only. Inspect existing installation, ports and pinned release before separately authorizing install. No QA verified.'; exit 0 ;;
  esac
}
