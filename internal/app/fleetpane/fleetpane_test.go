package fleetpane

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/spf13/cobra"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/ui"
)

// describe names a message sent by pump.
func describe(msg tea.Msg) string {
	switch msg := msg.(type) {
	case ui.SnapshotMsg:
		return fmt.Sprintf("snapshot %d", msg.Snapshot.Seq)
	case ui.DisconnectedMsg:
		return "disconnected"
	default:
		return fmt.Sprintf("%T", msg)
	}
}

func TestPump(t *testing.T) {
	tests := []struct {
		name string
		r    io.Reader
		want []string
	}{
		{
			name: "two snapshots then the stream ends",
			r:    strings.NewReader(`{"seq":1}` + "\n" + `{"seq":2}` + "\n"),
			want: []string{"snapshot 1", "snapshot 2", "disconnected"},
		},
		{
			name: "one snapshot then a read error",
			r:    io.MultiReader(strings.NewReader(`{"seq":1}`+"\n"), iotest.ErrReader(errors.New("boom"))),
			want: []string{"snapshot 1", "disconnected"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			pump(tt.r, func(msg tea.Msg) { got = append(got, describe(msg)) })
			if !slices.Equal(got, tt.want) {
				t.Errorf("sent %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRemaining(t *testing.T) {
	start := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name    string
		elapsed time.Duration
		want    time.Duration
	}{
		{"50ms elapsed waits 250ms more", 50 * time.Millisecond, 250 * time.Millisecond},
		{"400ms elapsed does not wait", 400 * time.Millisecond, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Remaining(start, start.Add(tt.elapsed)); got != tt.want {
				t.Errorf("Remaining() = %v, want %v", got, tt.want)
			}
		})
	}
}

// execute runs the root command with args and returns what it wrote to stderr.
func execute(args ...string) (string, error) {
	return executeCommand(NewCommand(), args...)
}

// executeCommand runs cmd with args and returns what it wrote to stderr.
func executeCommand(cmd *cobra.Command, args ...string) (string, error) {
	var stderr bytes.Buffer
	// A nil slice would make Cobra fall back to os.Args.
	cmd.SetArgs(append([]string{}, args...))
	cmd.SetOut(io.Discard)
	cmd.SetErr(&stderr)
	err := cmd.Execute()
	return stderr.String(), err
}

func TestMissingSocketFlag(t *testing.T) {
	for _, args := range [][]string{nil, {"--themes", "themes"}} {
		_, err := execute(args...)
		if err == nil || !strings.Contains(err.Error(), "socket") {
			t.Errorf("args %q: error = %v, want an error about --socket", args, err)
		}
	}
}

func TestUnexpectedArgument(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "absent.sock")
	if _, err := execute("--socket", socket, "extra"); err == nil {
		t.Error("a positional argument was accepted, want an error")
	}
}

func TestAbsentSocket(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "absent.sock")
	stderr, err := execute("--socket", socket, "--themes", "themes")
	if err != nil {
		t.Errorf("error = %v, want nil so that the exit code is 0", err)
	}
	if !strings.Contains(stderr, socket) {
		t.Errorf("stderr = %q, want a message naming %s", stderr, socket)
	}
}

// The sequences that hide and show the cursor of the terminal.
const (
	hideCursor = "\x1b[?25l"
	showCursor = "\x1b[?25h"
)

// The cursor of a new pane is hidden before anything else is written. It is
// still hidden while the pane is closed, and it is back before a failure is
// reported, for a terminal that stays.
func TestCursorIsHiddenFirst(t *testing.T) {
	// What the terminal gets: standard output and standard error alike.
	var terminal bytes.Buffer
	var seen []string
	runner := func(_ context.Context, _ *os.File, name string, _ ...string) (string, error) {
		seen = append(seen, name+":"+terminal.String())
		return "/dev/ttys004\n", nil
	}
	socket := filepath.Join(t.TempDir(), "absent.sock")
	cmd := newCommand(runner)
	cmd.SetArgs([]string{"--socket", socket, "--close-pane", splitScript})
	cmd.SetOut(&terminal)
	cmd.SetErr(&terminal)
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if want := []string{"/usr/bin/tty:" + hideCursor, "/usr/bin/osascript:" + hideCursor}; !slices.Equal(seen, want) {
		t.Errorf("commands and the terminal at the time = %q, want %q", seen, want)
	}
	got := terminal.String()
	if !strings.HasPrefix(got, hideCursor+showCursor+"fleetpane: ") || !strings.Contains(got, socket) || strings.Count(got, "\n") != 1 {
		t.Errorf("terminal = %q, want the cursor hidden, then shown, then only the dial failure", got)
	}
}

// closingWriter closes its listener, which removes the socket, at the first
// write.
type closingWriter struct {
	bytes.Buffer
	ln net.Listener
}

func (w *closingWriter) Write(p []byte) (int, error) {
	_ = w.ln.Close()
	return w.Buffer.Write(p)
}

// The socket is served until the first byte reaches the terminal. Connecting
// before that would succeed and start the TUI; connecting after it fails.
func TestCursorIsHiddenBeforeConnecting(t *testing.T) {
	// A relative path keeps the address within the limit of a Unix socket.
	t.Chdir(t.TempDir())
	ln, err := net.Listen("unix", "pane.sock")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	stdout := &closingWriter{ln: ln}
	var stderr bytes.Buffer
	cmd := NewCommand()
	cmd.SetArgs([]string{"--socket", "pane.sock"})
	cmd.SetOut(stdout)
	cmd.SetErr(&stderr)
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if got := stdout.String(); !strings.HasPrefix(got, hideCursor) {
		t.Errorf("stdout = %q, want it to start by hiding the cursor", got)
	}
	if got := stderr.String(); !strings.Contains(got, "pane.sock") {
		t.Errorf("stderr = %q, want the failure to connect to the socket closed at the first write", got)
	}
}

// Nothing is hidden when the command does not run: the terminal is the user's.
func TestCursorIsLeftAlone(t *testing.T) {
	for _, args := range [][]string{{}, {"--socket", ""}, {"--socket", "pane.sock", "extra"}, {"--help"}, {"--version"}} {
		var terminal bytes.Buffer
		cmd := NewCommand()
		cmd.SetArgs(args)
		cmd.SetOut(&terminal)
		cmd.SetErr(&terminal)
		_ = cmd.Execute()
		if got := terminal.String(); strings.Contains(got, "\x1b") {
			t.Errorf("args %q: terminal = %q, want no escape sequence", args, got)
		}
	}
}
