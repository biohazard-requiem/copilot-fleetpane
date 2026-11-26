package ui

import (
	"fmt"
	"image"
	"strconv"
	"time"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

// boxVariant selects the height and fields of a running sub-agent box.
type boxVariant uint8

const (
	boxFull  boxVariant = iota // height 7 (vertical level 1)
	boxTall                    // height 8 (horizontal level 1: adds desc line)
	boxShort                   // height 5 (vertical level 2: drops line 2 & tool trail)
)

const (
	fullBoxH  = 7
	tallBoxH  = 8
	shortBoxH = 5

	// Minimum remaining width after "name · " before line 1 displays the type.
	minTypeTailW = 4
	// Minimum box inner width to show status text alongside icon and elapsed.
	minStatusTextInnerW = 15
	// Compact-row width thresholds.
	compactSummaryMinW = 30
	compactParentMinW  = 40
)

// drawMainBox draws the main agent box of size w × h at (row, col) and returns
// its hit rectangle.
func drawMainBox(c *Canvas, row, col, w, h int, m Model) hit {
	c.Box(row, col, w, h, Style{FG: theme.RoleMain.Color()}, m.selected == mainID)
	innerCol := col + 2
	innerW := w - 4
	if innerW <= 0 || h < 3 {
		return hit{kind: hitItem, id: mainID, rect: image.Rect(col, row, col+w, row+h)}
	}

	// Line 1: main · <model>
	used := putClipped(c, row+1, innerCol, innerW, mainID, Style{FG: theme.RoleMain.Color(), Bold: true})
	model := Clean(m.snap.Main.Model)
	if model != "" && innerW-used >= 4 {
		sep := " " + Separator + " "
		rem := innerW - used - Width(sep)
		putClipped(c, row+1, innerCol+used, innerW-used, sep+Truncate(model, rem), Style{FG: theme.RoleDim.Color()})
	}

	// Line 2: status icon + text, right-aligned elapsed
	if h >= 4 {
		status := mainStatus(m.snap.Main)
		icon, role := statusIcon(status, m.frame)
		elapsed := mainElapsed(m)
		ew := Width(elapsed)
		putClipped(c, row+2, innerCol, 1, icon, iconStyle(icon, role))
		if ew > 0 && ew < innerW {
			putClipped(c, row+2, innerCol+innerW-ew, ew, elapsed, Style{FG: theme.RoleDim.Color()})
		}
		avail := innerW - 2
		if ew > 0 {
			avail -= ew + 1
		}
		if wait := m.snap.Main.Wait; wait != "" {
			putClipped(c, row+2, innerCol+2, avail, waitText(wait, avail), Style{FG: role.Color(), Bold: true})
		} else if avail > 0 {
			textStyle := Style{FG: theme.RoleFG.Color()}
			if status == "idle" {
				textStyle = Style{FG: theme.RoleDim.Color()}
			}
			putClipped(c, row+2, innerCol+2, avail, Truncate(status, avail), textStyle)
		}
	}

	// Line 3: current or recent tool call (or intent if none); dim when idle
	if h >= 5 {
		idle := Clean(m.snap.Main.Status) == "idle" || m.snap.Main.Status == ""
		if len(m.snap.Main.Tools) > 0 {
			t := m.snap.Main.Tools[len(m.snap.Main.Tools)-1]
			drawToolLine(c, row+3, innerCol, innerW, t, idle)
		} else if intent := Clean(m.snap.Main.Intent); intent != "" {
			st := Style{FG: theme.RoleDim.Color()}
			putClipped(c, row+3, innerCol, innerW, Truncate(intent, innerW), st)
		}
	}

	return hit{kind: hitItem, id: mainID, rect: image.Rect(col, row, col+w, row+h)}
}

// drawToolLine draws the name and summary of an agent's current or most
// recent tool call. They are dim when asked for, and for a cancelled call:
// it never completed, and it is not what the agent is doing.
func drawToolLine(c *Canvas, row, col, maxW int, t protocol.Tool, dim bool) {
	if maxW <= 0 {
		return
	}
	tName := Clean(t.Name)
	tSum := Clean(t.Summary)
	nameStyle := Style{FG: theme.RoleTool.Color()}
	sumStyle := Style{FG: theme.RoleFG.Color()}
	if dim || t.Status == "cancelled" {
		nameStyle = Style{FG: theme.RoleDim.Color()}
		sumStyle = nameStyle
	}
	nameTrunc := Truncate(tName, maxW)
	used := putClipped(c, row, col, maxW, nameTrunc, nameStyle)
	if tSum != "" && maxW-used >= 2 {
		rem := maxW - used - 1
		putClipped(c, row, col+used+1, rem, Truncate(tSum, rem), sumStyle)
	}
}

// drawToolTrail draws a sub-agent's recent tool calls as spaced squares (■)
// and a spinner for running tools, keeping only the most recent calls that fit.
// While the sub-agent waits for the user its running tools are the waiting
// mark instead: nothing in its box spins.
func drawToolTrail(c *Canvas, row, col, maxW int, tools []protocol.Tool, waiting bool, frame int) {
	if maxW <= 0 || len(tools) == 0 {
		return
	}
	maxItems := (maxW + 1) / 2
	if len(tools) > maxItems {
		tools = tools[len(tools)-maxItems:]
	}
	for i, t := range tools {
		var ch string
		var role theme.Role
		switch t.Status {
		case "running":
			ch = spinnerIcon(frame)
			if waiting {
				ch = IconWaiting
			}
			role = theme.RoleRun
		case "done", "ok":
			ch = MarkTool
			role = theme.RoleOK
		case "failed", "error":
			ch = MarkTool
			role = theme.RoleFail
		case "cancelled":
			ch = IconCancelled
			role = theme.RoleDim
		default:
			ch = MarkTool
			role = theme.RoleDim
		}
		c.Put(row, col+2*i, ch, iconStyle(ch, role))
	}
}

// agentBorderRole returns the role of the border of a running sub-agent's box:
// that of what is running while the sub-agent waits for the user. Selecting
// is not affected by waiting, so the parent of the selected item keeps its
// highlight.
func agentBorderRole(a protocol.Agent, isParentOfSelected bool) theme.Role {
	switch {
	case isParentOfSelected:
		return theme.RoleMain
	case agentWaits(a):
		return theme.RoleRun
	}
	return theme.RoleAgent
}

// drawAgentBox draws a running sub-agent box (full h=7, tall h=8, or short h=5)
// and returns its hit rectangle. parentName is non-empty only when the agent's
// parent is also currently running.
func drawAgentBox(c *Canvas, row, col, w int, variant boxVariant, a protocol.Agent, parentName string, selected, isParentOfSelected bool, frame int, now time.Time) hit {
	h := fullBoxH
	switch variant {
	case boxTall:
		h = tallBoxH
	case boxShort:
		h = shortBoxH
	}

	c.Box(row, col, w, h, Style{FG: agentBorderRole(a, isParentOfSelected).Color()}, selected)

	innerCol := col + 2
	innerW := w - 4
	if innerW <= 0 {
		return hit{kind: hitItem, id: a.ID, rect: image.Rect(col, row, col+w, row+h)}
	}

	name := Clean(a.Name)
	typ := Clean(a.Type)
	model := Clean(a.Model)
	isBG := a.Mode == "background"
	cleanParent := Clean(parentName)
	dim := Style{FG: theme.RoleDim.Color()}
	nameSt := Style{FG: theme.RoleAgent.Color(), Bold: true}

	if variant == boxShort {
		// Short box (h=5):
		// Line 1: <name> [‹ <parent>]
		if cleanParent != "" {
			sep := " " + MarkSpawnedBy + " "
			nameTrunc := Truncate(name, innerW)
			used := putClipped(c, row+1, innerCol, innerW, nameTrunc, nameSt)
			if rem := innerW - used - Width(sep); rem >= 1 {
				putClipped(c, row+1, innerCol+used, innerW-used, sep+Truncate(cleanParent, rem), dim)
			}
		} else {
			putClipped(c, row+1, innerCol, innerW, Truncate(name, innerW), nameSt)
		}
		// Line 2: current or recent tool
		if len(a.Tools) > 0 {
			drawToolLine(c, row+2, innerCol, innerW, a.Tools[len(a.Tools)-1], false)
		}
		// Line 3: status + elapsed
		drawAgentStatusLine(c, row+3, innerCol, innerW, a, frame, now)
		return hit{kind: hitItem, id: a.ID, rect: image.Rect(col, row, col+w, row+h)}
	}

	// Full (h=7) and Tall (h=8) first two lines per 7.11 "方框的前两行".
	bgSuffix := " " + Separator + " bg"
	if model != "" {
		// Line 1: name (bold) [ · <type> (dim)] if >= 4 cells remain after " · ".
		nameTrunc := Truncate(name, innerW)
		used := putClipped(c, row+1, innerCol, innerW, nameTrunc, nameSt)
		sep := " " + Separator + " "
		if typ != "" && innerW-used-Width(sep) >= minTypeTailW {
			rem := innerW - used - Width(sep)
			putClipped(c, row+1, innerCol+used, innerW-used, sep+Truncate(typ, rem), dim)
		}

		// Line 2:
		if cleanParent != "" {
			prefix := Truncate(MarkChild+" "+cleanParent, innerW)
			pw := putClipped(c, row+2, innerCol, innerW, prefix, dim)
			rem := innerW - pw - 2
			if rem >= Width(model) {
				if isBG && rem >= Width(model)+Width(bgSuffix) {
					putClipped(c, row+2, innerCol+pw+2, rem, model+bgSuffix, dim)
				} else {
					putClipped(c, row+2, innerCol+pw+2, rem, model, dim)
				}
			}
		} else if isBG && Width(model)+Width(bgSuffix) <= innerW {
			putClipped(c, row+2, innerCol, innerW, model+bgSuffix, dim)
		} else {
			putClipped(c, row+2, innerCol, innerW, Truncate(model, innerW), dim)
		}
	} else {
		// model empty: Line 1 is name only; Line 2 is type [+ · bg] or "↳ <parent>  <type>".
		putClipped(c, row+1, innerCol, innerW, Truncate(name, innerW), nameSt)
		if cleanParent != "" {
			prefix := Truncate(MarkChild+" "+cleanParent, innerW)
			pw := putClipped(c, row+2, innerCol, innerW, prefix, dim)
			if typ != "" {
				if rem := innerW - pw - 2; rem >= minTypeTailW {
					putClipped(c, row+2, innerCol+pw+2, rem, Truncate(typ, rem), dim)
				}
			}
		} else {
			switch {
			case isBG && typ != "" && Width(typ)+Width(bgSuffix) <= innerW:
				putClipped(c, row+2, innerCol, innerW, typ+bgSuffix, dim)
			case isBG && typ == "":
				putClipped(c, row+2, innerCol, innerW, Truncate("bg", innerW), dim)
			default:
				putClipped(c, row+2, innerCol, innerW, Truncate(typ, innerW), dim)
			}
		}
	}

	nextRow := row + 3
	if variant == boxTall {
		if desc := Clean(a.Desc); desc != "" {
			putClipped(c, nextRow, innerCol, innerW, Truncate(desc, innerW), dim)
		}
		nextRow++
	}

	drawToolTrail(c, nextRow, innerCol, innerW, a.Tools, agentWaits(a), frame)
	if len(a.Tools) > 0 {
		drawToolLine(c, nextRow+1, innerCol, innerW, a.Tools[len(a.Tools)-1], false)
	}
	drawAgentStatusLine(c, nextRow+2, innerCol, innerW, a, frame, now)

	return hit{kind: hitItem, id: a.ID, rect: image.Rect(col, row, col+w, row+h)}
}

func drawAgentStatusLine(c *Canvas, row, col, innerW int, a protocol.Agent, frame int, now time.Time) {
	status := agentStatus(a)
	icon, role := statusIcon(status, frame)
	elapsed := agentElapsed(a, now)
	ew := Width(elapsed)

	putClipped(c, row, col, 1, icon, iconStyle(icon, role))
	if ew > 0 && ew < innerW {
		putClipped(c, row, col+innerW-ew, ew, elapsed, Style{FG: theme.RoleDim.Color()})
	}
	if innerW < minStatusTextInnerW {
		return
	}
	avail := innerW - 2
	if ew > 0 {
		avail -= ew + 1
	}
	if agentWaits(a) {
		putClipped(c, row, col+2, avail, waitText(a.Wait, avail), Style{FG: role.Color(), Bold: true})
	} else if avail > 0 && status != "" {
		putClipped(c, row, col+2, avail, Truncate(status, avail), Style{FG: role.Color()})
	}
}

// drawCompactFrame draws the compact-rows box for running sub-agents (levels 3
// and 4 in vertical layout; levels 2 and 3 in horizontal layout) and returns
// hits for the frame and every visible agent row.
func drawCompactFrame(c *Canvas, row, col, boxW, boxH, cols, colW, leftPad int, running []protocol.Agent, runningByID map[string]protocol.Agent, m Model, parentHighlightID string) []hit {
	c.Box(row, col, boxW, boxH, Style{FG: theme.RoleAgent.Color()}, false)

	title := fmt.Sprintf(" running %s %d ", Separator, len(running))
	titleEnd := col + 2
	if boxW > 4 {
		tw := putClipped(c, row, col+2, boxW-4, Truncate(title, boxW-4), Style{FG: theme.RoleAgent.Color(), Bold: true})
		titleEnd = col + 2 + tw
	}

	visRows := max(0, boxH-2)
	totalRows := (len(running) + cols - 1) / cols
	offset := min(max(m.runOffset, 0), max(0, totalRows-visRows))
	startIdx := offset * cols
	endIdx := min(len(running), (offset+visRows)*cols)
	above := startIdx
	below := len(running) - endIdx

	drawScrollMark(c, row, col, boxW, titleEnd, ArrowUp, above)
	drawScrollMark(c, row+boxH-1, col, boxW, col+2, ArrowDown, below)

	hits := make([]hit, 0, 1+endIdx-startIdx)
	hits = append(hits, hit{kind: hitRunScroll, rect: image.Rect(col, row, col+boxW, row+boxH)})

	for i := startIdx; i < endIdx; i++ {
		rel := i - startIdx
		r := row + 1 + rel/cols
		colIdx := rel % cols
		cellCol := col + 1 + leftPad + colIdx*(colW+1)
		a := running[i]
		pName := ""
		if p, ok := runningParent(a, runningByID); ok {
			pName = p.Name
		}
		drawCompactRow(c, r, cellCol, colW, a, pName, m.selected == a.ID, a.ID == parentHighlightID, m.frame, m.now)
		hits = append(hits, hit{
			kind: hitItem,
			id:   a.ID,
			rect: image.Rect(cellCol, r, cellCol+colW, r+1),
		})
	}
	return hits
}

// drawCompactRow draws one sub-agent in a compact row of width colW.
// Format: [▸|◆| ]<icon> <name (max 14)> <tool> [‹ <parent> if colW>=40] [<summary> if colW>=30] <elapsed>.
// A sub-agent waiting for the user has a bold name, and says what it needs in
// place of the summary.
func drawCompactRow(c *Canvas, row, col, colW int, a protocol.Agent, parentName string, selected, isParentOfSelected bool, frame int, now time.Time) {
	if colW <= 0 {
		return
	}
	switch {
	case selected:
		c.Put(row, col, MarkSelected, Style{FG: theme.RoleAgent.Color(), Bold: true})
	case isParentOfSelected:
		c.Put(row, col, MarkParent, Style{FG: theme.RoleMain.Color(), Bold: true})
	}
	if colW < 2 {
		return
	}
	waiting := agentWaits(a)
	icon, role := statusIcon(agentStatus(a), frame)
	c.Put(row, col+1, icon, iconStyle(icon, role))
	if colW < 4 {
		return
	}

	elapsed := agentElapsed(a, now)
	ew := Width(elapsed)
	if ew > 0 && ew <= colW-3 {
		putClipped(c, row, col+colW-ew, ew, elapsed, Style{FG: theme.RoleDim.Color()})
	} else {
		ew = 0
	}

	avail := colW - 3
	if ew > 0 {
		avail -= ew + 1
	}
	if avail <= 0 {
		return
	}

	cleanName := Clean(a.Name)
	cleanParent := Clean(parentName)
	displayName := cleanName
	if cleanParent != "" {
		displayName = MarkChild + " " + cleanName
	}

	var toolName, toolSum string
	toolStyle := Style{FG: theme.RoleTool.Color()}
	if len(a.Tools) > 0 {
		last := a.Tools[len(a.Tools)-1]
		toolName = Clean(last.Name)
		toolSum = Clean(last.Summary)
		if last.Status == "cancelled" {
			toolStyle = Style{FG: theme.RoleDim.Color()}
		}
	}

	nameStyle := Style{FG: theme.RoleFG.Color()}
	if selected {
		nameStyle = Style{FG: theme.RoleAgent.Color(), Bold: true}
	} else if isParentOfSelected {
		nameStyle = Style{FG: theme.RoleMain.Color(), Bold: true}
	}
	nameStyle.Bold = nameStyle.Bold || waiting

	// Name width: up to 14 cells; on narrow columns reserve room for the tool name.
	nameSlot := 14
	if colW < compactSummaryMinW {
		// e.g. colW=26 -> avail=18 -> nameSlot=12, leaving 5 cells for tool + 1 space.
		toolReserve := 5
		if toolName == "" {
			toolReserve = 0
		}
		nameSlot = min(14, max(6, avail-toolReserve-1))
	} else {
		nameSlot = min(14, avail)
	}

	nameTrunc := Truncate(displayName, nameSlot)
	putClipped(c, row, col+3, nameSlot, nameTrunc, nameStyle)

	cursor := nameSlot + 1
	if cursor >= avail {
		return
	}

	// Tool name
	if toolName != "" {
		toolMax := avail - cursor
		if colW >= compactSummaryMinW {
			toolMax = min(toolMax, 8)
		}
		tw := putClipped(c, row, col+3+cursor, toolMax, Truncate(toolName, toolMax), toolStyle)
		cursor += tw + 1
	}

	// Parent name when colW >= 40
	if colW >= compactParentMinW && cleanParent != "" && cursor < avail {
		pStr := MarkSpawnedBy + " " + cleanParent
		pMax := avail - cursor
		if colW >= compactSummaryMinW && (toolSum != "" || waiting) && pMax > 12 {
			pMax = min(pMax, max(10, pMax/2))
		}
		pw := putClipped(c, row, col+3+cursor, pMax, Truncate(pStr, pMax), Style{FG: theme.RoleDim.Color()})
		cursor += pw + 1
	}

	// Summary when colW >= 30
	if colW >= compactSummaryMinW && cursor < avail {
		rem := avail - cursor
		if waiting {
			putClipped(c, row, col+3+cursor, rem, waitText(a.Wait, rem), Style{FG: theme.RoleRun.Color(), Bold: true})
		} else if toolSum != "" {
			putClipped(c, row, col+3+cursor, rem, Truncate(toolSum, rem), Style{FG: theme.RoleDim.Color()})
		}
	}
}

// entryHeight returns how many rows a finished sub-agent occupies in back to main.
func entryHeight(a protocol.Agent) int {
	if (a.Status == "failed" || a.Status == "error") && Clean(a.Error) != "" {
		return 2
	}
	return 1
}

// backTotalRows returns the total interior entry rows needed for reported.
func backTotalRows(reported []protocol.Agent) int {
	total := 0
	for _, a := range reported {
		total += entryHeight(a)
	}
	return total
}

// drawBackToMain draws the "back to main · reported" box of size boxW × boxH
// and returns hits for the frame and each visible entry (2 rows tall for
// failed entries so clicks on the error line select the agent).
func drawBackToMain(c *Canvas, row, col, boxW, boxH int, reported []protocol.Agent, totalThisTurn int, selected string, backOffset, frame int, now time.Time) []hit {
	c.Box(row, col, boxW, boxH, Style{FG: theme.RoleMain.Color()}, false)
	innerCol := col + 2
	innerW := boxW - 4
	hits := []hit{{kind: hitBackScroll, rect: image.Rect(col, row, col+boxW, row+boxH)}}
	if innerW <= 0 || boxH < 3 {
		return hits
	}

	// Header row: "back to main · reported" on left, "done/total" on right.
	ratio := strconv.Itoa(len(reported)) + "/" + strconv.Itoa(totalThisTurn)
	rw := Width(ratio)
	if rw <= innerW {
		putClipped(c, row+1, innerCol+innerW-rw, rw, ratio, Style{FG: theme.RoleFG.Color(), Bold: true})
	}
	headerAvail := innerW - rw - 1
	if headerAvail > 0 {
		used := putClipped(c, row+1, innerCol, headerAvail, Truncate("back to main", headerAvail), Style{FG: theme.RoleMain.Color(), Bold: true})
		if rem := headerAvail - used; rem >= 4 {
			putClipped(c, row+1, innerCol+used, rem, Truncate(" "+Separator+" reported", rem), Style{FG: theme.RoleDim.Color()})
		}
	}

	availRows := boxH - 3
	if len(reported) == 0 || availRows <= 0 {
		return hits
	}

	startIdx := min(max(backOffset, 0), len(reported)-1)
	usedRows := 0
	visCount := 0
	for i := startIdx; i < len(reported); i++ {
		a := reported[i]
		eh := entryHeight(a)
		if usedRows+eh > availRows {
			break
		}
		entryRow := row + 2 + usedRows
		drawBackEntry(c, entryRow, col, boxW, a, selected == a.ID, frame, now)
		hits = append(hits, hit{
			kind: hitItem,
			id:   a.ID,
			rect: image.Rect(col+1, entryRow, col+boxW-1, entryRow+eh),
		})
		usedRows += eh
		visCount++
	}

	above := startIdx
	below := len(reported) - (startIdx + visCount)
	drawScrollMark(c, row, col, boxW, col+2, ArrowUp, above)
	drawScrollMark(c, row+boxH-1, col, boxW, col+2, ArrowDown, below)
	return hits
}

func drawBackEntry(c *Canvas, row, boxCol, boxW int, a protocol.Agent, selected bool, frame int, now time.Time) {
	innerCol := boxCol + 2
	innerW := boxW - 4
	if selected {
		c.Put(row, boxCol+1, MarkSelected, Style{FG: theme.RoleMain.Color(), Bold: true})
	}
	icon, role := statusIcon(Clean(a.Status), frame)
	c.Put(row, innerCol, icon, Style{FG: role.Color()})

	elapsed := agentElapsed(a, now)
	ew := Width(elapsed)
	if ew > 0 && ew < innerW-2 {
		putClipped(c, row, innerCol+innerW-ew, ew, elapsed, Style{FG: theme.RoleDim.Color()})
	} else {
		ew = 0
	}

	avail := innerW - 2
	if ew > 0 {
		avail -= ew + 1
	}
	if avail <= 0 {
		return
	}

	name := Clean(a.Name)
	typ := Clean(a.Type)
	if a.Mode == "background" {
		if typ != "" {
			typ += " " + Separator + " bg"
		} else {
			typ = "bg"
		}
	}
	toolsN := a.ToolCount
	if toolsN == 0 && len(a.Tools) > 0 {
		toolsN = len(a.Tools)
	}
	toolsStr := fmt.Sprintf("%d tools", toolsN)
	if toolsN == 1 {
		toolsStr = "1 tool"
	}

	nameSt := Style{FG: theme.RoleFG.Color(), Bold: true}
	dim := Style{FG: theme.RoleDim.Color()}

	switch {
	case avail >= 30:
		nameW, typeW := 14, 11
		putClipped(c, row, innerCol+2, nameW-1, Truncate(name, nameW-1), nameSt)
		putClipped(c, row, innerCol+2+nameW, typeW-1, Truncate(typ, typeW-1), dim)
		rem := avail - nameW - typeW
		if rem > 0 {
			putClipped(c, row, innerCol+2+nameW+typeW, rem, Truncate(toolsStr, rem), dim)
		}
	case avail >= 20:
		nameW, typeW := 11, 8
		putClipped(c, row, innerCol+2, nameW-1, Truncate(name, nameW-1), nameSt)
		putClipped(c, row, innerCol+2+nameW, typeW-1, Truncate(typ, typeW-1), dim)
		rem := avail - nameW - typeW
		if rem > 0 {
			putClipped(c, row, innerCol+2+nameW+typeW, rem, Truncate(toolsStr, rem), dim)
		}
	default:
		putClipped(c, row, innerCol+2, avail, Truncate(name, avail), nameSt)
	}

	if entryHeight(a) == 2 && innerW > 2 {
		errText := Truncate(Clean(a.Error), innerW-2)
		putClipped(c, row+1, innerCol+2, innerW-2, errText, Style{FG: theme.RoleFail.Color()})
	}
}
