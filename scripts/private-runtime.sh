# Authorized preparation only; sourced after the native deployment gate.
prepare_private_runtime() {
  [ "$DEPLOYMENT_MODE" = independent ] && [ "$ALLOW_BOOTSTRAP" = true ] || return 2
  VERSION=v22.22.3
  if command -v node >/dev/null 2>&1 && node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' >/dev/null 2>&1; then
    NODE=$(command -v node)
  else
    CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/ima-qa-maintenance"
    mkdir -p "$CACHE"
    NAME="node-$VERSION-$SYSTEM-$ARCH"
    NODE="$CACHE/$NAME/bin/node"
    if [ ! -x "$NODE" ]; then
      TEMP=$(mktemp -d "$CACHE/download.XXXXXX")
      trap 'rm -rf "$TEMP"' EXIT HUP INT TERM
      curl --proto '=https' --tlsv1.2 -fsS "https://nodejs.org/dist/$VERSION/$NAME.tar.gz" -o "$TEMP/$NAME.tar.gz"
      curl --proto '=https' --tlsv1.2 -fsS "https://nodejs.org/dist/$VERSION/SHASUMS256.txt" -o "$TEMP/sums"
      EXPECTED=$(awk -v name="$NAME.tar.gz" '$2 == name {print $1}' "$TEMP/sums")
      if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TEMP/$NAME.tar.gz" | awk '{print $1}'); else ACTUAL=$(shasum -a 256 "$TEMP/$NAME.tar.gz" | awk '{print $1}'); fi
      test -n "$EXPECTED" && test "$EXPECTED" = "$ACTUAL" || { echo 'Node runtime checksum failed.' >&2; exit 1; }
      tar -xzf "$TEMP/$NAME.tar.gz" -C "$TEMP"
      test ! -e "$CACHE/$NAME" || { echo 'Runtime destination already exists; inspect it before retrying.' >&2; exit 1; }
      mv "$TEMP/$NAME" "$CACHE/$NAME"
      rm -rf "$TEMP"
      trap - EXIT HUP INT TERM
    fi
  fi
  PATH="$(dirname "$NODE"):$PATH"
  export PATH
  cd "$ROOT"
  if ! "$NODE" -e 'require("playwright-core");require("parse5")' >/dev/null 2>&1; then npm ci --omit=dev >&2; fi
}
