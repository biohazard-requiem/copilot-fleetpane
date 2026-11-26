package fleetpane

import (
	"context"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

const closeTimeout = 3 * time.Second

// ttyPattern matches the device of a macOS pseudo-terminal.
var ttyPattern = regexp.MustCompile(`^/dev/ttys\d+$`)

// commandRunner runs a command and returns its standard output. A nil stdin
// stands for the null device.
type commandRunner func(ctx context.Context, stdin *os.File, name string, args ...string) (string, error)

// closePane asks Ghostty, through the split script, to close the pane whose
// terminal is stdin: Ghostty keeps the pane of an exited command open. It is
// best effort. Nothing happens without a script or when stdin is not a
// terminal, and failures are ignored.
func closePane(script string, stdin *os.File, runner commandRunner) {
	if script == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), closeTimeout)
	defer cancel()

	out, err := runner(ctx, stdin, "/usr/bin/tty")
	tty := strings.TrimSpace(out)
	if err != nil || !ttyPattern.MatchString(tty) {
		return
	}
	_, _ = runner(ctx, nil, "/usr/bin/osascript", script, "close-tty", tty)
}

// runCommand is the commandRunner that executes real commands. Their
// standard error is discarded.
func runCommand(ctx context.Context, stdin *os.File, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	// Assigning a nil *os.File would make Stdin a non-nil interface.
	if stdin != nil {
		cmd.Stdin = stdin
	}
	out, err := cmd.Output()
	return string(out), err
}
