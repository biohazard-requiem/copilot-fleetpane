package ui

import (
	"fmt"
	"image"
	"time"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

func compactListHintsText() string {
	return "tab select " + Separator + " enter log " + Separator + " q"
}

func compactLogHintsText() string {
	return "esc back " + Separator + " pgup/dn " + Separator + " q"
}

// compactListVisRows returns the number of item rows visible in compact list mode.
func compactListVisRows(h int) int {
	return max(0, h-1)
}

// compactLogVisRows returns the number of log entry rows visible in compact log mode.
func compactLogVisRows(h int) int {
	return max(0, h-2)
}

type compactItem struct {
	id        string
	isMain    bool
	isRunning bool
	agent     protocol.Agent
}

// layoutCompactView lays out the compact list (or the selected item's activity
// page when m.showLog is true) onto c and returns all interactive hits.
func layoutCompactView(c *Canvas, m Model) []hit {
	running, runningByID := orderRunning(m.snap.Agents)
	if m.showLog {
		return layoutCompactLogPage(c, m, runningByID)
	}
	reported := reportedAgents(m.snap.Agents, m.snap.Turn)
	return layoutCompactList(c, m, running, runningByID, reported)
}

func layoutCompactList(c *Canvas, m Model, running []protocol.Agent, runningByID map[string]protocol.Agent, reported []protocol.Agent) []hit {
	W, H := c.W, c.H
	visRows := compactListVisRows(H)
	parentHighlightID := selectedParentID(m.selected, runningByID)

	items := make([]compactItem, 0, 1+len(running)+len(reported))
	items = append(items, compactItem{id: mainID, isMain: true})
	for _, a := range running {
		items = append(items, compactItem{id: a.ID, isRunning: true, agent: a})
	}
	for _, a := range reported {
		items = append(items, compactItem{id: a.ID, agent: a})
	}

	hits := make([]hit, 0, 1+visRows)
	if visRows > 0 {
		hits = append(hits, hit{kind: hitListScroll, rect: image.Rect(0, 0, W, visRows)})

		maxOff := max(0, len(items)-visRows)
		offset := min(max(m.listOffset, 0), maxOff)
		endIdx := min(len(items), offset+visRows)
		above := offset
		below := len(items) - endIdx

		for i := offset; i < endIdx; i++ {
			r := i - offset
			rowW := W
			if r == 0 && above > 0 {
				rowW = drawCompactScrollMark(c, r, rowW, ArrowUp, above)
			}
			if r == visRows-1 && below > 0 {
				rowW = drawCompactScrollMark(c, r, rowW, ArrowDown, below)
			}
			it := items[i]
			if it.isMain {
				drawCompactMainRow(c, r, rowW, m)
			} else {
				pName := ""
				if it.isRunning {
					if p, ok := runningParent(it.agent, runningByID); ok {
						pName = p.Name
					}
				}
				drawCompactAgentListRow(c, r, rowW, it.agent, pName, it.isRunning, m.selected == it.id, it.id == parentHighlightID, m.frame, m.now)
			}
			hits = append(hits, hit{
				kind: hitItem,
				id:   it.id,
				rect: image.Rect(0, r, W, r+1),
			})
		}
	}

	drawCompactHintRow(c, H-1, W, compactListHintsText())
	return hits
}

func layoutCompactLogPage(c *Canvas, m Model, runningByID map[string]protocol.Agent) []hit {
	W, H := c.W, c.H
	pageRows := compactListVisRows(H)
	visRows := compactLogVisRows(H)

	var hits []hit
	if pageRows > 0 {
		hits = append(hits, hit{kind: hitLogScroll, rect: image.Rect(0, 0, W, pageRows)})

		entries := filterLog(m.snap.Log, m.selected)
		var startIdx, endIdx, above, below int
		if len(entries) > 0 && visRows > 0 {
			startIdx = activityStartIndex(entries, visRows, m.logFollow, m.logTop)
			endIdx = min(len(entries), startIdx+visRows)
			above = startIdx
			below = len(entries) - endIdx
		}

		// Row 0: title and ▲ N scroll mark.
		hdrW := drawCompactScrollMark(c, 0, W, ArrowUp, above)
		putClipped(c, 0, 0, hdrW, Truncate(activityTitle(m, runningByID), hdrW), Style{FG: theme.RoleDim.Color(), Bold: true})

		if visRows > 0 {
			if len(entries) == 0 {
				putClipped(c, 1, 0, W, Truncate("no activity", W), Style{FG: theme.RoleDim.Color()})
			} else {
				// The ▼ N mark shortens the last row without changing its columns.
				full := W >= activityFullTimeMinW
				for i := startIdx; i < endIdx; i++ {
					r := 1 + (i - startIdx)
					rowW := W
					if r == pageRows-1 && below > 0 {
						rowW = drawCompactScrollMark(c, r, W, ArrowDown, below)
					}
					if full || m.selected == "" {
						drawActivityRow(c, r, 0, rowW, full, entries[i], m.frame)
					} else {
						drawCompactLogRow(c, r, 0, rowW, entries[i], m.frame)
					}
				}
			}
		}
	}

	drawCompactHintRow(c, H-1, W, compactLogHintsText())
	return hits
}

func drawCompactHintRow(c *Canvas, row, w int, hint string) {
	if row < 0 || row >= c.H || w <= 0 {
		return
	}
	c.MarkPanel(row, 0, w, 1)
	putClipped(c, row, 0, w, Truncate(hint, w), Style{FG: theme.RoleDim.Color()})
}

// drawCompactScrollMark writes "▲ N" or "▼ N" flush at the right end of row
// within [0, w) and returns the remaining left width (excluding a 1-cell gap).
func drawCompactScrollMark(c *Canvas, row, w int, arrow string, count int) int {
	if count <= 0 || w <= 0 {
		return w
	}
	label := fmt.Sprintf("%s %d", arrow, count)
	lw := Width(label)
	if lw >= w {
		putClipped(c, row, 0, w, Truncate(label, w), Style{FG: theme.RoleFG.Color(), Bold: true})
		return 0
	}
	c.Put(row, w-lw, label, Style{FG: theme.RoleFG.Color(), Bold: true})
	return max(0, w-lw-1)
}

func drawCompactMainRow(c *Canvas, row, rowW int, m Model) {
	if rowW <= 0 {
		return
	}
	selected := m.selected == mainID
	status := mainStatus(m.snap.Main)
	icon, role := statusIcon(status, m.frame)
	elapsed := mainElapsed(m)
	ew := Width(elapsed)

	col := 0
	if selected {
		c.Put(row, 0, MarkSelected, Style{FG: theme.RoleMain.Color(), Bold: true})
		col = 2
	}
	if col >= rowW {
		return
	}
	c.Put(row, col, icon, iconStyle(icon, role))
	textCol := col + 2
	if textCol >= rowW {
		return
	}

	avail := rowW - textCol
	if ew > 0 && ew < avail {
		putClipped(c, row, rowW-ew, ew, elapsed, Style{FG: theme.RoleDim.Color()})
		avail -= ew + 1
	}
	if avail <= 0 {
		return
	}

	used := putClipped(c, row, textCol, avail, Truncate(mainID, avail), Style{FG: theme.RoleMain.Color(), Bold: true})
	if rem := avail - used - 1; rem > 0 {
		stStyle := Style{FG: theme.RoleFG.Color()}
		switch status {
		case "idle":
			stStyle = Style{FG: theme.RoleDim.Color()}
		case "waiting":
			stStyle = Style{FG: theme.RoleRun.Color(), Bold: true}
		}
		putClipped(c, row, textCol+used+1, rem, Truncate(status, rem), stStyle)
	}
}

func drawCompactAgentListRow(c *Canvas, row, rowW int, a protocol.Agent, parentName string, isRunning, selected, isParentOfSelected bool, frame int, now time.Time) {
	if rowW <= 0 {
		return
	}
	switch {
	case selected:
		role := theme.RoleMain
		if isRunning {
			role = theme.RoleAgent
		}
		c.Put(row, 0, MarkSelected, Style{FG: role.Color(), Bold: true})
	case isParentOfSelected:
		c.Put(row, 0, MarkParent, Style{FG: theme.RoleMain.Color(), Bold: true})
	}
	if rowW <= 2 {
		return
	}

	icon, role := statusIcon(agentStatus(a), frame)
	c.Put(row, 2, icon, iconStyle(icon, role))
	const textCol = 4
	if rowW <= textCol {
		return
	}

	elapsed := agentElapsed(a, now)
	ew := Width(elapsed)
	avail := rowW - textCol
	if ew > 0 && ew < avail {
		putClipped(c, row, rowW-ew, ew, elapsed, Style{FG: theme.RoleDim.Color()})
		avail -= ew + 1
	}
	if avail <= 0 {
		return
	}

	displayName := Clean(a.Name)
	if cleanParent := Clean(parentName); cleanParent != "" {
		displayName = MarkChild + " " + displayName
	}

	nameStyle := Style{FG: theme.RoleFG.Color()}
	switch {
	case selected && isRunning:
		nameStyle = Style{FG: theme.RoleAgent.Color(), Bold: true}
	case selected || isParentOfSelected:
		nameStyle = Style{FG: theme.RoleMain.Color(), Bold: true}
	}
	nameStyle.Bold = nameStyle.Bold || agentWaits(a)
	putClipped(c, row, textCol, avail, Truncate(displayName, avail), nameStyle)
}

// drawCompactLogRow draws one single-actor log line in narrow compact log mode:
// "MM:SS <icon> <tool> <summary>", omitting the actor name already shown on row 0.
func drawCompactLogRow(c *Canvas, row, col, width int, e protocol.LogEntry, frame int) {
	if width <= 0 {
		return
	}
	const timeW = 5
	ts := ""
	if t, ok := parseTime(e.T); ok {
		ts = t.Format("04:05")
	}
	putClipped(c, row, col, min(timeW, width), ts, Style{FG: theme.RoleDim.Color()})
	cursor := timeW + 1
	if cursor >= width {
		return
	}

	status := Clean(e.Status)
	icon, role := statusIcon(status, frame)
	c.Put(row, col+cursor, icon, iconStyle(icon, role))
	cursor += 2
	if cursor >= width {
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
	rem := width - cursor
	toolSlot := max(6, min(Width(toolText), 10))
	// A tool name with no summary to line up after it has the rest of the row.
	if toolSlot > rem || (sum == "" && e.Kind != "agent") {
		toolSlot = rem
	}
	putClipped(c, row, col+cursor, toolSlot, Truncate(toolText, toolSlot), toolStyle)
	cursor += toolSlot + 1
	if cursor >= width {
		return
	}

	if sum != "" {
		sumW := width - cursor
		putClipped(c, row, col+cursor, sumW, Truncate(sum, sumW), Style{FG: theme.RoleFG.Color()})
	}
}
