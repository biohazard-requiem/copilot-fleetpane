package ui

import "github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"

// Horizontal workflow geometry constants.
const (
	horizMargin         = 1
	horizMainW          = 28
	horizBoxH           = 8
	horizBodyRow        = 3
	horizDelegateRow    = 1
	horizArrowRow       = 2
	horizMergeRow       = 11
	horizActTopRow      = 1
	horizActMinBottom   = 11
	horizGapAfterMain   = 4
	horizGapDirect      = 6
	horizGapBeforeBack  = 3
	horizBackW          = 44
	horizGapBeforeAct   = 2
	horizMinActW        = 36
	horizMaxRunSubtract = 119 // 1 + 28 + 4 + 3 + 44 + 2 + 1 + 36 (Wr = W - 119)
	horizBoxW           = 24
	horizBoxGap         = 1
	horizBoxStride      = horizBoxW + horizBoxGap // 25
	horizCompactMinColW = 28
	horizCompactRows    = 6
	horizDirectLabelRow = 4
	horizDirectArrowRow = 5
)

type horizontalPlan struct {
	actH        int
	useCompact  bool
	maxRunW     int
	compactCols int
	compactColW int
	runCols     int
	runVisRows  int
	backVisRows int
	logVisRows  int
}

func planHorizontal(W, H, runningN, reportedN int) horizontalPlan {
	actBottom := max(horizActMinBottom, H-4)
	actH := actBottom - horizActTopRow + 1
	p := horizontalPlan{
		actH:       actH,
		logVisRows: max(0, actH-2),
	}
	if runningN+reportedN == 0 {
		return p
	}
	p.backVisRows = max(0, horizBoxH-3)
	if runningN == 0 {
		return p
	}
	p.maxRunW = W - horizMaxRunSubtract
	if horizBoxStride*runningN-1 > p.maxRunW {
		p.useCompact = true
		inner := p.maxRunW - 4
		p.compactCols = max(1, (inner+1)/horizCompactMinColW)
		p.compactColW = (inner - (p.compactCols - 1)) / p.compactCols
		p.runCols = p.compactCols
		p.runVisRows = max(0, horizBoxH-2)
	}
	return p
}

// layoutHorizontalWorkflow lays out the horizontal workflow onto c and returns
// all interactive hit rectangles.
func layoutHorizontalWorkflow(c *Canvas, m Model) []hit {
	W, H := c.W, c.H
	th := m.activeTheme()

	running, runningByID := orderRunning(m.snap.Agents)
	reported := reportedAgents(m.snap.Agents, m.snap.Turn)
	totalThisTurn := len(running) + len(reported)
	parentHighlightID := selectedParentID(m.selected, runningByID)

	p := planHorizontal(W, H, len(running), len(reported))

	// Row 0: title and per-turn counts.
	titleW := drawTitle(c, 0, horizMargin, W-2*horizMargin, th, m.dark, false)
	countCol := horizMargin + titleW + 3
	drawCountLine(c, 0, countCol, W-horizMargin-countCol, running, reported, m.frame, false)

	mainCol := horizMargin
	var hits []hit
	hits = append(hits, drawMainBox(c, horizBodyRow, mainCol, horizMainW, horizBoxH, m))

	// Case 1: no sub-agents this turn.
	if totalThisTurn == 0 {
		actCol := mainCol + horizMainW + horizGapAfterMain
		actW := W - horizMargin - actCol
		hits = append(hits, drawActivity(c, horizActTopRow, actCol, actW, p.actH, m, runningByID))
		drawStatusAndHints(c, H-1, 0, W, m, 0, 0, false)
		return hits
	}

	// Case 2: sub-agents exist this turn, all finished.
	if len(running) == 0 {
		gapCol := mainCol + horizMainW
		backCol := gapCol + horizGapDirect
		actCol := backCol + horizBackW + horizGapBeforeAct
		actW := W - horizMargin - actCol

		// Direct connector in the 6-cell gap: row 4 "report", row 5 arrowed line in main color.
		putClipped(c, horizDirectLabelRow, gapCol, horizGapDirect, "report", Style{FG: theme.RoleDim.Color()})
		mainSt := Style{FG: theme.RoleMain.Color()}
		for col := gapCol; col < gapCol+horizGapDirect-1; col++ {
			c.Put(horizDirectArrowRow, col, LightBorder.Horizontal, mainSt)
		}
		c.Put(horizDirectArrowRow, gapCol+horizGapDirect-1, ArrowRight, mainSt)

		hits = append(hits, drawBackToMain(c, horizBodyRow, backCol, horizBackW, horizBoxH, reported, totalThisTurn, m.selected, m.backOffset, m.frame, m.now)...)
		hits = append(hits, drawActivity(c, horizActTopRow, actCol, actW, p.actH, m, runningByID))
		drawStatusAndHints(c, H-1, 0, W, m, 0, totalThisTurn, false)
		return hits
	}

	// Case 3: one or more running sub-agents.
	n := len(running)
	runCol := mainCol + horizMainW + horizGapAfterMain
	mainCx := mainCol + horizMainW/2

	var (
		runW   int
		connXs []int
		live   []bool // whether the connector into each of connXs is live
	)
	if !p.useCompact {
		// Level 1: tall boxes (24 × 8), gap 1; unused width goes to activity.
		runW = horizBoxStride*n - 1
		connXs = make([]int, n)
		live = make([]bool, n)
		for i, a := range running {
			bx := runCol + i*horizBoxStride
			pName := ""
			if par, ok := runningParent(a, runningByID); ok {
				pName = par.Name
			}
			hits = append(hits, drawAgentBox(c, horizBodyRow, bx, horizBoxW, boxTall, a, pName, m.selected == a.ID, a.ID == parentHighlightID, m.frame, m.now))
			cx := bx + horizBoxW/2
			connXs[i] = cx
			live[i] = !agentWaits(a)
			borderRole := agentBorderRole(a, a.ID == parentHighlightID)
			c.Put(horizBodyRow+horizBoxH-1, cx, TeeDown, Style{FG: borderRole.Color()})
		}
	} else {
		// Levels 2 & 3: compact rows inside a Wr × 8 frame (6 interior rows).
		runW = p.maxRunW
		hits = append(hits, drawCompactFrame(c, horizBodyRow, runCol, runW, horizBoxH, p.compactCols, p.compactColW, 1, running, runningByID, m, parentHighlightID)...)
		frameCx := runCol + runW/2
		connXs = []int{frameCx}
		live = []bool{anyLive(running)}
		if c.At(horizBodyRow+horizBoxH-1, frameCx).Text == LightBorder.Horizontal {
			c.Put(horizBodyRow+horizBoxH-1, frameCx, TeeDown, Style{FG: theme.RoleAgent.Color()})
		}
	}

	backCol := runCol + runW + horizGapBeforeBack
	backCx := backCol + horizBackW/2
	actCol := backCol + horizBackW + horizGapBeforeAct
	actW := W - horizMargin - actCol

	drawHorizDelegate(c, mainCx, connXs, live, m.frame)
	drawHorizReport(c, connXs, backCx)

	hits = append(hits, drawBackToMain(c, horizBodyRow, backCol, horizBackW, horizBoxH, reported, totalThisTurn, m.selected, m.backOffset, m.frame, m.now)...)
	hits = append(hits, drawActivity(c, horizActTopRow, actCol, actW, p.actH, m, runningByID))
	drawStatusAndHints(c, H-1, 0, W, m, n, totalThisTurn, false)
	return hits
}

// drawHorizDelegate draws the delegate line on row 1, the vertical stem and
// downward arrows on row 2, and the junction on main's top border (row 3).
// live tells for each of targetCols whether the connector into it is live.
// The line is live as far as the last such target, and static from there on.
func drawHorizDelegate(c *Canvas, mainCx int, targetCols []int, live []bool, frame int) {
	if len(targetCols) == 0 {
		return
	}
	mainSt := Style{FG: theme.RoleMain.Color()}
	liveSt := Style{FG: theme.RoleLive.Color()}
	dimSt := Style{FG: theme.RoleDim.Color()}

	lastLive := -1
	for i, tc := range targetCols {
		if live[i] {
			lastLive = tc
		}
	}
	lineSt := func(col int) Style { return branchStyle(col <= lastLive) }

	lastCol := targetCols[len(targetCols)-1]
	c.Put(horizBodyRow, mainCx, TeeUp, mainSt)
	c.Put(horizArrowRow, mainCx, LightBorder.Vertical, lineSt(mainCx))
	c.Put(horizDelegateRow, mainCx, LightBorder.TopLeft, lineSt(mainCx))
	for col := mainCx + 1; col < lastCol; col++ {
		c.Put(horizDelegateRow, col, LightBorder.Horizontal, lineSt(col))
	}

	const label = " delegate "
	labelCol := mainCx + 2
	labelEnd := labelCol
	if labelCol+len(label) <= targetCols[0] {
		c.Put(horizDelegateRow, labelCol, label, dimSt)
		labelEnd = labelCol + len(label)
	}

	isTarget := make(map[int]bool, len(targetCols))
	for i, tc := range targetCols {
		isTarget[tc] = true
		if i < len(targetCols)-1 {
			c.Put(horizDelegateRow, tc, TeeDown, lineSt(tc))
		} else {
			c.Put(horizDelegateRow, tc, LightBorder.TopRight, lineSt(tc))
		}
		c.Put(horizArrowRow, tc, ArrowDown, branchStyle(live[i]))
	}

	// Place one animated dot along the live horizontal segment after " delegate ".
	var dotCols []int
	for col := labelEnd; col < lastLive; col++ {
		if !isTarget[col] {
			dotCols = append(dotCols, col)
		}
	}
	if len(dotCols) > 0 {
		idx := ((frame % len(dotCols)) + len(dotCols)) % len(dotCols)
		c.Put(horizDelegateRow, dotCols[idx], Dot, liveSt)
	}
}

// drawHorizReport draws the static main-colored merge line on row 11 from the
// running boxes (or compact frame) to the upward arrow beneath back to main.
func drawHorizReport(c *Canvas, srcCols []int, backCx int) {
	if len(srcCols) == 0 {
		return
	}
	mainSt := Style{FG: theme.RoleMain.Color()}
	dimSt := Style{FG: theme.RoleDim.Color()}

	firstCol := srcCols[0]
	c.Put(horizMergeRow, firstCol, LightBorder.BottomLeft, mainSt)
	for col := firstCol + 1; col < backCx; col++ {
		c.Put(horizMergeRow, col, LightBorder.Horizontal, mainSt)
	}
	for i := 1; i < len(srcCols); i++ {
		c.Put(horizMergeRow, srcCols[i], TeeUp, mainSt)
	}
	c.Put(horizMergeRow, backCx, ArrowUp, mainSt)

	const label = " report "
	labelCol := firstCol + 3
	nextStop := backCx
	if len(srcCols) > 1 {
		nextStop = srcCols[1]
	}
	if labelCol+len(label) <= nextStop {
		c.Put(horizMergeRow, labelCol, label, dimSt)
	}
}
