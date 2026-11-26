package ui

import "github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"

// scrollGeom describes the active scrollable viewport capacities for the
// current pane dimensions and snapshot, shared with layout planning.
type scrollGeom struct {
	runCols     int
	runVisRows  int
	backVisRows int
	logVisRows  int
	listVisRows int
}

func (m Model) scrollGeometry(running, reported []protocol.Agent) scrollGeom {
	if m.width <= 0 || m.height <= 0 || !m.hasSnapshot() {
		return scrollGeom{}
	}
	switch chooseLayout(m.width, m.height) {
	case layoutVertical:
		p := planVertical(m.width, m.height, len(running), reported)
		return scrollGeom{
			runCols:     p.runCols,
			runVisRows:  p.runVisRows,
			backVisRows: p.backVisRows,
			logVisRows:  p.logVisRows,
		}
	case layoutHorizontal:
		p := planHorizontal(m.width, m.height, len(running), len(reported))
		return scrollGeom{
			runCols:     p.runCols,
			runVisRows:  p.runVisRows,
			backVisRows: p.backVisRows,
			logVisRows:  p.logVisRows,
		}
	case layoutCompact:
		if m.showLog {
			return scrollGeom{logVisRows: compactLogVisRows(m.height)}
		}
		return scrollGeom{listVisRows: compactListVisRows(m.height)}
	default:
		return scrollGeom{}
	}
}

// backMaxOffset returns the largest valid backOffset for reported in availRows:
// the smallest starting index from which every remaining entry fits without
// scrolling.
func backMaxOffset(reported []protocol.Agent, availRows int) int {
	if len(reported) == 0 || availRows <= 0 {
		return 0
	}
	rows := 0
	start := len(reported)
	for i := len(reported) - 1; i >= 0; i-- {
		eh := entryHeight(reported[i])
		if rows+eh > availRows {
			break
		}
		rows += eh
		start = i
	}
	if start == len(reported) {
		return len(reported) - 1
	}
	return start
}

// backVisibleCount returns how many entries fit in availRows starting at offset.
func backVisibleCount(reported []protocol.Agent, offset, availRows int) int {
	if offset < 0 || offset >= len(reported) || availRows <= 0 {
		return 0
	}
	used := 0
	count := 0
	for i := offset; i < len(reported); i++ {
		eh := entryHeight(reported[i])
		if used+eh > availRows {
			break
		}
		used += eh
		count++
	}
	return count
}

// clampOffsets brings all viewport offsets back into valid bounds without
// chasing the selected item.
func (m *Model) clampOffsets() {
	running, _ := orderRunning(m.snap.Agents)
	reported := reportedAgents(m.snap.Agents, m.snap.Turn)
	g := m.scrollGeometry(running, reported)

	// Run area compact rows
	if g.runVisRows <= 0 || g.runCols <= 0 || len(running) == 0 {
		m.runOffset = 0
	} else {
		totalRows := (len(running) + g.runCols - 1) / g.runCols
		maxOff := max(0, totalRows-g.runVisRows)
		m.runOffset = min(max(m.runOffset, 0), maxOff)
	}

	// Back to main
	if g.backVisRows <= 0 || len(reported) == 0 {
		m.backOffset = 0
	} else {
		maxOff := backMaxOffset(reported, g.backVisRows)
		m.backOffset = min(max(m.backOffset, 0), maxOff)
	}

	// Compact layout list
	if g.listVisRows <= 0 {
		if chooseLayout(m.width, m.height) != layoutCompact {
			m.listOffset = 0
		}
	} else {
		totalItems := 1 + len(running) + len(reported)
		maxOff := max(0, totalItems-g.listVisRows)
		m.listOffset = min(max(m.listOffset, 0), maxOff)
	}

	// Activity log
	if !m.logFollow && g.logVisRows > 0 {
		entries := filterLog(m.snap.Log, m.selected)
		if len(entries) == 0 {
			m.logFollow = true
			m.logTop = 0
		} else {
			idx := activityStartIndex(entries, g.logVisRows, false, m.logTop)
			m.logTop = entries[idx].Seq
		}
	}
}

// ensureSelectedVisible adjusts the viewport of the region containing
// m.selected just enough so the selected item is completely visible.
func (m *Model) ensureSelectedVisible() {
	if m.selected == "" || !m.hasSnapshot() || m.width <= 0 || m.height <= 0 {
		return
	}
	running, _ := orderRunning(m.snap.Agents)
	reported := reportedAgents(m.snap.Agents, m.snap.Turn)
	g := m.scrollGeometry(running, reported)

	// Compact layout list
	if g.listVisRows > 0 {
		idx := -1
		if m.selected == mainID {
			idx = 0
		} else {
			for i, a := range running {
				if a.ID == m.selected {
					idx = 1 + i
					break
				}
			}
			if idx < 0 {
				for i, a := range reported {
					if a.ID == m.selected {
						idx = 1 + len(running) + i
						break
					}
				}
			}
		}
		if idx >= 0 {
			totalItems := 1 + len(running) + len(reported)
			maxOff := max(0, totalItems-g.listVisRows)
			m.listOffset = min(max(m.listOffset, 0), maxOff)
			if idx < m.listOffset {
				m.listOffset = idx
			} else if idx >= m.listOffset+g.listVisRows {
				m.listOffset = idx - g.listVisRows + 1
			}
			m.listOffset = min(max(m.listOffset, 0), maxOff)
		}
		return
	}

	// Run area compact rows
	if g.runVisRows > 0 && g.runCols > 0 {
		for i, a := range running {
			if a.ID == m.selected {
				totalRows := (len(running) + g.runCols - 1) / g.runCols
				maxOff := max(0, totalRows-g.runVisRows)
				m.runOffset = min(max(m.runOffset, 0), maxOff)
				itemRow := i / g.runCols
				if itemRow < m.runOffset {
					m.runOffset = itemRow
				} else if itemRow >= m.runOffset+g.runVisRows {
					m.runOffset = itemRow - g.runVisRows + 1
				}
				m.runOffset = min(max(m.runOffset, 0), maxOff)
				return
			}
		}
	}

	// Back to main
	if g.backVisRows > 0 {
		for i, a := range reported {
			if a.ID == m.selected {
				maxOff := backMaxOffset(reported, g.backVisRows)
				m.backOffset = min(max(m.backOffset, 0), maxOff)
				if i < m.backOffset {
					m.backOffset = i
				} else if vis := backVisibleCount(reported, m.backOffset, g.backVisRows); i >= m.backOffset+vis {
					rows := 0
					off := i
					for j := i; j >= 0; j-- {
						eh := entryHeight(reported[j])
						if rows+eh > g.backVisRows {
							break
						}
						rows += eh
						off = j
					}
					m.backOffset = min(off, maxOff)
				}
				return
			}
		}
	}
}

func (m *Model) scrollRun(delta int) {
	running, _ := orderRunning(m.snap.Agents)
	reported := reportedAgents(m.snap.Agents, m.snap.Turn)
	g := m.scrollGeometry(running, reported)
	if g.runVisRows <= 0 || g.runCols <= 0 || len(running) == 0 {
		return
	}
	totalRows := (len(running) + g.runCols - 1) / g.runCols
	maxOff := max(0, totalRows-g.runVisRows)
	m.runOffset = min(max(m.runOffset+delta, 0), maxOff)
}

func (m *Model) scrollBack(delta int) {
	running, _ := orderRunning(m.snap.Agents)
	reported := reportedAgents(m.snap.Agents, m.snap.Turn)
	g := m.scrollGeometry(running, reported)
	if g.backVisRows <= 0 || len(reported) == 0 {
		return
	}
	maxOff := backMaxOffset(reported, g.backVisRows)
	m.backOffset = min(max(m.backOffset+delta, 0), maxOff)
}

func (m *Model) scrollList(delta int) {
	running, _ := orderRunning(m.snap.Agents)
	reported := reportedAgents(m.snap.Agents, m.snap.Turn)
	g := m.scrollGeometry(running, reported)
	if g.listVisRows <= 0 {
		return
	}
	totalItems := 1 + len(running) + len(reported)
	maxOff := max(0, totalItems-g.listVisRows)
	m.listOffset = min(max(m.listOffset+delta, 0), maxOff)
}

func (m *Model) scrollLog(delta int) {
	running, _ := orderRunning(m.snap.Agents)
	reported := reportedAgents(m.snap.Agents, m.snap.Turn)
	g := m.scrollGeometry(running, reported)
	if g.logVisRows <= 0 {
		return
	}
	entries := filterLog(m.snap.Log, m.selected)
	if len(entries) == 0 {
		return
	}
	maxStart := max(0, len(entries)-g.logVisRows)
	cur := activityStartIndex(entries, g.logVisRows, m.logFollow, m.logTop)
	next := min(max(cur+delta, 0), maxStart)
	if next >= maxStart {
		m.logFollow = true
		m.logTop = 0
	} else {
		m.logFollow = false
		m.logTop = entries[next].Seq
	}
}

func (m *Model) pageLog(dir int) {
	running, _ := orderRunning(m.snap.Agents)
	reported := reportedAgents(m.snap.Agents, m.snap.Turn)
	g := m.scrollGeometry(running, reported)
	if g.logVisRows <= 0 {
		return
	}
	step := max(1, g.logVisRows-1)
	m.scrollLog(dir * step)
}
