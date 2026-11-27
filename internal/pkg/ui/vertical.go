package ui

import (
	"fmt"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

// Vertical workflow row budget and geometry constants.
const (
	verticalFixedRows     = 13 // 3 (title+count+blank) + 5 (main) + 1 (delegate) + 1 (blank) + 1 (blank) + 2 (status+hints)
	verticalNoAgentsFixed = 12 // 3 + 5 + 1 (blank) + 1 (blank) + 2
	minActivityRows       = 5
	mainBoxH              = 5
	singleBoxMaxW         = 31
	minThreeBoxW          = 16
	compactTwoColMinW     = 49
	backChromeRows        = 3 // top border + header + bottom border
	backMaxRowsNormal     = 8
	backMaxRowsTight      = 3

	connSingleRow = 4 // 2 fanout + 2 merge
	connGrid      = 1 // 1 merge arrow below trunk
	connCompact   = 2 // 1 arrow above + 1 arrow below
	connDirect    = 1 // 1 arrow directly into back to main
)

type runLevel uint8

const (
	levelFullBoxes runLevel = iota + 1
	levelShortBoxes
	levelCompact
	levelCompactScroll
)

type verticalPlan struct {
	W, H         int
	x0           int
	level        runLevel
	useSingleRow bool
	compactCols  int
	compactColW  int
	runH         int
	backH        int
	actH         int
	conn         int
	runCols      int
	runVisRows   int
	backVisRows  int
	logVisRows   int
}

func planVertical(canvasW, canvasH, runningN int, reported []protocol.Agent) verticalPlan {
	W := min(canvasW, maxVerticalW)
	H := canvasH
	p := verticalPlan{
		W:  W,
		H:  H,
		x0: (canvasW - W) / 2,
	}
	totalThisTurn := runningN + len(reported)

	// Case 1: no sub-agents this turn.
	if totalThisTurn == 0 {
		p.actH = H - verticalNoAgentsFixed
		p.logVisRows = max(0, p.actH-2)
		return p
	}

	// Case 2: sub-agents exist this turn, all finished.
	if runningN == 0 {
		actualBack := backTotalRows(reported)
		maxBackEntries := max(0, H-verticalFixedRows-connDirect-minActivityRows-backChromeRows)
		entryRows := min(actualBack, min(backMaxRowsNormal, maxBackEntries))
		p.backH = backChromeRows + entryRows
		p.actH = H - verticalFixedRows - connDirect - p.backH
		p.backVisRows = max(0, p.backH-3)
		p.logVisRows = max(0, p.actH-2)
		return p
	}

	// Case 3: one or more running sub-agents.
	p.useSingleRow = runningN == 1 || runningN == 2 || (runningN == 3 && (W-6)/3 >= minThreeBoxW)
	boxConn := connGrid
	boxRows := (runningN + 1) / 2
	if p.useSingleRow {
		boxConn = connSingleRow
		boxRows = 1
	}

	p.compactCols = 1
	p.compactColW = W - 4
	if W >= compactTwoColMinW {
		p.compactCols = 2
		p.compactColW = (W - 5) / 2
	}
	compactNeedH := (runningN+p.compactCols-1)/p.compactCols + 2

	availR := func(conn, B int) int {
		return H - verticalFixedRows - conn - B - minActivityRows
	}

	actualBack := backTotalRows(reported)
	B1 := backChromeRows + min(actualBack, backMaxRowsNormal)
	B2 := backChromeRows + min(actualBack, backMaxRowsTight)
	level1Need := boxRows * fullBoxH
	level2Need := boxRows * shortBoxH

	switch {
	case level1Need <= availR(boxConn, B1):
		p.level, p.backH, p.conn, p.runH = levelFullBoxes, B1, boxConn, level1Need
	case level1Need <= availR(boxConn, B2):
		p.level, p.backH, p.conn, p.runH = levelFullBoxes, B2, boxConn, level1Need
	case level2Need <= availR(boxConn, B2):
		p.level, p.backH, p.conn, p.runH = levelShortBoxes, B2, boxConn, level2Need
	case compactNeedH <= availR(connCompact, B2):
		p.level, p.backH, p.conn, p.runH = levelCompact, B2, connCompact, compactNeedH
	default:
		p.level, p.backH, p.conn, p.runH = levelCompactScroll, B2, connCompact, availR(connCompact, B2)
	}

	p.actH = H - verticalFixedRows - p.conn - p.backH - p.runH
	if p.level == levelCompact || p.level == levelCompactScroll {
		p.runCols = p.compactCols
		p.runVisRows = max(0, p.runH-2)
	}
	p.backVisRows = max(0, p.backH-3)
	p.logVisRows = max(0, p.actH-2)
	return p
}

// layoutVerticalWorkflow lays out the vertical workflow onto c and returns all
// interactive hit rectangles.
func layoutVerticalWorkflow(c *Canvas, m Model) []hit {
	th := m.activeTheme()

	running, runningByID := orderRunning(m.snap.Agents)
	reported := reportedAgents(m.snap.Agents, m.snap.Turn)
	totalThisTurn := len(running) + len(reported)
	parentHighlightID := selectedParentID(m.selected, runningByID)

	p := planVertical(c.W, c.H, len(running), reported)
	W, H, x0 := p.W, p.H, p.x0

	// Rows 0..2: title, count line, blank.
	drawTitle(c, 0, x0, W, th, m.dark, true)
	drawCountLine(c, 1, x0, W, running, reported, m.frame, true)

	// Rows 3..7: main box.
	mainW := min(singleBoxMaxW, W-2)
	mainCol := x0 + (W-mainW)/2
	cx := mainCol + mainW/2

	var hits []hit
	hits = append(hits, drawMainBox(c, 3, mainCol, mainW, mainBoxH, m))

	// Case 1: no sub-agents this turn.
	if totalThisTurn == 0 {
		actRow := 9
		hits = append(hits, drawActivity(c, actRow, x0+1, W-2, p.actH, m, runningByID))
		drawStatusAndHints(c, H-2, x0, W, m, 0, 0, true)
		return hits
	}

	// Case 2: sub-agents exist this turn, all finished.
	if len(running) == 0 {
		mainSt := Style{FG: theme.RoleMain.Color()}
		c.Put(7, cx, TeeDown, mainSt)
		c.Put(8, cx, LightBorder.Vertical, mainSt)
		c.Put(9, cx, ArrowDown, mainSt)

		backRow := 10
		hits = append(hits, drawBackToMain(c, backRow, x0+1, W-2, p.backH, reported, totalThisTurn, m.selected, m.backOffset, m.frame, m.now)...)

		actRow := backRow + p.backH + 1
		hits = append(hits, drawActivity(c, actRow, x0+1, W-2, p.actH, m, runningByID))
		drawStatusAndHints(c, H-2, x0, W, m, 0, totalThisTurn, true)
		return hits
	}

	// Case 3: one or more running sub-agents.
	n := len(running)

	// Row 7 junction on main box bottom border and Row 8 delegate stem.
	stemSt := branchStyle(anyLive(running))
	mainSt := Style{FG: theme.RoleMain.Color()}
	dimSt := Style{FG: theme.RoleDim.Color()}

	c.Put(7, cx, TeeDown, mainSt)
	c.Put(8, cx, LightBorder.Vertical, stemSt)
	labelW := x0 + W - (cx + 1)
	putClipped(c, 8, cx+1, labelW, delegateLabel(n, labelW), dimSt)

	var backRow int
	switch p.level {
	case levelFullBoxes, levelShortBoxes:
		variant := boxFull
		if p.level == levelShortBoxes {
			variant = boxShort
		}
		if p.useSingleRow {
			hits = append(hits, drawVerticalSingleRow(c, 9, x0, W, cx, variant, running, runningByID, m, parentHighlightID)...)
			backRow = 9 + 2 + p.runH + 2
		} else {
			hits = append(hits, drawVerticalGrid(c, 9, x0, W, cx, variant, running, runningByID, m, parentHighlightID)...)
			backRow = 9 + p.runH + 1
		}
	case levelCompact, levelCompactScroll:
		c.Put(9, cx, ArrowDown, stemSt)
		boxRow := 10
		hits = append(hits, drawCompactFrame(c, boxRow, x0+1, W-2, p.runH, p.compactCols, p.compactColW, 0, running, runningByID, m, parentHighlightID)...)
		c.Put(boxRow+p.runH, cx, ArrowDown, mainSt)
		backRow = boxRow + p.runH + 1
	}

	hits = append(hits, drawBackToMain(c, backRow, x0+1, W-2, p.backH, reported, totalThisTurn, m.selected, m.backOffset, m.frame, m.now)...)

	actRow := backRow + p.backH + 1
	hits = append(hits, drawActivity(c, actRow, x0+1, W-2, p.actH, m, runningByID))
	drawStatusAndHints(c, H-2, x0, W, m, n, totalThisTurn, true)
	return hits
}

// delegateLabel returns what the delegate stem of n running sub-agents says
// in avail cells: "delegate · N running", only "delegate · N" when that does
// not fit, and nothing when that does not fit either.
func delegateLabel(n, avail int) string {
	short := fmt.Sprintf(" delegate %s %d", Separator, n)
	if full := short + " running"; Width(full) <= avail {
		return full
	}
	if Width(short) <= avail {
		return short
	}
	return ""
}

// drawVerticalSingleRow draws the fanout (2 rows), 1..3 boxes in a row, and
// merge connectors (2 rows) starting at topRow.
func drawVerticalSingleRow(c *Canvas, topRow, x0, W, cx int, variant boxVariant, running []protocol.Agent, runningByID map[string]protocol.Agent, m Model, parentHighlightID string) []hit {
	n := len(running)
	boxH := fullBoxH
	if variant == boxShort {
		boxH = shortBoxH
	}

	var bw, gap int
	switch n {
	case 1:
		bw, gap = min(singleBoxMaxW, W-2), 0
	case 2:
		bw, gap = (W-5)/2, 3
	case 3:
		bw, gap = (W-6)/3, 2
	}
	totalW := n*bw + (n-1)*gap
	left := x0 + (W-totalW)/2

	bx := make([]int, n)
	bc := make([]int, n)
	for i := range n {
		bx[i] = left + i*(bw+gap)
		bc[i] = bx[i] + bw/2
	}

	liveSt := Style{FG: theme.RoleLive.Color()}
	mainSt := Style{FG: theme.RoleMain.Color()}
	fanRow := topRow
	arrowRow := topRow + 1
	boxRow := topRow + 2
	mergeRow := boxRow + boxH
	mergeArrowRow := mergeRow + 1

	// The fanout is live, with a flowing dot, from the stem as far as the
	// outermost boxes that are not waiting for the user: columns
	// [liveLo, liveHi], empty when all of them wait. The rest of it is static.
	liveLo, liveHi := c.W, -1
	for i, a := range running {
		if !agentWaits(a) {
			liveLo, liveHi = min(liveLo, bc[i], cx), max(liveHi, bc[i], cx)
		}
	}
	fanSt := func(col int) Style { return branchStyle(liveLo <= col && col <= liveHi) }

	if n == 1 {
		if m.frame%2 == 0 && !agentWaits(running[0]) {
			c.Put(fanRow, cx, Dot, liveSt)
		} else {
			c.Put(fanRow, cx, LightBorder.Vertical, fanSt(cx))
		}
	} else {
		for col := bc[0] + 1; col < bc[n-1]; col++ {
			c.Put(fanRow, col, LightBorder.Horizontal, fanSt(col))
		}
		c.Put(fanRow, bc[0], LightBorder.TopLeft, fanSt(bc[0]))
		c.Put(fanRow, bc[n-1], LightBorder.TopRight, fanSt(bc[n-1]))
		if n == 3 && bc[1] == cx {
			c.Put(fanRow, cx, Cross, fanSt(cx))
		} else {
			c.Put(fanRow, cx, TeeUp, fanSt(cx))
			if n == 3 {
				c.Put(fanRow, bc[1], TeeDown, fanSt(bc[1]))
			}
		}
		// Animated dot along left and right arms moving outward from cx.
		if leftLen := cx - liveLo - 1; leftLen > 0 {
			pos := cx - 1 - (((m.frame % leftLen) + leftLen) % leftLen)
			c.Put(fanRow, pos, Dot, liveSt)
		}
		if rightLen := liveHi - cx - 1; rightLen > 0 {
			pos := cx + 1 + (((m.frame % rightLen) + rightLen) % rightLen)
			c.Put(fanRow, pos, Dot, liveSt)
		}
	}
	for i, a := range running {
		c.Put(arrowRow, bc[i], ArrowDown, branchStyle(!agentWaits(a)))
	}

	// Boxes
	hits := make([]hit, 0, n)
	for i, a := range running {
		pName := ""
		if p, ok := runningParent(a, runningByID); ok {
			pName = p.Name
		}
		hits = append(hits, drawAgentBox(c, boxRow, bx[i], bw, variant, a, pName, m.selected == a.ID, a.ID == parentHighlightID, m.frame, m.now))
		// Junction on box bottom border in the box's own border color.
		borderRole := agentBorderRole(a, a.ID == parentHighlightID)
		c.Put(boxRow+boxH-1, bc[i], TeeDown, Style{FG: borderRole.Color()})
	}

	// Merge connectors (static, main color).
	if n == 1 {
		c.Put(mergeRow, cx, LightBorder.Vertical, mainSt)
	} else {
		for col := bc[0] + 1; col < bc[n-1]; col++ {
			c.Put(mergeRow, col, LightBorder.Horizontal, mainSt)
		}
		c.Put(mergeRow, bc[0], LightBorder.BottomLeft, mainSt)
		c.Put(mergeRow, bc[n-1], LightBorder.BottomRight, mainSt)
		if n == 3 && bc[1] == cx {
			c.Put(mergeRow, cx, Cross, mainSt)
		} else {
			c.Put(mergeRow, cx, TeeDown, mainSt)
			if n == 3 {
				c.Put(mergeRow, bc[1], TeeUp, mainSt)
			}
		}
	}
	c.Put(mergeArrowRow, cx, ArrowDown, mainSt)
	return hits
}

// drawVerticalGrid draws the two-column grid with a central vertical trunk,
// left/right animated branches, and the final arrow into back to main.
func drawVerticalGrid(c *Canvas, topRow, x0, W, cx int, variant boxVariant, running []protocol.Agent, runningByID map[string]protocol.Agent, m Model, parentHighlightID string) []hit {
	boxH := fullBoxH
	branchOffset := 3 // 1-based row 4 of h=7 box
	if variant == boxShort {
		boxH = shortBoxH
		branchOffset = 2 // 1-based row 3 of h=5 box
	}

	bw := (W - 9) / 2
	const centerGap = 7
	totalW := 2*bw + centerGap
	leftCol := x0 + (W-totalW)/2
	trunkCol := leftCol + bw + 3
	rightCol := leftCol + bw + centerGap

	rows := (len(running) + 1) / 2
	lastBranchRow := topRow + (rows-1)*boxH + branchOffset
	totalH := rows * boxH

	liveSt := Style{FG: theme.RoleLive.Color()}
	mainSt := Style{FG: theme.RoleMain.Color()}

	// The trunk is live down to the last branch into a box that is not
	// waiting for the user, static from there down to lastBranchRow, and
	// main below it.
	lastLiveRow := topRow - 1
	for i, a := range running {
		if !agentWaits(a) {
			lastLiveRow = topRow + (i/2)*boxH + branchOffset
		}
	}
	trunkSt := func(r int) Style {
		if r > lastBranchRow {
			return mainSt
		}
		return branchStyle(r <= lastLiveRow)
	}
	for r := topRow; r < topRow+totalH; r++ {
		c.Put(r, trunkCol, LightBorder.Vertical, trunkSt(r))
	}
	c.Put(topRow+totalH, trunkCol, ArrowDown, mainSt)

	dotOff := ((m.frame % 2) + 2) % 2
	hits := make([]hit, 0, len(running))

	for rowIdx := range rows {
		boxRow := topRow + rowIdx*boxH
		branchRow := boxRow + branchOffset
		leftIdx := rowIdx * 2
		rightIdx := leftIdx + 1
		hasRight := rightIdx < len(running)

		// Left box
		la := running[leftIdx]
		lpName := ""
		if p, ok := runningParent(la, runningByID); ok {
			lpName = p.Name
		}
		hits = append(hits, drawAgentBox(c, boxRow, leftCol, bw, variant, la, lpName, m.selected == la.ID, la.ID == parentHighlightID, m.frame, m.now))

		// Left branch: ◀ [•/─] [─/•] (trunk); no dot into a box waiting for the user.
		leftSt := branchStyle(!agentWaits(la))
		c.Put(branchRow, trunkCol-3, ArrowLeft, leftSt)
		c.Put(branchRow, trunkCol-2, LightBorder.Horizontal, leftSt)
		c.Put(branchRow, trunkCol-1, LightBorder.Horizontal, leftSt)
		if !agentWaits(la) {
			c.Put(branchRow, trunkCol-1-dotOff, Dot, liveSt)
		}

		if hasRight {
			ra := running[rightIdx]
			rpName := ""
			if p, ok := runningParent(ra, runningByID); ok {
				rpName = p.Name
			}
			hits = append(hits, drawAgentBox(c, boxRow, rightCol, bw, variant, ra, rpName, m.selected == ra.ID, ra.ID == parentHighlightID, m.frame, m.now))

			rightSt := branchStyle(!agentWaits(ra))
			c.Put(branchRow, trunkCol, Cross, trunkSt(branchRow))
			c.Put(branchRow, trunkCol+1, LightBorder.Horizontal, rightSt)
			c.Put(branchRow, trunkCol+2, LightBorder.Horizontal, rightSt)
			if !agentWaits(ra) {
				c.Put(branchRow, trunkCol+1+dotOff, Dot, liveSt)
			}
			c.Put(branchRow, trunkCol+3, ArrowRight, rightSt)
		} else {
			c.Put(branchRow, trunkCol, TeeLeft, trunkSt(branchRow))
		}
	}

	return hits
}
