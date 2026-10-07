#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$ROOT/scripts/deployment-choice.sh"
deployment_gate "$@"
# Preparation requires both independent mode and explicit bootstrap consent.
umask 077
if [ "$ALLOW_BOOTSTRAP" = true ]; then
  . "$ROOT/scripts/private-runtime.sh"
  prepare_private_runtime
fi
for argument do
  shift
  [ "$argument" = '--allow-bootstrap' ] || set -- "$@" "$argument"
done
if [ "$MODE_SUPPLIED" = false ]; then set -- "$@" --deployment-mode "$DEPLOYMENT_MODE"; fi
PATH="$(dirname "$NODE"):$PATH"
export PATH
cd "$ROOT"
exec "$NODE" scripts/onboard.mjs "$@"
