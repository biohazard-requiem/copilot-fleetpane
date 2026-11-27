package ui

import (
	"image"
	"time"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

// activityFullTimeMinW is the inner width threshold for full HH:MM:SS timestamps
// and 12-cell actor names; narrower boxes use MM:SS and 10-cell names.
const activityFullTimeMinW = 50

// drawActivity draws the activity log frame of size boxW × boxH at (row, col),
// filtered to m.selected when non-empty and windowed by logFollow / logTop.
func drawActivity(c *Canvas, row, col, boxW, boxH int, m Model, runningByID map[string]protocol.Agent) hit {
	c.Box(row, col, boxW, boxH, Style{FG: theme.RoleEdge.Color()}, false)
	h := hit{kind: hitLogScroll, rect: image.Rect(col, row, col+boxW, row+boxH)}

	entries := filterLog(m.snap.Log, m.selected)
	visRows := max(0, boxH-2)
	var startIdx, endIdx, above, below int
	if len(entries) > 0 && visRows > 0 {
		startIdx = activityStartIndex(entries, visRows, m.logFollow, m.logTop)
		endIdx = min(len(entries), startIdx+visRows)
		above = startIdx
		below = len(entries) - endIdx
	}

	// The ▲ N mark comes first: a long title would leave it no room, so the
	// title has what the mark leaves of the top border.
	titleW := boxW - 4 - drawScrollMark(c, row, col, boxW, col+2, ArrowUp, above)
	putClipped(c, row, col+2, titleW, Truncate(" "+activityTitle(m, runningByID)+" ", titleW), Style{FG: theme.RoleDim.Color()})
	drawScrollMark(c, row+boxH-1, col, boxW, col+2, ArrowDown, below)

	innerCol := col + 2
	innerW := boxW - 4
	if innerW <= 0 {
		return h
	}
	for i := startIdx; i < endIdx; i++ {
		drawActivityRow(c, row+1+(i-startIdx), innerCol, innerW, innerW >= activityFullTimeMinW, entries[i], m.frame, m.location())
	}
	return h
}

func activityTitle(m Model, runningByID map[string]protocol.Agent) string {
	if m.selected == "" {
		return "activity"
	}
	if m.selected == mainID {
		return "activity " + Separator + " " + mainID
	}
	// Find selected agent's name (and running parent if applicable).
	for _, a := range m.snap.Agents {
		if a.ID == m.selected {
			name := Clean(a.Name)
			if p, ok := runningParent(a, runningByID); ok && a.Status == "running" {
				return "activity " + Separator + " " + name + " " + MarkSpawnedBy + " " + Clean(p.Name)
			}
			return "activity " + Separator + " " + name
		}
	}
	return "activity " + Separator + " " + Clean(m.selected)
}

func filterLog(entries []protocol.LogEntry, selected string) []protocol.LogEntry {
	if selected == "" {
		return entries
	}
	var out []protocol.LogEntry
	for _, e := range entries {
		if e.Actor == selected {
			out = append(out, e)
		}
	}
	return out
}

func activityStartIndex(entries []protocol.LogEntry, visRows int, follow bool, logTop int64) int {
	if len(entries) == 0 {
		return 0
	}
	maxStart := max(0, len(entries)-visRows)
	if follow {
		return maxStart
	}
	if entries[0].Seq >= logTop {
		return 0
	}
	for i, e := range entries {
		if e.Seq >= logTop {
			return min(i, maxStart)
		}
	}
	return maxStart
}

// drawActivityRow draws one record in innerW cells. full selects the columns:
// the caller decides it once, so that every row of a page has the same. The
// time of the record is shown in loc.
func drawActivityRow(c *Canvas, row, col, innerW int, full bool, e protocol.LogEntry, frame int, loc *time.Location) {
	timeW := 5
	nameW := 10
	timeFmt := "04:05"
	if full {
		timeW = 8
		nameW = 12
		timeFmt = "15:04:05"
	}

	ts := ""
	if t, ok := parseTime(e.T); ok {
		ts = t.In(loc).Format(timeFmt)
	}
	putClipped(c, row, col, min(timeW, innerW), ts, Style{FG: theme.RoleDim.Color()})
	cursor := timeW + 1
	if cursor >= innerW {
		return
	}

	actorName := Clean(e.Name)
	if actorName == "" {
		actorName = Clean(e.Actor)
	}
	nameRole := theme.RoleAgent
	if e.Actor == mainID || actorName == mainID {
		nameRole = theme.RoleMain
	}
	putClipped(c, row, col+cursor, min(nameW, innerW-cursor), Truncate(actorName, min(nameW, innerW-cursor)), Style{FG: nameRole.Color()})
	cursor += nameW + 1
	if cursor >= innerW {
		return
	}

	status := Clean(e.Status)
	icon, role := statusIcon(status, frame)
	c.Put(row, col+cursor, icon, iconStyle(icon, role))
	cursor += 2
	if cursor >= innerW {
		return
	}

	var toolText string
	var toolStyle Style
	if e.Kind == "agent" {
		toolText = status
		toolStyle = Style{FG: role.Color(), Bold: true}
	} else {
		toolText = Clean(e.Tool)
		toolStyle = Style{FG: theme.RoleTool.Color()}
	}

	sum := Clean(e.Summary)
	rem := innerW - cursor
	toolSlot := max(6, min(Width(toolText), 10))
	// A tool name with no summary to line up after it has the rest of the row.
	if toolSlot > rem || (sum == "" && e.Kind != "agent") {
		toolSlot = rem
	}
	putClipped(c, row, col+cursor, toolSlot, Truncate(toolText, toolSlot), toolStyle)
	cursor += toolSlot + 1
	if cursor >= innerW {
		return
	}

	if sum != "" {
		sumW := innerW - cursor
		putClipped(c, row, col+cursor, sumW, Truncate(sum, sumW), Style{FG: theme.RoleFG.Color()})
	}
}
