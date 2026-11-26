#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-dev}"
if [[ ! "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "dist: VERSION may only contain letters, digits, '.', '_' and '-': $VERSION" >&2
  exit 1
fi
NAME="fleetpane-$VERSION-darwin-arm64.tar.gz"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/fleetpane"
mkdir -p "$PKG/lib" "$PKG/bin" "$PKG/themes"

# What hack/install.sh puts in place on a first install, plus the license.
install -m 0644 "$ROOT/extension/extension.mjs" "$ROOT/extension/ghostty-split.applescript" "$ROOT/LICENSE" "$PKG/"
install -m 0644 "$ROOT"/extension/lib/*.mjs "$PKG/lib/"
install -m 0644 "$ROOT/extension/themes/example.json" "$PKG/themes/"
(cd "$ROOT" && GOOS=darwin GOARCH=arm64 go build -trimpath \
  -ldflags "-X github.com/biohazard-requiem/copilot-fleetpane/internal/app/fleetpane.version=$VERSION" \
  -o "$PKG/bin/fleetpane" ./cmd/fleetpane)
chmod 0755 "$PKG" "$PKG/lib" "$PKG/bin" "$PKG/themes" "$PKG/bin/fleetpane"

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
