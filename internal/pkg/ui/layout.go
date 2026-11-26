package ui

import (
	"fmt"
	"image"
	"slices"
	"time"

	"github.com/charmbracelet/x/ansi"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

const (
	mainID    = "main"
	titleText = "FLEETPANE"

	// Layout selection thresholds.
	minVerticalW   = 40
	minVerticalH   = 30
	maxVerticalW   = 100
	minHorizontalW = 147
	minHorizontalH = 14
)

// layoutKind selects one of the three pane layouts by current dimensions.
type layoutKind uint8

const (
	layoutVertical layoutKind = iota
	layoutHorizontal
	layoutCompact
)

func chooseLayout(w, h int) layoutKind {
	if h >= minVerticalH && w >= minVerticalW {
		return layoutVertical
	}
	if h >= minHorizontalH && w >= minHorizontalW {
		return layoutHorizontal
	}
	return layoutCompact
}

// hitKind identifies what a hit rectangle represents.
type hitKind uint8

const (
	hitItem       hitKind = iota // selectable item ("main" or agent ID)
	hitRunScroll                 // scrollable compact-rows run area frame
	hitBackScroll                // scrollable back to main frame
	hitLogScroll                 // scrollable activity frame
	hitListScroll                // scrollable compact layout list
)

// hit is one interactive rectangle produced by layout: either a selectable
// item or a scrollable frame. Coordinates are (col, row), Max exclusive.
type hit struct {
	kind hitKind
	id   string
	rect image.Rectangle
}

// layout is the pure layout function of the pane: given m it returns a freshly
// drawn Canvas and the interactive hit rectangles without mutating m.
func layout(m Model) (*Canvas, []hit) {
	c := NewCanvas(m.width, m.height)
	if c.W == 0 || c.H == 0 {
		return c, nil
	}
	if !m.hasSnapshot() {
		msg := Truncate("Connecting"+Ellipsis, c.W)
		c.Put(c.H/2, (c.W-Width(msg))/2, msg, Style{FG: theme.RoleDim.Color()})
		return c, nil
	}

	switch chooseLayout(c.W, c.H) {
	case layoutVertical:
		return c, layoutVerticalWorkflow(c, m)
	case layoutHorizontal:
		return c, layoutHorizontalWorkflow(c, m)
	case layoutCompact:
		return c, layoutCompactView(c, m)
	default:
		return c, nil
	}
}

// spinnerIcon returns the animation frame's spinner character.
func spinnerIcon(frame int) string {
	n := len(Spinner)
	return Spinner[((frame%n)+n)%n]
}

// statusIcon maps a protocol status string to its single-cell icon and color role.
func statusIcon(status string, frame int) (string, theme.Role) {
	switch status {
	case "running", "working":
		return spinnerIcon(frame), theme.RoleRun
	case "waiting":
		return IconWaiting, theme.RoleRun
	case "done", "ok":
		return IconOK, theme.RoleOK
	case "failed", "error":
		return IconFail, theme.RoleFail
	case "cancelled":
		return IconCancelled, theme.RoleDim
	case "idle":
		return IconIdle, theme.RoleDim
	default:
		return IconUnknown, theme.RoleDim
	}
}

// iconStyle returns the style of a status icon: the mark of an item waiting
// for the user is bold.
func iconStyle(icon string, role theme.Role) Style {
	return Style{FG: role.Color(), Bold: icon == IconWaiting}
}

// mainStatus returns the status the main agent is drawn with: "waiting" while
// it waits for the user, whatever its own status.
func mainStatus(main protocol.Main) string {
	if main.Wait != "" {
		return "waiting"
	}
	if status := Clean(main.Status); status != "" {
		return status
	}
	return "idle"
}

// agentWaits reports whether a sub-agent is waiting for the user. Only a
// running one can be.
func agentWaits(a protocol.Agent) bool {
	return a.Status == "running" && a.Wait != ""
}

// agentStatus returns the status a sub-agent is drawn with: "waiting" while it
// waits for the user.
func agentStatus(a protocol.Agent) string {
	if agentWaits(a) {
		return "waiting"
	}
	return Clean(a.Status)
}

// anyLive reports whether one of the running sub-agents is not waiting for
// the user: the connectors they share are live for it.
func anyLive(running []protocol.Agent) bool {
	return slices.ContainsFunc(running, func(a protocol.Agent) bool { return !agentWaits(a) })
}

// branchStyle returns the style of the connector into the box of a running
// sub-agent: live, or static while the sub-agent waits for the user.
func branchStyle(live bool) Style {
	if live {
		return Style{FG: theme.RoleLive.Color()}
	}
	return Style{FG: theme.RoleEdge.Color()}
}

// waitText returns what an item waiting for the user says in avail cells:
// "needs approval" or "needs answer", only "approval" or "answer" when that
// does not fit, and nothing when that does not fit either.
func waitText(wait string, avail int) string {
	short := Clean(wait)
	if full := "needs " + short; Width(full) <= avail {
		return full
	}
	if Width(short) <= avail {
		return short
	}
	return ""
}

func parseTime(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func mainElapsed(m Model) string {
	since, ok := parseTime(m.snap.Main.Since)
	if !ok || m.now.IsZero() {
		return ""
	}
	return FormatElapsed(m.now.Sub(since))
}

func agentElapsed(a protocol.Agent, now time.Time) string {
	if a.Status != "running" {
		if a.DurationMs > 0 {
			return FormatElapsed(time.Duration(a.DurationMs) * time.Millisecond)
		}
		if s, ok1 := parseTime(a.StartedAt); ok1 {
			if e, ok2 := parseTime(a.EndedAt); ok2 {
				return FormatElapsed(e.Sub(s))
			}
		}
		return FormatElapsed(0)
	}
	if s, ok := parseTime(a.StartedAt); ok && !now.IsZero() {
		return FormatElapsed(now.Sub(s))
	}
	if a.DurationMs > 0 {
		return FormatElapsed(time.Duration(a.DurationMs) * time.Millisecond)
	}
	return ""
}

// orderRunning extracts running agents in preorder (children immediately after
// their running parent, preserving snapshot order among siblings) and returns
// a lookup map of running agents by ID.
func orderRunning(agents []protocol.Agent) ([]protocol.Agent, map[string]protocol.Agent) {
	var raw []protocol.Agent
	byID := make(map[string]protocol.Agent)
	for _, a := range agents {
		if a.Status == "running" {
			raw = append(raw, a)
			if a.ID != "" {
				byID[a.ID] = a
			}
		}
	}
	if len(raw) == 0 {
		return nil, byID
	}

	children := make(map[string][]int)
	var roots []int
	for i, a := range raw {
		if a.Parent != "" && a.Parent != a.ID {
			if _, ok := byID[a.Parent]; ok {
				children[a.Parent] = append(children[a.Parent], i)
				continue
			}
		}
		roots = append(roots, i)
	}

	ordered := make([]protocol.Agent, 0, len(raw))
	visited := make([]bool, len(raw))
	var visit func(idx int)
	visit = func(idx int) {
		if visited[idx] {
			return
		}
		visited[idx] = true
		a := raw[idx]
		ordered = append(ordered, a)
		for _, ci := range children[a.ID] {
			visit(ci)
		}
	}
	for _, r := range roots {
		visit(r)
	}
	// Guard against any parent cycle so no running agent is ever dropped.
	for i := range raw {
		if !visited[i] {
			visit(i)
		}
	}
	return ordered, byID
}

// reportedAgents returns sub-agents finished in the current turn, in snapshot order.
func reportedAgents(agents []protocol.Agent, turn int) []protocol.Agent {
	var out []protocol.Agent
	for _, a := range agents {
		if a.Status != "running" && a.ReportedTurn == turn {
			out = append(out, a)
		}
	}
	return out
}

// runningParent returns a's parent when that parent is currently running.
func runningParent(a protocol.Agent, runningByID map[string]protocol.Agent) (protocol.Agent, bool) {
	if a.Parent == "" || a.Parent == a.ID {
		return protocol.Agent{}, false
	}
	p, ok := runningByID[a.Parent]
	return p, ok
}

// selectedParentID returns the ID of the running parent of m.selected, if any.
func selectedParentID(selected string, runningByID map[string]protocol.Agent) string {
	if selected == "" || selected == mainID {
		return ""
	}
	sel, ok := runningByID[selected]
	if !ok {
		return ""
	}
	if p, ok := runningParent(sel, runningByID); ok {
		return p.ID
	}
	return ""
}

// putClipped draws text at (row, col) stopping once maxW cells have been used.
func putClipped(c *Canvas, row, col, maxW int, text string, st Style) int {
	if maxW <= 0 || text == "" {
		return 0
	}
	used := 0
	for text != "" && used < maxW {
		g, w := ansi.FirstGraphemeCluster(text, ansi.GraphemeWidth)
		text = text[len(g):]
		if w <= 0 {
			continue
		}
		if used+w > maxW {
			break
		}
		c.Put(row, col+used, g, st)
		used += w
	}
	return used
}

// drawTitle draws the gradient "FLEETPANE" title within [col, col+w).
func drawTitle(c *Canvas, row, col, w int, th *theme.Theme, dark, centered bool) int {
	n := len(titleText)
	startCol := col
	if centered && w > n {
		startCol = col + (w-n)/2
	}
	used := 0
	for i := range n {
		if used >= w {
			break
		}
		st := Style{FG: th.Title(i, n, dark), Bold: true}
		c.Put(row, startCol+used, titleText[i:i+1], st)
		used++
	}
	return used
}

type styledPart struct {
	text string
	st   Style
}

func putParts(c *Canvas, row, col, maxW int, parts []styledPart) int {
	used := 0
	for _, p := range parts {
		if used >= maxW {
			break
		}
		used += putClipped(c, row, col+used, maxW-used, p.text, p.st)
	}
	return used
}

func partsWidth(parts []styledPart) int {
	w := 0
	for _, p := range parts {
		w += Width(p.text)
	}
	return w
}

// drawCountLine draws the per-turn sub-agent counts (or "no sub-agents this
// turn" when empty) within [col, col+w).
func drawCountLine(c *Canvas, row, col, w int, running, reported []protocol.Agent, frame int, centered bool) {
	if len(running)+len(reported) == 0 {
		msg := Truncate("no sub-agents this turn", w)
		startCol := col
		if centered && w > Width(msg) {
			startCol = col + (w-Width(msg))/2
		}
		putClipped(c, row, startCol, w, msg, Style{FG: theme.RoleDim.Color()})
		return
	}

	var doneN, failN, cancelN int
	for _, a := range reported {
		switch a.Status {
		case "done", "ok":
			doneN++
		case "failed", "error":
			failN++
		case "cancelled":
			cancelN++
		}
	}

	var waitN int
	for _, a := range running {
		if agentWaits(a) {
			waitN++
		}
	}
	runN := len(running) - waitN
	// Nothing counted as running, nothing to spin for.
	runIcon := Spinner[0]
	if runN > 0 {
		runIcon = spinnerIcon(frame)
	}

	dim := Style{FG: theme.RoleDim.Color()}
	parts := []styledPart{
		{runIcon, Style{FG: theme.RoleRun.Color()}},
		{fmt.Sprintf(" %d running  ", runN), dim},
	}
	if waitN > 0 {
		parts = append(parts,
			styledPart{IconWaiting, iconStyle(IconWaiting, theme.RoleRun)},
			styledPart{fmt.Sprintf(" %d waiting  ", waitN), Style{FG: theme.RoleFG.Color(), Bold: true}},
		)
	}
	parts = append(parts,
		styledPart{IconOK, Style{FG: theme.RoleOK.Color()}},
		styledPart{fmt.Sprintf(" %d done  ", doneN), dim},
		styledPart{IconFail, Style{FG: theme.RoleFail.Color()}},
		styledPart{fmt.Sprintf(" %d failed", failN), dim},
	)
	if cancelN > 0 {
		parts = append(parts,
			styledPart{"  " + IconCancelled, dim},
			styledPart{fmt.Sprintf(" %d cancelled", cancelN), dim},
		)
	}

	totalW := partsWidth(parts)
	startCol := col
	if centered && w > totalW {
		startCol = col + (w-totalW)/2
	}
	putParts(c, row, startCol, w, parts)
}

// drawScrollMark draws " ▲ N " or " ▼ N " near the right end of a box border.
func drawScrollMark(c *Canvas, row, boxCol, boxW, minCol int, arrow string, count int) {
	if count <= 0 {
		return
	}
	label := fmt.Sprintf(" %s %d ", arrow, count)
	lw := Width(label)
	startCol := boxCol + boxW - 2 - lw
	if startCol < minCol {
		return
	}
	c.Put(row, startCol, label, Style{FG: theme.RoleFG.Color(), Bold: true})
}

func keyHintsText() string {
	return HintLeft + HintUp + HintDown + HintRight + " select " + Separator + " esc all " + Separator + " q close"
}

// drawStatusAndHints draws the status bar and key hints on either two rows
// (when twoRows is true or single-row width is tight) or one row with hints
// right-aligned. Affected rows are marked as Panel cells.
func drawStatusAndHints(c *Canvas, row, col, w int, m Model, runningCount, totalThisTurn int, twoRows bool) {
	status := mainStatus(m.snap.Main)
	_, stRole := statusIcon(status, m.frame)
	stStyle := Style{FG: stRole.Color(), Bold: status != "idle"}
	dim := Style{FG: theme.RoleDim.Color()}

	parts := []styledPart{
		{"main ", dim},
		{"[" + status + "]", stStyle},
		{"  sub-agents ", dim},
		{fmt.Sprintf("[%d/%d]", runningCount, totalThisTurn), Style{FG: theme.RoleAgent.Color()}},
		{"  tools ", dim},
		{fmt.Sprintf("[%d]", m.snap.Stats.TurnTools), Style{FG: theme.RoleTool.Color()}},
	}
	hints := keyHintsText()
	availW := max(0, w-2)
	errSt := Style{FG: theme.RoleFail.Color()}

	if twoRows {
		c.MarkPanel(row, col, w, 2)
		if m.themeErr != "" {
			sw := partsWidth(parts)
			ew := Width(m.themeErr)
			if sw+2+ew <= availW {
				parts = append(parts, styledPart{"  " + m.themeErr, errSt})
				putParts(c, row, col+1, availW, parts)
				putClipped(c, row+1, col+1, availW, Truncate(hints, availW), dim)
				return
			}
			putParts(c, row, col+1, availW, parts)
			hw := Width(hints)
			if hw+2+ew <= availW {
				putClipped(c, row+1, col+1, availW, hints, dim)
				c.Put(row+1, col+w-1-ew, m.themeErr, errSt)
			} else {
				putClipped(c, row+1, col+1, availW, Truncate(m.themeErr, availW), errSt)
			}
			return
		}
		putParts(c, row, col+1, availW, parts)
		putClipped(c, row+1, col+1, availW, Truncate(hints, availW), dim)
		return
	}

	c.MarkPanel(row, col, w, 1)
	if m.themeErr != "" {
		rem := availW - partsWidth(parts) - 2
		if rem > 0 {
			parts = append(parts, styledPart{"  " + Truncate(m.themeErr, rem), errSt})
		}
	}
	sw := partsWidth(parts)
	hw := Width(hints)
	putParts(c, row, col+1, availW, parts)
	if sw+2+hw <= availW {
		c.Put(row, col+w-1-hw, hints, dim)
	}
}
