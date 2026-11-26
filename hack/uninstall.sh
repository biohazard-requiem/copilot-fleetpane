#!/usr/bin/env bash
set -euo pipefail

DEST="${COPILOT_HOME:-$HOME/.copilot}/extensions/fleetpane"
# Same choice as runtimeDir in extension/lib/server.mjs: the variable counts only
# when it is an absolute path.
RUNTIME_DIR="${FLEETPANE_RUNTIME_DIR:-}"
if [[ "$RUNTIME_DIR" != /* ]]; then
  RUNTIME_DIR="/tmp/fleetpane-$(id -u)"
fi

if [[ "$DEST" != */extensions/fleetpane ]]; then
  echo "uninstall: refusing to remove unexpected path: $DEST" >&2
  exit 1
fi
rm -rf "$DEST"

# Same rule as sweepStale in extension/lib/server.mjs: only the names FleetPane
# writes there are looked at, the whole name has to match, and the file is stale
# only when the pid in it is gone (ESRCH). A kill failure for any other reason
# leaves the file alone.
SWEPT='^([A-Za-z0-9_-]{1,64}\.([1-9][0-9]*)\.([0-9]+\.sock|log)|override\.([1-9][0-9]*)\.([1-9][0-9]*\.tmp\.)?json)$'

pid_gone() {
  local err
  err="$(LC_ALL=C kill -0 "$1" 2>&1)" && return 1
  [[ "$err" == *"No such process"* ]]
}

# Swept only when it is a real directory of this user: behind a link, or in a
# directory of someone else, files with these names can be anybody's.
pane_open=0
if [[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" && -O "$RUNTIME_DIR" ]]; then
  shopt -s nullglob
  for f in "$RUNTIME_DIR"/*; do
    [[ "${f##*/}" =~ $SWEPT ]] || continue
    pid="${BASH_REMATCH[2]:-${BASH_REMATCH[4]}}"
    if pid_gone "$pid"; then
      rm -f "$f"
    elif [[ "$f" == *.sock ]]; then
      pane_open=1
    fi
  done
  shopt -u nullglob
  rmdir "$RUNTIME_DIR" 2>/dev/null || true
elif [[ -e "$RUNTIME_DIR" || -L "$RUNTIME_DIR" ]]; then
  echo "uninstall: left $RUNTIME_DIR alone: not a real directory owned by the current user" >&2
fi

cat <<EOF
Removed $DEST

"experimental" is a Copilot CLI setting and was left unchanged. To turn it off:
  copilot config experimental off
EOF

if [[ "$pane_open" == 1 ]]; then
  cat <<EOF

A Copilot session that is still open keeps its pane until the session ends. The
pane can then no longer close itself: press any key in it to close it. Run
"make uninstall" again afterwards to remove what such a session leaves behind.
EOF
fi
