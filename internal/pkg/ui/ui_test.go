package ui

import (
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
)

var (
	start = time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)

	keyQ     = tea.KeyPressMsg{Code: 'q', Text: "q"}
	keyCtrlC = tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl}
)

// modelAt returns a model started at start whose clock reads start+elapsed.
func modelAt(elapsed time.Duration) Model {
	m := New("", start)
	m.clock = func() time.Time { return start.Add(elapsed) }
	m.now = start.Add(elapsed)
	return m
}

func isQuit(cmd tea.Cmd) bool {
	if cmd == nil {
		return false
	}
	_, ok := cmd().(tea.QuitMsg)
	return ok
}

func TestKeyPress(t *testing.T) {
	tests := []struct {
		name     string
		elapsed  time.Duration
		key      tea.KeyPressMsg
		wantQuit bool
	}{
		{"q at start is ignored", 0, keyQ, false},
		{"q after 499ms is ignored", 499 * time.Millisecond, keyQ, false},
		{"ctrl+c after 499ms is ignored", 499 * time.Millisecond, keyCtrlC, false},
		{"q after 500ms quits", 500 * time.Millisecond, keyQ, true},
		{"ctrl+c after 500ms quits", 500 * time.Millisecond, keyCtrlC, true},
		{"another key after 500ms does not quit", 500 * time.Millisecond, tea.KeyPressMsg{Code: 'x', Text: "x"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, cmd := modelAt(tt.elapsed).Update(tt.key)
			if got := isQuit(cmd); got != tt.wantQuit {
				t.Errorf("quit = %v, want %v", got, tt.wantQuit)
			}
		})
	}
}

func TestNewUsesWallClock(t *testing.T) {
	if _, cmd := New("", time.Now().Add(time.Hour)).Update(keyQ); isQuit(cmd) {
		t.Error("q before the guard elapsed quit, want it ignored")
	}
	if _, cmd := New("", time.Now().Add(-time.Hour)).Update(keyQ); !isQuit(cmd) {
		t.Error("q an hour after start did not quit")
	}
}

func TestDisconnectedQuits(t *testing.T) {
	if _, cmd := modelAt(0).Update(DisconnectedMsg{}); !isQuit(cmd) {
		t.Error("DisconnectedMsg did not return a quit command")
	}
}

func TestView(t *testing.T) {
	var m tea.Model = modelAt(0)
	m, _ = m.Update(tea.WindowSizeMsg{Width: 57, Height: 45})

	v := m.View()
	if !v.AltScreen || v.WindowTitle != "FleetPane" || v.MouseMode != tea.MouseModeCellMotion {
		t.Errorf("AltScreen = %v, WindowTitle = %q, MouseMode = %v, want true, %q, CellMotion",
			v.AltScreen, v.WindowTitle, v.MouseMode, "FleetPane")
	}
	if !strings.Contains(v.Content, "Connecting…") {
		t.Errorf("view before the first snapshot = %q, want it to contain %q", v.Content, "Connecting…")
	}

	for _, seq := range []int64{42, 43} {
		m, _ = m.Update(SnapshotMsg{Snapshot: protocol.Snapshot{
			Seq:  seq,
			Main: protocol.Main{Status: "working"},
		}})
	}
	v = m.View()
	if !v.AltScreen || v.WindowTitle != "FleetPane" || v.MouseMode != tea.MouseModeCellMotion {
		t.Errorf("AltScreen = %v, WindowTitle = %q, MouseMode = %v, want true, %q, CellMotion",
			v.AltScreen, v.WindowTitle, v.MouseMode, "FleetPane")
	}
	if strings.Contains(v.Content, "Connecting…") {
		t.Errorf("view after a snapshot = %q, want no %q", v.Content, "Connecting…")
	}
	if !strings.Contains(v.Content, "FLEETPANE") && !strings.Contains(ansi.Strip(v.Content), "FLEETPANE") {
		t.Errorf("view after snapshots did not contain FLEETPANE")
	}
	if !strings.Contains(ansi.Strip(v.Content), "working") {
		t.Errorf("view after snapshots did not contain main status working")
	}
}

// Bubble Tea draws the first frame before it reports the size of the window.
// Without a size nothing is laid out: the view is empty, in the same terminal
// modes as every later frame.
func TestViewWithoutSize(t *testing.T) {
	tests := []struct {
		name     string
		w, h     int
		snapshot bool
	}{
		{"size not reported yet", 0, 0, false},
		{"size not reported yet, with a snapshot", 0, 0, true},
		{"no columns", 0, 45, false},
		{"no rows", 57, 0, true},
		{"negative size", -1, -1, false},
		{"negative size, with a snapshot", -1, -1, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var m tea.Model = modelAt(0)
			if tt.w != 0 || tt.h != 0 {
				m, _ = m.Update(tea.WindowSizeMsg{Width: tt.w, Height: tt.h})
			}
			if tt.snapshot {
				m, _ = m.Update(SnapshotMsg{Snapshot: fixtureSW()})
			}

			v := m.View()
			if v.Content != "" {
				t.Errorf("content = %q, want none", v.Content)
			}
			if !v.AltScreen || v.WindowTitle != "FleetPane" || v.MouseMode != tea.MouseModeCellMotion {
				t.Errorf("AltScreen = %v, WindowTitle = %q, MouseMode = %v, want true, %q, CellMotion",
					v.AltScreen, v.WindowTitle, v.MouseMode, "FleetPane")
			}
		})
	}
}
