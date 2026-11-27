#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-dev}"
if [[ ! "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "dist: VERSION may only contain letters, digits, '.', '_' and '-': $VERSION" >&2
  exit 1
fi
NAME="fleetpane-$VERSION-darwin-arm64.tar.gz"
# The package is built from go.mod alone: a go.work in use would change what is linked, and go list
# would count its modules as this project's own, so that their licenses were left out.
export GOWORK=off

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/fleetpane"
mkdir -p "$PKG/lib" "$PKG/bin" "$PKG/themes" "$PKG/licenses"

# What hack/install.sh puts in place on a first install, plus the license.
install -m 0644 "$ROOT/extension/extension.mjs" "$ROOT/extension/ghostty-split.applescript" "$ROOT/LICENSE" "$PKG/"
install -m 0644 "$ROOT"/extension/lib/*.mjs "$PKG/lib/"
install -m 0644 "$ROOT/extension/themes/example.json" "$PKG/themes/"
(cd "$ROOT" && GOOS=darwin GOARCH=arm64 go build -trimpath \
  -ldflags "-X github.com/biohazard-requiem/copilot-fleetpane/internal/app/fleetpane.version=$VERSION" \
  -o "$PKG/bin/fleetpane" ./cmd/fleetpane)

# The licenses of what is linked into the binary ask for their notices to go with it: Go itself
# (runtime and standard library) and the third-party modules of this build, as go list reports
# them for darwin/arm64. notices NAME DIR copies the license files at the top of DIR to
# licenses/NAME; for a module, NAME is its path with _ for each /, and its version.
notices() {
  local files file
  files="$(find -H "$2" -maxdepth 1 -type f \
    \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \))"
  if [[ -z "$files" ]]; then
    echo "dist: $1 is linked into the binary, but there is no license file in $2" >&2
    exit 1
  fi
  mkdir "$PKG/licenses/$1"
  # the module cache is read-only: the modes are not copied
  while IFS= read -r file; do
    install -m 0644 "$file" "$PKG/licenses/$1/"
  done <<<"$files"
}

notices go "$(cd "$ROOT" && go env GOROOT)"
MODULES="$(cd "$ROOT" && GOOS=darwin GOARCH=arm64 go list -deps \
  -f '{{with .Module}}{{if not .Main}}{{.Path}} {{.Version}} {{.Dir}}{{end}}{{end}}' ./cmd/fleetpane | sort -u)"
while read -r mod ver dir; do
  # the standard library and this project's own packages give an empty line
  [[ -n "$mod" ]] || continue
  notices "${mod//\//_}@$ver" "$dir"
done <<<"$MODULES"

chmod 0755 "$PKG" "$PKG/lib" "$PKG/bin" "$PKG/themes" "$PKG/bin/fleetpane" "$PKG/licenses" "$PKG/licenses"/*

mkdir -p "$ROOT/dist"
# One top-level directory, so that extracting into extensions/ gives extensions/fleetpane/.
# Neither macOS metadata (it would come out as ._ files) nor the builder's user name goes in.
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --uid 0 --gid 0 --uname root --gname wheel \
  -czf "$ROOT/dist/$NAME" -C "$STAGE" fleetpane

cat <<EOF
Created dist/$NAME
sha256: $(shasum -a 256 "$ROOT/dist/$NAME" | cut -d' ' -f1)

To install it:
  mkdir -p ~/.copilot/extensions
  tar -xzf $NAME -C ~/.copilot/extensions
  copilot config experimental on
EOF
