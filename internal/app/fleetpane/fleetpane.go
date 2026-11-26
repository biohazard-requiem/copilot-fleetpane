// Package fleetpane implements the fleetpane command.
package fleetpane

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/spf13/cobra"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/ui"
)

var version = "dev"

// MinRuntime is the shortest time the process may live. Ghostty treats a
// command that exits within 250ms as failed and prints an error in its pane.
const MinRuntime = 300 * time.Millisecond

const dialTimeout = 2 * time.Second

type options struct {
	socket    string
	themes    string
	closePane string
	stdout    io.Writer
	stderr    io.Writer
	runner    commandRunner
}

// NewCommand returns the fleetpane root command. It returns an error only
// for invalid command-line arguments.
func NewCommand() *cobra.Command {
	return newCommand(runCommand)
}

// newCommand returns the root command. It closes the pane with runner.
func newCommand(runner commandRunner) *cobra.Command {
	opts := options{runner: runner}
	cmd := &cobra.Command{
		Use:     "fleetpane --socket <path> [--themes <dir>] [--close-pane <script>]",
		Short:   "Side pane that visualizes a Copilot CLI session's agent fleet",
		Version: version,
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if opts.socket == "" {
				return errors.New("--socket must not be empty")
			}
			opts.stdout = cmd.OutOrStdout()
			opts.stderr = cmd.ErrOrStderr()
			return run(cmd.Context(), opts)
		},
	}
	cmd.Flags().StringVar(&opts.socket, "socket", "", "path of the Unix socket served by the fleetpane extension")
	cmd.Flags().StringVar(&opts.themes, "themes", "", "directory of custom themes")
	cmd.Flags().StringVar(&opts.closePane, "close-pane", "", "close the hosting Ghostty pane on exit, using this split script (set by the extension)")
	_ = cmd.MarkFlagRequired("socket")
	return cmd
}

// Remaining returns how much longer a process started at start has to run at
// now to have lived for MinRuntime.
func Remaining(start, now time.Time) time.Duration {
	return max(0, MinRuntime-now.Sub(start))
}

// run connects to the extension and shows its snapshots until the user quits
// or the connection ends. Failures are reported on stderr and are not errors:
// only invalid arguments exit non-zero. However it ends, the pane is closed
// if opts.closePane is set, and before anything else becomes visible in it:
// before the TUI leaves the alternate screen, and before a failure is
// reported. When the close works the process is gone by then.
//
// The cursor is hidden first of all: a new pane would show it until the first
// frame, which is not drawn before the connection is made. Bubble Tea shows
// it again only after it has drawn a frame, so a terminal that stays gets it
// back here.
func run(ctx context.Context, opts options) error {
	closeOnce := sync.OnceFunc(func() { closePane(opts.closePane, os.Stdin, opts.runner) })
	fmt.Fprint(opts.stdout, ansi.HideCursor)
	err := show(ctx, opts, closeOnce)
	closeOnce()
	fmt.Fprint(opts.stdout, ansi.ShowCursor)
	if err != nil {
		fmt.Fprintf(opts.stderr, "fleetpane: %v\n", err)
	}
	return nil
}

// show runs the TUI on the extension's snapshots until it quits.
func show(ctx context.Context, opts options, closeOnce func()) error {
	conn, err := net.DialTimeout("unix", opts.socket, dialTimeout)
	if err != nil {
		return err
	}
	defer conn.Close()

	p := tea.NewProgram(ui.New(opts.themes, time.Now()), tea.WithContext(ctx), tea.WithFilter(quitFilter(closeOnce)))
	go pump(conn, p.Send)
	_, err = p.Run()
	return err
}

// quitFilter returns a Bubble Tea filter that calls closeOnce when the
// program is about to quit, while its last frame is still on screen.
func quitFilter(closeOnce func()) func(tea.Model, tea.Msg) tea.Msg {
	return func(_ tea.Model, msg tea.Msg) tea.Msg {
		if _, ok := msg.(tea.QuitMsg); ok {
			closeOnce()
		}
		return msg
	}
}

// pump sends one ui.SnapshotMsg for each snapshot read from r, then one
// ui.DisconnectedMsg when the stream ends or fails.
func pump(r io.Reader, send func(tea.Msg)) {
	dec := protocol.NewDecoder(r)
	for {
		snap, err := dec.Next()
		if err != nil {
			send(ui.DisconnectedMsg{})
			return
		}
		send(ui.SnapshotMsg{Snapshot: snap})
	}
}
