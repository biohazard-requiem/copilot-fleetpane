#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${COPILOT_HOME:-$HOME/.copilot}/extensions/fleetpane"

# Nothing is installed through a link: the files would end up wherever it leads.
for dir in "$DEST" "$DEST/lib" "$DEST/bin" "$DEST/themes"; do
  if [[ -L "$dir" ]]; then
    echo "install: refusing to install into a symbolic link: $dir" >&2
    exit 1
  fi
done

mkdir -p "$DEST/lib" "$DEST/bin" "$DEST/themes"

# Copy next to the target, then rename. The swap is atomic, so a running pane keeps its
# old binary; and a link at the target is replaced, where cp would write to what it leads to.
put() {
  local tmp="$2.tmp.$$"
  cp "$1" "$tmp"
  # when the link leads to a directory, mv would move the file into that directory
  if [[ -L "$2" ]]; then
    rm -f "$2"
  fi
  mv -f "$tmp" "$2"
}

put "$ROOT/extension/extension.mjs" "$DEST/extension.mjs"
put "$ROOT/extension/ghostty-split.applescript" "$DEST/ghostty-split.applescript"
for f in "$ROOT"/extension/lib/*.mjs; do
  put "$f" "$DEST/lib/${f##*/}"
done
put "$ROOT/bin/fleetpane" "$DEST/bin/fleetpane"

# Files the user may have edited (config.json, themes) are never overwritten.
if [[ -f "$ROOT/extension/themes/example.json" && ! -e "$DEST/themes/example.json" && ! -L "$DEST/themes/example.json" ]]; then
  put "$ROOT/extension/themes/example.json" "$DEST/themes/example.json"
fi

cat <<EOF
Installed fleetpane to $DEST

Next steps:
  1. Enable experimental features so the CLI loads extensions:
       copilot config experimental on
  2. Start a new Copilot session and run /extensions manage; "fleetpane" should be listed.
EOF
