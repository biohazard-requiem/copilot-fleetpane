// Package ui implements the FleetPane terminal interface.
package ui

import (
	"fmt"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

// inputGuard is how long after start key presses are ignored: keys typed
// while Ghostty splits the window can land in the new pane.
const inputGuard = 500 * time.Millisecond

var defaultTheme = mustLoadDefaultTheme()

func mustLoadDefaultTheme() *theme.Theme {
	th, err := theme.Load("gta6", "")
	if err != nil {
		panic(fmt.Sprintf("ui: built-in gta6 theme failed to load: %v", err))
	}
	return th
}

// SnapshotMsg carries a snapshot received from the extension.
type SnapshotMsg struct {
	Snapshot protocol.Snapshot
}

// DisconnectedMsg reports that the snapshot stream has ended.
type DisconnectedMsg struct{}

// Model is the Bubble Tea model of the pane.
type Model struct {
	snap          protocol.Snapshot
	connected     bool
	width         int
	height        int
	selected      string // selected item ID ("main" or agent.ID); empty shows all activity
	showLog       bool   // compact layout only: activity page visible
	logFollow     bool   // activity sticks to the bottom on new entries
	logTop        int64  // first visible log entry seq when !logFollow
	runOffset     int    // first visible row in the compact-rows run area
	backOffset    int    // index of first visible entry in back to main
	listOffset    int    // first visible row in compact layout list
	animating     bool   // whether the 140ms animation tick chain is active
	frame         int    // spinner and connector-dot animation frame
	now           time.Time
	clock         func() time.Time                                     // injectable wall clock for inputGuard and clock ticks
	tick          func(time.Duration, func(time.Time) tea.Msg) tea.Cmd // injectable timer (defaults to tea.Tick)
	startedAt     time.Time
	themeName     string
	theme         *theme.Theme
	themeErr      string // theme load failure shown in status bar
	themesDir     string
	dark          bool // terminal background is dark (default true)
	bgQueryGen    int  // invalidates stale background-color query ticks
	bgQueryActive bool // whether a background-color query loop is armed

	// Cached palm silhouette mask for (maskW, maskH), refreshed on resize.
	mask  theme.Mask
	maskW int
	maskH int
}

// New returns a Model that started at now. themesDir is the directory of
// custom themes, empty for none.
func New(themesDir string, now time.Time) Model {
	return Model{
		logFollow: true,
		now:       now,
		clock:     time.Now,
		startedAt: now,
		themeName: "gta6",
		theme:     defaultTheme,
		themesDir: themesDir,
		dark:      true,
	}
}

func (m Model) currentClock() time.Time {
	if m.clock != nil {
		return m.clock()
	}
	return time.Now()
}

func (m Model) activeTheme() *theme.Theme {
	if m.theme != nil {
		return m.theme
	}
	return defaultTheme
}

func (m Model) hasSnapshot() bool {
	return m.connected ||
		m.snap.Seq != 0 ||
		m.snap.Session != "" ||
		m.snap.Main.Status != "" ||
		len(m.snap.Agents) > 0 ||
		len(m.snap.Log) > 0
}

func (m Model) after(d time.Duration, fn func(time.Time) tea.Msg) tea.Cmd {
	if m.tick != nil {
		return m.tick(d, fn)
	}
	return tea.Tick(d, fn)
}

func (m *Model) refreshMask() {
	th := m.activeTheme()
	if m.width > 0 && m.height > 0 && th.HasBackground() && th.Decor().Kind == theme.DecorPalms {
		if m.maskW != m.width || m.maskH != m.height {
			m.mask = theme.PalmMask(m.width, m.height)
			m.maskW = m.width
			m.maskH = m.height
		}
	}
}

// View implements tea.Model. Without a size there is nothing to lay out: the
// first frame, which Bubble Tea draws before it reports the size, is empty.
func (m Model) View() tea.View {
	th := m.activeTheme()
	var content string
	if m.width > 0 && m.height > 0 {
		c, _ := layout(m)
		mask := m.mask
		if th.HasBackground() && th.Decor().Kind == theme.DecorPalms && (m.maskW != c.W || m.maskH != c.H) {
			mask = theme.PalmMask(c.W, c.H)
		}
		content = c.Render(th, m.dark, mask)
	}
	v := tea.NewView(content)
	v.AltScreen = true
	v.WindowTitle = "FleetPane"
	v.MouseMode = tea.MouseModeCellMotion
	if bg, ok := th.FirstStop(); ok {
		v.BackgroundColor = bg
	}
	return v
}
