package fleetpane

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
)

const splitScript = "/repo/extension/ghostty-split.applescript"

var (
	ttyCommand   = []string{"/usr/bin/tty"}
	closeCommand = []string{"/usr/bin/osascript", splitScript, "close-tty", "/dev/ttys004"}
)

// call is one command passed to a recorder.
type call struct {
	stdin   *os.File
	command []string
	timeout time.Duration
}

// recorder is a commandRunner that records commands instead of running them.
// It answers /usr/bin/tty with ttyOut and ttyErr, anything else with closeErr.
type recorder struct {
	ttyOut   string
	ttyErr   error
	closeErr error
	calls    []call
}

func (r *recorder) run(ctx context.Context, stdin *os.File, name string, args ...string) (string, error) {
	c := call{stdin: stdin, command: append([]string{name}, args...)}
	if deadline, ok := ctx.Deadline(); ok {
		c.timeout = time.Until(deadline)
	}
	r.calls = append(r.calls, c)
	if name == "/usr/bin/tty" {
		return r.ttyOut, r.ttyErr
	}
	return "", r.closeErr
}

// check reports recorded commands that differ from want.
func (r *recorder) check(t *testing.T, want ...[]string) {
	t.Helper()
	var got [][]string
	for _, c := range r.calls {
		got = append(got, c.command)
	}
	if !slices.EqualFunc(got, want, slices.Equal[[]string]) {
		t.Errorf("ran %q, want %q", got, want)
	}
}

func TestClosePane(t *testing.T) {
	failed := errors.New("exit status 1")
	tests := []struct {
		name   string
		script string
		rec    recorder
		want   [][]string
	}{
		{
			name: "without a script nothing runs",
			rec:  recorder{ttyOut: "/dev/ttys004\n"},
		},
		{
			name:   "the terminal on stdin is closed",
			script: splitScript,
			rec:    recorder{ttyOut: "/dev/ttys004\n"},
			want:   [][]string{ttyCommand, closeCommand},
		},
		{
			name:   "stdin is not a terminal",
			script: splitScript,
			rec:    recorder{ttyOut: "not a tty\n", ttyErr: failed},
			want:   [][]string{ttyCommand},
		},
		{
			name:   "tty fails",
			script: splitScript,
			rec:    recorder{ttyOut: "/dev/ttys004\n", ttyErr: failed},
			want:   [][]string{ttyCommand},
		},
		{
			name:   "tty prints more than a device",
			script: splitScript,
			rec:    recorder{ttyOut: "/dev/ttys004; rm -rf x\n"},
			want:   [][]string{ttyCommand},
		},
		{
			name:   "tty prints two devices",
			script: splitScript,
			rec:    recorder{ttyOut: "/dev/ttys004\n/dev/ttys005\n"},
			want:   [][]string{ttyCommand},
		},
		{
			name:   "tty prints another kind of device",
			script: splitScript,
			rec:    recorder{ttyOut: "/dev/console\n"},
			want:   [][]string{ttyCommand},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			closePane(tt.script, os.Stdin, tt.rec.run)
			tt.rec.check(t, tt.want...)
		})
	}
}

func TestClosePaneStdinAndTimeout(t *testing.T) {
	stdin, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()

	rec := recorder{ttyOut: "/dev/ttys004\n"}
	closePane(splitScript, stdin, rec.run)
	if len(rec.calls) != 2 {
		t.Fatalf("ran %d commands, want 2", len(rec.calls))
	}
	if got := rec.calls[0].stdin; got != stdin {
		t.Errorf("tty ran with stdin %v, want the given file", got)
	}
	if got := rec.calls[1].stdin; got != nil {
		t.Errorf("osascript ran with stdin %v, want none", got)
	}
	if got := rec.calls[1].timeout; got <= 2*time.Second || got > 3*time.Second {
		t.Errorf("osascript ran with %v left, want a 3s timeout", got)
	}
}

func TestRunCommand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stdin")
	if err := os.WriteFile(path, []byte("hello\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stdin, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()

	if got, err := runCommand(t.Context(), stdin, "/bin/cat"); got != "hello\n" || err != nil {
		t.Errorf("cat of a file = %q, %v, want its content", got, err)
	}
	if got, err := runCommand(t.Context(), nil, "/bin/cat"); got != "" || err != nil {
		t.Errorf("cat without stdin = %q, %v, want nothing", got, err)
	}
	if _, err := runCommand(t.Context(), nil, "/usr/bin/false"); err == nil {
		t.Error("false succeeded, want an error")
	}
}

func TestDialFailureClosesPane(t *testing.T) {
	tests := []struct {
		name     string
		closeErr error
	}{
		{"osascript succeeds", nil},
		{"osascript fails", errors.New("exit status 1")},
		{"osascript times out", context.DeadlineExceeded},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := recorder{ttyOut: "/dev/ttys004\n", closeErr: tt.closeErr}
			socket := filepath.Join(t.TempDir(), "absent.sock")
			stderr, err := executeCommand(newCommand(rec.run), "--socket", socket, "--close-pane", splitScript)
			if err != nil {
				t.Errorf("error = %v, want nil so that the exit code is 0", err)
			}
			if !strings.Contains(stderr, socket) || strings.Count(stderr, "\n") != 1 {
				t.Errorf("stderr = %q, want only the dial failure", stderr)
			}
			rec.check(t, ttyCommand, closeCommand)
			if len(rec.calls) > 0 && rec.calls[0].stdin != os.Stdin {
				t.Errorf("tty ran with stdin %v, want the process's", rec.calls[0].stdin)
			}
		})
	}
}

// The pane is closed before the failure is reported: when the close works the
// process is gone before anything is printed into the pane.
func TestDialFailureIsReportedAfterTheClose(t *testing.T) {
	var stderr bytes.Buffer
	var seen []string
	runner := func(_ context.Context, _ *os.File, name string, _ ...string) (string, error) {
		seen = append(seen, name+":"+stderr.String())
		return "/dev/ttys004\n", nil
	}
	cmd := newCommand(runner)
	cmd.SetArgs([]string{"--socket", filepath.Join(t.TempDir(), "absent.sock"), "--close-pane", splitScript})
	cmd.SetOut(io.Discard)
	cmd.SetErr(&stderr)
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if want := []string{"/usr/bin/tty:", "/usr/bin/osascript:"}; !slices.Equal(seen, want) {
		t.Errorf("commands and stderr at the time = %q, want %q", seen, want)
	}
	if stderr.Len() == 0 {
		t.Error("stderr is empty after a failed close, want the dial failure")
	}
}

func TestQuitFilter(t *testing.T) {
	closed := 0
	filter := quitFilter(func() { closed++ })
	if msg := filter(nil, tea.KeyPressMsg{Code: 'x', Text: "x"}); msg == nil || closed != 0 {
		t.Errorf("a key press: msg = %v, closed %d times, want it passed on and no close", msg, closed)
	}
	if msg := filter(nil, tea.QuitMsg{}); msg == nil || closed != 1 {
		t.Errorf("quit: msg = %v, closed %d times, want it passed on after one close", msg, closed)
	}
}

func TestPaneIsKept(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "absent.sock")
	tests := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{name: "no --close-pane", args: []string{"--socket", socket}},
		{name: "missing --socket", args: []string{"--close-pane", splitScript}, wantErr: "socket"},
		{name: "empty --socket", args: []string{"--socket", "", "--close-pane", splitScript}, wantErr: "socket"},
		{name: "unknown flag", args: []string{"--socket", socket, "--close-pane", splitScript, "--bogus"}, wantErr: "bogus"},
		{name: "--help", args: []string{"--socket", socket, "--close-pane", splitScript, "--help"}},
		{name: "--version", args: []string{"--socket", socket, "--close-pane", splitScript, "--version"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := recorder{ttyOut: "/dev/ttys004\n"}
			_, err := executeCommand(newCommand(rec.run), tt.args...)
			if tt.wantErr == "" && err != nil {
				t.Errorf("error = %v, want nil", err)
			}
			if tt.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tt.wantErr)) {
				t.Errorf("error = %v, want an error about %s", err, tt.wantErr)
			}
			rec.check(t)
		})
	}
}
