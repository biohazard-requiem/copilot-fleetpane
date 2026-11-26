package ui

import (
	"fmt"
	"image"
	"slices"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

const (
	clockTickInterval = time.Second
	animTickInterval  = 140 * time.Millisecond
	bgQueryDelay      = 100 * time.Millisecond
	bgQueryInterval   = 2 * time.Second
)

type clockTickMsg time.Time
type animTickMsg time.Time
type bgQueryTickMsg struct{ gen int }

// hasSpinner reports whether any spinner is active on screen: that of the
// working main agent or of a running sub-agent. One waiting for the user
// shows a static mark instead.
func hasSpinner(snap protocol.Snapshot) bool {
	if snap.Main.Status == "working" && snap.Main.Wait == "" {
		return true
	}
	for _, a := range snap.Agents {
		if a.Status == "running" && a.Wait == "" {
			return true
		}
	}
	return false
}

func (m Model) clockTickCmd() tea.Cmd {
	return m.after(clockTickInterval, func(t time.Time) tea.Msg { return clockTickMsg(t) })
}

func (m Model) animTickCmd() tea.Cmd {
	return m.after(animTickInterval, func(t time.Time) tea.Msg { return animTickMsg(t) })
}

func (m Model) bgQueryTickCmd(d time.Duration, gen int) tea.Cmd {
	return m.after(d, func(time.Time) tea.Msg { return bgQueryTickMsg{gen: gen} })
}

func batchCmds(cmds ...tea.Cmd) tea.Cmd {
	var nonNil []tea.Cmd
	for _, c := range cmds {
		if c != nil {
			nonNil = append(nonNil, c)
		}
	}
	switch len(nonNil) {
	case 0:
		return nil
	case 1:
		return nonNil[0]
	default:
		return tea.Batch(nonNil...)
	}
}

// Init implements tea.Model.
func (m Model) Init() tea.Cmd {
	var cmds []tea.Cmd
	cmds = append(cmds, m.clockTickCmd())
	if !m.activeTheme().HasBackground() {
		cmds = append(cmds, tea.RequestBackgroundColor, m.bgQueryTickCmd(bgQueryInterval, m.bgQueryGen))
	}
	return batchCmds(cmds...)
}

// Update implements tea.Model.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		if chooseLayout(m.width, m.height) != layoutCompact {
			m.showLog = false
		}
		m.refreshMask()
		m.clampOffsets()
	case SnapshotMsg:
		m.snap = msg.Snapshot
		m.connected = true
		if m.selected != "" && !slices.Contains(m.selectableIDs(), m.selected) {
			m.selected = ""
			m.showLog = false
			m.logFollow = true
			m.logTop = 0
		}
		bgCmd := m.applyTheme(msg.Snapshot.Theme)
		m.clampOffsets()
		var animCmd tea.Cmd
		if hasSpinner(m.snap) && !m.animating {
			m.animating = true
			animCmd = m.animTickCmd()
		}
		return m, batchCmds(bgCmd, animCmd)
	case DisconnectedMsg:
		return m, tea.Quit
	case clockTickMsg:
		m.now = m.currentClock()
		return m, m.clockTickCmd()
	case animTickMsg:
		if !hasSpinner(m.snap) {
			m.animating = false
			return m, nil
		}
		m.frame++
		m.animating = true
		return m, m.animTickCmd()
	case bgQueryTickMsg:
		if msg.gen != m.bgQueryGen || m.activeTheme().HasBackground() {
			return m, nil
		}
		return m, tea.Batch(
			tea.RequestBackgroundColor,
			m.bgQueryTickCmd(bgQueryInterval, m.bgQueryGen),
		)
	case tea.BackgroundColorMsg:
		m.dark = msg.IsDark()
	case tea.KeyPressMsg:
		if m.currentClock().Sub(m.startedAt) < inputGuard {
			return m, nil
		}
		return m.handleKey(msg)
	case tea.MouseWheelMsg:
		if m.currentClock().Sub(m.startedAt) < inputGuard {
			return m, nil
		}
		m.handleMouseWheel(msg)
	case tea.MouseClickMsg:
		if m.currentClock().Sub(m.startedAt) < inputGuard {
			return m, nil
		}
		m.handleMouseClick(msg)
	}
	return m, nil
}

func (m *Model) applyTheme(name string) tea.Cmd {
	if name == "" || name == m.themeName {
		return nil
	}
	prevHadBG := m.activeTheme().HasBackground()
	th, err := theme.Load(name, m.themesDir)
	m.themeName = name
	if err != nil {
		m.theme = defaultTheme
		cleanName := Clean(name)
		reason := Clean(err.Error())
		if cleanName != "" {
			m.themeErr = fmt.Sprintf("theme %s %s", cleanName, reason)
		} else {
			m.themeErr = fmt.Sprintf("theme %s", reason)
		}
	} else {
		m.theme = th
		m.themeErr = ""
	}
	m.refreshMask()

	nowHasBG := m.activeTheme().HasBackground()
	if !nowHasBG {
		if prevHadBG {
			m.bgQueryGen++
			m.bgQueryActive = true
			return m.bgQueryTickCmd(bgQueryDelay, m.bgQueryGen)
		}
		if !m.bgQueryActive {
			m.bgQueryGen++
			m.bgQueryActive = true
			return tea.Batch(
				tea.RequestBackgroundColor,
				m.bgQueryTickCmd(bgQueryInterval, m.bgQueryGen),
			)
		}
		return nil
	}
	if m.bgQueryActive || !prevHadBG {
		m.bgQueryGen++
		m.bgQueryActive = false
	}
	return nil
}

// selectableIDs returns the selectable item IDs in navigation order:
// main, running sub-agents in display order, then reported sub-agents this turn.
func (m Model) selectableIDs() []string {
	if !m.hasSnapshot() {
		return nil
	}
	running, _ := orderRunning(m.snap.Agents)
	reported := reportedAgents(m.snap.Agents, m.snap.Turn)
	ids := make([]string, 0, 1+len(running)+len(reported))
	ids = append(ids, mainID)
	for _, a := range running {
		ids = append(ids, a.ID)
	}
	for _, a := range reported {
		ids = append(ids, a.ID)
	}
	return ids
}

func (m *Model) setSelected(id string) {
	if id == m.selected {
		return
	}
	m.selected = id
	m.logFollow = true
	m.logTop = 0
	m.ensureSelectedVisible()
}

func (m *Model) stepSelection(delta int) {
	ids := m.selectableIDs()
	if len(ids) == 0 {
		return
	}
	if m.selected == "" {
		m.setSelected(ids[0])
		return
	}
	idx := slices.Index(ids, m.selected)
	if idx < 0 {
		m.setSelected(ids[0])
		return
	}
	next := (idx + delta) % len(ids)
	if next < 0 {
		next += len(ids)
	}
	m.setSelected(ids[next])
}

func (m Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "tab", "down", "j", "right", "l":
		m.stepSelection(1)
	case "shift+tab", "up", "k", "left", "h":
		m.stepSelection(-1)
	case "esc":
		if chooseLayout(m.width, m.height) == layoutCompact && m.showLog {
			m.showLog = false
			m.ensureSelectedVisible()
		} else {
			m.setSelected("")
		}
	case "enter":
		if chooseLayout(m.width, m.height) == layoutCompact && !m.showLog {
			ids := m.selectableIDs()
			if len(ids) == 0 {
				return m, nil
			}
			if m.selected == "" {
				m.setSelected(ids[0])
			} else {
				m.showLog = true
				m.logFollow = true
				m.logTop = 0
			}
		}
	case "pgup":
		m.pageLog(-1)
	case "pgdown":
		m.pageLog(1)
	case "end":
		running, _ := orderRunning(m.snap.Agents)
		reported := reportedAgents(m.snap.Agents, m.snap.Turn)
		if m.scrollGeometry(running, reported).logVisRows > 0 {
			m.logFollow = true
			m.logTop = 0
		}
	}
	return m, nil
}

func (m *Model) handleMouseWheel(msg tea.MouseWheelMsg) {
	var delta int
	switch msg.Button {
	case tea.MouseWheelUp:
		delta = -1
	case tea.MouseWheelDown:
		delta = 1
	default:
		return
	}
	if !m.hasSnapshot() || m.width <= 0 || m.height <= 0 {
		return
	}
	_, hits := layout(*m)
	pt := image.Pt(msg.X, msg.Y)
	for _, h := range hits {
		if !pt.In(h.rect) {
			continue
		}
		switch h.kind {
		case hitRunScroll:
			m.scrollRun(delta)
			return
		case hitBackScroll:
			m.scrollBack(delta)
			return
		case hitLogScroll:
			m.scrollLog(delta)
			return
		case hitListScroll:
			m.scrollList(delta)
			return
		}
	}
}

func (m *Model) handleMouseClick(msg tea.MouseClickMsg) {
	if msg.Button != tea.MouseLeft {
		return
	}
	if !m.hasSnapshot() || m.width <= 0 || m.height <= 0 {
		return
	}
	_, hits := layout(*m)
	pt := image.Pt(msg.X, msg.Y)
	for _, h := range hits {
		if h.kind == hitItem && pt.In(h.rect) {
			m.setSelected(h.id)
			return
		}
	}
}
